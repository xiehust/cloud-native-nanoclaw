# File Attachments — Design Document

**Date:** 2026-03-18
**Goal:** Enable bidirectional file transfer between agents and messaging channels (Discord, Slack, Telegram).

## Scope

- **Outbound:** Agent creates files (pptx, pdf, images, etc.) in `/workspace/group/` and sends them through the channel via new MCP tool `send_file`
- **Inbound:** Slack and Telegram webhook handlers download user-sent attachments to S3 (Discord already supported), making them accessible to the agent
- **Web Console:** Add permission guidance for Slack (`files:write`, `files:read`) and Discord (`Attach Files`) in channel setup

## Data Flow

### Outbound (Agent → Channel)

```
Agent creates file /workspace/group/report.pptx
  → MCP send_file(filePath, caption?)
  → Validates path under /workspace/group/, checks size <= 25MB
  → Reads file as Buffer, guesses mimeType from extension
  → Uploads to S3: {userId}/{botId}/attachments/{messageId}/{fileName}
  → Sends SqsFileReplyPayload to reply queue
  → Reply Consumer receives message
  → Downloads file from S3 to memory
  → adapter.sendFile(ctx, fileBuffer, fileName, mimeType, caption)
  → Channel-specific API call
```

### Inbound (Channel → Agent)

```
User sends file in Slack/Telegram
  → Webhook receives message, detects attachment
  → Downloads file from channel API (Slack: url_private_download, Telegram: getFile)
  → Uploads to S3 via downloadAndStore()
  → SqsInboundPayload.attachments[] carries { type, s3Key, mimeType, fileName }
  → Dispatcher downloads attachments to /workspace/group/attachments/ before invocation
  → Agent reads files from /workspace/group/attachments/
```

### S3 Attachments Path

```
{userId}/{botId}/attachments/{messageId}/{fileName}
```

Shared by both inbound and outbound. Existing Discord inbound already uses this pattern.

## Interface Changes

### shared/src/types.ts

```typescript
export interface SqsTextReplyPayload {
  type: 'reply';
  botId: string;
  groupJid: string;
  channelType: ChannelType;
  text: string;
  timestamp: string;
}

export interface SqsFileReplyPayload {
  type: 'file_reply';
  botId: string;
  groupJid: string;
  channelType: ChannelType;
  s3Key: string;
  fileName: string;
  mimeType: string;
  size: number;
  caption?: string;
  timestamp: string;
}

export type SqsReplyPayload = SqsTextReplyPayload | SqsFileReplyPayload;
```

### shared/src/channel-adapter.ts

```typescript
export interface ChannelAdapter {
  // ... existing methods
  sendReply(ctx: ReplyContext, text: string, opts?: ReplyOptions): Promise<void>;
  sendFile?(ctx: ReplyContext, file: Buffer, fileName: string, mimeType: string, caption?: string): Promise<void>;
}
```

`sendFile` is optional — adapters that don't support it fallback to a text message in the reply consumer.

### MCP Tool: send_file

```typescript
server.tool('send_file',
  'Send a file to the user or group. File must exist in /workspace/group/.',
  {
    filePath: z.string().describe('Absolute path, must be under /workspace/group/'),
    caption: z.string().optional().describe('Optional message to accompany the file'),
  },
  async ({ filePath, caption }) => { ... }
);
```

## Channel-Specific Implementation

### Discord

**Outbound:**
```typescript
async sendFile(ctx, file, fileName, mimeType, caption?) {
  const channel = await client.channels.fetch(channelId);
  await channel.send({
    content: caption || '',
    files: [{ attachment: file, name: fileName }],
  });
}
```

Requires: `Attach Files` server permission (usually granted by default).

**Inbound:** Already implemented.

### Slack

**Outbound:**
```typescript
async sendFile(ctx, file, fileName, mimeType, caption?) {
  const form = new FormData();
  form.append('file', new Blob([file]), fileName);
  form.append('channels', channelId);
  if (caption) form.append('initial_comment', caption);
  await fetch('https://slack.com/api/files.uploadV2', {
    headers: { Authorization: `Bearer ${botToken}` },
    body: form,
  });
}
```

Requires: `files:write` OAuth scope.

**Inbound:** Parse `event.files[]` → `files.info` for `url_private_download` → download with Bearer token → `downloadAndStore()`. Requires: `files:read` OAuth scope.

### Telegram

**Outbound:**
```typescript
async sendFile(ctx, file, fileName, mimeType, caption?) {
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('document', new Blob([file]), fileName);
  if (caption) form.append('caption', caption);
  await fetch(`${API}/bot${token}/sendDocument`, { body: form });
}
```

No extra permissions needed.

**Inbound:** Parse `message.photo[]` (largest size) or `message.document` → `getFile` API → download → `downloadAndStore()`. Photo + document only (no voice/video/sticker). No extra permissions needed.

## Error Handling

| Scenario | Handling |
|----------|----------|
| File > 25MB | MCP tool returns error, agent can inform user |
| Path outside /workspace/group/ | MCP tool rejects with path restriction error |
| S3 upload failure | MCP tool returns error |
| Channel API failure (missing perms) | Reply consumer logs, SQS retries up to 3x, then gives up |
| Adapter doesn't support sendFile | Fallback: send text message with file name |

## Web Console Changes

- **Slack channel setup:** Add permission hint — "To enable file sending/receiving, add `files:write` and `files:read` OAuth scopes to your Slack App"
- **Discord channel setup:** Add permission hint — "Ensure Bot has 'Attach Files' permission in target servers"
- **Telegram:** No extra permissions needed, no hint

Text-only changes in existing ChannelSetup.tsx steps, no new pages/components.

## File Size Limits

Unified 25MB limit across all channels (Discord free tier minimum).

- Discord: 25MB (free) / 50MB (Nitro)
- Slack: No API limit (depends on workspace plan)
- Telegram: 50MB (sendDocument)

## Files Changed

| File | Change |
|------|--------|
| `shared/src/types.ts` | Split SqsReplyPayload into text + file union |
| `shared/src/channel-adapter.ts` | Add optional `sendFile?` method |
| `agent-runtime/src/mcp-server.ts` | Add `send_file` tool definition |
| `agent-runtime/src/mcp-tools.ts` | Implement `sendFile()` (read→S3→SQS) |
| `control-plane/src/sqs/reply-consumer.ts` | Handle `file_reply`, download from S3, forward via adapter |
| `control-plane/src/adapters/discord/index.ts` | Implement `sendFile` (discord.js files) |
| `control-plane/src/adapters/slack/index.ts` | Implement `sendFile` (files.uploadV2) |
| `control-plane/src/adapters/telegram/index.ts` | Implement `sendFile` (sendDocument) |
| `control-plane/src/webhooks/slack.ts` | Inbound: download Slack file attachments → S3 |
| `control-plane/src/webhooks/telegram.ts` | Inbound: download Telegram photo/document → S3 |
| `web-console/src/pages/ChannelSetup.tsx` | Slack/Discord file permission hints |
| `control-plane/src/__tests__/` | Tests for file reply flow |
