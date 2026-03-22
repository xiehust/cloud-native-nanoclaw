// Feishu — Shared message handler
// Used by the Gateway WSClient (im.message.receive_v1 event).
// Single source of truth for: content parsing, @mention detection, attachment processing,
// group management, DynamoDB store, SQS dispatch.

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
import { downloadFeishuResource, addFeishuReaction } from '../channels/feishu.js';
import type { FeishuDomain } from '../channels/feishu.js';
import { storeFromBuffer } from '../services/attachments.js';
import type { Attachment, Message, SqsInboundPayload } from '@clawbot/shared';

const sqs = new SQSClient({ region: config.region });

// ── Feishu Event Types ────────────────────────────────────────────────────────

export interface FeishuSenderId {
  open_id: string;
  user_id?: string;
  union_id?: string;
}

export interface FeishuSender {
  sender_id: FeishuSenderId;
  sender_type: string;
  tenant_key?: string;
}

export interface FeishuMention {
  key: string;
  /** Event callback: object { open_id, user_id, union_id }; REST API: flat string */
  id: string | { open_id?: string; user_id?: string; union_id?: string };
  id_type?: string;
  name: string;
  tenant_key?: string;
}

export interface FeishuMessageBody {
  message_id: string;
  root_id?: string;
  parent_id?: string;
  create_time: string;
  chat_id: string;
  chat_type: 'p2p' | 'group';
  message_type: string; // text, post, image, file, audio, etc.
  content: string; // JSON string
  mentions?: FeishuMention[];
}

export interface FeishuImMessageEvent {
  sender: FeishuSender;
  message: FeishuMessageBody;
}

// ── Handler Options ──────────────────────────────────────────────────────────

export interface HandleFeishuMessageOpts {
  event: FeishuImMessageEvent;
  botId: string;
  botOpenId: string;
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
  logger: pino.Logger;
  onProcessing?: (groupJid: string) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Strip @bot mentions from Feishu text content.
 * Rich text format: <at user_id="ou_xxx">BotName</at>
 * Plain text format: @_user_N (where N is a number)
 */
function stripAtMentions(text: string): string {
  // Rich text format
  let cleaned = text.replace(/<at user_id="[^"]*">[^<]*<\/at>/g, '');
  // Plain text format
  cleaned = cleaned.replace(/@_user_\d+/g, '');
  return cleaned.trim();
}

/**
 * Check if the bot was @mentioned in a group message.
 * Handles both event callback format (id is object) and REST API format (id is string).
 */
function isBotMentioned(mentions: FeishuMention[] | undefined, botOpenId: string): boolean {
  if (!mentions || !botOpenId) return false;
  return mentions.some(m => {
    if (typeof m.id === 'object' && m.id !== null) {
      // Event callback format: { open_id, user_id, union_id }
      return m.id.open_id === botOpenId;
    }
    // REST API / flat format
    return m.id === botOpenId;
  });
}

function shouldTrigger(
  text: string,
  chatType: 'p2p' | 'group',
  triggerPattern: string,
  mentions: FeishuMention[] | undefined,
  botOpenId: string,
  hasMedia: boolean = false,
): boolean {
  // Private (p2p) chats always trigger
  if (chatType === 'p2p') return true;

  // In groups, check if bot was @mentioned
  if (isBotMentioned(mentions, botOpenId)) return true;

  // Media messages (image/file) in groups also trigger — users send
  // attachments to the bot intentionally; standalone images without
  // text or @mention should still be processed.
  if (hasMedia) return true;

  // Check trigger pattern
  if (!triggerPattern) return false;
  try {
    const regex = new RegExp(triggerPattern, 'i');
    return regex.test(text);
  } catch {
    return text.toLowerCase().includes(triggerPattern.toLowerCase());
  }
}

/**
 * Parse Feishu message content JSON and extract text.
 * Text messages: { "text": "@_user_1 hello" }
 * Post (rich text) messages: { "title": "...", "content": [[{ "tag": "text", "text": "..." }, { "tag": "img", ... }]] }
 *
 * Note: Feishu uses "post" (not "rich_text") as the message_type for rich text messages.
 */
function parseFeishuContent(messageType: string, contentJson: string): string {
  try {
    const parsed = JSON.parse(contentJson);

    if (messageType === 'text') {
      return parsed.text || '';
    }

    if (messageType === 'post') {
      // Post messages have nested content arrays: [[{ tag: "text", text: "..." }, { tag: "img", ... }]]
      const lines: string[] = [];
      const title = parsed.title;
      if (title) lines.push(title);

      const content = parsed.content;
      if (Array.isArray(content)) {
        for (const line of content) {
          if (Array.isArray(line)) {
            const lineText = line
              .filter((el: { tag: string }) => el.tag === 'text' || el.tag === 'a')
              .map((el: { text?: string; href?: string }) => el.text || el.href || '')
              .join('');
            if (lineText) lines.push(lineText);
          }
        }
      }
      return lines.join('\n');
    }

    // For image/file/audio types, return empty — handled separately
    return '';
  } catch {
    return '';
  }
}

/**
 * Determine MIME type from Feishu message_type.
 */
function mimeTypeForFeishuMessage(messageType: string): string {
  switch (messageType) {
    case 'image':
      return 'image/png';
    case 'audio':
      return 'audio/opus';
    case 'file':
      return 'application/octet-stream';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Sanitize file name before using it in S3 keys.
 * Removes path separators and traversal sequences, truncates long names.
 */
function sanitizeFileName(name: string): string {
  return name
    .replace(/[/\\]/g, '_')     // Remove path separators
    .replace(/\.\./g, '_')      // Remove path traversal
    .slice(0, 200);             // Truncate long names
}

// ── Main Handler ─────────────────────────────────────────────────────────────

export async function handleFeishuMessage({
  event,
  botId,
  botOpenId,
  appId,
  appSecret,
  domain,
  logger,
  onProcessing,
}: HandleFeishuMessageOpts): Promise<void> {
  const feishuMsg = event.message;
  const sender = event.sender;

  // Filter out this bot's own messages to prevent infinite loops.
  // Other bots' messages are kept so they appear in group chat context.
  if (sender.sender_id.open_id === botOpenId) return;

  // Parse message content
  const rawContent = parseFeishuContent(feishuMsg.message_type, feishuMsg.content);
  let content = stripAtMentions(rawContent);

  // Detect media: standalone image/file/audio, or post messages containing img tags
  let hasMedia = ['image', 'file', 'audio'].includes(feishuMsg.message_type);

  // Pre-parse post content once (reused for hasMedia detection and image download)
  interface PostElement { tag: string; image_key?: string; text?: string; href?: string }
  let postImgElements: PostElement[] = [];
  if (feishuMsg.message_type === 'post') {
    try {
      const parsed = JSON.parse(feishuMsg.content);
      const elements = ((parsed.content as PostElement[][])?.flat() ?? []);
      postImgElements = elements.filter((el) => el.tag === 'img');
      if (postImgElements.length > 0) hasMedia = true;
    } catch { /* ignore parse errors */ }
  }

  // Audio: append unsupported note
  if (feishuMsg.message_type === 'audio') {
    content += '\n[Voice message — not yet supported]';
  }

  // Skip messages with no text and no media
  if (!content.trim() && !hasMedia) return;

  const chatId = feishuMsg.chat_id;
  const groupJid = `feishu#${chatId}`;
  const isGroup = feishuMsg.chat_type === 'group';
  const chatName = isGroup ? `feishu-group-${chatId}` : `feishu-dm-${sender.sender_id.open_id}`;
  const messageId = feishuMsg.message_id;

  // Load bot config
  const bot = await getCachedBot(botId);
  if (!bot || bot.status !== 'active') return;

  // Process image/file attachments
  const attachments: Attachment[] = [];

  if (appId && appSecret && (feishuMsg.message_type === 'image' || feishuMsg.message_type === 'file')) {
    try {
      // Extract file_key from content JSON
      const contentParsed = JSON.parse(feishuMsg.content);
      const fileKey = contentParsed.image_key || contentParsed.file_key;
      const fileName = sanitizeFileName(contentParsed.file_name || `${feishuMsg.message_type}_${Date.now()}`);
      const mimeType = mimeTypeForFeishuMessage(feishuMsg.message_type);
      const resourceType = feishuMsg.message_type === 'image' ? 'image' as const : 'file' as const;

      if (fileKey) {
        const data = await downloadFeishuResource(
          appId, appSecret, messageId, fileKey, domain, resourceType,
        );
        const att = await storeFromBuffer(
          bot.userId, botId, messageId, data, fileName, mimeType,
        );
        if (att) attachments.push(att);
      }
    } catch (err) {
      logger.warn({ err, botId }, 'Failed to download Feishu attachment');
    }
  }

  // Process inline images from post (rich text) messages
  if (appId && appSecret && postImgElements.length > 0) {
    for (let i = 0; i < postImgElements.length; i++) {
      try {
        const imageKey = postImgElements[i].image_key;
        if (!imageKey) continue;
        const fileName = sanitizeFileName(`post_image_${i}_${imageKey.slice(-8)}`);
        const data = await downloadFeishuResource(
          appId, appSecret, messageId, imageKey, domain, 'image',
        );
        const att = await storeFromBuffer(
          bot.userId, botId, messageId, data, fileName, 'image/png',
        );
        if (att) attachments.push(att);
      } catch (err) {
        logger.warn({ err, botId, index: i }, 'Failed to download post inline image');
      }
    }
  }

  // Check group quota before auto-creating
  const existingGroups = await listGroups(botId);
  const isNewGroup = !existingGroups.find(g => g.groupJid === groupJid);
  if (isNewGroup) {
    const owner = await getUser(bot.userId);
    const maxGroups = owner?.quota?.maxGroupsPerBot ?? 10;
    if (existingGroups.length >= maxGroups) {
      logger.warn({ botId, maxGroups }, 'Group limit reached, skipping message');
      return;
    }
  }

  // Append attachment info so agent knows what files are available
  if (attachments.length > 0) {
    const fileDescs = attachments.map((a) => `- ${a.fileName || a.s3Key.split('/').pop()} (${a.mimeType})`).join('\n');
    content += `\n[Attached files — saved to /workspace/group/attachments/]\n${fileDescs}`;
  }

  // Ensure group exists in DynamoDB
  await getOrCreateGroup(botId, groupJid, chatName, 'feishu', isGroup);

  // Store message in DynamoDB
  const createTimeMs = Number(feishuMsg.create_time);
  const timestamp = createTimeMs > 0
    ? new Date(createTimeMs).toISOString()
    : new Date().toISOString();
  const msg: Message = {
    botId,
    groupJid,
    timestamp,
    messageId,
    sender: sender.sender_id.open_id,
    senderName: sender.sender_id.open_id, // Feishu doesn't include display name in events
    content,
    isFromMe: false,
    isBotMessage: false,
    channelType: 'feishu',
    ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
    ...(attachments.length > 0 && { attachments }),
  };
  await putMessage(msg);

  // Other bots' messages are stored for context but never dispatched
  if (sender.sender_type === 'bot') return;

  // Check trigger (use mentions array for bot detection, raw content for pattern matching)
  if (!shouldTrigger(rawContent, feishuMsg.chat_type, bot.triggerPattern, feishuMsg.mentions, botOpenId, hasMedia)) {
    logger.debug({ botId, groupJid }, 'Message did not match trigger');
    return;
  }

  // Signal that validation passed — caller can start typing indicator etc.
  onProcessing?.(groupJid);

  // Add "OnIt" reaction to acknowledge receipt (fire-and-forget — don't block processing)
  addFeishuReaction(appId, appSecret, messageId, 'OnIt', domain).catch((err) => {
    logger.warn({ err, botId, messageId }, 'Failed to add OnIt reaction');
  });

  logger.info(
    {
      botId,
      groupJid,
      messageId: msg.messageId,
      contentLength: content.length,
      attachmentCount: attachments.length,
    },
    'Feishu message processing',
  );

  // Send to SQS FIFO for agent dispatch
  const sqsPayload: SqsInboundPayload = {
    type: 'inbound_message',
    botId,
    groupJid,
    userId: bot.userId,
    messageId: msg.messageId,
    content: msg.content,
    channelType: 'feishu',
    timestamp,
    ...(attachments.length > 0 && { attachments }),
    replyContext: {
      feishuChatId: chatId,
      feishuMessageId: messageId,
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
    'Feishu message dispatched to SQS',
  );
}
