// ClawBot Cloud — Discord Webhook Handler
// Handles Discord Interactions Endpoint (ping verification only).
// Regular messages are received via the Gateway connection in discord/gateway-manager.ts.

import type { FastifyPluginAsync } from 'fastify';
import { getChannelsByBot, updateChannelHealth } from '../services/dynamo.js';
import { getChannelCredentials } from '../services/cached-lookups.js';
import { verifyDiscordSignature } from './signature.js';

const INTERACTION_PING = 1;
const INTERACTION_APPLICATION_COMMAND = 2;

interface DiscordInteraction {
  type: number;
  id: string;
  token?: string;
  data?: Record<string, unknown>;
}

export const discordWebhook: FastifyPluginAsync = async (app) => {
  // Raw body parser for Ed25519 signature verification
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      req.rawBody = body as string;
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.post<{ Params: { botId: string } }>(
    '/:botId',
    async (request, reply) => {
      const { botId } = request.params;
      const body = request.body as DiscordInteraction;
      const logger = request.log;

      try {
        // 1. Verify Ed25519 signature for ALL interactions (including PING)
        const channels = await getChannelsByBot(botId);
        const discordChannel = channels.find(
          (ch) => ch.channelType === 'discord',
        );
        if (!discordChannel) {
          logger.warn({ botId }, 'No Discord channel configured for bot');
          return reply.status(404).send({ error: 'Channel not found' });
        }

        const creds = await getChannelCredentials(
          discordChannel.credentialSecretArn,
        );
        if (!creds.publicKey) {
          logger.error({ botId }, 'Discord public key not configured — rejecting request');
          return reply.status(500).send({ error: 'Webhook not properly configured' });
        }

        const rawBody = request.rawBody ?? JSON.stringify(request.body);
        const valid = await verifyDiscordSignature(
          request.headers as Record<string, string | undefined>,
          rawBody,
          creds.publicKey,
        );
        if (!valid) {
          return reply.status(401).send({ error: 'Invalid signature' });
        }

        // 2. PING — Discord verification handshake (signature already verified)
        if (body.type === INTERACTION_PING) {
          logger.info({ botId }, 'Discord PING received, responding with PONG');

          const channelKey = `${discordChannel.channelType}#${discordChannel.channelId}`;
          await updateChannelHealth(
            botId,
            channelKey,
            'healthy',
            0,
            'connected',
          );

          return reply.status(200).send({ type: 1 }); // PONG
        }

        // 3. Application commands — acknowledge only
        if (body.type === INTERACTION_APPLICATION_COMMAND) {
          return reply.status(200).send({
            type: 4,
            data: { content: 'Command received.' },
          });
        }

        return reply.status(200).send({ ok: true });
      } catch (err) {
        logger.error(err, 'Error processing Discord webhook');
        return reply.status(200).send({ ok: true });
      }
    },
  );
};
