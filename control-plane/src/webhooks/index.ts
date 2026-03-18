// ClawBot Cloud — Webhook Route Registry
// Registers all channel webhook handlers under /webhook/

import type { FastifyPluginAsync } from 'fastify';
import { telegramWebhook } from './telegram.js';
import { discordWebhook } from './discord.js';
import { slackWebhook } from './slack.js';
import { whatsappWebhook } from './whatsapp.js';
import { feishuWebhook } from './feishu.js';

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  await app.register(telegramWebhook, { prefix: '/telegram' });
  await app.register(discordWebhook, { prefix: '/discord' });
  await app.register(slackWebhook, { prefix: '/slack' });
  await app.register(whatsappWebhook, { prefix: '/whatsapp' });
  await app.register(feishuWebhook, { prefix: '/feishu' });
};
