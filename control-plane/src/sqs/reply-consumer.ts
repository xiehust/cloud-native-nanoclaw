// ClawBot Cloud — Reply Queue Consumer
// Long-polls the SQS standard reply queue for agent replies
// Routes replies back to the originating channel

import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { config } from '../config.js';
import { getChannelsByBot } from '../services/dynamo.js';
import { getChannelCredentials } from '../services/cached-lookups.js';
import { sendChannelMessage } from '../channels/index.js';
import type { SqsReplyPayload } from '@clawbot/shared';
import type { Logger } from 'pino';

let running = false;

export function startReplyConsumer(logger: Logger): void {
  if (!config.queues.replies) {
    logger.warn('SQS_REPLIES_URL not set, reply consumer disabled');
    return;
  }
  running = true;
  replyLoop(logger).catch((err) =>
    logger.error(err, 'Reply consumer crashed'),
  );
}

export function stopReplyConsumer(): void {
  running = false;
}

async function replyLoop(logger: Logger): Promise<void> {
  const sqs = new SQSClient({ region: config.region });

  logger.info({ queueUrl: config.queues.replies }, 'Reply consumer started');

  while (running) {
    try {
      const result = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: config.queues.replies,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 20,
          VisibilityTimeout: 60,
        }),
      );

      if (!result.Messages || result.Messages.length === 0) {
        continue;
      }

      for (const msg of result.Messages) {
        try {
          const payload: SqsReplyPayload = JSON.parse(msg.Body!);

          // Load channel config for the bot
          const channels = await getChannelsByBot(payload.botId);
          const channel = channels.find(
            (ch) => ch.channelType === payload.channelType,
          );

          if (!channel) {
            logger.warn(
              { botId: payload.botId, channelType: payload.channelType },
              'No channel configured for reply',
            );
            // Delete the message anyway to avoid infinite retries
            await sqs.send(
              new DeleteMessageCommand({
                QueueUrl: config.queues.replies,
                ReceiptHandle: msg.ReceiptHandle!,
              }),
            );
            continue;
          }

          // Load credentials
          const creds = await getChannelCredentials(channel.credentialSecretArn);

          // Extract chatId from groupJid
          const chatId = payload.groupJid.split(':')[1];
          if (!chatId) {
            logger.error(
              { groupJid: payload.groupJid },
              'Could not extract chatId from groupJid',
            );
            await sqs.send(
              new DeleteMessageCommand({
                QueueUrl: config.queues.replies,
                ReceiptHandle: msg.ReceiptHandle!,
              }),
            );
            continue;
          }

          // Send reply via channel API
          await sendChannelMessage(
            payload.channelType,
            creds,
            chatId,
            payload.text,
          );

          // Delete message on success
          await sqs.send(
            new DeleteMessageCommand({
              QueueUrl: config.queues.replies,
              ReceiptHandle: msg.ReceiptHandle!,
            }),
          );

          logger.info(
            {
              botId: payload.botId,
              groupJid: payload.groupJid,
              channelType: payload.channelType,
            },
            'Reply delivered via channel',
          );
        } catch (err) {
          logger.error(
            { err, messageId: msg.MessageId },
            'Failed to process reply message',
          );
          // Don't delete — let visibility timeout return it to queue for retry
        }
      }
    } catch (err) {
      logger.error(err, 'Reply consumer receive error');
      if (running) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  logger.info('Reply consumer stopped');
}
