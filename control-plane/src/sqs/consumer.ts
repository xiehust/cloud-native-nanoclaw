// ClawBot Cloud — SQS FIFO Consumer
// Long-polls the inbound message queue and dispatches to agent processing

import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { config } from '../config.js';
import { dispatch } from './dispatcher.js';
import type { Logger } from 'pino';

let running = false;

export function startSqsConsumer(logger: Logger): void {
  if (!config.queues.messages) {
    logger.warn('SQS_MESSAGES_URL not set, SQS consumer disabled');
    return;
  }
  running = true;
  consumeLoop(logger).catch((err) =>
    logger.error(err, 'SQS consumer crashed'),
  );
}

export function stopSqsConsumer(): void {
  running = false;
}

// Simple counting semaphore for concurrency control
class Semaphore {
  private count: number;
  private readonly max: number;
  private waitQueue: Array<() => void> = [];

  constructor(max: number) {
    this.max = max;
    this.count = 0;
  }

  async acquire(): Promise<void> {
    if (this.count < this.max) {
      this.count++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(() => {
        this.count++;
        resolve();
      });
    });
  }

  release(): void {
    this.count--;
    const next = this.waitQueue.shift();
    if (next) next();
  }
}

async function consumeLoop(logger: Logger): Promise<void> {
  const sqs = new SQSClient({ region: config.region });
  const semaphore = new Semaphore(config.maxConcurrentDispatches);

  logger.info(
    { queueUrl: config.queues.messages, maxConcurrent: config.maxConcurrentDispatches },
    'SQS consumer started',
  );

  while (running) {
    try {
      const result = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: config.queues.messages,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 20, // Long-poll
          VisibilityTimeout: 600,
        }),
      );

      if (!result.Messages || result.Messages.length === 0) {
        continue;
      }

      for (const msg of result.Messages) {
        await semaphore.acquire();

        // Fire-and-forget dispatch with cleanup
        dispatch(msg, logger)
          .then(async () => {
            // Delete message on success
            await sqs.send(
              new DeleteMessageCommand({
                QueueUrl: config.queues.messages,
                ReceiptHandle: msg.ReceiptHandle!,
              }),
            );
          })
          .catch((err) => {
            logger.error(
              { err, messageId: msg.MessageId },
              'Dispatch failed, message will return to queue after visibility timeout',
            );
          })
          .finally(() => {
            semaphore.release();
          });
      }
    } catch (err) {
      logger.error(err, 'SQS receive error');
      // Back off on receive errors to avoid tight error loops
      if (running) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  logger.info('SQS consumer stopped');
}
