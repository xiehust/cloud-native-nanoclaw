# Close All Architecture-to-Implementation Gaps

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close every gap between `docs/CLOUD_ARCHITECTURE.md` and the current codebase so the platform works end-to-end and matches the design.

**Architecture:** The platform is an NPM workspaces monorepo (shared, control-plane, agent-runtime, infra, web-console). Control Plane is Fastify on ECS Fargate. Agent Runtime runs in AgentCore microVMs. All AWS. Changes span all 5 packages.

**Tech Stack:** TypeScript 5.7, Fastify 5, AWS SDK v3, AWS CDK 2.170, Claude Agent SDK, MCP SDK, React 19, Vite 6, Vitest 2, Zod 4, Pino, DynamoDB, SQS FIFO, S3, EventBridge Scheduler, Cognito, CloudFront.

---

## Task 1: AgentCore Runtime Integration in Dispatcher (P0)

The SQS dispatcher currently returns a hardcoded error instead of calling AgentCore. This is the single biggest gap — nothing works without it.

**Files:**
- Modify: `control-plane/src/sqs/dispatcher.ts:231-258`
- Modify: `control-plane/src/config.ts` (verify `AGENTCORE_RUNTIME_ARN` exists)
- Test: `control-plane/src/__tests__/dispatcher.test.ts` (create)

**Context:** The design says the dispatcher should call AgentCore Runtime via its API. AgentCore exposes an HTTP-based invocation API. The `config.ts` already has `AGENTCORE_RUNTIME_ARN`. The `InvocationPayload` type is defined in `shared/src/types.ts`. The agent-runtime's `/invocations` endpoint accepts this payload and returns `InvocationResult`.

**Step 1: Write the failing test**

Create `control-plane/src/__tests__/dispatcher.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// We'll test the invokeAgent function in isolation.
// Since it's currently a module-private function, we need to either:
// a) Export it for testing, or b) Test via dispatchMessage.
// For now, we'll test the integration through a mock of the HTTP call.

describe('invokeAgent', () => {
  it('should POST to AgentCore runtime and return the result', async () => {
    // Test will be filled after we decide on the invocation mechanism
    expect(true).toBe(false); // placeholder — fails
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -w control-plane -- --run`
Expected: FAIL

**Step 3: Implement AgentCore invocation**

Replace the placeholder `invokeAgent()` in `control-plane/src/sqs/dispatcher.ts:231-258` with a real HTTP call to AgentCore. The AgentCore Runtime API uses `InvokeAgentRuntime` — for the MVP, implement as an HTTP POST to the runtime endpoint.

```typescript
import { InvocationPayload, InvocationResult } from '@clawbot/shared/types';

async function invokeAgent(
  payload: InvocationPayload,
  logger: Logger,
): Promise<InvocationResult> {
  const runtimeArn = config.agentcore.runtimeArn;
  if (!runtimeArn) {
    logger.error('AGENTCORE_RUNTIME_ARN not configured');
    return { status: 'error', result: null, error: 'AgentCore runtime not configured' };
  }

  logger.info(
    { botId: payload.botId, groupJid: payload.groupJid, isScheduledTask: payload.isScheduledTask },
    'Invoking AgentCore runtime',
  );

  try {
    // AgentCore Runtime invocation via AWS SDK or HTTP
    // The exact mechanism depends on the AgentCore API:
    // Option A: AWS SDK InvokeAgentRuntime (if using AgentCore SDK)
    // Option B: HTTP POST to runtime endpoint
    //
    // Using HTTP POST for now — AgentCore exposes /invocations on the runtime.
    // The runtime ARN maps to an endpoint via AgentCore service discovery.
    const response = await fetch(runtimeArn, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.error({ status: response.status, body: errText }, 'AgentCore invocation failed');
      return { status: 'error', result: null, error: `AgentCore HTTP ${response.status}: ${errText}` };
    }

    const body = await response.json() as { output: InvocationResult };
    return body.output;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'AgentCore invocation error');
    return { status: 'error', result: null, error: message };
  }
}
```

> **Note:** The exact invocation mechanism depends on how AgentCore is deployed. If using the AgentCore SDK (`@aws/agentcore-client` or similar), replace `fetch()` with the SDK call. The `runtimeArn` config value should point to the appropriate endpoint. Adjust based on your AgentCore setup.

**Step 4: Update the test with a proper mock**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('invokeAgent', () => {
  it('should return success result from AgentCore', async () => {
    const mockResult = { status: 'success' as const, result: 'Hello!', newSessionId: 'sess-1' };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ output: mockResult }),
    });

    // Import after mocking
    const { invokeAgent } = await import('../sqs/dispatcher.js');
    const result = await invokeAgent(
      { botId: 'b1', botName: 'Test', groupJid: 'g1', userId: 'u1', prompt: 'hi', sessionPath: 's3://...', memoryPaths: { shared: '', botGlobal: '', group: '' } } as any,
      { info: vi.fn(), error: vi.fn() } as any,
    );

    expect(result.status).toBe('success');
    expect(result.result).toBe('Hello!');
  });

  it('should return error when runtime is not configured', async () => {
    // Test with empty runtimeArn
  });
});
```

> **Important:** To make `invokeAgent` testable, export it from `dispatcher.ts`. Add `export` before `async function invokeAgent`.

**Step 5: Run test to verify it passes**

Run: `npm test -w control-plane -- --run`
Expected: PASS

**Step 6: Commit**

```bash
git add control-plane/src/sqs/dispatcher.ts control-plane/src/__tests__/dispatcher.test.ts
git commit -m "feat(control-plane): integrate AgentCore runtime invocation in dispatcher"
```

---

## Task 2: Fix channelType Hardcoding (P0)

Channel type is hardcoded to `'telegram'` in three places. Must flow from the actual group/channel data.

**Files:**
- Modify: `agent-runtime/src/agent.ts:207-209` — pass channelType from payload
- Modify: `control-plane/src/sqs/dispatcher.ts:75,215` — resolve channelType from group
- Modify: `shared/src/types.ts` — ensure `InvocationPayload` includes `channelType`

**Step 1: Add channelType to InvocationPayload**

In `shared/src/types.ts`, verify `InvocationPayload` has a `channelType` field. If not, add:

```typescript
export interface InvocationPayload {
  // ... existing fields ...
  channelType: ChannelType;
}
```

**Step 2: Pass channelType in dispatcher**

In `control-plane/src/sqs/dispatcher.ts`, the inbound SQS message already contains `channelType` (set by webhook handlers). Pass it through to the `InvocationPayload`:

```typescript
// In dispatchInboundMessage(), around line 75:
const channelType = sqsPayload.channelType; // already in SqsInboundPayload

// In the InvocationPayload construction:
const invocationPayload: InvocationPayload = {
  // ... existing fields ...
  channelType,
};
```

For scheduled tasks (line 215), look up the group to get channelType:

```typescript
// In dispatchScheduledTask():
const group = await dynamo.getOrCreateGroup(botId, groupJid, '', 'telegram', false);
const channelType = group.channelType as ChannelType;
```

**Step 3: Use channelType from payload in agent-runtime**

In `agent-runtime/src/agent.ts:207-209`, replace:

```typescript
CLAWBOT_CHANNEL_TYPE: payload.attachments?.[0]
  ? 'telegram'
  : 'telegram',
```

With:

```typescript
CLAWBOT_CHANNEL_TYPE: payload.channelType || 'telegram',
```

**Step 4: Build and verify types**

Run: `npm run build -w shared && npm run typecheck -w control-plane && npm run typecheck -w agent-runtime`
Expected: No errors

**Step 5: Commit**

```bash
git add shared/src/types.ts control-plane/src/sqs/dispatcher.ts agent-runtime/src/agent.ts
git commit -m "fix: pass actual channelType through invocation pipeline instead of hardcoding telegram"
```

---

## Task 3: EventBridge Scheduler Integration in Control Plane (P1)

The agent-runtime MCP tools already create EventBridge schedules. The control-plane REST API for tasks does not — it has TODOs at `tasks.ts:73-75` and `tasks.ts:143`.

**Files:**
- Modify: `control-plane/src/routes/api/tasks.ts:73-75,143`
- Modify: `control-plane/src/config.ts` — add scheduler role ARN + message queue ARN configs
- Test: `control-plane/src/__tests__/tasks-api.test.ts` (create)

**Step 1: Add config for scheduler**

In `control-plane/src/config.ts`, add (if not already present):

```typescript
scheduler: {
  roleArn: process.env.SCHEDULER_ROLE_ARN || '',
  messageQueueArn: process.env.MESSAGE_QUEUE_ARN || '',
},
```

**Step 2: Implement EventBridge schedule creation in POST handler**

In `control-plane/src/routes/api/tasks.ts`, after the DynamoDB write (line 73-75), add:

```typescript
import { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand } from '@aws-sdk/client-scheduler';
import config from '../../config.js';

const scheduler = new SchedulerClient({ region: config.region });

// Inside POST handler, after createTask():
if (config.scheduler.roleArn && config.scheduler.messageQueueArn) {
  const scheduleName = `clawbot-${botId}-${task.taskId}`;
  const scheduleExpression = task.scheduleType === 'cron'
    ? `cron(${task.scheduleValue} *)`  // append year field for EventBridge
    : task.scheduleType === 'interval'
      ? `rate(${Math.round(parseInt(task.scheduleValue) / 60000)} minutes)`
      : `at(${task.scheduleValue})`;

  await scheduler.send(new CreateScheduleCommand({
    Name: scheduleName,
    ScheduleExpression: scheduleExpression,
    ScheduleExpressionTimezone: 'UTC',
    FlexibleTimeWindow: { Mode: 'OFF' },
    Target: {
      Arn: config.scheduler.messageQueueArn,
      RoleArn: config.scheduler.roleArn,
      Input: JSON.stringify({
        type: 'scheduled_task',
        botId,
        taskId: task.taskId,
        groupJid: body.groupJid,
        prompt: body.prompt,
      }),
      SqsParameters: { MessageGroupId: `${botId}#${body.groupJid}` },
    },
    State: 'ENABLED',
  }));
}
```

**Step 3: Implement EventBridge schedule deletion in DELETE handler**

At `tasks.ts:143`, before `deleteTask()`:

```typescript
try {
  await scheduler.send(new DeleteScheduleCommand({
    Name: `clawbot-${botId}-${taskId}`,
  }));
} catch (err: any) {
  if (err.name !== 'ResourceNotFoundException') {
    request.log.error({ err }, 'Failed to delete EventBridge schedule');
  }
}
```

**Step 4: Add PATCH handler schedule update support**

When a task's status changes to 'paused' or schedule changes, update the EventBridge schedule accordingly. Add `UpdateScheduleCommand` import and use it in the PATCH handler.

**Step 5: Build and verify**

Run: `npm run typecheck -w control-plane`
Expected: No errors

**Step 6: Commit**

```bash
git add control-plane/src/routes/api/tasks.ts control-plane/src/config.ts
git commit -m "feat(control-plane): integrate EventBridge Scheduler for task create/delete/update"
```

---

## Task 4: Memory Management APIs (P1)

Design specifies 6 memory endpoints that don't exist. These let users read/edit shared, bot-global, and group-level CLAUDE.md files via the web console.

**Files:**
- Create: `control-plane/src/routes/api/memory.ts`
- Modify: `control-plane/src/routes/api/index.ts` — register new routes
- Modify: `web-console/src/lib/api.ts` — add memory API client methods
- Test: `control-plane/src/__tests__/memory-api.test.ts` (create)

**Step 1: Create memory routes**

Create `control-plane/src/routes/api/memory.ts`:

```typescript
import { FastifyPluginAsync } from 'fastify';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import config from '../../config.js';

const s3 = new S3Client({ region: config.region });

const memoryRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/shared-memory
  app.get('/shared-memory', async (request) => {
    const userId = request.userId;
    const key = `${userId}/shared/CLAUDE.md`;
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: config.dataBucket, Key: key }));
      const content = await obj.Body!.transformToString();
      return { content };
    } catch (err: any) {
      if (err.name === 'NoSuchKey') return { content: '' };
      throw err;
    }
  });

  // PUT /api/shared-memory
  app.put('/shared-memory', async (request) => {
    const userId = request.userId;
    const { content } = request.body as { content: string };
    const key = `${userId}/shared/CLAUDE.md`;
    await s3.send(new PutObjectCommand({ Bucket: config.dataBucket, Key: key, Body: content, ContentType: 'text/markdown' }));
    return { ok: true };
  });

  // GET /api/bots/:botId/memory
  app.get('/bots/:botId/memory', async (request) => {
    const { botId } = request.params as { botId: string };
    const userId = request.userId;
    // Verify ownership
    const bot = await import('../../services/dynamo.js').then(d => d.getBot(userId, botId));
    if (!bot) return request.server.httpErrors.notFound('Bot not found');
    const key = `${userId}/${botId}/memory/global/CLAUDE.md`;
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: config.dataBucket, Key: key }));
      return { content: await obj.Body!.transformToString() };
    } catch (err: any) {
      if (err.name === 'NoSuchKey') return { content: '' };
      throw err;
    }
  });

  // PUT /api/bots/:botId/memory
  app.put('/bots/:botId/memory', async (request) => {
    const { botId } = request.params as { botId: string };
    const userId = request.userId;
    const bot = await import('../../services/dynamo.js').then(d => d.getBot(userId, botId));
    if (!bot) return request.server.httpErrors.notFound('Bot not found');
    const { content } = request.body as { content: string };
    const key = `${userId}/${botId}/memory/global/CLAUDE.md`;
    await s3.send(new PutObjectCommand({ Bucket: config.dataBucket, Key: key, Body: content, ContentType: 'text/markdown' }));
    return { ok: true };
  });

  // GET /api/bots/:botId/groups/:groupJid/memory
  app.get('/bots/:botId/groups/:groupJid/memory', async (request) => {
    const { botId, groupJid } = request.params as { botId: string; groupJid: string };
    const userId = request.userId;
    const bot = await import('../../services/dynamo.js').then(d => d.getBot(userId, botId));
    if (!bot) return request.server.httpErrors.notFound('Bot not found');
    const key = `${userId}/${botId}/memory/${groupJid}/CLAUDE.md`;
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: config.dataBucket, Key: key }));
      return { content: await obj.Body!.transformToString() };
    } catch (err: any) {
      if (err.name === 'NoSuchKey') return { content: '' };
      throw err;
    }
  });

  // PUT /api/bots/:botId/groups/:groupJid/memory
  app.put('/bots/:botId/groups/:groupJid/memory', async (request) => {
    const { botId, groupJid } = request.params as { botId: string; groupJid: string };
    const userId = request.userId;
    const bot = await import('../../services/dynamo.js').then(d => d.getBot(userId, botId));
    if (!bot) return request.server.httpErrors.notFound('Bot not found');
    const { content } = request.body as { content: string };
    const key = `${userId}/${botId}/memory/${groupJid}/CLAUDE.md`;
    await s3.send(new PutObjectCommand({ Bucket: config.dataBucket, Key: key, Body: content, ContentType: 'text/markdown' }));
    return { ok: true };
  });
};

export default memoryRoutes;
```

**Step 2: Register in API index**

In `control-plane/src/routes/api/index.ts`, add:

```typescript
import memoryRoutes from './memory.js';
// Inside the plugin:
app.register(memoryRoutes);
```

**Step 3: Add web-console API client**

In `web-console/src/lib/api.ts`, add:

```typescript
memory: {
  getShared: () => get<{ content: string }>('/shared-memory'),
  updateShared: (content: string) => put('/shared-memory', { content }),
  getBotGlobal: (botId: string) => get<{ content: string }>(`/bots/${botId}/memory`),
  updateBotGlobal: (botId: string, content: string) => put(`/bots/${botId}/memory`, { content }),
  getGroup: (botId: string, groupJid: string) => get<{ content: string }>(`/bots/${botId}/groups/${encodeURIComponent(groupJid)}/memory`),
  updateGroup: (botId: string, groupJid: string, content: string) => put(`/bots/${botId}/groups/${encodeURIComponent(groupJid)}/memory`, { content }),
},
```

**Step 4: Build and verify**

Run: `npm run typecheck -w control-plane && npm run typecheck -w web-console`
Expected: No errors

**Step 5: Commit**

```bash
git add control-plane/src/routes/api/memory.ts control-plane/src/routes/api/index.ts web-console/src/lib/api.ts
git commit -m "feat(control-plane): add memory management APIs for shared/bot/group CLAUDE.md"
```

---

## Task 5: Usage Quota Checks (P1)

Design specifies quota enforcement before dispatching agents. Currently `updateUserUsage` is called but no pre-dispatch quota check exists.

**Files:**
- Modify: `control-plane/src/sqs/dispatcher.ts` — add quota check before invokeAgent
- Modify: `control-plane/src/services/dynamo.ts` — add `checkAndAcquireAgentSlot` and `releaseAgentSlot`
- Modify: `control-plane/src/routes/api/bots.ts` — add bot count check on create
- Test: `control-plane/src/__tests__/quota.test.ts` (create)

**Step 1: Add atomic agent slot operations to dynamo service**

In `control-plane/src/services/dynamo.ts`, add:

```typescript
/**
 * Atomically increment active_agents if under quota.
 * Returns true if slot acquired, false if over quota.
 */
export async function checkAndAcquireAgentSlot(userId: string): Promise<boolean> {
  try {
    await docClient.send(new UpdateCommand({
      TableName: config.tables.users,
      Key: { userId },
      UpdateExpression: 'SET activeAgents = if_not_exists(activeAgents, :zero) + :one',
      ConditionExpression: 'attribute_not_exists(activeAgents) OR activeAgents < quota.maxConcurrentAgents',
      ExpressionAttributeValues: { ':one': 1, ':zero': 0 },
    }));
    return true;
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

export async function releaseAgentSlot(userId: string): Promise<void> {
  await docClient.send(new UpdateCommand({
    TableName: config.tables.users,
    Key: { userId },
    UpdateExpression: 'SET activeAgents = activeAgents - :one',
    ExpressionAttributeValues: { ':one': 1 },
  }));
}
```

**Step 2: Add quota check in dispatcher**

In `control-plane/src/sqs/dispatcher.ts`, before calling `invokeAgent()`:

```typescript
// Check monthly token quota
const user = await dynamo.getUser(userId);
if (user && user.usageTokens >= (user.quota?.maxMonthlyTokens ?? Infinity)) {
  logger.warn({ userId }, 'Monthly token quota exceeded');
  // Send quota-exceeded reply to user
  await storeAndReply(bot, groupJid, channelType, '⚠️ Monthly token quota exceeded. Agent responses paused until next month.');
  return;
}

// Acquire concurrent agent slot
const slotAcquired = await dynamo.checkAndAcquireAgentSlot(userId);
if (!slotAcquired) {
  logger.warn({ userId }, 'Concurrent agent limit reached — message will retry');
  // Don't delete SQS message — it'll become visible again after VisibilityTimeout
  throw new Error('CONCURRENT_LIMIT');
}

try {
  const result = await invokeAgent(payload, logger);
  // ... existing post-invocation logic ...
} finally {
  await dynamo.releaseAgentSlot(userId);
}
```

**Step 3: Add bot count check on create**

In `control-plane/src/routes/api/bots.ts`, in the POST handler before creating the bot:

```typescript
const existingBots = await dynamo.listBots(userId);
const activeBots = existingBots.filter(b => b.status !== 'deleted');
const user = await dynamo.getUser(userId);
const maxBots = user?.quota?.maxBots ?? 3;
if (activeBots.length >= maxBots) {
  return reply.status(403).send({ error: `Bot limit reached (${maxBots}). Upgrade your plan for more.` });
}
```

**Step 4: Build and verify**

Run: `npm run typecheck -w control-plane`
Expected: No errors

**Step 5: Commit**

```bash
git add control-plane/src/sqs/dispatcher.ts control-plane/src/services/dynamo.ts control-plane/src/routes/api/bots.ts
git commit -m "feat(control-plane): add usage quota checks for tokens, concurrency, and bot count"
```

---

## Task 6: Channel Credential Validation on Create (P2)

Design says channel creation should validate the token by calling the channel's API (e.g., Telegram `getMe`) before storing.

**Files:**
- Modify: `control-plane/src/routes/api/channels.ts:63-74`
- Verify: `control-plane/src/channels/index.ts` — `verifyChannelCredentials` already exists

**Step 1: Verify current implementation**

The `channels/index.ts` already has `verifyChannelCredentials()` which calls `telegram.getMe()`, `discord.verifyCredentials()`, and `slack.authTest()`. Check if `channels.ts` actually calls it.

**Step 2: Ensure validation happens before storage**

In `control-plane/src/routes/api/channels.ts`, verify the POST handler calls `verifyChannelCredentials()` and handles failures with a clear error response. If not present, add before the `CreateSecretCommand`:

```typescript
let verifiedInfo: Record<string, string> = {};
try {
  verifiedInfo = await verifyChannelCredentials(body.channelType, body.credentials);
} catch (err) {
  return reply.status(400).send({
    error: `Invalid credentials: ${err instanceof Error ? err.message : 'verification failed'}`,
  });
}
```

**Step 3: Build and verify**

Run: `npm run typecheck -w control-plane`

**Step 4: Commit**

```bash
git add control-plane/src/routes/api/channels.ts
git commit -m "feat(control-plane): validate channel credentials before storing"
```

---

## Task 7: Webhook Auto-Registration and Unregistration (P2)

Design says webhook URLs should be auto-registered on channel create and unregistered on delete.

**Files:**
- Modify: `control-plane/src/routes/api/channels.ts` — POST and DELETE handlers
- Verify: Channel clients have `registerWebhook`/`deleteWebhook` methods

**Step 1: Add webhook registration for all channel types**

In the POST handler in `channels.ts`, after storing credentials, register webhooks for each channel type:

```typescript
const webhookBase = config.webhookBaseUrl; // Add to config
const webhookUrl = `${webhookBase}/webhook/${body.channelType}/${botId}`;

switch (body.channelType) {
  case 'telegram':
    await telegram.setWebhook(body.credentials.botToken, webhookUrl, verifiedInfo.secretToken);
    break;
  // Discord and Slack require manual webhook URL setup in their portals,
  // but we can validate the connection.
}
```

**Step 2: Add webhook unregistration on delete**

In the DELETE handler, before deleting the secret:

```typescript
try {
  const creds = await getChannelCredentials(channel.credentialSecretArn);
  switch (channelType) {
    case 'telegram':
      await telegram.deleteWebhook(creds.botToken);
      break;
  }
} catch (err) {
  request.log.warn({ err }, 'Failed to unregister webhook — continuing with deletion');
}
```

**Step 3: Add `WEBHOOK_BASE_URL` to config**

In `control-plane/src/config.ts`:

```typescript
webhookBaseUrl: process.env.WEBHOOK_BASE_URL || '',
```

**Step 4: Build and verify**

Run: `npm run typecheck -w control-plane`

**Step 5: Commit**

```bash
git add control-plane/src/routes/api/channels.ts control-plane/src/config.ts
git commit -m "feat(control-plane): auto-register/unregister webhooks on channel create/delete"
```

---

## Task 8: Channel Health Check Loop (P2)

Design specifies a periodic health check (every 60 min) that validates channel credentials are still working.

**Files:**
- Create: `control-plane/src/services/health-checker.ts`
- Modify: `control-plane/src/index.ts` — start health check loop

**Step 1: Create health checker module**

```typescript
import { Logger } from 'pino';
import * as dynamo from './dynamo.js';
import { verifyChannelCredentials } from '../channels/index.js';
import { getChannelCredentials } from './cached-lookups.js';

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function startHealthCheckLoop(logger: Logger): void {
  const check = async () => {
    try {
      // Scan all bots, then their channels
      // In production, paginate or use a DynamoDB scan with filter
      logger.info('Starting channel health check cycle');

      // For each channel with status 'connected':
      // 1. Get credentials from Secrets Manager
      // 2. Call verifyChannelCredentials
      // 3. Update health status in DynamoDB
      // 4. If consecutiveFailures >= 3, notify user

      // Implementation: iterate bots → channels → verify
      // This is a background best-effort task; errors are logged, not thrown.
    } catch (err) {
      logger.error({ err }, 'Health check cycle failed');
    }
  };

  // Run first check after 5 minutes (let app warm up)
  setTimeout(() => {
    check();
    setInterval(check, INTERVAL_MS);
  }, 5 * 60 * 1000);
}
```

**Step 2: Wire into index.ts**

In `control-plane/src/index.ts`, after starting consumers:

```typescript
import { startHealthCheckLoop } from './services/health-checker.js';
startHealthCheckLoop(logger);
```

**Step 3: Build and verify**

Run: `npm run typecheck -w control-plane`

**Step 4: Commit**

```bash
git add control-plane/src/services/health-checker.ts control-plane/src/index.ts
git commit -m "feat(control-plane): add periodic channel credential health check loop"
```

---

## Task 9: WhatsApp Channel Support (P2)

Design includes WhatsApp but no webhook handler, signature verification, or channel client exists.

**Files:**
- Create: `control-plane/src/webhooks/whatsapp.ts`
- Create: `control-plane/src/channels/whatsapp.ts`
- Modify: `control-plane/src/webhooks/index.ts` — register WhatsApp routes
- Modify: `control-plane/src/webhooks/signature.ts` — add WhatsApp verification
- Modify: `control-plane/src/channels/index.ts` — add WhatsApp to router

**Step 1: Create WhatsApp channel client**

Create `control-plane/src/channels/whatsapp.ts`:

```typescript
const GRAPH_API = 'https://graph.facebook.com/v18.0';

export async function sendMessage(accessToken: string, phoneNumberId: string, to: string, text: string): Promise<void> {
  const res = await fetch(`${GRAPH_API}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
  });
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${await res.text()}`);
}

export async function verifyCredentials(accessToken: string, phoneNumberId: string): Promise<{ phoneNumber: string }> {
  const res = await fetch(`${GRAPH_API}/${phoneNumberId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`WhatsApp verification failed: ${res.status}`);
  const data = await res.json() as any;
  return { phoneNumber: data.display_phone_number };
}
```

**Step 2: Create WhatsApp webhook handler**

Create `control-plane/src/webhooks/whatsapp.ts` following the same pattern as `telegram.ts`:
- GET handler for Meta webhook verification challenge (`hub.verify_token`)
- POST handler for incoming messages
- HMAC-SHA256 signature verification using `app_secret`
- Parse WhatsApp Cloud API message format → unified Message
- Store in DynamoDB, check trigger, enqueue to SQS FIFO

**Step 3: Add to routers**

In `control-plane/src/channels/index.ts`, add the `'whatsapp'` case to `sendChannelMessage` and `verifyChannelCredentials`.

In `control-plane/src/webhooks/index.ts`, register WhatsApp webhook route.

**Step 4: Build and verify**

Run: `npm run typecheck -w control-plane`

**Step 5: Commit**

```bash
git add control-plane/src/channels/whatsapp.ts control-plane/src/webhooks/whatsapp.ts control-plane/src/channels/index.ts control-plane/src/webhooks/index.ts control-plane/src/webhooks/signature.ts
git commit -m "feat(control-plane): add WhatsApp channel support (webhook, client, signature verification)"
```

---

## Task 10: Multimedia Message Processing (P2)

Design describes attachment download → S3 upload → agent processing pipeline. Currently webhooks only process text.

**Files:**
- Modify: `control-plane/src/webhooks/telegram.ts` — parse attachments
- Modify: `control-plane/src/webhooks/discord.ts` — parse attachments
- Modify: `control-plane/src/webhooks/slack.ts` — parse attachments
- Create: `control-plane/src/services/attachments.ts` — download + S3 upload
- Modify: `control-plane/src/sqs/dispatcher.ts` — pass attachments in payload

**Step 1: Create attachment service**

Create `control-plane/src/services/attachments.ts`:

```typescript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Attachment } from '@clawbot/shared/types';
import config from '../config.js';

const s3 = new S3Client({ region: config.region });
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

export async function downloadAndStore(
  userId: string, botId: string, messageId: string,
  url: string, fileName: string, mimeType: string,
  authHeaders?: Record<string, string>,
): Promise<Attachment | null> {
  const res = await fetch(url, { headers: authHeaders });
  if (!res.ok) return null;

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_FILE_SIZE) return null;

  const s3Key = `${userId}/${botId}/attachments/${messageId}/${fileName}`;
  await s3.send(new PutObjectCommand({
    Bucket: config.dataBucket, Key: s3Key, Body: buffer, ContentType: mimeType,
  }));

  return {
    type: mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('audio/') ? 'voice' : 'document',
    s3Key, fileName, mimeType, size: buffer.length,
  };
}
```

**Step 2: Parse attachments in Telegram webhook**

In `control-plane/src/webhooks/telegram.ts`, after extracting the message, check for `photo`, `document`, `voice`, `video` fields. For each, call `telegram.getFile(botToken, fileId)` to get the download URL, then `downloadAndStore()`.

**Step 3: Similar for Discord (attachments array) and Slack (files array)**

**Step 4: Pass attachments array through SQS → dispatcher → InvocationPayload**

**Step 5: Build and verify**

Run: `npm run typecheck -w control-plane`

**Step 6: Commit**

```bash
git add control-plane/src/services/attachments.ts control-plane/src/webhooks/telegram.ts control-plane/src/webhooks/discord.ts control-plane/src/webhooks/slack.ts control-plane/src/sqs/dispatcher.ts
git commit -m "feat(control-plane): add multimedia message handling (download, S3 upload, pass to agent)"
```

---

## Task 11: Missing REST API Endpoints (P3)

Several endpoints from the design are not implemented.

**Files:**
- Create: `control-plane/src/routes/api/user.ts` — GET /api/me
- Modify: `control-plane/src/routes/api/groups.ts` — add PUT /:groupId
- Modify: `control-plane/src/routes/api/channels.ts` — add PUT /:channelKey, POST /:channelKey/test
- Modify: `control-plane/src/routes/api/index.ts` — register user routes

**Step 1: Create GET /api/me**

```typescript
// control-plane/src/routes/api/user.ts
import { FastifyPluginAsync } from 'fastify';
import * as dynamo from '../../services/dynamo.js';

const userRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', async (request) => {
    const user = await dynamo.getUser(request.userId);
    if (!user) return { userId: request.userId, email: request.userEmail };
    const { quota, usageTokens, usageInvocations, usageMonth, plan, ...rest } = user;
    return { ...rest, plan, quota, usage: { tokens: usageTokens, invocations: usageInvocations, month: usageMonth } };
  });
};
export default userRoutes;
```

**Step 2: Add PUT /api/bots/:botId/groups/:groupJid**

In `control-plane/src/routes/api/groups.ts`:

```typescript
app.put('/:groupJid', async (request, reply) => {
  const { botId, groupJid } = request.params as { botId: string; groupJid: string };
  const updates = request.body as { name?: string; requiresTrigger?: boolean };
  // Verify bot ownership...
  // Update group in DynamoDB
  await dynamo.updateGroup(botId, groupJid, updates);
  return { ok: true };
});
```

> Note: `updateGroup` may need to be added to `dynamo.ts`.

**Step 3: Add PUT /api/bots/:botId/channels/:channelKey** (update credentials)

In `channels.ts`, add handler that:
1. Validates new credentials
2. Updates Secrets Manager secret
3. Re-registers webhook with new token
4. Resets health status

**Step 4: Add POST /api/bots/:botId/channels/:channelKey/test** (test connection)

```typescript
app.post('/:channelKey/test', async (request) => {
  // Load credentials, call verifyChannelCredentials, return result
});
```

**Step 5: Register user routes in index**

**Step 6: Build and verify**

Run: `npm run typecheck -w control-plane`

**Step 7: Commit**

```bash
git add control-plane/src/routes/api/user.ts control-plane/src/routes/api/groups.ts control-plane/src/routes/api/channels.ts control-plane/src/routes/api/index.ts control-plane/src/services/dynamo.ts
git commit -m "feat(control-plane): add missing API endpoints (GET /me, PUT group, PUT/test channel)"
```

---

## Task 12: Bot Lifecycle State Machine (P3)

Design shows `created → ready → active → paused → deleted`. Currently only `active` and `deleted`.

**Files:**
- Modify: `shared/src/types.ts` — expand BotStatus type
- Modify: `control-plane/src/routes/api/bots.ts` — enforce state transitions
- Modify: `control-plane/src/routes/api/channels.ts` — auto-activate bot on first channel add
- Modify: `control-plane/src/webhooks/*.ts` — check bot status before processing

**Step 1: Update Bot status type**

In `shared/src/types.ts`:

```typescript
export type BotStatus = 'created' | 'ready' | 'active' | 'paused' | 'deleted';
```

**Step 2: Set initial status to 'created' on bot creation**

In `bots.ts` POST handler, set `status: 'created'` instead of `'active'`.

**Step 3: Auto-transition to 'active' when first channel is added**

In `channels.ts` POST handler, after storing the channel:

```typescript
const bot = await dynamo.getBot(userId, botId);
if (bot && (bot.status === 'created' || bot.status === 'ready')) {
  await dynamo.updateBot(userId, botId, { status: 'active' });
}
```

**Step 4: Add state transition validation**

In `bots.ts` PUT handler, validate transitions (e.g., can't go from `deleted` to `active`).

**Step 5: Check bot status in webhooks**

In each webhook handler, after loading the bot, check:

```typescript
if (bot.status !== 'active') {
  request.log.info({ botId, status: bot.status }, 'Bot not active — ignoring message');
  return reply.send({ ok: true });
}
```

**Step 6: Build and verify**

Run: `npm run build -w shared && npm run typecheck -w control-plane`

**Step 7: Commit**

```bash
git add shared/src/types.ts control-plane/src/routes/api/bots.ts control-plane/src/routes/api/channels.ts control-plane/src/webhooks/telegram.ts control-plane/src/webhooks/discord.ts control-plane/src/webhooks/slack.ts
git commit -m "feat: implement bot lifecycle state machine (created → active → paused → deleted)"
```

---

## Task 13: Agent Runtime Fixes — Ping Busy State, Token Tracking, Session Switch (P3)

Three small fixes in agent-runtime.

**Files:**
- Modify: `agent-runtime/src/server.ts` — add HealthyBusy response
- Modify: `agent-runtime/src/agent.ts` — track tokens, detect session switch

**Step 1: Add busy state tracking to /ping**

In `agent-runtime/src/server.ts`:

```typescript
let busy = false;
export function setBusy() { busy = true; }
export function setIdle() { busy = false; }

app.get('/ping', async () => ({
  status: busy ? 'HealthyBusy' : 'Healthy',
}));
```

In `agent-runtime/src/agent.ts`, call `setBusy()` at start and `setIdle()` in finally block of `handleInvocation`.

**Step 2: Extract token usage from SDK messages**

In `agent-runtime/src/agent.ts`, in the query loop, look for usage data in messages:

```typescript
for await (const message of queryStream) {
  // Track token usage from result messages
  if (message.type === 'result' && 'usage' in message) {
    const usage = (message as any).usage;
    if (usage?.input_tokens) tokensUsed += usage.input_tokens;
    if (usage?.output_tokens) tokensUsed += usage.output_tokens;
  }
  // ... existing message handling ...
}
```

**Step 3: Add session switch detection**

Add `cleanLocalWorkspace()` and session key tracking as described in the architecture doc (section 9.4):

```typescript
let currentSessionKey: string | null = null;

// At start of handleInvocation:
const sessionKey = `${payload.botId}#${payload.groupJid}`;
if (currentSessionKey !== null && currentSessionKey !== sessionKey) {
  logger.warn({ from: currentSessionKey, to: sessionKey }, 'Session switch detected — clearing workspace');
  await cleanLocalWorkspace();
}
currentSessionKey = sessionKey;
```

**Step 4: Build and verify**

Run: `npm run typecheck -w agent-runtime`

**Step 5: Commit**

```bash
git add agent-runtime/src/server.ts agent-runtime/src/agent.ts
git commit -m "fix(agent-runtime): add ping busy state, token tracking, session switch detection"
```

---

## Task 14: ECS Auto Scaling (P3)

Design specifies auto-scaling based on SQS queue depth. Currently fixed at 2 tasks.

**Files:**
- Modify: `infra/lib/control-plane-stack.ts` — add auto-scaling configuration

**Step 1: Add auto-scaling to ECS service**

In `infra/lib/control-plane-stack.ts`, after the service definition:

```typescript
const scaling = service.autoScaleTaskCount({
  minCapacity: 2,
  maxCapacity: 10,
});

// Scale based on SQS queue depth
scaling.scaleOnMetric('SqsQueueDepthScaling', {
  metric: props.messageQueue.metricApproximateNumberOfMessagesVisible(),
  scalingSteps: [
    { upper: 0, change: 0 },       // At 0 messages, don't scale
    { lower: 50, change: +1 },     // At 50+ messages, add 1
    { lower: 200, change: +2 },    // At 200+ messages, add 2
  ],
  adjustmentType: cdk.aws_applicationautoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
  cooldown: cdk.Duration.minutes(3),
});

// Scale in when idle
scaling.scaleOnMetric('SqsQueueIdleScaling', {
  metric: props.messageQueue.metricApproximateNumberOfMessagesVisible(),
  scalingSteps: [
    { upper: 0, change: -1 },
  ],
  adjustmentType: cdk.aws_applicationautoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
  cooldown: cdk.Duration.minutes(30),
});
```

**Step 2: Build and verify**

Run: `npm run typecheck -w infra`

**Step 3: Commit**

```bash
git add infra/lib/control-plane-stack.ts
git commit -m "feat(infra): add ECS auto-scaling based on SQS queue depth"
```

---

## Task 15: Web Console Enhancements (P3)

Missing pages: usage statistics, memory editing, user-visible logs.

**Files:**
- Create: `web-console/src/pages/MemoryEditor.tsx` — edit shared/bot/group memory
- Modify: `web-console/src/pages/Dashboard.tsx` — show usage stats
- Modify: `web-console/src/pages/BotDetail.tsx` — add memory edit links
- Modify: `web-console/src/App.tsx` — add new routes
- Modify: `web-console/src/lib/api.ts` — ensure memory API methods exist (done in Task 4)

**Step 1: Create MemoryEditor page**

Create `web-console/src/pages/MemoryEditor.tsx`:

```tsx
import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';

export default function MemoryEditor() {
  const { botId, groupJid } = useParams();
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [level, setLevel] = useState<'shared' | 'bot' | 'group'>('shared');

  useEffect(() => {
    loadMemory();
  }, [level, botId, groupJid]);

  async function loadMemory() {
    let result;
    if (level === 'shared') result = await api.memory.getShared();
    else if (level === 'bot' && botId) result = await api.memory.getBotGlobal(botId);
    else if (level === 'group' && botId && groupJid) result = await api.memory.getGroup(botId, groupJid);
    if (result) setContent(result.content);
  }

  async function saveMemory() {
    setSaving(true);
    if (level === 'shared') await api.memory.updateShared(content);
    else if (level === 'bot' && botId) await api.memory.updateBotGlobal(botId, content);
    else if (level === 'group' && botId && groupJid) await api.memory.updateGroup(botId, groupJid, content);
    setSaving(false);
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-4">Memory Editor</h1>
      {/* Level selector tabs, textarea, save button */}
      <textarea className="w-full h-96 font-mono text-sm border rounded p-3"
        value={content} onChange={e => setContent(e.target.value)} />
      <button onClick={saveMemory} disabled={saving}
        className="mt-2 px-4 py-2 bg-blue-600 text-white rounded">
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  );
}
```

**Step 2: Add route in App.tsx**

```tsx
<Route path="/memory" element={<MemoryEditor />} />
<Route path="/bots/:botId/memory" element={<MemoryEditor />} />
<Route path="/bots/:botId/groups/:groupJid/memory" element={<MemoryEditor />} />
```

**Step 3: Add usage stats to Dashboard**

In `Dashboard.tsx`, fetch user info via `api.user.me()` (add this API method if needed) and display usage:

```tsx
<div className="mb-6 p-4 bg-gray-50 rounded">
  <h2>Usage This Month</h2>
  <p>Tokens: {user?.usage?.tokens?.toLocaleString()} / {user?.quota?.maxMonthlyTokens?.toLocaleString()}</p>
  <p>Invocations: {user?.usage?.invocations}</p>
</div>
```

**Step 4: Add memory edit links in BotDetail**

In `BotDetail.tsx`, add links to `/bots/{botId}/memory` and per-group memory links.

**Step 5: Build and verify**

Run: `npm run build -w web-console`

**Step 6: Commit**

```bash
git add web-console/src/pages/MemoryEditor.tsx web-console/src/App.tsx web-console/src/pages/Dashboard.tsx web-console/src/pages/BotDetail.tsx
git commit -m "feat(web-console): add memory editor, usage stats dashboard, and memory navigation"
```

---

## Dependency Order

```
Task 1 (AgentCore integration) — standalone, highest priority
Task 2 (channelType fix) — standalone, can parallel with Task 1
Task 3 (EventBridge CP) — standalone
Task 4 (Memory APIs) — standalone
Task 5 (Quota checks) — depends on Task 1 (needs working dispatch)
Task 6 (Credential validation) — standalone
Task 7 (Webhook registration) — depends on Task 6
Task 8 (Health check) — depends on Task 6
Task 9 (WhatsApp) — standalone, large
Task 10 (Multimedia) — standalone, large
Task 11 (Missing endpoints) — depends on Task 4 (memory routes)
Task 12 (Bot lifecycle) — standalone
Task 13 (Runtime fixes) — standalone
Task 14 (Auto scaling) — standalone
Task 15 (Web console) — depends on Task 4, Task 11
```

Parallelizable groups:
- **Group A:** Tasks 1, 2, 3, 4 (all standalone P0/P1)
- **Group B:** Tasks 5, 6, 9, 12, 13, 14 (after Group A)
- **Group C:** Tasks 7, 8, 10, 11, 15 (after dependencies)
