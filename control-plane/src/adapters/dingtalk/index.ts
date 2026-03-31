// DingTalk Channel Adapter
// Manages DingTalk Stream (WebSocket) gateway connections for inbound messages.
// Uses DingTalk REST API for outbound replies, with sessionWebhook fast-path.
// Leader election via DynamoDB distributed lock — only one ECS task maintains
// WebSocket connections, matching Discord and Feishu adapter patterns.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
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
import { getChannelsByBot, getRecentMessages, getGroup } from '../../services/dynamo.js';
import { getChannelCredentials } from '../../services/cached-lookups.js';
import { config } from '../../config.js';

// ── Leader Election Constants ─────────────────────────────────────────────────

const LOCK_TABLE = config.tables.sessions;
const LOCK_PK = '__system__';
const LOCK_SK = 'dingtalk-gateway-leader';
const LOCK_TTL_S = 30;
const RENEW_INTERVAL_MS = 15_000;
const POLL_INTERVAL_MS = 15_000;
const POLL_INITIAL_DELAY_MS = 5_000;

const INSTANCE_ID =
  process.env.ECS_TASK_ID ||
  `local-${process.pid}-${Date.now().toString(36)}`;

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: config.region }),
);

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

  private isLeader = false;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private initialPollTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(parentLogger: import('pino').Logger) {
    super(parentLogger);
    this.init();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.stopped = false;

    // Initialize the singleton gateway manager (pure connection management, no leader logic)
    this.gateway = initDingTalkGatewayManager(this.logger);

    // Leader election: only one ECS task maintains WebSocket connections.
    // Matches Discord and Feishu adapter patterns.
    const acquired = await this.tryAcquireLock();
    if (acquired) {
      await this.becomeLeader();
    } else {
      this.logger.info('DingTalk: another instance is leader, entering standby');
      this.gateway.markStopped();
      this.startStandbyPoll();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;

    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.initialPollTimer) {
      clearTimeout(this.initialPollTimer);
      this.initialPollTimer = null;
    }

    if (this.gateway) {
      await this.gateway.stopAll();
    }

    if (this.isLeader) {
      await this.releaseLock();
      this.isLeader = false;
    }
  }

  // ── Leader Election ─────────────────────────────────────────────────────

  private async tryAcquireLock(): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    try {
      await ddb.send(
        new PutCommand({
          TableName: LOCK_TABLE,
          Item: {
            pk: LOCK_PK,
            sk: LOCK_SK,
            leaderId: INSTANCE_ID,
            expiresAt: now + LOCK_TTL_S,
          },
          ConditionExpression:
            'attribute_not_exists(pk) OR expiresAt < :now',
          ExpressionAttributeValues: { ':now': now },
        }),
      );
      this.logger.info({ instanceId: INSTANCE_ID }, 'DingTalk leader lock acquired');
      return true;
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        return false;
      }
      this.logger.error(err, 'Failed to acquire DingTalk leader lock');
      return false;
    }
  }

  private async renewLock(): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    try {
      await ddb.send(
        new PutCommand({
          TableName: LOCK_TABLE,
          Item: {
            pk: LOCK_PK,
            sk: LOCK_SK,
            leaderId: INSTANCE_ID,
            expiresAt: now + LOCK_TTL_S,
          },
          ConditionExpression: 'leaderId = :me',
          ExpressionAttributeValues: { ':me': INSTANCE_ID },
        }),
      );
      return true;
    } catch {
      this.logger.warn('Failed to renew DingTalk leader lock, stepping down');
      return false;
    }
  }

  private async releaseLock(): Promise<void> {
    try {
      await ddb.send(
        new DeleteCommand({
          TableName: LOCK_TABLE,
          Key: { pk: LOCK_PK, sk: LOCK_SK },
          ConditionExpression: 'leaderId = :me',
          ExpressionAttributeValues: { ':me': INSTANCE_ID },
        }),
      );
      this.logger.info('DingTalk leader lock released');
    } catch {
      // Already expired or taken
    }
  }

  private async isLockExpired(): Promise<boolean> {
    try {
      const res = await ddb.send(
        new GetCommand({
          TableName: LOCK_TABLE,
          Key: { pk: LOCK_PK, sk: LOCK_SK },
        }),
      );
      if (!res.Item) return true;
      return (res.Item.expiresAt as number) < Math.floor(Date.now() / 1000);
    } catch {
      return true;
    }
  }

  // ── Leader Lifecycle ────────────────────────────────────────────────────

  private async becomeLeader(): Promise<void> {
    this.isLeader = true;
    this.logger.info('DingTalk: became leader, starting gateway connections');

    try {
      this.gateway!.resetStopped();
      await this.gateway!.start();
    } catch (err) {
      this.logger.error(err, 'Failed to start DingTalk gateway');
      this.isLeader = false;
      await this.releaseLock();
      return;
    }

    this.startRenewLoop();
  }

  private startRenewLoop(): void {
    this.renewTimer = setInterval(async () => {
      if (this.stopped) return;
      const ok = await this.renewLock();
      if (!ok) {
        this.logger.warn('Lost DingTalk leader lock, stopping gateway');
        if (this.gateway) {
          await this.gateway.stopAll();
        }
        this.isLeader = false;
        if (!this.stopped) {
          this.startStandbyPoll();
        }
      }
    }, RENEW_INTERVAL_MS);
  }

  private startStandbyPoll(): void {
    const poll = async () => {
      if (this.stopped) return;
      const expired = await this.isLockExpired();
      if (expired) {
        this.logger.info('DingTalk leader lock expired, attempting takeover');
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
        const acquired = await this.tryAcquireLock();
        if (acquired) {
          await this.becomeLeader();
        } else {
          this.startStandbyPoll();
        }
      }
    };
    // First check quickly (covers rolling update where old leader just died)
    this.initialPollTimer = setTimeout(poll, POLL_INITIAL_DELAY_MS);
    // Then regular interval
    this.pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /**
   * Resolve whether this context is a group chat.
   * SQS reply path doesn't include dingtalkIsGroup, so we look up the Group record.
   */
  private async resolveIsGroup(ctx: ReplyContext): Promise<boolean> {
    if (ctx.dingtalkIsGroup !== undefined) return ctx.dingtalkIsGroup;

    try {
      const group = await getGroup(ctx.botId, ctx.groupJid);
      if (group) {
        this.logger.info({ botId: ctx.botId, groupJid: ctx.groupJid, isGroup: group.isGroup }, 'Resolved isGroup from DynamoDB Group record');
        return group.isGroup;
      }
      this.logger.warn({ botId: ctx.botId, groupJid: ctx.groupJid }, 'Group record not found in DynamoDB, defaulting to DM');
    } catch (err) {
      this.logger.warn({ err, botId: ctx.botId, groupJid: ctx.groupJid }, 'Failed to look up group for isGroup');
    }
    return false; // default to DM if unknown
  }

  /**
   * Recover dingtalkSenderStaffId when missing from ReplyContext.
   * SQS reply path doesn't include channel-specific replyContext fields,
   * so we look up the most recent inbound message to get the sender.
   */
  private async recoverSenderStaffId(ctx: ReplyContext, isGroup: boolean): Promise<string | undefined> {
    if (ctx.dingtalkSenderStaffId) return ctx.dingtalkSenderStaffId;

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
      const isGroup = await this.resolveIsGroup(ctx);

      // Recover senderStaffId if missing (SQS reply path)
      const senderStaffId = await this.recoverSenderStaffId(ctx, isGroup);

      // Log the full reply decision context for debugging routing issues
      // (e.g. group messages accidentally sent as DM)
      this.logger.debug(
        {
          botId: ctx.botId,
          groupJid: ctx.groupJid,
          isGroup,
          isGroupSource: ctx.dingtalkIsGroup !== undefined ? 'ctx' : 'dynamodb',
          hasSessionWebhook: !!ctx.dingtalkSessionWebhook,
          hasSenderStaffId: !!senderStaffId,
          conversationId,
          textLength: text.length,
        },
        'DingTalk sendReply decision context',
      );

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
      const isGroup = await this.resolveIsGroup(ctx);
      const conversationId = ctx.dingtalkConversationId || ctx.groupJid.replace(/^dt:/, '');

      this.logger.debug(
        {
          botId: ctx.botId, groupJid: ctx.groupJid, isGroup,
          isGroupSource: ctx.dingtalkIsGroup !== undefined ? 'ctx' : 'dynamodb',
          fileName, mediaType, mediaId,
        },
        'DingTalk sendFile decision context',
      );

      if (isGroup) {
        await sendMediaMessage(token, { openConversationId: conversationId }, mediaId, msgKey, robotCode, fileName);
      } else {
        const senderStaffId = await this.recoverSenderStaffId(ctx, false);
        if (!senderStaffId) {
          this.logger.error({ botId: ctx.botId, groupJid: ctx.groupJid }, 'Missing senderStaffId for DM sendFile, cannot send');
          return;
        }
        await sendMediaMessage(token, { userIds: [senderStaffId] }, mediaId, msgKey, robotCode, fileName);
      }

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
