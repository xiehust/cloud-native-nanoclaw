// DingTalk Channel Adapter
// Manages DingTalk Stream (WebSocket) gateway connections for inbound messages.
// Uses DingTalk REST API for outbound replies, with sessionWebhook fast-path.
// Leader election is handled internally by DingTalkGatewayManager.

import { BaseChannelAdapter } from '../base.js';
import type { ReplyContext, ReplyOptions } from '@clawbot/shared/channel-adapter';
import {
  getAccessToken,
  sendMarkdownMessage,
  replyGroupMarkdownMessage,
} from '../../channels/dingtalk.js';
import {
  initDingTalkGatewayManager,
  getDingTalkGatewayManager,
} from '../../dingtalk/gateway-manager.js';
import { getChannelsByBot } from '../../services/dynamo.js';
import { getChannelCredentials } from '../../services/cached-lookups.js';

// ── Helper: DingTalk sessionWebhook allows direct reply without API token ──

async function sendViaSessionWebhook(
  webhookUrl: string,
  text: string,
): Promise<void> {
  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'markdown',
      markdown: { title: 'Reply', text },
    }),
  });
  if (!resp.ok) throw new Error(`Session webhook failed: ${resp.status}`);
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class DingTalkAdapter extends BaseChannelAdapter {
  readonly channelType = 'dingtalk';

  constructor(parentLogger: import('pino').Logger) {
    super(parentLogger);
    this.init();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Initialize the gateway manager (handles leader election internally)
    initDingTalkGatewayManager(this.logger);
    const gw = getDingTalkGatewayManager();
    if (gw) await gw.start();
  }

  async stop(): Promise<void> {
    const gw = getDingTalkGatewayManager();
    if (gw) await gw.stopAll();
  }

  // ── Send Reply ──────────────────────────────────────────────────────────

  async sendReply(
    ctx: ReplyContext,
    text: string,
    _opts?: ReplyOptions,
  ): Promise<void> {
    try {
      // Load channel config for this bot
      const channels = await getChannelsByBot(ctx.botId);
      const channel = channels.find((ch) => ch.channelType === 'dingtalk');
      if (!channel) {
        this.logger.warn(
          { botId: ctx.botId },
          'No DingTalk channel configured for bot',
        );
        return;
      }

      // Load credentials from Secrets Manager (cached)
      const creds = await getChannelCredentials(channel.credentialSecretArn);
      const clientId = creds.clientId;
      const clientSecret = creds.clientSecret;

      if (!clientId || !clientSecret) {
        this.logger.error(
          { botId: ctx.botId },
          'Missing clientId or clientSecret in DingTalk credentials',
        );
        return;
      }

      // Get access token
      const token = await getAccessToken(clientId, clientSecret);
      const robotCode = clientId; // robotCode === clientId in DingTalk

      // Determine conversation ID and message type
      const conversationId =
        ctx.dingtalkConversationId || ctx.groupJid.replace(/^dt:/, '');
      const isGroup = ctx.dingtalkIsGroup ?? false;

      // Try sessionWebhook first (fastest path for group replies)
      if (ctx.dingtalkSessionWebhook) {
        try {
          await sendViaSessionWebhook(ctx.dingtalkSessionWebhook, text);
          this.logger.info(
            { botId: ctx.botId, groupJid: ctx.groupJid },
            'DingTalk reply sent via session webhook',
          );
          return;
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
          text,
          robotCode,
        );
      } else {
        await sendMarkdownMessage(
          token,
          conversationId,
          'Reply',
          text,
          robotCode,
        );
      }

      this.logger.info(
        { botId: ctx.botId, groupJid: ctx.groupJid, isGroup },
        'DingTalk reply sent',
      );
    } catch (err) {
      this.logger.error(
        { err, botId: ctx.botId, groupJid: ctx.groupJid },
        'Failed to send DingTalk reply',
      );
    }
  }

  // sendFile — DingTalk media upload API not yet implemented (P1 feature).
  // For now, send the file name as text.
  async sendFile(
    ctx: ReplyContext,
    _file: Buffer,
    fileName: string,
    _mimeType: string,
    caption?: string,
  ): Promise<void> {
    const text = caption ? `${caption}\n[File: ${fileName}]` : `[File: ${fileName}]`;
    await this.sendReply(ctx, text);
  }
}
