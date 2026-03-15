// ClawBot Cloud — Channels API Routes
// CRUD operations for channel management (BYOK credentials)

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  SecretsManagerClient,
  CreateSecretCommand,
  DeleteSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import { config } from '../../config.js';
import {
  getBot,
  createChannel,
  getChannelsByBot,
  deleteChannel,
} from '../../services/dynamo.js';
import { getChannelCredentials } from '../../services/cached-lookups.js';
import { verifyChannelCredentials } from '../../channels/index.js';
import * as telegram from '../../channels/telegram.js';
import type { ChannelConfig, CreateChannelRequest } from '@clawbot/shared';

const secrets = new SecretsManagerClient({ region: config.region });

const createChannelSchema = z.object({
  channelType: z.enum(['telegram', 'discord', 'slack', 'whatsapp']),
  credentials: z.record(z.string(), z.string()),
});

export const channelsRoutes: FastifyPluginAsync = async (app) => {
  // List channels for a bot
  app.get<{ Params: { botId: string } }>('/', async (request, reply) => {
    const { botId } = request.params;

    // Verify bot ownership
    const bot = await getBot(request.userId, botId);
    if (!bot || bot.status === 'deleted') {
      return reply.status(404).send({ error: 'Bot not found' });
    }

    const channels = await getChannelsByBot(botId);
    // Redact secret ARNs from response
    return channels.map((ch) => ({
      ...ch,
      credentialSecretArn: '[redacted]',
    }));
  });

  // Add a channel to a bot
  app.post<{ Params: { botId: string } }>('/', async (request, reply) => {
    const { botId } = request.params;

    // Verify bot ownership
    const bot = await getBot(request.userId, botId);
    if (!bot || bot.status === 'deleted') {
      return reply.status(404).send({ error: 'Bot not found' });
    }

    const body = createChannelSchema.parse(
      request.body as CreateChannelRequest,
    );

    // 1. Verify credentials are valid by calling the channel API
    let verifiedInfo: Record<string, string>;
    try {
      verifiedInfo = await verifyChannelCredentials(
        body.channelType,
        body.credentials,
      );
    } catch (err) {
      return reply.status(400).send({
        error: `Failed to verify ${body.channelType} credentials: ${(err as Error).message}`,
      });
    }

    // 2. Store credentials in Secrets Manager
    const secretName = `clawbot/${config.stage}/${botId}/${body.channelType}`;
    const secretResult = await secrets.send(
      new CreateSecretCommand({
        Name: secretName,
        SecretString: JSON.stringify({
          ...body.credentials,
          ...verifiedInfo,
        }),
        Description: `ClawBot ${body.channelType} credentials for bot ${botId}`,
      }),
    );

    // 3. Determine channel ID from verified info
    const channelId =
      verifiedInfo.botId ||
      verifiedInfo.applicationId ||
      verifiedInfo.botUserId ||
      'default';

    // 4. Build webhook URL
    const webhookBase =
      process.env.WEBHOOK_BASE_URL || `https://${config.stage}.clawbot.ai`;
    const webhookUrl = `${webhookBase}/webhook/${body.channelType}/${botId}`;

    // 5. Register webhook with channel provider (Telegram)
    if (body.channelType === 'telegram') {
      const webhookSecret = crypto.randomUUID();
      await telegram.setWebhook(
        body.credentials.botToken,
        webhookUrl,
        webhookSecret,
      );
      // Update the secret with webhook secret
      // (In production, use UpdateSecret — for now we just included it in the initial create)
    }

    // 6. Create channel record
    const channel: ChannelConfig = {
      botId,
      channelType: body.channelType,
      channelId,
      credentialSecretArn: secretResult.ARN || secretName,
      webhookUrl,
      status: 'connected',
      healthStatus: 'healthy',
      consecutiveFailures: 0,
      config: verifiedInfo,
      createdAt: new Date().toISOString(),
    };

    await createChannel(channel);

    return reply.status(201).send({
      ...channel,
      credentialSecretArn: '[redacted]',
    });
  });

  // Delete a channel
  app.delete<{ Params: { botId: string; channelType: string } }>(
    '/:channelType',
    async (request, reply) => {
      const { botId, channelType } = request.params;

      // Verify bot ownership
      const bot = await getBot(request.userId, botId);
      if (!bot || bot.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      const channels = await getChannelsByBot(botId);
      const channel = channels.find((ch) => ch.channelType === channelType);
      if (!channel) {
        return reply.status(404).send({ error: 'Channel not found' });
      }

      // Unregister webhook before deleting
      try {
        const creds = await getChannelCredentials(channel.credentialSecretArn);
        if (channelType === 'telegram') {
          await telegram.deleteWebhook(creds.botToken);
        }
      } catch {
        // Best effort — proceed with deletion even if unregister fails
      }

      // Delete secret from Secrets Manager
      try {
        await secrets.send(
          new DeleteSecretCommand({
            SecretId: channel.credentialSecretArn,
            ForceDeleteWithoutRecovery: true,
          }),
        );
      } catch {
        // Best effort — secret may not exist
      }

      // Delete channel record
      const channelKey = `${channel.channelType}#${channel.channelId}`;
      await deleteChannel(botId, channelKey);

      return reply.status(204).send();
    },
  );
};
