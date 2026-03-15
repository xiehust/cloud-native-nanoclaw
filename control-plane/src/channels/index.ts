// ClawBot Cloud — Channel Router
// Maps channel type to the appropriate client for outbound messages

import * as telegram from './telegram.js';
import * as discord from './discord.js';
import * as slack from './slack.js';
import type { ChannelType } from '@clawbot/shared';

export async function sendChannelMessage(
  channelType: ChannelType,
  credentials: Record<string, string>,
  chatId: string,
  text: string,
): Promise<void> {
  switch (channelType) {
    case 'telegram':
      return telegram.sendMessage(credentials.botToken, chatId, text);
    case 'discord':
      return discord.sendMessage(credentials.botToken, chatId, text);
    case 'slack':
      return slack.sendMessage(credentials.botToken, chatId, text);
    default:
      throw new Error(`Unsupported channel type: ${channelType}`);
  }
}

export async function verifyChannelCredentials(
  channelType: ChannelType,
  credentials: Record<string, string>,
): Promise<Record<string, string>> {
  switch (channelType) {
    case 'telegram': {
      const me = await telegram.getMe(credentials.botToken);
      return { botId: String(me.id), username: me.username };
    }
    case 'discord': {
      const me = await discord.verifyCredentials(credentials.botToken);
      return { applicationId: me.id, username: me.username };
    }
    case 'slack': {
      const auth = await slack.authTest(credentials.botToken);
      return {
        botUserId: auth.userId,
        teamId: auth.teamId,
        slackBotId: auth.botId,
      };
    }
    default:
      throw new Error(`Unsupported channel type: ${channelType}`);
  }
}
