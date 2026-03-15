// ClawBot Cloud — Message Dispatcher
// Core message processing: the cloud equivalent of NanoClaw's message loop
// Receives SQS messages, loads context, invokes agent, stores reply, sends to channel

import type { Message as SQSMessage } from '@aws-sdk/client-sqs';
import { formatMessages, formatOutbound } from '@clawbot/shared';
import type {
  InvocationPayload,
  InvocationResult,
  SqsInboundPayload,
  SqsPayload,
  SqsTaskPayload,
  Message,
} from '@clawbot/shared';
import { config } from '../config.js';
import {
  getRecentMessages,
  putMessage,
  putSession,
  getTask,
  getChannelsByBot,
  updateUserUsage,
} from '../services/dynamo.js';
import { getCachedBot, getChannelCredentials } from '../services/cached-lookups.js';
import { sendChannelMessage } from '../channels/index.js';
import type { Logger } from 'pino';

// ── Main dispatch entry point ───────────────────────────────────────────────

export async function dispatch(
  sqsMessage: SQSMessage,
  logger: Logger,
): Promise<void> {
  const payload: SqsPayload = JSON.parse(sqsMessage.Body!);

  if (payload.type === 'inbound_message') {
    await dispatchMessage(payload, logger);
  } else if (payload.type === 'scheduled_task') {
    await dispatchTask(payload, logger);
  } else {
    logger.warn({ payload }, 'Unknown SQS payload type');
  }
}

// ── Inbound message dispatch ────────────────────────────────────────────────

async function dispatchMessage(
  payload: SqsInboundPayload,
  logger: Logger,
): Promise<void> {
  const startTime = Date.now();

  // 1. Load bot config
  const bot = await getCachedBot(payload.botId);
  if (!bot || bot.status !== 'active') {
    logger.info({ botId: payload.botId }, 'Bot not found or inactive, skipping dispatch');
    return;
  }

  // 2. Query recent messages (last 50, filter out bot messages for context)
  const messages = await getRecentMessages(
    payload.botId,
    payload.groupJid,
    50,
  );
  const contextMessages = messages.filter((m) => !m.isBotMessage);

  // 3. Format into XML (preserving NanoClaw's format exactly)
  const prompt = formatMessages(
    contextMessages.map((m) => ({
      senderName: m.senderName,
      content: m.content,
      timestamp: m.timestamp,
    })),
    'UTC', // TODO: get timezone from bot/user config
  );

  // 4. Build invocation payload
  const invocationPayload: InvocationPayload = {
    botId: payload.botId,
    botName: bot.name,
    groupJid: payload.groupJid,
    userId: payload.userId,
    prompt,
    systemPrompt: bot.systemPrompt,
    sessionPath: `${payload.userId}/${payload.botId}/sessions/${payload.groupJid}/`,
    memoryPaths: {
      shared: `${payload.userId}/shared/CLAUDE.md`,
      botGlobal: `${payload.userId}/${payload.botId}/memory/global/CLAUDE.md`,
      group: `${payload.userId}/${payload.botId}/memory/${payload.groupJid}/CLAUDE.md`,
    },
  };

  logger.info(
    { botId: payload.botId, groupJid: payload.groupJid },
    'Invoking agent',
  );

  // 5. Invoke AgentCore
  const result = await invokeAgent(invocationPayload, logger);

  // 6. Store bot reply in DynamoDB
  if (result.status === 'success' && result.result) {
    const replyText = formatOutbound(result.result);
    if (replyText) {
      await putMessage({
        botId: payload.botId,
        groupJid: payload.groupJid,
        timestamp: new Date().toISOString(),
        messageId: `bot-${Date.now()}`,
        sender: bot.name,
        senderName: bot.name,
        content: replyText,
        isFromMe: true,
        isBotMessage: true,
        channelType: payload.channelType,
        ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
      });

      // 7. Send reply via channel API
      await sendChannelReply(
        payload.botId,
        payload.groupJid,
        payload.channelType,
        replyText,
        logger,
      );
    }
  } else if (result.status === 'error') {
    logger.error(
      { botId: payload.botId, error: result.error },
      'Agent invocation failed',
    );
  }

  // 8. Update session
  if (result.newSessionId) {
    await putSession({
      botId: payload.botId,
      groupJid: payload.groupJid,
      agentcoreSessionId: result.newSessionId,
      s3SessionPath: invocationPayload.sessionPath,
      lastActiveAt: new Date().toISOString(),
      status: 'active',
    });
  }

  // 9. Track usage
  if (result.tokensUsed) {
    await updateUserUsage(payload.userId, result.tokensUsed).catch((err) =>
      logger.error(err, 'Failed to update user usage'),
    );
  }

  const duration = Date.now() - startTime;
  logger.info(
    {
      botId: payload.botId,
      groupJid: payload.groupJid,
      durationMs: duration,
      status: result.status,
    },
    'Message dispatch complete',
  );
}

// ── Scheduled task dispatch ─────────────────────────────────────────────────

async function dispatchTask(
  payload: SqsTaskPayload,
  logger: Logger,
): Promise<void> {
  const bot = await getCachedBot(payload.botId);
  if (!bot || bot.status !== 'active') return;

  const task = await getTask(payload.botId, payload.taskId);
  if (!task || task.status !== 'active') return;

  logger.info(
    { botId: payload.botId, taskId: payload.taskId },
    'Dispatching scheduled task',
  );

  const invocationPayload: InvocationPayload = {
    botId: payload.botId,
    botName: bot.name,
    groupJid: payload.groupJid,
    userId: payload.userId,
    prompt: task.prompt,
    systemPrompt: bot.systemPrompt,
    isScheduledTask: true,
    sessionPath: `${payload.userId}/${payload.botId}/sessions/${payload.groupJid}/`,
    memoryPaths: {
      shared: `${payload.userId}/shared/CLAUDE.md`,
      botGlobal: `${payload.userId}/${payload.botId}/memory/global/CLAUDE.md`,
      group: `${payload.userId}/${payload.botId}/memory/${payload.groupJid}/CLAUDE.md`,
    },
  };

  const result = await invokeAgent(invocationPayload, logger);

  if (result.status === 'success' && result.result) {
    const replyText = formatOutbound(result.result);
    if (replyText) {
      await putMessage({
        botId: payload.botId,
        groupJid: payload.groupJid,
        timestamp: new Date().toISOString(),
        messageId: `task-${payload.taskId}-${Date.now()}`,
        sender: bot.name,
        senderName: bot.name,
        content: replyText,
        isFromMe: true,
        isBotMessage: true,
        channelType: 'telegram', // TODO: resolve from group
        ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
      });

      // TODO: resolve channel type from group config
      // For now, skip channel reply for tasks until we wire up group -> channel mapping
    }
  }
}

// ── Agent Invocation (AgentCore placeholder) ────────────────────────────────

async function invokeAgent(
  payload: InvocationPayload,
  logger: Logger,
): Promise<InvocationResult> {
  // TODO: Replace with real AgentCore Runtime invocation
  // This will call the AgentCore Runtime API with the invocation payload.
  // The runtime manages Claude sessions, filesystem isolation, and tool execution.
  //
  // Expected flow:
  // 1. POST to AgentCore Runtime ARN (config.agentcore.runtimeArn)
  //    with InvocationPayload
  // 2. Runtime loads session from S3 (or creates new)
  // 3. Runtime invokes Claude with system prompt + message context
  // 4. Runtime returns InvocationResult with response text and session ID
  //
  // For now, return a placeholder that logs the invocation.

  logger.info(
    {
      botId: payload.botId,
      groupJid: payload.groupJid,
      promptLength: payload.prompt.length,
      isScheduledTask: payload.isScheduledTask,
    },
    'Agent invocation placeholder — AgentCore integration pending',
  );

  return {
    status: 'error',
    result: null,
    error: 'AgentCore runtime not yet integrated',
  };
}

// ── Channel reply routing ───────────────────────────────────────────────────

async function sendChannelReply(
  botId: string,
  groupJid: string,
  channelType: string,
  text: string,
  logger: Logger,
): Promise<void> {
  try {
    // Load channel config for this bot + channel type
    const channels = await getChannelsByBot(botId);
    const channel = channels.find((ch) => ch.channelType === channelType);
    if (!channel) {
      logger.warn(
        { botId, channelType },
        'No channel configured for reply routing',
      );
      return;
    }

    // Load credentials
    const creds = await getChannelCredentials(channel.credentialSecretArn);

    // Extract chat ID from groupJid (format: "tg:123456", "dc:789", "sl:C01234")
    const chatId = groupJid.split(':')[1];
    if (!chatId) {
      logger.error({ groupJid }, 'Could not extract chatId from groupJid');
      return;
    }

    // Send via channel client
    await sendChannelMessage(
      channelType as Message['channelType'],
      creds,
      chatId,
      text,
    );

    logger.info(
      { botId, groupJid, channelType },
      'Reply sent via channel',
    );
  } catch (err) {
    logger.error(
      { err, botId, groupJid, channelType },
      'Failed to send channel reply',
    );
  }
}
