// ClawBot Cloud — Web Chat API Routes
// WebSocket-backed chat channel for the web console / embeddable widget.

import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { RawData } from 'ws';
import { config } from '../../config.js';
import {
  getBot,
  getOrCreateGroup,
  getRecentMessages,
  putMessage,
} from '../../services/dynamo.js';
import {
  registerWebSession,
  sendSessionEvent,
  unregisterWebSession,
} from '../../adapters/webchat/index.js';
import type { Attachment, Message, SqsInboundPayload } from '@clawbot/shared';
import { storeFromBuffer } from '../../services/attachments.js';

const sqs = new SQSClient({ region: config.region });

const attachmentSchema = z.object({
  type: z.enum(['image', 'audio', 'document', 'video']),
  s3Key: z.string(),
  mimeType: z.string(),
  fileName: z.string().optional(),
  size: z.number().optional(),
});

const inboundMessageSchema = z.object({
  type: z.literal('send_message'),
  content: z.string().min(1).max(10_000),
  clientMessageId: z.string().min(1).max(200).optional(),
  attachments: z.array(attachmentSchema).optional(),
});

function buildGroupJid(request: FastifyRequest): string {
  const key = request.integrationGroupKey;
  if (key && key.length > 0) {
    return `web:${key}`;
  }
  return `web:${request.userId}`;
}

function webSenderId(request: FastifyRequest): string {
  return request.integrationGroupKey
    ? `integration:${request.integrationGroupKey}`
    : request.userId;
}

function webSenderName(request: FastifyRequest): string {
  if (request.integrationGroupKey) {
    return `Integration:${request.integrationGroupKey}`;
  }
  return request.userEmail || 'User';
}

async function enqueueInboundMessage(payload: SqsInboundPayload): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: config.queues.messages,
      MessageBody: JSON.stringify(payload),
      MessageGroupId: `${payload.botId}#${payload.groupJid}`,
      MessageDeduplicationId: payload.messageId,
    }),
  );
}

export const webchatRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { botId: string }; Querystring: { limit?: string } }>(
    '/messages',
    async (request, reply) => {
      const { botId } = request.params;
      const bot = await getBot(request.userId, botId);
      if (!bot || bot.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      const limit = Math.min(Number(request.query.limit) || 100, 200);
      const groupJid = buildGroupJid(request);
      return getRecentMessages(botId, groupJid, limit);
    },
  );

  // REST enqueue (e.g. Ad-Platform HTTP chat) — same payload as WebSocket text messages
  app.post<{ Params: { botId: string }; Body: unknown }>(
    '/messages',
    async (request, reply) => {
      const { botId } = request.params;
      const bot = await getBot(request.userId, botId);
      if (!bot || bot.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      const groupJid = buildGroupJid(request);
      await getOrCreateGroup(
        botId,
        groupJid,
        webSenderName(request),
        'web',
        false,
      );

      let body: z.infer<typeof inboundMessageSchema>;
      try {
        body = inboundMessageSchema.parse(request.body);
      } catch (err) {
        return reply.status(400).send({
          error: err instanceof Error ? err.message : 'Invalid body',
        });
      }

      const now = new Date().toISOString();
      const messageId = body.clientMessageId || `web-user-${randomUUID()}`;
      const attachments = body.attachments as Attachment[] | undefined;

      const message: Message = {
        botId,
        groupJid,
        timestamp: now,
        messageId,
        sender: webSenderId(request),
        senderName: webSenderName(request),
        content: body.content,
        isFromMe: false,
        isBotMessage: false,
        channelType: 'web',
        ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
        attachments,
      };

      await putMessage(message);

      await enqueueInboundMessage({
        type: 'inbound_message',
        botId,
        groupJid,
        userId: bot.userId,
        messageId,
        content: body.content,
        channelType: 'web',
        timestamp: now,
        attachments,
      });

      return reply.status(202).send({ ok: true, messageId, groupJid });
    },
  );

  // Multipart upload → S3 attachment descriptor (for send_message.attachments)
  app.post<{ Params: { botId: string } }>(
    '/upload',
    async (request, reply) => {
      const { botId } = request.params;
      const bot = await getBot(request.userId, botId);
      if (!bot || bot.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      const file = await request.file();
      if (!file) {
        return reply.status(400).send({ error: 'file field required' });
      }

      const buf = await file.toBuffer();
      const messageId = `upload-${randomUUID()}`;
      const fileName = file.filename || 'upload.bin';
      const mimeType = file.mimetype || 'application/octet-stream';

      const ab = buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
      ) as ArrayBuffer;

      const att = await storeFromBuffer(
        bot.userId,
        botId,
        messageId,
        ab,
        fileName,
        mimeType,
      );
      if (!att) {
        return reply.status(400).send({ error: 'Failed to store attachment' });
      }

      return { attachment: att };
    },
  );

  app.get<{ Params: { botId: string } }>(
    '/ws',
    { websocket: true },
    async (socket, request) => {
      const { botId } = request.params as { botId: string };
      const bot = await getBot(request.userId, botId);

      if (!bot || bot.status === 'deleted') {
        socket.send(
          JSON.stringify({ type: 'error', error: 'Bot not found' }),
        );
        socket.close();
        return;
      }

      const groupJid = buildGroupJid(request);
      const sessionId = randomUUID();

      await getOrCreateGroup(
        botId,
        groupJid,
        webSenderName(request),
        'web',
        false,
      );

      registerWebSession({
        sessionId,
        botId,
        groupJid,
        userId: request.userId,
        userName: webSenderName(request),
        socket,
      });

      sendSessionEvent(sessionId, { type: 'connected', sessionId });
      sendSessionEvent(sessionId, {
        type: 'history',
        messages: await getRecentMessages(botId, groupJid, 100),
      });

      socket.on('message', async (raw: RawData) => {
        try {
          const body = inboundMessageSchema.parse(
            JSON.parse(raw.toString()),
          );
          const now = new Date().toISOString();
          const messageId = body.clientMessageId || `web-user-${randomUUID()}`;
          const attachments = body.attachments as Attachment[] | undefined;

          const message: Message = {
            botId,
            groupJid,
            timestamp: now,
            messageId,
            sender: webSenderId(request),
            senderName: webSenderName(request),
            content: body.content,
            isFromMe: false,
            isBotMessage: false,
            channelType: 'web',
            ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
            attachments,
          };

          await putMessage(message);
          sendSessionEvent(sessionId, { type: 'message', message });

          await enqueueInboundMessage({
            type: 'inbound_message',
            botId,
            groupJid,
            userId: bot.userId,
            messageId,
            content: body.content,
            channelType: 'web',
            timestamp: now,
            attachments,
            replyContext: { webSessionId: sessionId },
          });
        } catch (err) {
          request.log.warn({ err, botId, sessionId }, 'Invalid web socket message');
          sendSessionEvent(sessionId, {
            type: 'error',
            error: err instanceof Error ? err.message : 'Invalid websocket payload',
          });
        }
      });

      socket.on('close', () => {
        unregisterWebSession(sessionId);
      });

      socket.on('error', (err: Error) => {
        request.log.warn({ err, botId, sessionId }, 'Web socket connection error');
        unregisterWebSession(sessionId);
      });
    },
  );
};
