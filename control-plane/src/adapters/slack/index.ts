// Slack Channel Adapter
// Thin wrapper around the existing Slack channel client.
// Slack uses webhooks for inbound — start/stop are no-ops.

import { BaseChannelAdapter } from '../base.js';
import type { ReplyContext, ReplyOptions } from '@clawbot/shared/channel-adapter';
import { sendMessage } from '../../channels/slack.js';
import { getChannelsByBot } from '../../services/dynamo.js';
import { getChannelCredentials } from '../../services/cached-lookups.js';

export class SlackAdapter extends BaseChannelAdapter {
  readonly channelType = 'slack';

  constructor(parentLogger: import('pino').Logger) {
    super(parentLogger);
    this.init();
  }

  async start(): Promise<void> {
    // Slack uses webhook-based ingestion — no gateway to connect
  }

  async stop(): Promise<void> {
    // Nothing to tear down
  }

  async sendReply(
    ctx: ReplyContext,
    text: string,
    _opts?: ReplyOptions,
  ): Promise<void> {
    try {
      // Load channel config for this bot
      const channels = await getChannelsByBot(ctx.botId);
      const channel = channels.find((ch) => ch.channelType === 'slack');
      if (!channel) {
        this.logger.warn(
          { botId: ctx.botId },
          'No Slack channel configured for bot',
        );
        return;
      }

      // Load credentials from Secrets Manager (cached)
      const creds = await getChannelCredentials(channel.credentialSecretArn);

      // Extract Slack channel ID from groupJid (format: "sl:C01234")
      const chatId = ctx.groupJid.split(':')[1];
      if (!chatId) {
        this.logger.error(
          { groupJid: ctx.groupJid },
          'Could not extract chatId from groupJid',
        );
        return;
      }

      await sendMessage(creds.botToken, chatId, text);

      this.logger.info(
        { botId: ctx.botId, groupJid: ctx.groupJid },
        'Slack reply sent',
      );
    } catch (err) {
      this.logger.error(
        { err, botId: ctx.botId, groupJid: ctx.groupJid },
        'Failed to send Slack reply',
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
      const channels = await getChannelsByBot(ctx.botId);
      const channel = channels.find((ch) => ch.channelType === 'slack');
      if (!channel) {
        this.logger.warn(
          { botId: ctx.botId },
          'No Slack channel configured for bot (sendFile)',
        );
        return;
      }

      const creds = await getChannelCredentials(channel.credentialSecretArn);

      const chatId = ctx.groupJid.split(':')[1];
      if (!chatId) {
        this.logger.error(
          { groupJid: ctx.groupJid },
          'Could not extract chatId from groupJid for sendFile',
        );
        return;
      }

      const form = new FormData();
      form.append('file', new Blob([file], { type: mimeType }), fileName);
      form.append('filename', fileName);
      form.append('channel_id', chatId);
      if (caption) form.append('initial_comment', caption);

      const resp = await fetch('https://slack.com/api/files.uploadV2', {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.botToken}` },
        body: form,
      });

      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Slack files.uploadV2 failed: ${resp.status} — ${body}`);
      }

      const result = (await resp.json()) as { ok: boolean; error?: string };
      if (!result.ok) {
        throw new Error(`Slack files.uploadV2 error: ${result.error}`);
      }

      this.logger.info(
        { botId: ctx.botId, groupJid: ctx.groupJid, fileName },
        'Slack file sent',
      );
    } catch (err) {
      this.logger.error(
        { err, botId: ctx.botId, groupJid: ctx.groupJid, fileName },
        'Failed to send file via Slack',
      );
    }
  }
}
