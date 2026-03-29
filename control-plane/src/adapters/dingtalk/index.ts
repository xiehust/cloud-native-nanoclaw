// DingTalk Channel Adapter
// Manages DingTalk Stream (WebSocket) gateway connections for inbound messages.
// Uses DingTalk REST API for outbound replies, with sessionWebhook fast-path.
// No leader election — all instances connect independently.
// SQS FIFO MessageDeduplicationId suppresses duplicate messages.

import { BaseChannelAdapter } from '../base.js';
import type { ReplyContext, ReplyOptions } from '@clawbot/shared/channel-adapter';
import {
  getAccessToken,
  sendMarkdownMessage,
  replyGroupMarkdownMessage,
  uploadMedia,
  sendMediaMessage,
} from '../../channels/dingtalk.js';
import {
  type DingTalkGatewayManager,
  initDingTalkGatewayManager,
} from '../../dingtalk/gateway-manager.js';
import { getChannelsByBot, getRecentMessages } from '../../services/dynamo.js';
import { getChannelCredentials } from '../../services/cached-lookups.js';

// ── Constants ────────────────────────────────────────────────────────────────

const DINGTALK_MAX_CHARS = 4000;
const DINGTALK_WEBHOOK_URL_PREFIX = 'https://oapi.dingtalk.com/';

// ── Helper: DingTalk sessionWebhook allows direct reply without API token ──

async function sendViaSessionWebhook(
  webhookUrl: string,
  text: string,
): Promise<void> {
  // Validate URL to prevent SSRF
  if (!webhookUrl.startsWith(DINGTALK_WEBHOOK_URL_PREFIX)) {
    throw new Error(`Invalid session webhook URL: must start with ${DINGTALK_WEBHOOK_URL_PREFIX}`);
  }

  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'markdown',
      markdown: { title: 'Reply', text },
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '(could not read body)');
    throw new Error(`Session webhook failed: ${resp.status} ${resp.statusText} — ${body}`);
  }
  // DingTalk webhook API returns HTTP 200 even on failure — check errcode in body
  const body = await resp.json().catch(() => ({})) as { errcode?: number; errmsg?: string };
  if (body.errcode && body.errcode !== 0) {
    throw new Error(`Session webhook errcode ${body.errcode}: ${body.errmsg || 'unknown error'}`);
  }
}

// ── Message Chunking ─────────────────────────────────────────────────────────

/**
 * Split text into chunks of up to maxLen characters.
 * Avoids splitting in the middle of fenced code blocks (``` ... ```).
 * Falls back to splitting at newlines, then at spaces, then hard-cut.
 */
function chunkMarkdownText(text: string, maxLen = DINGTALK_MAX_CHARS): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = maxLen;

    // Check if we would split inside a fenced code block.
    const candidate = remaining.slice(0, splitAt);
    const fenceMatches = candidate.match(/```/g);
    const fenceCount = fenceMatches ? fenceMatches.length : 0;

    if (fenceCount % 2 !== 0) {
      // We are inside a code block — find the opening ``` and split before it
      const lastFenceIdx = candidate.lastIndexOf('```');
      if (lastFenceIdx > 0) {
        const beforeFence = candidate.slice(0, lastFenceIdx);
        const newlineIdx = beforeFence.lastIndexOf('\n');
        splitAt = newlineIdx > 0 ? newlineIdx : lastFenceIdx;
      }
    }

    // If splitAt is still at maxLen, try to split at a natural boundary
    if (splitAt === maxLen) {
      const segment = remaining.slice(0, splitAt);
      const newlineIdx = segment.lastIndexOf('\n');
      if (newlineIdx > maxLen * 0.3) {
        splitAt = newlineIdx;
      } else {
        const spaceIdx = segment.lastIndexOf(' ');
        if (spaceIdx > maxLen * 0.3) {
          splitAt = spaceIdx;
        }
      }
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class DingTalkAdapter extends BaseChannelAdapter {
  readonly channelType = 'dingtalk';
  private gateway: DingTalkGatewayManager | null = null;

  private stopped = false;

  constructor(parentLogger: import('pino').Logger) {
    super(parentLogger);
    this.init();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.stopped = false;

    // Initialize the singleton gateway manager and connect all bots directly.
    // No leader election — every instance connects independently.
    // SQS FIFO MessageDeduplicationId handles duplicate message suppression.
    this.gateway = initDingTalkGatewayManager(this.logger);

    try {
      await this.gateway.start();
      this.logger.info('DingTalk gateway started (all instances connect independently)');
    } catch (err) {
      this.logger.error(err, 'Failed to start DingTalk gateway');
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.gateway) {
      await this.gateway.stopAll();
    }
  }

  // Leader election removed — all instances connect independently.
  // SQS FIFO MessageDeduplicationId (messageId) suppresses duplicate messages.

  // ── Helpers ────────────────────────────────────────────────────────────

  /**
   * Recover dingtalkSenderStaffId when missing from ReplyContext.
   * SQS reply path doesn't include channel-specific replyContext fields,
   * so we look up the most recent inbound message to get the sender.
   */
  private async recoverSenderStaffId(ctx: ReplyContext): Promise<string | undefined> {
    if (ctx.dingtalkSenderStaffId) return ctx.dingtalkSenderStaffId;

    const isGroup = ctx.dingtalkIsGroup ?? false;
    if (isGroup) return undefined; // groups don't need staffId

    try {
      const msgs = await getRecentMessages(ctx.botId, ctx.groupJid, 5);
      const inbound = msgs.find((m) => !m.isFromMe && m.sender);
      if (inbound) {
        this.logger.info(
          { botId: ctx.botId, senderStaffId: inbound.sender },
          'Recovered senderStaffId from recent messages',
        );
        return inbound.sender;
      }
    } catch (err) {
      this.logger.warn({ err, botId: ctx.botId }, 'Failed to recover senderStaffId');
    }
    return undefined;
  }

  // ── Credential Loading ─────────────────────────────────────────────────

  /**
   * Load DingTalk credentials and access token for a bot.
   * Shared by sendReply and sendFile to avoid duplication.
   */
  private async loadCredentials(botId: string): Promise<{
    token: string;
    robotCode: string;
    clientId: string;
    clientSecret: string;
  } | null> {
    const channels = await getChannelsByBot(botId);
    const channel = channels.find((ch) => ch.channelType === 'dingtalk');
    if (!channel) {
      this.logger.warn({ botId }, 'No DingTalk channel configured for bot');
      return null;
    }

    const creds = await getChannelCredentials(channel.credentialSecretArn);
    const clientId = creds.clientId;
    const clientSecret = creds.clientSecret;

    if (!clientId || !clientSecret) {
      this.logger.error({ botId }, 'Missing clientId or clientSecret in DingTalk credentials');
      return null;
    }

    const token = await getAccessToken(clientId, clientSecret);
    return { token, robotCode: clientId, clientId, clientSecret };
  }

  // ── Send Reply ──────────────────────────────────────────────────────────

  async sendReply(
    ctx: ReplyContext,
    text: string,
    _opts?: ReplyOptions,
  ): Promise<void> {
    try {
      const cred = await this.loadCredentials(ctx.botId);
      if (!cred) return;
      const { token, robotCode } = cred;

      // Determine conversation ID and message type
      const conversationId =
        ctx.dingtalkConversationId || ctx.groupJid.replace(/^dt:/, '');
      const isGroup = ctx.dingtalkIsGroup ?? false;

      // Recover senderStaffId if missing (SQS reply path)
      const senderStaffId = await this.recoverSenderStaffId(ctx);

      // Split long messages into chunks
      const chunks = chunkMarkdownText(text);

      for (const chunk of chunks) {
        // Try sessionWebhook first (fastest path for group replies)
        if (isGroup && ctx.dingtalkSessionWebhook) {
          try {
            await sendViaSessionWebhook(ctx.dingtalkSessionWebhook, chunk);
            this.logger.info(
              { botId: ctx.botId, groupJid: ctx.groupJid },
              'DingTalk reply sent via session webhook',
            );
            continue;
          } catch (err) {
            this.logger.warn(
              { err, botId: ctx.botId },
              'DingTalk session webhook failed, falling back to API',
            );
            // Fall through to API path
          }
        }

        // Send via DingTalk API (Markdown format preferred)
        if (isGroup) {
          await replyGroupMarkdownMessage(
            token,
            conversationId,
            'Reply',
            chunk,
            robotCode,
          );
        } else {
          // DM: oToMessages/batchSend requires userIds, not conversationId
          if (!senderStaffId) {
            this.logger.error(
              { botId: ctx.botId, groupJid: ctx.groupJid },
              'Missing dingtalkSenderStaffId for DM reply, cannot send',
            );
            continue;
          }
          await sendMarkdownMessage(
            token,
            [senderStaffId],
            'Reply',
            chunk,
            robotCode,
          );
        }

        this.logger.info(
          { botId: ctx.botId, groupJid: ctx.groupJid, isGroup, path: 'api' },
          'DingTalk reply sent via API',
        );
      }
    } catch (err) {
      this.logger.error(
        { err, botId: ctx.botId, groupJid: ctx.groupJid },
        'Failed to send DingTalk reply',
      );
    }
  }

  // ── Send File ──────────────────────────────────────────────────────────

  async sendFile(
    ctx: ReplyContext,
    file: Buffer,
    fileName: string,
    mimeType: string,
    caption?: string,
  ): Promise<void> {
    try {
      const cred = await this.loadCredentials(ctx.botId);
      if (!cred) return;
      const { token, robotCode, clientId, clientSecret } = cred;

      // Determine media type from MIME
      const mediaType: 'image' | 'file' | 'audio' | 'video' =
        mimeType.startsWith('image/') ? 'image'
        : mimeType.startsWith('audio/') ? 'audio'
        : mimeType.startsWith('video/') ? 'video'
        : 'file';

      const msgKey: 'sampleFile' | 'sampleImageMsg' | 'sampleAudio' | 'sampleVideo' =
        mediaType === 'image' ? 'sampleImageMsg'
        : mediaType === 'audio' ? 'sampleAudio'
        : mediaType === 'video' ? 'sampleVideo'
        : 'sampleFile';

      // Upload file to DingTalk (uses old oapi.dingtalk.com endpoint)
      const mediaId = await uploadMedia(clientId, clientSecret, file, fileName, mediaType);

      // Send media message
      const isGroup = ctx.dingtalkIsGroup ?? false;
      const senderStaffId = await this.recoverSenderStaffId(ctx);

      const conversationId = ctx.dingtalkConversationId || ctx.groupJid.replace(/^dt:/, '');
      const target = isGroup
        ? { openConversationId: conversationId }
        : { userIds: senderStaffId ? [senderStaffId] : undefined };

      if (!target.userIds && !target.openConversationId) {
        this.logger.error({ botId: ctx.botId, groupJid: ctx.groupJid }, 'Missing target for DingTalk sendFile');
        return;
      }

      await sendMediaMessage(token, target as { userIds?: string[]; openConversationId?: string }, mediaId, msgKey, robotCode, fileName);

      this.logger.info(
        { botId: ctx.botId, groupJid: ctx.groupJid, fileName, mediaType },
        'DingTalk file sent',
      );

      // Send caption as a separate text message if provided
      if (caption) {
        await this.sendReply(ctx, caption);
      }
    } catch (err) {
      this.logger.error(
        { err, botId: ctx.botId, groupJid: ctx.groupJid, fileName },
        'Failed to send file via DingTalk',
      );
    }
  }
}
