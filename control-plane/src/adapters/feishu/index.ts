// Feishu/Lark Channel Adapter
// Manages WebSocket-based Feishu Gateway connections with leader election.
// Uses Lark SDK WSClient for inbound messages, REST API for outbound replies.
// Sends card messages (markdown) with fallback to plain text.

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
  sendFeishuMessage,
  sendFeishuCardMessage,
  replyFeishuMessage,
  uploadFeishuFile,
  uploadFeishuImage,
  sendFeishuFileMessage,
  sendFeishuImageMessage,
  listFeishuReactions,
  removeFeishuReaction,
} from '../../channels/feishu.js';
import type { FeishuDomain } from '../../channels/feishu.js';
import { getChannelsByBot } from '../../services/dynamo.js';
import { getChannelCredentials } from '../../services/cached-lookups.js';
import { config } from '../../config.js';
import {
  type FeishuGatewayManager,
  initFeishuGatewayManager,
} from '../../feishu/gateway-manager.js';

// ── Leader Election Constants ─────────────────────────────────────────────────

const LOCK_TABLE = config.tables.sessions;
const LOCK_PK = '__system__';
const LOCK_SK = 'feishu-gateway-leader';
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

// ── Text Chunking ──────────────────────────────────────────────────────────

const FEISHU_MAX_CHARS = 4000;

/**
 * Split text into chunks of up to maxLen characters.
 * Avoids splitting in the middle of fenced code blocks (``` ... ```).
 * Falls back to splitting at newlines, then at spaces, then hard-cut.
 */
function chunkMarkdownText(text: string, maxLen = FEISHU_MAX_CHARS): string[] {
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
    // Count ``` occurrences in the candidate chunk.
    const candidate = remaining.slice(0, splitAt);
    const fenceMatches = candidate.match(/```/g);
    const fenceCount = fenceMatches ? fenceMatches.length : 0;

    if (fenceCount % 2 !== 0) {
      // We are inside a code block — find the opening ``` and split before it
      const lastFenceIdx = candidate.lastIndexOf('```');
      if (lastFenceIdx > 0) {
        // Try to split at a newline just before the code block
        const beforeFence = candidate.slice(0, lastFenceIdx);
        const newlineIdx = beforeFence.lastIndexOf('\n');
        splitAt = newlineIdx > 0 ? newlineIdx : lastFenceIdx;
      }
    }

    // If splitAt is still at maxLen, try to split at a natural boundary
    if (splitAt === maxLen) {
      const segment = remaining.slice(0, splitAt);
      // Prefer splitting at the last newline
      const newlineIdx = segment.lastIndexOf('\n');
      if (newlineIdx > maxLen * 0.3) {
        splitAt = newlineIdx;
      } else {
        // Try splitting at last space
        const spaceIdx = segment.lastIndexOf(' ');
        if (spaceIdx > maxLen * 0.3) {
          splitAt = spaceIdx;
        }
        // Otherwise hard-cut at maxLen
      }
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, ''); // trim leading newline from next chunk
  }

  return chunks;
}

// ── Card Builder ───────────────────────────────────────────────────────────

function buildCard(markdownContent: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'NanoClaw' },
      template: 'blue',
    },
    elements: [{ tag: 'markdown', content: markdownContent }],
  };
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class FeishuAdapter extends BaseChannelAdapter {
  readonly channelType = 'feishu';

  private isLeader = false;
  private gateway: FeishuGatewayManager | null = null;
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

    // Initialize the singleton gateway manager
    this.gateway = initFeishuGatewayManager(this.logger);

    const acquired = await this.tryAcquireLock();
    if (acquired) {
      await this.becomeLeader();
    } else {
      this.logger.info('Feishu: another instance is leader, entering standby');
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
      await this.gateway.stop();
    }

    if (this.isLeader) {
      await this.releaseLock();
      this.isLeader = false;
    }
  }

  // ── Leader Election ──────────────────────────────────────────────────────

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
      this.logger.info({ instanceId: INSTANCE_ID }, 'Feishu leader lock acquired');
      return true;
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        return false;
      }
      this.logger.error(err, 'Failed to acquire Feishu leader lock');
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
      this.logger.warn('Failed to renew Feishu leader lock, stepping down');
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
      this.logger.info('Feishu leader lock released');
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

  // ── Leader Lifecycle ─────────────────────────────────────────────────────

  private async becomeLeader(): Promise<void> {
    this.isLeader = true;

    this.logger.info('Feishu: became leader, starting gateway connections');

    try {
      await this.gateway!.start();
    } catch (err) {
      this.logger.error(err, 'Failed to start Feishu gateway');
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
        this.logger.warn('Lost Feishu leader lock, stopping gateway');
        if (this.gateway) {
          await this.gateway.stop();
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
        this.logger.info('Feishu leader lock expired, attempting takeover');
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

  async sendReply(
    ctx: ReplyContext,
    text: string,
    _opts?: ReplyOptions,
  ): Promise<void> {
    try {
      // Load channel config for this bot
      const channels = await getChannelsByBot(ctx.botId);
      const channel = channels.find((ch) => ch.channelType === 'feishu');
      if (!channel) {
        this.logger.warn(
          { botId: ctx.botId },
          'No Feishu channel configured for bot',
        );
        return;
      }

      // Load credentials from Secrets Manager (cached)
      const creds = await getChannelCredentials(channel.credentialSecretArn);
      const appId = creds.appId;
      const appSecret = creds.appSecret;
      const domain = (creds.domain as FeishuDomain) || 'feishu';

      if (!appId || !appSecret) {
        this.logger.error(
          { botId: ctx.botId },
          'Missing appId or appSecret in Feishu credentials',
        );
        return;
      }

      // Extract chat ID: prefer explicit feishuChatId, fall back to groupJid parsing
      const chatId =
        ctx.feishuChatId || ctx.groupJid.replace(/^feishu#/, '');
      if (!chatId) {
        this.logger.error(
          { groupJid: ctx.groupJid },
          'Could not extract chatId from groupJid',
        );
        return;
      }

      // Remove "OnIt" reaction on first reply (best-effort, don't block sending)
      if (ctx.feishuMessageId) {
        this.removeAckReaction(appId, appSecret, ctx.feishuMessageId, domain).catch((err) => {
          this.logger.warn({ err, messageId: ctx.feishuMessageId }, 'Failed to remove OnIt reaction');
        });
      }

      // Split long messages into chunks
      const chunks = chunkMarkdownText(text);

      for (const chunk of chunks) {
        // For group replies with a message ID, use reply API
        if (ctx.feishuMessageId) {
          try {
            await replyFeishuMessage(
              appId,
              appSecret,
              ctx.feishuMessageId,
              chunk,
              domain,
            );
            // Only reply to the first chunk; subsequent chunks are sent as new messages
            ctx = { ...ctx, feishuMessageId: undefined };
            continue;
          } catch (err) {
            this.logger.warn(
              { err, botId: ctx.botId },
              'Feishu reply failed, falling back to send',
            );
            // Fall through to send as new message
          }
        }

        // Try card message first, fall back to plain text
        try {
          const card = buildCard(chunk);
          await sendFeishuCardMessage(appId, appSecret, chatId, card, domain);
        } catch (cardErr) {
          this.logger.warn(
            { err: cardErr, botId: ctx.botId },
            'Feishu card message failed, falling back to plain text',
          );
          await sendFeishuMessage(appId, appSecret, chatId, chunk, domain);
        }
      }

      this.logger.info(
        { botId: ctx.botId, groupJid: ctx.groupJid, chunks: chunks.length },
        'Feishu reply sent',
      );
    } catch (err) {
      this.logger.error(
        { err, botId: ctx.botId, groupJid: ctx.groupJid },
        'Failed to send Feishu reply',
      );
    }
  }

  async sendFile(
    ctx: ReplyContext,
    file: Buffer,
    fileName: string,
    mimeType: string,
    caption?: string,
  ): Promise<void> {
    try {
      // Load channel config for this bot
      const channels = await getChannelsByBot(ctx.botId);
      const channel = channels.find((ch) => ch.channelType === 'feishu');
      if (!channel) {
        this.logger.warn(
          { botId: ctx.botId },
          'No Feishu channel configured for bot',
        );
        return;
      }

      const creds = await getChannelCredentials(channel.credentialSecretArn);
      const appId = creds.appId;
      const appSecret = creds.appSecret;
      const domain = (creds.domain as FeishuDomain) || 'feishu';

      if (!appId || !appSecret) {
        this.logger.error(
          { botId: ctx.botId },
          'Missing appId or appSecret in Feishu credentials',
        );
        return;
      }

      const chatId =
        ctx.feishuChatId || ctx.groupJid.replace(/^feishu#/, '');
      if (!chatId) {
        this.logger.error(
          { groupJid: ctx.groupJid },
          'Could not extract chatId from groupJid for sendFile',
        );
        return;
      }

      const isImage = mimeType.startsWith('image/');

      if (isImage) {
        // Upload image and send as image message
        const imageKey = await uploadFeishuImage(
          appId, appSecret, file, mimeType, domain,
        );
        await sendFeishuImageMessage(appId, appSecret, chatId, imageKey, domain);
      } else {
        // Upload file and send as file message
        const fileKey = await uploadFeishuFile(
          appId, appSecret, file, fileName, mimeType, domain,
        );
        await sendFeishuFileMessage(appId, appSecret, chatId, fileKey, domain);
      }

      // Send caption as a separate text message if provided
      if (caption) {
        await this.sendReply(ctx, caption);
      }

      this.logger.info(
        { botId: ctx.botId, groupJid: ctx.groupJid, fileName, isImage },
        'Feishu file sent',
      );
    } catch (err) {
      this.logger.error(
        { err, botId: ctx.botId, groupJid: ctx.groupJid, fileName },
        'Failed to send file via Feishu',
      );
    }
  }

  /**
   * Best-effort removal of the "OnIt" reaction added at message receipt.
   * Lists reactions to find ours, then deletes it.
   */
  private async removeAckReaction(
    appId: string,
    appSecret: string,
    messageId: string,
    domain: FeishuDomain,
  ): Promise<void> {
    const reactions = await listFeishuReactions(appId, appSecret, messageId, 'OnIt', domain);
    // Feishu API only allows deleting reactions you created, so iterating all
    // is safe — attempts to delete others' reactions will fail silently.
    for (const r of reactions) {
      await removeFeishuReaction(appId, appSecret, messageId, r.reactionId, domain);
    }
  }
}
