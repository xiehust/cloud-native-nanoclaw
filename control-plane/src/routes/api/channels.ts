// ClawBot Cloud — Channels API Routes
// CRUD operations for channel management (BYOK credentials)

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  SecretsManagerClient,
  CreateSecretCommand,
  DeleteSecretCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { config } from '../../config.js';
import {
  getBot,
  updateBot,
  createChannel,
  getChannelsByBot,
  deleteChannel,
  updateChannelHealth,
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

    // 2. Generate webhook secret upfront (for Telegram) so it can be persisted
    const webhookSecret =
      body.channelType === 'telegram' ? crypto.randomUUID() : undefined;

    // 3. Store credentials in Secrets Manager (including webhookSecret for Telegram)
    const secretName = `clawbot/${config.stage}/${botId}/${body.channelType}`;
    const secretResult = await secrets.send(
      new CreateSecretCommand({
        Name: secretName,
        SecretString: JSON.stringify({
          ...body.credentials,
          ...verifiedInfo,
          ...(webhookSecret ? { webhookSecret } : {}),
        }),
        Description: `ClawBot ${body.channelType} credentials for bot ${botId}`,
      }),
    );

    // 4. Determine channel ID from verified info
    const channelId =
      verifiedInfo.botId ||
      verifiedInfo.applicationId ||
      verifiedInfo.botUserId ||
      'default';

    // 5. Build webhook URL
    const webhookBase =
      config.webhookBaseUrl || `https://${config.stage}.clawbot.ai`;
    const webhookUrl = `${webhookBase}/webhook/${body.channelType}/${botId}`;

    // 6. Register webhook with channel provider
    let webhookRegistered = false;
    let setupInstructions: string | undefined;

    if (body.channelType === 'telegram') {
      await telegram.setWebhook(
        body.credentials.botToken,
        webhookUrl,
        webhookSecret!,
      );
      webhookRegistered = true;
    } else {
      // Discord, Slack, WhatsApp require manual webhook configuration
      const instructions: Record<string, string> = {
        discord: `Go to Discord Developer Portal > Application > "Interactions Endpoint URL" and set it to: ${webhookUrl}`,
        slack: `Go to Slack App settings > "Event Subscriptions" > "Request URL" and set it to: ${webhookUrl}`,
        whatsapp: `Go to Meta Developer Portal > WhatsApp > Configuration > "Callback URL" and set it to: ${webhookUrl}`,
      };
      setupInstructions = instructions[body.channelType];
    }

    // 7. Create channel record
    const channel: ChannelConfig = {
      botId,
      channelType: body.channelType,
      channelId,
      credentialSecretArn: secretResult.ARN || secretName,
      webhookUrl,
      status: webhookRegistered ? 'connected' : 'pending_webhook',
      healthStatus: 'healthy',
      consecutiveFailures: 0,
      config: verifiedInfo,
      createdAt: new Date().toISOString(),
    };

    await createChannel(channel);

    // Auto-activate bot when first channel is connected
    if (bot.status === 'created') {
      await updateBot(request.userId, botId, { status: 'active' });
    }

    return reply.status(201).send({
      ...channel,
      credentialSecretArn: '[redacted]',
      ...(setupInstructions ? { setupInstructions } : {}),
    });
  });

  // Test channel credentials
  app.post<{ Params: { botId: string; channelKey: string } }>(
    '/:channelKey/test',
    async (request, reply) => {
      const { botId, channelKey } = request.params;

      // Verify bot ownership
      const bot = await getBot(request.userId, botId);
      if (!bot || bot.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      const channels = await getChannelsByBot(botId);
      const decodedKey = decodeURIComponent(channelKey);
      const channel = channels.find(
        (ch) => `${ch.channelType}#${ch.channelId}` === decodedKey,
      );
      if (!channel) {
        return reply.status(404).send({ error: 'Channel not found' });
      }

      try {
        const creds = await getChannelCredentials(channel.credentialSecretArn);
        await verifyChannelCredentials(channel.channelType, creds);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
  );

  // Update channel credentials
  app.put<{ Params: { botId: string; channelKey: string } }>(
    '/:channelKey',
    async (request, reply) => {
      const { botId, channelKey } = request.params;

      // Verify bot ownership
      const bot = await getBot(request.userId, botId);
      if (!bot || bot.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      // Find the existing channel
      const channels = await getChannelsByBot(botId);
      const decodedKey = decodeURIComponent(channelKey);
      const channel = channels.find(
        (ch) => `${ch.channelType}#${ch.channelId}` === decodedKey,
      );
      if (!channel) {
        return reply.status(404).send({ error: 'Channel not found' });
      }

      const body = z
        .object({ credentials: z.record(z.string(), z.string()) })
        .parse(request.body);

      // 1. Validate new credentials
      let verifiedInfo: Record<string, string>;
      try {
        verifiedInfo = await verifyChannelCredentials(
          channel.channelType,
          body.credentials,
        );
      } catch (err) {
        return reply.status(400).send({
          error: `Failed to verify ${channel.channelType} credentials: ${(err as Error).message}`,
        });
      }

      // 2. Generate new webhook secret for Telegram
      const webhookSecret =
        channel.channelType === 'telegram' ? crypto.randomUUID() : undefined;

      // 3. Update the secret in Secrets Manager
      await secrets.send(
        new PutSecretValueCommand({
          SecretId: channel.credentialSecretArn,
          SecretString: JSON.stringify({
            ...body.credentials,
            ...verifiedInfo,
            ...(webhookSecret ? { webhookSecret } : {}),
          }),
        }),
      );

      // 4. Re-register webhook for Telegram
      if (channel.channelType === 'telegram') {
        await telegram.setWebhook(
          body.credentials.botToken,
          channel.webhookUrl,
          webhookSecret!,
        );
      }

      // 5. Reset health status
      await updateChannelHealth(botId, decodedKey, 'healthy', 0);

      return {
        ...channel,
        healthStatus: 'healthy',
        consecutiveFailures: 0,
        credentialSecretArn: '[redacted]',
      };
    },
  );

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
      } catch (err) {
        request.log.warn(
          { err, botId, channelType },
          'Failed to unregister webhook — proceeding with channel deletion',
        );
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
