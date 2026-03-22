# Model Providers Refactor — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace per-user Anthropic API key configuration with admin-managed global Model Providers. Users select from admin-configured providers and model IDs per bot.

**Architecture:** New `providers` DynamoDB table holds global provider configs (name, type, baseUrl, modelIds). Admin CRUD via `/api/admin/providers`. Public read-only list via `/api/providers`. Bot schema changes from `model`/`modelProvider` to `providerId`/`modelId`. Dispatcher resolves credentials from providers table instead of per-user secrets.

**Tech Stack:** TypeScript, Fastify, DynamoDB, Secrets Manager, Zod, React, Vitest

---

## Task 1: Add Provider Type to Shared Types

**Files:**
- Modify: `shared/src/types.ts:63-83`

**Step 1: Update ModelProvider type and add Provider interface**

Replace lines 63-83 in `shared/src/types.ts`:

```typescript
// --- Model Provider ---

export type ProviderType = 'bedrock' | 'anthropic-compatible-api';

/** @deprecated Use ProviderType instead — kept only for Session.lastModelProvider backward compat */
export type ModelProvider = 'bedrock' | 'anthropic-api';

export interface Provider {
  providerId: string;
  providerName: string;
  providerType: ProviderType;
  baseUrl?: string;
  hasApiKey: boolean;
  modelIds: string[];
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

// --- Bot (DynamoDB: bots table, PK=userId, SK=botId) ---
// Evolved from NanoClaw's RegisteredGroup

export interface Bot {
  userId: string;
  botId: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  triggerPattern: string;
  providerId?: string;   // References providers table
  modelId?: string;      // One of provider's modelIds
  /** @deprecated Use providerId/modelId — kept for migration reads */
  model?: string;
  /** @deprecated Use providerId/modelId — kept for migration reads */
  modelProvider?: ModelProvider;
  status: 'created' | 'active' | 'paused' | 'deleted';
  containerConfig?: BotContainerConfig;
  createdAt: string;
  updatedAt: string;
}
```

**Step 2: Update InvocationPayload**

In `shared/src/types.ts`, update the `InvocationPayload` interface (lines 221-245). Replace the `model?`, `modelProvider?`, `anthropicApiKey?`, `anthropicBaseUrl?` fields:

```typescript
export interface InvocationPayload {
  botId: string;
  botName: string;
  groupJid: string;
  userId: string;
  channelType: ChannelType;
  prompt: string;
  systemPrompt?: string;
  model?: string;
  modelProvider?: ModelProvider;
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
  providerType?: ProviderType;   // NEW: from providers table
  sessionPath: string;
  memoryPaths: MemoryPaths;
  attachments?: Attachment[];
  isScheduledTask?: boolean;
  isGroupChat?: boolean;
  maxTurns?: number;
  feishu?: FeishuInvocationConfig;
  forceNewSession?: boolean;
  proxyRules?: InvocationProxyRule[];
}
```

**Step 3: Update CreateBotRequest and UpdateBotRequest**

Replace `model`/`modelProvider` with `providerId`/`modelId`:

```typescript
export interface CreateBotRequest {
  name: string;
  description?: string;
  systemPrompt?: string;
  triggerPattern?: string;
  providerId?: string;
  modelId?: string;
}

export interface UpdateBotRequest {
  name?: string;
  description?: string;
  systemPrompt?: string;
  triggerPattern?: string;
  providerId?: string;
  modelId?: string;
  status?: 'active' | 'paused' | 'deleted';
}
```

**Step 4: Build shared to verify compilation**

Run: `npm run build -w shared`
Expected: Build succeeds (downstream packages will have type errors — that's expected).

**Step 5: Commit**

```bash
git add shared/src/types.ts
git commit -m "refactor: add Provider type, update Bot to use providerId/modelId"
```

---

## Task 2: CDK — Add Providers DynamoDB Table

**Files:**
- Modify: `infra/lib/foundation-stack.ts:20-27,101-173`

**Step 1: Add providersTable property and table definition**

In `foundation-stack.ts`, add to the class property list (after line 26):

```typescript
public readonly providersTable: dynamodb.Table;
```

After the sessions table definition (line 173), before the stack outputs section, add:

```typescript
    // 8. Providers table (global model provider configs, admin-managed)
    this.providersTable = new dynamodb.Table(this, 'ProvidersTable', {
      ...tableDefaults,
      tableName: `nanoclawbot-${stage}-providers`,
      partitionKey: { name: 'providerId', type: dynamodb.AttributeType.STRING },
      pointInTimeRecovery: true,
    });
```

**Step 2: Build infra to verify**

Run: `npm run build -w infra`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add infra/lib/foundation-stack.ts
git commit -m "infra: add providers DynamoDB table for global model provider configs"
```

---

## Task 3: Control Plane Config — Add Providers Table Name

**Files:**
- Modify: `control-plane/src/config.ts:20-29`

**Step 1: Add providers table to config**

In `config.ts`, add to the `tables` object (after line 28):

```typescript
    providers: process.env.PROVIDERS_TABLE || 'nanoclawbot-dev-providers',
```

**Step 2: Commit**

```bash
git add control-plane/src/config.ts
git commit -m "config: add providers table name to control-plane config"
```

---

## Task 4: Provider DynamoDB CRUD in dynamo.ts

**Files:**
- Modify: `control-plane/src/services/dynamo.ts`
- Create: `control-plane/src/__tests__/providers.test.ts`

**Step 1: Write failing tests for provider CRUD**

Create `control-plane/src/__tests__/providers.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DynamoDB client
const mockSend = vi.fn();
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  GetCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'Get', ...input })),
  PutCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'Put', ...input })),
  ScanCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'Scan', ...input })),
  DeleteCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'Delete', ...input })),
  UpdateCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'Update', ...input })),
  QueryCommand: vi.fn().mockImplementation((input: unknown) => ({ _type: 'Query', ...input })),
}));
vi.mock('../config.js', () => ({
  config: {
    region: 'us-east-1',
    stage: 'dev',
    tables: {
      users: 'test-users',
      bots: 'test-bots',
      channels: 'test-channels',
      groups: 'test-groups',
      messages: 'test-messages',
      tasks: 'test-tasks',
      sessions: 'test-sessions',
      providers: 'test-providers',
    },
  },
}));

describe('Provider CRUD', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('getProvider returns null when not found', async () => {
    mockSend.mockResolvedValue({ Item: undefined });
    const { getProvider } = await import('../services/dynamo.js');
    const result = await getProvider('non-existent');
    expect(result).toBeNull();
  });

  it('getProvider returns provider when found', async () => {
    const provider = {
      providerId: 'prov-1',
      providerName: 'Test',
      providerType: 'bedrock',
      modelIds: ['model-1'],
      isDefault: false,
      hasApiKey: false,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    mockSend.mockResolvedValue({ Item: provider });
    const { getProvider } = await import('../services/dynamo.js');
    const result = await getProvider('prov-1');
    expect(result).toEqual(provider);
  });

  it('listProviders returns all providers', async () => {
    const providers = [
      { providerId: 'prov-1', providerName: 'A' },
      { providerId: 'prov-2', providerName: 'B' },
    ];
    mockSend.mockResolvedValue({ Items: providers });
    const { listProviders } = await import('../services/dynamo.js');
    const result = await listProviders();
    expect(result).toEqual(providers);
  });

  it('putProvider calls DynamoDB PutCommand', async () => {
    mockSend.mockResolvedValue({});
    const { putProvider } = await import('../services/dynamo.js');
    await putProvider({
      providerId: 'prov-1',
      providerName: 'Test',
      providerType: 'bedrock',
      modelIds: ['m1'],
      isDefault: false,
      hasApiKey: false,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    expect(mockSend).toHaveBeenCalled();
  });

  it('deleteProvider calls DynamoDB DeleteCommand', async () => {
    mockSend.mockResolvedValue({});
    const { deleteProvider } = await import('../services/dynamo.js');
    await deleteProvider('prov-1');
    expect(mockSend).toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -w control-plane -- --run src/__tests__/providers.test.ts`
Expected: FAIL — functions not exported from dynamo.js.

**Step 3: Implement provider CRUD in dynamo.ts**

Add at the end of `control-plane/src/services/dynamo.ts` (after the `savePlanQuotas` function, ~line 974):

```typescript
// ── Provider operations (global, admin-managed) ──────────────────────────

import type { Provider } from '@clawbot/shared';

export async function getProvider(providerId: string): Promise<Provider | null> {
  z.string().min(1).parse(providerId);
  const result = await client.send(
    new GetCommand({
      TableName: config.tables.providers,
      Key: { providerId },
    }),
  );
  return (result.Item as Provider) ?? null;
}

export async function listProviders(): Promise<Provider[]> {
  const items: Provider[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new ScanCommand({
        TableName: config.tables.providers,
        ExclusiveStartKey: lastKey,
      }),
    );
    if (result.Items) items.push(...(result.Items as Provider[]));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

export async function putProvider(provider: Provider): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: config.tables.providers,
      Item: provider,
    }),
  );
}

export async function updateProvider(
  providerId: string,
  updates: Partial<Omit<Provider, 'providerId' | 'createdAt'>>,
): Promise<void> {
  z.string().min(1).parse(providerId);
  const expressions: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  const fields = ['providerName', 'providerType', 'baseUrl', 'hasApiKey', 'modelIds', 'isDefault', 'updatedAt'] as const;

  for (const field of fields) {
    if ((updates as Record<string, unknown>)[field] !== undefined) {
      expressions.push(`#${field} = :${field}`);
      names[`#${field}`] = field;
      values[`:${field}`] = (updates as Record<string, unknown>)[field];
    }
  }

  if (expressions.length === 0) return;

  await client.send(
    new UpdateCommand({
      TableName: config.tables.providers,
      Key: { providerId },
      UpdateExpression: `SET ${expressions.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

export async function deleteProvider(providerId: string): Promise<void> {
  z.string().min(1).parse(providerId);
  await client.send(
    new DeleteCommand({
      TableName: config.tables.providers,
      Key: { providerId },
    }),
  );
}

/** Clear the isDefault flag on all providers (used before setting a new default). */
export async function clearDefaultProvider(): Promise<void> {
  const providers = await listProviders();
  const defaults = providers.filter((p) => p.isDefault);
  for (const p of defaults) {
    await updateProvider(p.providerId, { isDefault: false, updatedAt: new Date().toISOString() });
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -w control-plane -- --run src/__tests__/providers.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add control-plane/src/services/dynamo.ts control-plane/src/__tests__/providers.test.ts
git commit -m "feat: add provider CRUD operations to DynamoDB service layer"
```

---

## Task 5: Provider Secrets Manager Functions

**Files:**
- Modify: `control-plane/src/services/secrets.ts:1-61`

**Step 1: Add provider API key functions, remove per-user functions**

Replace lines 12-61 in `secrets.ts` (the `anthropicKeySecretId` + 3 functions) with:

```typescript
// ── Per-user Anthropic API key (DEPRECATED — remove after migration) ─────

function anthropicKeySecretId(userId: string): string {
  return `nanoclawbot/${config.stage}/${userId}/anthropic-api-key`;
}

export async function getAnthropicApiKey(userId: string): Promise<string | null> {
  try {
    const result = await client.send(
      new GetSecretValueCommand({ SecretId: anthropicKeySecretId(userId) }),
    );
    return result.SecretString ?? null;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ResourceNotFoundException') {
      return null;
    }
    throw err;
  }
}

// ── Provider API key (global, admin-managed) ─────────────────────────────

function providerKeySecretId(providerId: string): string {
  return `nanoclawbot/${config.stage}/providers/${providerId}/api-key`;
}

export async function getProviderApiKey(providerId: string): Promise<string | null> {
  try {
    const result = await client.send(
      new GetSecretValueCommand({ SecretId: providerKeySecretId(providerId) }),
    );
    return result.SecretString ?? null;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ResourceNotFoundException') {
      return null;
    }
    throw err;
  }
}

export async function putProviderApiKey(providerId: string, apiKey: string): Promise<void> {
  const secretId = providerKeySecretId(providerId);
  try {
    await client.send(
      new PutSecretValueCommand({ SecretId: secretId, SecretString: apiKey }),
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ResourceNotFoundException') {
      await client.send(
        new CreateSecretCommand({ Name: secretId, SecretString: apiKey }),
      );
    } else {
      throw err;
    }
  }
}

export async function deleteProviderApiKey(providerId: string): Promise<void> {
  try {
    await client.send(
      new DeleteSecretCommand({
        SecretId: providerKeySecretId(providerId),
        ForceDeleteWithoutRecovery: true,
      }),
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ResourceNotFoundException') {
      return;
    }
    throw err;
  }
}
```

Remove `putAnthropicApiKey` and `deleteAnthropicApiKey` (no longer needed).

**Step 2: Build to check compilation**

Run: `npm run build -w control-plane` (will have errors in other files that import removed functions — expected, fixed in later tasks)

**Step 3: Commit**

```bash
git add control-plane/src/services/secrets.ts
git commit -m "feat: add provider-scoped API key functions to secrets service"
```

---

## Task 6: Admin Provider CRUD Routes

**Files:**
- Create: `control-plane/src/routes/api/providers.ts`
- Modify: `control-plane/src/routes/api/admin.ts`
- Modify: `control-plane/src/routes/api/index.ts:9,91-101`

**Step 1: Create public providers list route**

Create `control-plane/src/routes/api/providers.ts`:

```typescript
// ClawBot Cloud — Public Providers API
// Read-only listing of admin-configured model providers (no secrets)

import type { FastifyPluginAsync } from 'fastify';
import { listProviders } from '../../services/dynamo.js';

export const providersRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async () => {
    const providers = await listProviders();
    // Return public view — no secrets
    return providers.map((p) => ({
      providerId: p.providerId,
      providerName: p.providerName,
      providerType: p.providerType,
      modelIds: p.modelIds,
      isDefault: p.isDefault,
    }));
  });
};
```

**Step 2: Add admin provider CRUD routes**

In `control-plane/src/routes/api/admin.ts`, add imports and routes. After the existing imports, add:

```typescript
import {
  getProvider,
  listProviders,
  putProvider,
  updateProvider as updateProviderDb,
  deleteProvider as deleteProviderDb,
  clearDefaultProvider,
} from '../../services/dynamo.js';
import {
  putProviderApiKey,
  deleteProviderApiKey,
} from '../../services/secrets.js';
import { ulid } from 'ulid';
import type { ProviderType } from '@clawbot/shared';
```

Add Zod schemas (after existing schemas):

```typescript
const providerCreateSchema = z.object({
  providerName: z.string().min(1).max(100),
  providerType: z.enum(['bedrock', 'anthropic-compatible-api']),
  baseUrl: z.string().url().max(500).optional(),
  apiKey: z.string().min(1).max(2000).optional(),
  modelIds: z.array(z.string().min(1).max(200)).min(1),
  isDefault: z.boolean().optional().default(false),
});

const providerUpdateSchema = z.object({
  providerName: z.string().min(1).max(100).optional(),
  providerType: z.enum(['bedrock', 'anthropic-compatible-api']).optional(),
  baseUrl: z.string().url().max(500).optional().nullable(),
  apiKey: z.string().min(1).max(2000).optional(),
  modelIds: z.array(z.string().min(1).max(200)).min(1).optional(),
  isDefault: z.boolean().optional(),
});
```

Add routes inside the `adminRoutes` function (after the soft-delete user route, before the closing `};`):

```typescript
  // ── Model Providers ────────────────────────────────────────────────────

  app.get('/providers', async () => {
    return listProviders();
  });

  app.post('/providers', async (request) => {
    const body = providerCreateSchema.parse(request.body);
    const now = new Date().toISOString();
    const providerId = ulid();

    if (body.isDefault) {
      await clearDefaultProvider();
    }

    const hasApiKey = !!body.apiKey;
    if (body.apiKey) {
      await putProviderApiKey(providerId, body.apiKey);
    }

    const provider = {
      providerId,
      providerName: body.providerName,
      providerType: body.providerType as ProviderType,
      baseUrl: body.baseUrl,
      hasApiKey,
      modelIds: body.modelIds,
      isDefault: body.isDefault,
      createdAt: now,
      updatedAt: now,
    };
    await putProvider(provider);
    return provider;
  });

  app.put<{ Params: { providerId: string } }>('/providers/:providerId', async (request, reply) => {
    const { providerId } = request.params;
    const existing = await getProvider(providerId);
    if (!existing) {
      return reply.status(404).send({ error: 'Provider not found' });
    }

    const body = providerUpdateSchema.parse(request.body);
    const now = new Date().toISOString();

    if (body.isDefault) {
      await clearDefaultProvider();
    }

    if (body.apiKey) {
      await putProviderApiKey(providerId, body.apiKey);
    }

    const updates: Record<string, unknown> = { updatedAt: now };
    if (body.providerName !== undefined) updates.providerName = body.providerName;
    if (body.providerType !== undefined) updates.providerType = body.providerType;
    if (body.baseUrl !== undefined) updates.baseUrl = body.baseUrl ?? undefined;
    if (body.apiKey) updates.hasApiKey = true;
    if (body.modelIds !== undefined) updates.modelIds = body.modelIds;
    if (body.isDefault !== undefined) updates.isDefault = body.isDefault;

    await updateProviderDb(providerId, updates);
    const updated = await getProvider(providerId);
    return updated;
  });

  app.delete<{ Params: { providerId: string } }>('/providers/:providerId', async (request, reply) => {
    const { providerId } = request.params;
    const existing = await getProvider(providerId);
    if (!existing) {
      return reply.status(404).send({ error: 'Provider not found' });
    }

    // TODO: Check if any bots reference this provider (blocked delete)
    // For now, allow delete — bot will fall back to no provider

    if (existing.hasApiKey) {
      await deleteProviderApiKey(providerId).catch(() => {});
    }
    await deleteProviderDb(providerId);
    return { ok: true };
  });
```

**Step 3: Register providers route in index.ts**

In `control-plane/src/routes/api/index.ts`, add import:

```typescript
import { providersRoutes } from './providers.js';
```

Add registration (after the admin route, line 100):

```typescript
  await app.register(providersRoutes, { prefix: '/providers' });
```

**Step 4: Commit**

```bash
git add control-plane/src/routes/api/providers.ts control-plane/src/routes/api/admin.ts control-plane/src/routes/api/index.ts
git commit -m "feat: add admin provider CRUD routes and public providers list endpoint"
```

---

## Task 7: Remove Per-User Provider Routes & Update Bot Routes

**Files:**
- Modify: `control-plane/src/routes/api/user.ts`
- Modify: `control-plane/src/routes/api/bots.ts:17-34,95-132`
- Modify: `control-plane/src/services/dynamo.ts:314-337,454-502`

**Step 1: Remove provider routes from user.ts**

Replace `control-plane/src/routes/api/user.ts` entirely:

```typescript
// ClawBot Cloud — User API Routes
// Returns authenticated user profile and usage information

import type { FastifyPluginAsync } from 'fastify';
import { ensureUser, updateLastLogin } from '../../services/dynamo.js';

export const userRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', async (request) => {
    const user = await ensureUser(request.userId, request.userEmail);
    // Fire-and-forget: update lastLogin timestamp
    updateLastLogin(request.userId).catch(() => {});
    return {
      userId: user.userId,
      email: user.email,
      plan: user.plan,
      quota: user.quota,
      usage: {
        month: user.usageMonth,
        tokens: user.usageTokens,
        invocations: user.usageInvocations,
      },
      isAdmin: request.isAdmin,
    };
  });
};
```

**Step 2: Update bot create/update schemas and validation**

In `control-plane/src/routes/api/bots.ts`, update schemas and import:

Replace the create/update schemas (lines 17-34):

```typescript
const createBotSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  systemPrompt: z.string().max(10000).optional(),
  triggerPattern: z.string().max(200).optional(),
  providerId: z.string().min(1).max(100).optional(),
  modelId: z.string().min(1).max(200).optional(),
});

const updateBotSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  systemPrompt: z.string().max(10000).optional(),
  triggerPattern: z.string().max(200).optional(),
  providerId: z.string().min(1).max(100).optional(),
  modelId: z.string().min(1).max(200).optional(),
  status: z.enum(['active', 'paused', 'deleted']).optional(),
});
```

Add import for `getProvider`:

```typescript
import { createBot, getBot, getUser, listBots, updateBot, deleteBot, getProvider } from '../../services/dynamo.js';
```

Remove the old `import type { Bot, CreateBotRequest, UpdateBotRequest } from '@clawbot/shared';` and replace with:

```typescript
import type { Bot, CreateBotRequest, UpdateBotRequest } from '@clawbot/shared';
```

Update bot creation (in the POST handler) — replace the bot object construction:

```typescript
    const bot: Bot = {
      userId: request.userId,
      botId: ulid(),
      name: body.name,
      description: body.description,
      systemPrompt: body.systemPrompt,
      triggerPattern: body.triggerPattern || `@${body.name}`,
      providerId: body.providerId,
      modelId: body.modelId,
      status: 'created',
      createdAt: now,
      updatedAt: now,
    };
```

Replace the provider validation block (lines 117-126) in the PUT handler:

```typescript
      // Validate provider and modelId exist
      if (updates.providerId) {
        const provider = await getProvider(updates.providerId);
        if (!provider) {
          return reply.status(400).send({ error: 'Provider not found' });
        }
        if (updates.modelId && !provider.modelIds.includes(updates.modelId)) {
          return reply.status(400).send({ error: 'Model ID not available for this provider' });
        }
      }
```

**Step 3: Update updateBot allowed fields in dynamo.ts**

In `control-plane/src/services/dynamo.ts`, update the `allowedFields` in `updateBot` (line 465-474):

```typescript
  const allowedFields = [
    'name',
    'description',
    'systemPrompt',
    'triggerPattern',
    'providerId',
    'modelId',
    'model',
    'modelProvider',
    'status',
    'containerConfig',
  ] as const;
```

Also remove the `updateUserProvider` function (lines 314-337).

**Step 4: Build control-plane to verify**

Run: `npm run build -w control-plane`
Expected: Build succeeds (or only agent-runtime type errors, which are separate).

**Step 5: Commit**

```bash
git add control-plane/src/routes/api/user.ts control-plane/src/routes/api/bots.ts control-plane/src/services/dynamo.ts
git commit -m "refactor: remove per-user provider routes, update bot routes for providerId/modelId"
```

---

## Task 8: Rewrite Dispatcher Provider Resolution

**Files:**
- Modify: `control-plane/src/sqs/dispatcher.ts:36,98-179,250-295,428-465`

**Step 1: Rewrite resolveProviderCredentials**

In `dispatcher.ts`, update the import (line 36) to replace `getAnthropicApiKey` with `getProviderApiKey`:

```typescript
import { getProviderApiKey, getProxyRules } from '../services/secrets.js';
```

Add import for `getProvider`:

```typescript
import { getProvider } from '../services/dynamo.js';
// (add to existing dynamo import line)
```

Replace `resolveProviderCredentials` (lines 98-123):

```typescript
async function resolveProviderCredentials(
  bot: { providerId?: string; modelId?: string; modelProvider?: ModelProvider; botId: string },
  userId: string,
  logger: Logger,
): Promise<{ model?: string; modelProvider?: ModelProvider; providerType?: ProviderType; anthropicApiKey?: string; anthropicBaseUrl?: string }> {
  // New path: use providerId from providers table
  if (bot.providerId) {
    try {
      const provider = await getProvider(bot.providerId);
      if (!provider) {
        logger.warn({ providerId: bot.providerId, botId: bot.botId }, 'Provider not found, falling back to bedrock');
        return {};
      }

      const result: Record<string, unknown> = {
        model: bot.modelId,
        providerType: provider.providerType,
      };

      // Map providerType to legacy modelProvider for backward compat with agent-runtime
      if (provider.providerType === 'anthropic-compatible-api') {
        result.modelProvider = 'anthropic-api' as ModelProvider;
        if (provider.hasApiKey) {
          const apiKey = await getProviderApiKey(provider.providerId);
          if (apiKey) {
            result.anthropicApiKey = apiKey;
          }
        }
        if (provider.baseUrl) {
          result.anthropicBaseUrl = provider.baseUrl;
        }
      } else {
        result.modelProvider = 'bedrock' as ModelProvider;
      }

      return result as { model?: string; modelProvider?: ModelProvider; providerType?: ProviderType; anthropicApiKey?: string; anthropicBaseUrl?: string };
    } catch (err) {
      logger.error({ err, providerId: bot.providerId }, 'Failed to resolve provider, falling back to bedrock');
      return {};
    }
  }

  // Legacy path: bot still has old modelProvider field (migration period)
  if (bot.modelProvider === 'anthropic-api') {
    return { modelProvider: 'anthropic-api' };
  }

  return {};
}
```

Add the ProviderType import at the top:

```typescript
import type { ProviderType } from '@clawbot/shared';
```

**Step 2: Update invocation payload construction in dispatchMessage**

In the `dispatchMessage` function, update lines ~272-295 to use the new resolved fields:

```typescript
    const invocationPayload: InvocationPayload = {
      botId: payload.botId,
      botName: bot.name,
      groupJid: payload.groupJid,
      userId: payload.userId,
      channelType: payload.channelType,
      prompt,
      systemPrompt: bot.systemPrompt,
      model: providerCreds.model || bot.model,
      sessionPath: `${payload.userId}/${payload.botId}/sessions/${payload.groupJid}/`,
      memoryPaths: {
        botClaude: `${payload.userId}/${payload.botId}/CLAUDE.md`,
        groupPrefix: `${payload.userId}/${payload.botId}/workspace/${payload.groupJid}/`,
        learnings: `${payload.userId}/${payload.botId}/learnings/`,
      },
      isGroupChat: group?.isGroup,
      ...(payload.attachments && payload.attachments.length > 0 && {
        attachments: payload.attachments,
      }),
      ...(feishuConfig && { feishu: feishuConfig }),
      ...providerCreds,
      ...(forceNewSession && { forceNewSession: true }),
      ...(proxyRules.length > 0 && { proxyRules }),
    };
```

Apply similar changes to `dispatchTask`.

**Step 3: Update session model tracking**

The `shouldResetSession` function should now check `model` (which comes from `modelId`) and `modelProvider` — this already works since we pass both via `providerCreds`.

**Step 4: Build and run existing tests**

Run: `npm run build -w shared && npm run build -w control-plane && npm test -w control-plane`
Expected: Build succeeds, tests pass.

**Step 5: Commit**

```bash
git add control-plane/src/sqs/dispatcher.ts
git commit -m "refactor: rewrite dispatcher to resolve credentials from providers table"
```

---

## Task 9: Frontend API Client Updates

**Files:**
- Modify: `web-console/src/lib/api.ts`

**Step 1: Update types and API methods**

In `web-console/src/lib/api.ts`:

Update `Bot` interface (line 33-42):

```typescript
export interface Bot {
  botId: string;
  name: string;
  description?: string;
  status: string;
  triggerPattern: string;
  providerId?: string;
  modelId?: string;
  /** @deprecated */
  model?: string;
  /** @deprecated */
  modelProvider?: 'bedrock' | 'anthropic-api';
  createdAt: string;
}
```

Update `CreateBotRequest` (line 84-90):

```typescript
export interface CreateBotRequest {
  name: string;
  description?: string;
  triggerPattern?: string;
  providerId?: string;
  modelId?: string;
}
```

Remove `ProviderConfig` and `UpdateProviderRequest` interfaces (lines 109-117).

Remove `user.getProvider` and `user.updateProvider` from the user API (lines 152-153).

Add provider types and API:

```typescript
// Provider types (admin-managed)
export interface ProviderPublic {
  providerId: string;
  providerName: string;
  providerType: 'bedrock' | 'anthropic-compatible-api';
  modelIds: string[];
  isDefault: boolean;
}

export interface ProviderFull extends ProviderPublic {
  baseUrl?: string;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProviderRequest {
  providerName: string;
  providerType: 'bedrock' | 'anthropic-compatible-api';
  baseUrl?: string;
  apiKey?: string;
  modelIds: string[];
  isDefault?: boolean;
}

export interface UpdateProviderRequest {
  providerName?: string;
  providerType?: 'bedrock' | 'anthropic-compatible-api';
  baseUrl?: string | null;
  apiKey?: string;
  modelIds?: string[];
  isDefault?: boolean;
}

// Public providers (any authenticated user)
export const providers = {
  list: () => request<ProviderPublic[]>('/providers'),
};
```

Add to the `admin` object:

```typescript
  // Provider management
  listProviders: () => request<ProviderFull[]>('/admin/providers'),
  createProvider: (data: CreateProviderRequest) =>
    request<ProviderFull>('/admin/providers', { method: 'POST', body: JSON.stringify(data) }),
  updateProvider: (providerId: string, data: UpdateProviderRequest) =>
    request<ProviderFull>(`/admin/providers/${providerId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteProvider: (providerId: string) =>
    request<{ ok: boolean }>(`/admin/providers/${providerId}`, { method: 'DELETE' }),
```

**Step 2: Commit**

```bash
git add web-console/src/lib/api.ts
git commit -m "feat: add provider API client, update bot types for providerId/modelId"
```

---

## Task 10: Frontend — Admin Model Providers Tab in Settings

**Files:**
- Modify: `web-console/src/pages/Settings.tsx`

**Step 1: Replace AnthropicTab with ProvidersTab**

Rewrite `Settings.tsx`. Remove the `AnthropicTab` component entirely. Add a new `ProvidersTab` that is only visible to admins. The full implementation:

- Admin sees two tabs: "Model Providers" + "API Credentials"
- Non-admin sees only: "API Credentials"
- ProvidersTab shows a table of providers with CRUD actions
- Provider form includes: name, type, baseUrl (conditional), apiKey (conditional), model IDs (presets + custom), isDefault toggle
- Presets: Bedrock → `global.anthropic.claude-sonnet-4-6`, `global.anthropic.claude-opus-4-6-v1`; Anthropic → `claude-sonnet-4-6`, `claude-opus-4-6`

The component needs to call `userApi.me()` to check `isAdmin`, then conditionally render tabs.

**Step 2: Build web-console**

Run: `npm run build -w web-console`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add web-console/src/pages/Settings.tsx
git commit -m "feat: replace AnthropicTab with admin-only Model Providers management"
```

---

## Task 11: Frontend — Bot Overview Model Selection Dropdowns

**Files:**
- Modify: `web-console/src/pages/BotDetail.tsx:1-42,57-257,750-824`

**Step 1: Replace model selection with two dropdowns**

Remove the model preset constants (lines 20-41) and `getModelSelection` helper.

Update the OverviewTab props to use providers:

```typescript
// New props for provider-based selection
providers: ProviderPublic[];
selectedProviderId: string;
setSelectedProviderId: (v: string) => void;
selectedModelId: string;
setSelectedModelId: (v: string) => void;
```

Replace the Model / Provider card content (lines 159-238):

- Dropdown 1: Provider name (from `providers` array)
- Dropdown 2: Model ID (from selected provider's `modelIds`)
- No radio buttons, no custom input
- If no providers, show "No model providers available. Contact your administrator."

Update `loadData` to call `providers.list()` instead of `userApi.getProvider()`.

Update `saveModel` to call `botsApi.update(botId, { providerId, modelId })`.

**Step 2: Build web-console**

Run: `npm run build -w web-console`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add web-console/src/pages/BotDetail.tsx
git commit -m "feat: replace model radio buttons with provider/model dropdowns"
```

---

## Task 12: CDK — Wire Providers Table to Control Plane

**Files:**
- Modify: `infra/lib/controlplane-stack.ts` (add PROVIDERS_TABLE env var and table grant)

**Step 1: Add table env var and permissions**

Find where other table env vars are set in the control plane ECS task definition and add:

```typescript
PROVIDERS_TABLE: props.foundation.providersTable.tableName,
```

Grant the task role read/write access:

```typescript
props.foundation.providersTable.grantReadWriteData(taskRole);
```

**Step 2: Build infra**

Run: `npm run build -w infra`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add infra/lib/controlplane-stack.ts
git commit -m "infra: wire providers table to control plane ECS task"
```

---

## Task 13: Full Build + Test Verification

**Step 1: Build all packages**

Run: `npm run build --workspaces`
Expected: All packages build successfully.

**Step 2: Run all tests**

Run: `npm test -w control-plane`
Expected: All tests pass.

**Step 3: TypeCheck all packages**

Run: `npm run typecheck -w control-plane && npm run typecheck -w shared && npm run typecheck -w infra`
Expected: No type errors.

**Step 4: Commit any remaining fixes**

```bash
git add -A
git commit -m "fix: resolve remaining type errors from provider refactor"
```
