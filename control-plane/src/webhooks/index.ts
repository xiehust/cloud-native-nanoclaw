// ClawBot Cloud — Webhook Route Registry
// Registers all channel webhook handlers under /webhook/

import type { FastifyPluginAsync } from 'fastify';
import { telegramWebhook } from './telegram.js';
import { discordWebhook } from './discord.js';
import { slackWebhook } from './slack.js';

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  await app.register(telegramWebhook, { prefix: '/telegram' });
  await app.register(discordWebhook, { prefix: '/discord' });
  await app.register(slackWebhook, { prefix: '/slack' });
};
