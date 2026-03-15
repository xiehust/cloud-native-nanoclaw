import { config } from '../config.js';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import * as dynamo from './dynamo.js';
import { botCache, channelCredentialCache } from './cache.js';
import type { Bot } from '@clawbot/shared';

const secrets = new SecretsManagerClient({ region: config.region });

export async function getCachedBot(botId: string): Promise<Bot | null> {
  const cached = botCache.get(botId);
  if (cached) return cached;
  const bot = await dynamo.getBotById(botId);
  if (bot) botCache.set(botId, bot);
  return bot;
}

export async function getChannelCredentials(secretArn: string): Promise<Record<string, string>> {
  const cached = channelCredentialCache.get(secretArn);
  if (cached) return cached;
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const creds = JSON.parse(result.SecretString || '{}');
  channelCredentialCache.set(secretArn, creds);
  return creds;
}
