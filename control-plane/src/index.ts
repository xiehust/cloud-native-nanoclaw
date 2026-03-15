// ClawBot Cloud — Control Plane Entry Point
// Main Fastify application: webhooks, API routes, SQS consumers

import Fastify from 'fastify';
import cors from '@fastify/cors';
import pino from 'pino';
import { config } from './config.js';
import { healthRoutes } from './routes/health.js';
import { apiRoutes } from './routes/api/index.js';
import { webhookRoutes } from './webhooks/index.js';
import { startSqsConsumer, stopSqsConsumer } from './sqs/consumer.js';
import { startReplyConsumer, stopReplyConsumer } from './sqs/reply-consumer.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

async function main() {
  const app = Fastify({ logger });

  await app.register(cors, { origin: config.corsOrigin });
  await app.register(healthRoutes);
  await app.register(webhookRoutes, { prefix: '/webhook' });
  await app.register(apiRoutes, { prefix: '/api' });

  // Start background SQS consumers
  startSqsConsumer(logger);
  startReplyConsumer(logger);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    stopSqsConsumer();
    stopReplyConsumer();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port: config.port, host: '0.0.0.0' });
  logger.info(`Control plane listening on port ${config.port}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
