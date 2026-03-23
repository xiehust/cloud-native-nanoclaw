// DingTalk -- Message Handler
// Used by the DingTalk Gateway Stream client (TOPIC_ROBOT callback).
// Single source of truth for: content parsing, @mention detection,
// group management, DynamoDB store, SQS dispatch.
//
// Pattern: follows feishu/message-handler.ts exactly for DynamoDB operations,
// quota checking, and SQS FIFO dispatch.

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type pino from 'pino';
import { config } from '../config.js';
import {
  putMessage,
  getOrCreateGroup,
  listGroups,
  getUser,
} from '../services/dynamo.js';
import { getCachedBot } from '../services/cached-lookups.js';
import type { Message, SqsInboundPayload } from '@clawbot/shared';

const sqs = new SQSClient({ region: config.region });

// -- DingTalk Message Data Types ----------------------------------------------

export interface DingTalkMessageData {
  conversationId: string;       // chat/conversation ID
  chatbotCorpId: string;        // corp ID
  chatbotUserId: string;        // bot's DingTalk userId
  msgId: string;                // message ID
  senderNick: string;           // sender display name
  isAdmin: boolean;
  senderStaffId: string;        // sender userId
  sessionWebhookExpiredTime: number;
  createAt: number;             // timestamp in milliseconds
  senderCorpId: string;
  conversationType: string;     // '1' = private, '2' = group
  senderId: string;
  sessionWebhook: string;       // webhook URL for quick reply
  robotCode: string;            // robot app key
  text: { content: string };    // message text content
  msgtype: string;              // 'text', 'richText', 'picture', etc.
  isInAtList?: boolean;         // whether bot was @mentioned
  atUsers?: Array<{ dingtalkId: string; staffId?: string }>;
}

// -- Helpers ------------------------------------------------------------------

/**
 * Strip @bot mentions from DingTalk text content.
 * DingTalk @mentions appear as @NickName in the text body.
 * Remove them for cleaner prompts sent to the agent.
 */
function stripAtMentions(text: string): string {
  // DingTalk inserts @mentions as @NickName (non-whitespace sequence)
  return text.replace(/@\S+/g, '').trim();
}

/**
 * Determine whether a message should trigger agent processing.
 *
 * - Private chat (conversationType '1'): always trigger
 * - Group chat (conversationType '2'): trigger when bot is @mentioned
 *   (isInAtList) or when text matches the bot's triggerPattern
 */
function shouldTrigger(
  content: string,
  conversationType: string,
  triggerPattern: string,
  isInAtList?: boolean,
): boolean {
  // Private chats always trigger
  if (conversationType === '1') return true;

  // In groups, check if bot was @mentioned
  if (isInAtList) return true;

  // Check trigger pattern
  if (!triggerPattern) return false;
  try {
    const regex = new RegExp(triggerPattern, 'i');
    return regex.test(content);
  } catch {
    return content.toLowerCase().includes(triggerPattern.toLowerCase());
  }
}

// -- Main Handler -------------------------------------------------------------

/**
 * Process an incoming DingTalk robot message.
 *
 * @param botId   - ClawBot bot ID that owns this DingTalk channel
 * @param userId  - DingTalk sender's staff ID (senderStaffId)
 * @param data    - Raw message data parsed from the stream callback
 * @param logger  - Pino logger instance
 */
export async function handleDingTalkMessage(
  botId: string,
  userId: string,
  data: DingTalkMessageData,
  logger: pino.Logger,
): Promise<void> {
  // Only handle text messages for now; other types (image, file, richText)
  // can be added later following the feishu attachment pattern.
  if (data.msgtype !== 'text') {
    logger.debug(
      { botId, msgtype: data.msgtype },
      'Skipping non-text DingTalk message',
    );
    return;
  }

  const rawContent = data.text?.content || '';
  if (!rawContent.trim()) return;

  // Construct group identifier: dt:{conversationId}
  const groupJid = `dt:${data.conversationId}`;
  const isGroup = data.conversationType === '2';
  const chatName = isGroup
    ? `dingtalk-group-${data.conversationId}`
    : `dingtalk-dm-${data.senderStaffId}`;
  const messageId = `dt-${data.msgId}`;

  // Load bot config
  const bot = await getCachedBot(botId);
  if (!bot || bot.status !== 'active') return;

  // Check group quota before auto-creating (same pattern as feishu)
  const existingGroups = await listGroups(botId);
  const isNewGroup = !existingGroups.find((g) => g.groupJid === groupJid);
  if (isNewGroup) {
    const owner = await getUser(bot.userId);
    const maxGroups = owner?.quota?.maxGroupsPerBot ?? 10;
    if (existingGroups.length >= maxGroups) {
      logger.warn(
        { botId, maxGroups },
        'Group limit reached, skipping DingTalk message',
      );
      return;
    }
  }

  // Ensure group exists in DynamoDB
  await getOrCreateGroup(botId, groupJid, chatName, 'dingtalk', isGroup);

  // Clean @mention text for cleaner prompts (only in group chats)
  const content = isGroup ? stripAtMentions(rawContent) : rawContent.trim();

  // Store message in DynamoDB
  const timestamp =
    data.createAt > 0
      ? new Date(data.createAt).toISOString()
      : new Date().toISOString();

  const msg: Message = {
    botId,
    groupJid,
    timestamp,
    messageId,
    sender: data.senderStaffId,
    senderName: data.senderNick || data.senderStaffId,
    content,
    isFromMe: false,
    isBotMessage: false,
    channelType: 'dingtalk',
    ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
  };
  await putMessage(msg);

  // Check trigger (use raw content for pattern matching, before @mention stripping)
  if (
    !shouldTrigger(
      rawContent,
      data.conversationType,
      bot.triggerPattern,
      data.isInAtList,
    )
  ) {
    logger.debug({ botId, groupJid }, 'DingTalk message did not match trigger');
    return;
  }

  logger.info(
    {
      botId,
      groupJid,
      messageId: msg.messageId,
      contentLength: content.length,
    },
    'DingTalk message processing',
  );

  // Send to SQS FIFO for agent dispatch
  const sqsPayload: SqsInboundPayload = {
    type: 'inbound_message',
    botId,
    groupJid,
    userId: bot.userId,
    messageId: msg.messageId,
    content: msg.content,
    channelType: 'dingtalk',
    timestamp,
    replyContext: {
      dingtalkConversationId: data.conversationId,
      dingtalkMsgId: data.msgId,
      dingtalkSessionWebhook: data.sessionWebhook,
      dingtalkIsGroup: data.conversationType === '2',
    },
  };

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: config.queues.messages,
      MessageBody: JSON.stringify(sqsPayload),
      MessageGroupId: `${botId}#${groupJid}`,
      MessageDeduplicationId: messageId,
    }),
  );

  logger.info(
    { botId, groupJid, messageId: msg.messageId },
    'DingTalk message dispatched to SQS',
  );
}
