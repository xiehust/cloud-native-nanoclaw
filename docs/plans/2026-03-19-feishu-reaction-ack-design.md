# Feishu Reaction Acknowledgement

**Date:** 2026-03-19
**Status:** Approved

## Problem

When users send messages to the Feishu bot, there's no immediate feedback that the message was received. The bot takes time to process via AgentCore, leaving users uncertain whether their message was picked up.

## Design

Add an OnIt (🛠️) emoji reaction to the user's message immediately upon receipt, then remove it after the first reply is sent.

### Flow

1. User sends message → trigger check passes → **add 👀 reaction** (fire-and-forget)
2. Message dispatched to SQS → Agent processes → reply queued
3. Feishu adapter `sendReply()` sends first reply → **remove 👀 reaction** (best-effort)

### Changes

| File | Change |
|------|--------|
| `channels/feishu.ts` | Add `addFeishuReaction()` and `removeFeishuReaction()` API functions |
| `feishu/message-handler.ts` | Call `addFeishuReaction()` after trigger check (fire-and-forget) |
| `adapters/feishu/index.ts` | In `sendReply()`, remove reaction when `ctx.feishuMessageId` is present (first reply only) |

### Reaction removal strategy

- `sendReply()` already clears `feishuMessageId` after the first reply, so reaction removal naturally executes only once.
- Removal calls `GET /im/v1/messages/{message_id}/reactions` to find the bot's OnIt reaction_id, then `DELETE` to remove it.
- Removal is best-effort — failures are logged but don't affect message delivery.

### Feishu API endpoints

- **Add:** `POST /open-apis/im/v1/messages/{message_id}/reactions` with `{ reaction_type: { emoji_type: "OnIt" } }`
- **List:** `GET /open-apis/im/v1/messages/{message_id}/reactions?reaction_type=OnIt`
- **Remove:** `DELETE /open-apis/im/v1/messages/{message_id}/reactions/{reaction_id}`
