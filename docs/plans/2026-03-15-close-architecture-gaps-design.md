# Close Architecture Gaps — Design Document

> Design decisions and specifications for closing all gaps between
> `docs/CLOUD_ARCHITECTURE.md` and the current implementation.

---

## 1. AgentCore Integration (P0)

**Decision:** HTTP POST to AgentCore endpoint.

The dispatcher's `invokeAgent()` sends a `POST /invocations` request to the
URL configured in `AGENTCORE_RUNTIME_ARN`. The agent-runtime already handles
this endpoint and returns `InvocationResult`.

- **Timeout:** 10 minutes (agent turns can be long).
- **Error handling:** On HTTP failure, do NOT delete the SQS message — let it
  retry after VisibilityTimeout (600s). After 3 failures → DLQ.
- **Config:** `AGENTCORE_RUNTIME_ARN` already exists in `config.ts`. Treat it
  as a direct HTTP endpoint URL. In production, may need ARN-to-URL resolver.

### channelType Fix

Thread `channelType` from webhook → SQS payload → `InvocationPayload` →
agent-runtime env `CLAWBOT_CHANNEL_TYPE` → MCP tools.

For scheduled tasks, look up `group.channelType` from DynamoDB.

Remove all hardcoded `'telegram'` fallbacks in `agent.ts:207-209`,
`mcp-server.ts:51`, and `dispatcher.ts:215`.

---

## 2. EventBridge Scheduler in Control Plane (P1)

The agent-runtime MCP tools already create EventBridge schedules. The REST API
(`POST /api/bots/:botId/tasks`) needs the same integration.

**On task create:** Create EventBridge Schedule `clawbot-{botId}-{taskId}` with
SQS FIFO target and `MessageGroupId = {botId}#{groupJid}`.

**On task delete:** Delete EventBridge Schedule (ignore ResourceNotFound).

**On task patch (status):** Toggle schedule ENABLED/DISABLED.

**On task patch (schedule):** Update schedule expression.

**Schedule expression conversion:**
- `cron` → `cron({value} *)` (append year wildcard)
- `interval` → `rate(N minutes)` (ms → minutes)
- `once` → `at({iso-timestamp})`

**New config values:**
- `SCHEDULER_ROLE_ARN` — EventBridge assumes this to send to SQS
- `MESSAGE_QUEUE_ARN` — SQS FIFO target for scheduled events

**Timezone:** UTC for now. Per-bot timezone is a future enhancement.

---

## 3. Memory Management APIs (P1)

Six S3-backed endpoints for reading/writing CLAUDE.md files:

| Endpoint | S3 Key | Scope |
|----------|--------|-------|
| `GET/PUT /api/shared-memory` | `{userId}/shared/CLAUDE.md` | User-wide |
| `GET/PUT /api/bots/:botId/memory` | `{userId}/{botId}/memory/global/CLAUDE.md` | Bot-wide |
| `GET/PUT /api/bots/:botId/groups/:gid/memory` | `{userId}/{botId}/memory/{gid}/CLAUDE.md` | Group |

**Rules:**
- JWT auth required, scoped to authenticated user
- Bot ownership verified via DynamoDB before any S3 access
- `NoSuchKey` → `{ content: '' }` (not 404)
- PUT body: `{ content: string }`, max 100KB, validated with Zod
- ContentType: `text/markdown`
- Uses control-plane's task role (not ABAC scoped)

**File:** New `control-plane/src/routes/api/memory.ts`, registered in
`routes/api/index.ts`.

---

## 4. Quota Enforcement (P1)

### Pre-Dispatch Checks (dispatcher)

1. **Monthly token quota:** If `user.usageTokens >= quota.maxMonthlyTokens`,
   send "quota exceeded" message to channel, delete SQS message.

2. **Concurrent agent limit:** DynamoDB conditional update:
   `SET activeAgents += 1 WHERE activeAgents < quota.maxConcurrentAgents`.
   If fails → don't delete SQS message (retry after visibility timeout).
   Always release slot in `finally` block.

### Resource Creation Checks (API routes)

- Bot create: `activeBots.length < quota.maxBots`
- Group auto-create (webhook): `groups.length < quota.maxGroupsPerBot`
- Task create (API + MCP): `tasks.length < quota.maxTasksPerBot`

### Monthly Reset — Lazy Approach

In `updateUserUsage()`: if `usageMonth !== currentMonth`, reset `usageTokens`
and `usageInvocations` to 0 first. No extra EventBridge rule needed.

### Token Usage Source

Agent-runtime returns `tokensUsed` in `InvocationResult`. Currently always
`undefined` — will be fixed to extract from SDK result messages.

---

## 5. Channel Credential Validation (P2)

`verifyChannelCredentials()` already exists in `channels/index.ts`. Ensure it
is called in the POST handler **before** `CreateSecretCommand`. On failure,
return 400 with clear error message, don't store credentials.

---

## 6. Webhook Auto-Registration (P2)

After credential storage and verification:

| Channel | Auto-Register? | Method |
|---------|---------------|--------|
| Telegram | Yes | `setWebhook()` API call |
| Discord | No | Must configure in Developer Portal — return instructions |
| Slack | No | Must configure Events API URL — return instructions |
| WhatsApp | No | Must configure in Meta Console — return instructions |

On channel delete: call `deleteWebhook()` for Telegram, log warning for others.

**New config:** `WEBHOOK_BASE_URL` — ALB DNS name or custom domain.

---

## 7. Channel Health Check Loop (P2)

**Infrastructure:** Add GSI `healthCheckIndex` to channels table in CDK:
- PK: `healthStatus`
- SK: `lastHealthCheck`

**Service:** `control-plane/src/services/health-checker.ts`
- Runs every 60 minutes (first run 5 min after startup)
- Query GSI for channels needing check
- For each: call `verifyChannelCredentials()`, update health fields
- If `consecutiveFailures >= 3` and not notified: send notification via
  another healthy channel or log warning
- All errors caught and logged, never crashes the loop

---

## 8. WhatsApp Channel Support (P2)

Full implementation:

**`channels/whatsapp.ts`** — Meta Graph API v18.0 client:
- `sendMessage(accessToken, phoneNumberId, to, text)` — POST to messages endpoint
- `verifyCredentials(accessToken, phoneNumberId)` — GET phone number info

**`webhooks/whatsapp.ts`** — Webhook handler:
- `GET /webhook/whatsapp/:botId` — Meta verification challenge
  (`hub.mode=subscribe`, return `hub.challenge`)
- `POST /webhook/whatsapp/:botId` — Process incoming messages
  - HMAC-SHA256 signature verification with `app_secret`
  - Parse `entry[].changes[].value.messages[]` for text messages
  - Extract sender phone, timestamp, message body
  - Store in DynamoDB, check trigger, enqueue to SQS FIFO

**Wiring:**
- Add `'whatsapp'` case to `channels/index.ts` router
- Register routes in `webhooks/index.ts`
- Add `verifyWhatsApp()` to `webhooks/signature.ts`

---

## 9. Multimedia Message Processing (P2)

**Scope:** Images and documents only. Voice/video → "not yet supported" note.

**Webhook pipeline:**
1. Detect attachment (photo, document, voice, video) in webhook payload
2. For image/document: download from channel API, upload to S3
   (`{userId}/{botId}/attachments/{messageId}/{filename}`)
3. Add `Attachment[]` to DynamoDB message record
4. Include attachments in SQS payload → InvocationPayload
5. For voice/video: append `[Voice/Video not yet supported]` to content

**Agent-side:** Downloads from S3 to `/workspace/group/attachments/` using
scoped credentials. Claude handles images via Read tool (multimodal).

**Limits:** 20MB per file, 50MB total per message.

**New file:** `control-plane/src/services/attachments.ts`

**Channel-specific download:**
- Telegram: `getFile(fileId)` → download URL
- Discord: `attachments[].url` → direct download
- Slack: `files[].url_private` → download with Bot token in header
- WhatsApp: `media/{mediaId}` → download URL via API

---

## 10. Missing REST API Endpoints (P3)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/me` | User profile + quota + usage |
| `PUT /api/bots/:botId/groups/:groupJid` | Update group config (name, requiresTrigger) |
| `PUT /api/bots/:botId/channels/:channelKey` | Update credentials, re-verify, re-register webhook, reset health |
| `POST /api/bots/:botId/channels/:channelKey/test` | Test channel connection |

**New dynamo methods:** `updateGroup(botId, groupJid, updates)`

**New file:** `control-plane/src/routes/api/user.ts` for `/api/me`

---

## 11. Bot Lifecycle State Machine (P3)

Expand `BotStatus` from `'active' | 'deleted'` to
`'created' | 'active' | 'paused' | 'deleted'`.

**Transitions:**
- New bot → `'created'`
- First channel added → `'active'`
- User pauses → `'paused'`
- User resumes → `'active'`
- User deletes → `'deleted'` (soft)

**Enforcement:** Webhooks skip bots where `status !== 'active'`.

---

## 12. Agent Runtime Fixes (P3)

**`/ping` busy state:** Track `busy` boolean, return `HealthyBusy` when
`handleInvocation` is running.

**Token tracking:** In the `query()` loop, extract `usage.input_tokens` and
`usage.output_tokens` from result messages. Sum into `tokensUsed`.

**Session switch detection:** Track `currentSessionKey = {botId}#{groupJid}`.
If it changes between invocations, call `cleanLocalWorkspace()` (rm -rf
`/workspace/group/*`, `/workspace/global/*`, `/home/node/.claude/*`) and
recreate directories. Reset scoped credentials.

---

## 13. ECS Auto Scaling (P3)

Add to `control-plane-stack.ts`:

- `minCapacity: 2`, `maxCapacity: 10`
- Step scaling on `ApproximateNumberOfMessagesVisible`:
  - 50+ messages → +1 task
  - 200+ messages → +2 tasks
  - 0 messages for 30 min → -1 task (never below 2)
- Cooldown: 3 min (up), 30 min (down)

---

## 14. Web Console Enhancements (P3)

Functional-but-minimal pages:

**MemoryEditor.tsx:**
- Textarea + save button
- Level selector: shared / bot-global / group
- Routes: `/memory`, `/bots/:botId/memory`, `/bots/:botId/groups/:gid/memory`

**Dashboard usage stats:**
- Fetch `GET /api/me`, display token count / quota, invocation count

**BotDetail memory links:**
- Link to `/bots/:botId/memory` for bot-global memory
- Per-group links to group memory

**Deferred:** Logs page (needs CloudWatch Logs integration — separate effort).

---

## CDK Infrastructure Changes Summary

1. **foundation-stack.ts:** Add GSI `healthCheckIndex` to channels table
2. **control-plane-stack.ts:** Add auto-scaling configuration, add new env vars
   (`SCHEDULER_ROLE_ARN`, `MESSAGE_QUEUE_ARN`, `WEBHOOK_BASE_URL`)
3. No new stacks needed
