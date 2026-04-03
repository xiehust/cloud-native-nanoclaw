# Architecture Review

**Date:** 2026-03-26
**Scope:** Full codebase — shared, control-plane, agent-runtime, web-console, infra
**Reviewer:** Architecture Review Agent

---

## Executive Summary

The NanoClaw on Cloud codebase is a well-structured NPM monorepo implementing a multi-tenant AI assistant platform on AWS. The architecture follows sound cloud-native principles: stateless compute, event-driven message flow, ABAC-based tenant isolation, and clean package boundaries. However, there are areas where the codebase could improve — particularly around testing coverage, type duplication, resilience patterns, and the monolithic DynamoDB service layer.

**Finding counts:** 4 Critical, 8 High, 12 Medium, 7 Low

---

## Table of Contents

1. [Package Structure](#1-package-structure)
2. [Separation of Concerns](#2-separation-of-concerns)
3. [Error Handling Patterns](#3-error-handling-patterns)
4. [Code Duplication](#4-code-duplication)
5. [API Design](#5-api-design)
6. [Type Safety](#6-type-safety)
7. [Configuration Management](#7-configuration-management)
8. [Extensibility](#8-extensibility)
9. [Testing Strategy](#9-testing-strategy)
10. [CDK Infrastructure](#10-cdk-infrastructure)
11. [Observability](#11-observability)
12. [Resilience](#12-resilience)

---

## 1. Package Structure

### 1.1 Monorepo Organization

The monorepo uses NPM workspaces with 5 packages and a clear dependency graph:

```
shared <-- control-plane
       <-- agent-runtime

infra       (standalone)
web-console (standalone)
```

**Strengths:**
- Clean unidirectional dependency graph (no circular deps)
- Proper subpath exports in shared package (`./types`, `./channel-adapter`, etc.)
- ESM throughout with consistent `"type": "module"`
- Shared `tsconfig.base.json` ensures consistent compiler settings
- Build order documented and respected

### Finding 1.1: Unused Zod dependency in shared package
**Severity: Low**

`zod@^4.0.0` is declared in shared's `dependencies` but never imported in any shared source file. Zod is used in control-plane and agent-runtime directly.

**Recommendation:** Remove Zod from shared `dependencies`, or move validation schemas (currently defined per-consumer) into shared to create a single source of truth for request/response validation.

### Finding 1.2: No workspace-level linting or formatting enforcement
**Severity: Medium**

No ESLint config, Prettier config, or pre-commit hooks found at the repo root. Code style consistency relies entirely on developer discipline.

**Recommendation:** Add a root-level ESLint + Prettier config with a pre-commit hook (e.g., via `lint-staged` + `husky`) to enforce consistent formatting and catch issues early.

---

## 2. Separation of Concerns

### 2.1 Control Plane Layering

The control-plane has a reasonable layered structure:

```
HTTP Layer      → routes/api/*, webhooks/*
Business Logic  → sqs/dispatcher.ts, adapters/*
Data Access     → services/dynamo.ts, services/secrets.ts, services/cache.ts
Channel Layer   → channels/*, adapters/*, */gateway-manager.ts
```

### Finding 2.1: Monolithic DynamoDB service layer (dynamo.ts = 1058 lines)
**Severity: High**

`control-plane/src/services/dynamo.ts` is a single 1058-line file containing CRUD operations for all 8 DynamoDB tables (Users, Bots, Channels, Groups, Messages, Tasks, Sessions, Providers). This violates the Single Responsibility Principle and makes the file difficult to navigate, test, and maintain.

**Recommendation:** Split into domain-specific modules:
- `services/db/users.ts` — User CRUD, quota management, slot operations
- `services/db/bots.ts` — Bot CRUD
- `services/db/channels.ts` — Channel CRUD, health tracking
- `services/db/groups.ts` — Group CRUD
- `services/db/messages.ts` — Message storage with TTL
- `services/db/tasks.ts` — Task CRUD
- `services/db/sessions.ts` — Session state management
- `services/db/providers.ts` — Provider CRUD
- `services/db/client.ts` — Shared DynamoDB client instance

### Finding 2.2: Dispatcher combines too many concerns
**Severity: Medium**

`control-plane/src/sqs/dispatcher.ts` handles quota checking, context building, provider credential resolution, proxy rule assembly, AgentCore invocation, reply routing, session management, and usage tracking — all in a single dispatch function. While logically sequential, this makes the function very long and hard to unit test in isolation.

**Recommendation:** Extract helper functions into focused modules:
- `services/quota.ts` — Quota checks and slot management
- `services/invocation.ts` — Payload construction and AgentCore invocation
- `services/context-builder.ts` — Chat history and system prompt assembly

### Finding 2.3: Channel adapter vs channel client layer confusion
**Severity: Medium**

There are three channel-related directories with overlapping responsibilities:
- `src/adapters/*` — Implements `ChannelAdapter` interface for outbound replies
- `src/channels/*` — REST API wrappers for channel platforms
- `src/*/gateway-manager.ts` — WebSocket lifecycle for Discord/Feishu/DingTalk

The boundary between `adapters/` and `channels/` is blurry. Some adapters call channels directly, while others inline the REST calls.

**Recommendation:** Consolidate into a single `channels/{channelType}/` directory per channel, with sub-files for adapter, client, and gateway as needed.

---

## 3. Error Handling Patterns

### Finding 3.1: Raw error details exposed to end users
**Severity: Critical**

`control-plane/src/sqs/dispatcher.ts:425-428` sends raw error strings to channel users:
```typescript
// TODO: Sanitize before production — raw error may contain ARNs, bucket names, userId.
const errorText = `Sorry, something went wrong...\n\nError: ${result.error || 'Unknown error'}`;
```

This is explicitly marked as a TODO. Raw errors may leak AWS ARNs, S3 bucket names, user IDs, and other internal infrastructure details.

**Recommendation:** Replace with a generic error message immediately. Log the detailed error server-side only. Consider error codes for debugging:
```typescript
const errorText = `Sorry, something went wrong processing your message. (ref: ${shortId})`;
```

### Finding 3.2: Inconsistent error typing in catch blocks
**Severity: Medium**

Catch blocks use a mix of patterns:
- `catch (err)` — Untyped (12 occurrences)
- `catch (err: unknown)` — Proper typed (18 occurrences)
- `(err as Error).message` — Unsafe cast (several occurrences)

**Recommendation:** Standardize on `catch (err: unknown)` everywhere and use a type guard:
```typescript
function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

### Finding 3.3: Silent error swallowing in fire-and-forget patterns
**Severity: Medium**

Several operations use `.catch(() => {})` to silently swallow errors:
- `control-plane/src/sqs/consumer.ts:67` — SQS message visibility change
- `control-plane/src/sqs/consumer.ts:140` — SQS message release
- `control-plane/src/routes/api/admin.ts:254` — Cognito compensating rollback
- `control-plane/src/routes/api/user.ts:10` — Last login update

While some of these are genuinely best-effort, silent swallowing hides operational issues.

**Recommendation:** At minimum, log warnings for swallowed errors:
```typescript
.catch((err) => logger.warn({ err }, 'Best-effort operation failed'));
```

### Finding 3.4: Webhook handlers always return 200 even on internal errors
**Severity: Low**

Webhooks for Telegram, Slack, and WhatsApp return HTTP 200 even when internal processing fails, to prevent the channel provider from retrying. This is correct behavior but should be documented as intentional in each handler.

---

## 4. Code Duplication

### Finding 4.1: SqsReplyContext and ReplyContext are near-duplicates
**Severity: High**

Two interfaces represent the same concept — channel-specific reply routing data:

- `shared/src/types.ts:213-224` — `SqsReplyContext` (channel-specific fields only)
- `shared/src/channel-adapter.ts:10-29` — `ReplyContext` (same fields + botId, groupJid, channelType)

Both contain identical Discord, Slack, Feishu, and DingTalk fields. Every time a new channel is added, both must be updated.

**Recommendation:** Define `SqsReplyContext` as the base, and have `ReplyContext` extend it:
```typescript
export interface ReplyContext extends SqsReplyContext {
  botId: string;
  groupJid: string;
  channelType: ChannelType;
}
```

### Finding 4.2: Gateway manager leader election duplicated across 3 channels
**Severity: High**

Discord (`discord/gateway-manager.ts`), Feishu (`feishu/gateway-manager.ts`), and DingTalk (`dingtalk/gateway-manager.ts`) each independently implement the same DynamoDB-based leader election pattern:
- Acquire lock with TTL in sessions table
- Renew lock every 15 seconds
- Poll for active bots every 15 seconds
- Release lock on shutdown

The core logic is identical; only the channel-specific connection/disconnection differs.

**Recommendation:** Extract a generic `LeaderElectedGateway` base class or utility that handles lock lifecycle, with channel-specific hooks for connect/disconnect/handleMessage.

### Finding 4.3: API type definitions duplicated between shared and web-console
**Severity: Medium**

`web-console/src/lib/api.ts` redefines many types that already exist in `@clawbot/shared`:
- `Bot`, `ChannelConfig`, `Group`, `Message`, `ScheduledTask`

The web-console is a standalone package (doesn't depend on shared), so these types can drift.

**Recommendation:** Either add `@clawbot/shared` as a dev dependency to web-console for type imports, or generate a lightweight API types package from the control-plane's Zod schemas.

### Finding 4.4: Deprecated ModelProvider coexists with ProviderType
**Severity: Medium**

`shared/src/types.ts` contains both:
- `ProviderType = 'bedrock' | 'anthropic-compatible-api'` (new)
- `ModelProvider = 'bedrock' | 'anthropic-api'` (deprecated)

Both are still referenced in `Session`, `InvocationPayload`, and `Bot` interfaces. The `Bot` type has both `providerId`/`modelId` (new) and `model`/`modelProvider` (deprecated) fields.

**Recommendation:** Create a migration plan with a target removal date. In the interim, add `@deprecated` JSDoc to all old-path fields so consumers get IDE warnings.

---

## 5. API Design

### 5.1 REST API Consistency

The API follows RESTful conventions with consistent patterns:
- Resource-oriented URLs (`/api/bots/:botId/channels`)
- Standard HTTP methods (GET, POST, PUT, PATCH, DELETE)
- Zod validation on all request bodies
- JWT auth on all `/api/*` routes

**Strengths:**
- Consistent nested resource URLs
- Admin routes properly gated behind `isAdmin` check
- Proper HTTP status codes (201 for creation, 204 for deletion, 403 for forbidden)

### Finding 5.1: No API versioning strategy
**Severity: Medium**

All endpoints are under `/api/` with no version prefix. There is no mechanism for introducing breaking changes without affecting existing clients.

**Recommendation:** Consider adding version prefix (`/api/v1/`) before the API stabilizes. Alternatively, adopt header-based versioning.

### Finding 5.2: Inconsistent use of PATCH vs PUT for partial updates
**Severity: Low**

- Tasks use `PATCH /api/bots/:botId/tasks/:taskId` for partial updates
- Bots use `PUT /api/bots/:botId` for updates (which is also partial, not full replacement)

**Recommendation:** Standardize: use PATCH for partial updates, PUT for full replacement.

### Finding 5.3: Admin endpoints have inconsistent prefix
**Severity: Low**

Most admin endpoints use `/api/admin/*`, but some operations are mixed:
- `GET /api/admin/users` — List users
- `GET /api/admin/providers` — List providers (admin)
- `GET /api/providers` — List providers (user)

The user-facing and admin-facing provider endpoints coexist but return different data shapes.

**Recommendation:** This is acceptable as-is. Document the different response shapes clearly.

---

## 6. Type Safety

### Finding 6.1: Extensive `any` usage in Feishu tools
**Severity: High**

`agent-runtime/src/feishu-tools/doc-tool.ts` contains 20+ explicit `any` type annotations (all marked with `eslint-disable-next-line @typescript-eslint/no-explicit-any`). The Lark SDK apparently does not provide strong types for document block structures.

```typescript
function sortBlocksByFirstLevel(blocks: any[], firstLevelIds: string[]): any[] { ... }
```

**Recommendation:** Define local interface types for the Lark document block structures, even if approximate. This provides autocomplete and catches typos:
```typescript
interface LarkBlock {
  block_id: string;
  block_type: number;
  children?: LarkBlock[];
  table?: { cells?: string[] };
}
```

### Finding 6.2: Unvalidated SQS message payloads
**Severity: High**

`control-plane/src/sqs/dispatcher.ts` parses SQS message bodies with `JSON.parse()` and trusts the result:
```typescript
const payload: SqsPayload = JSON.parse(sqsMessage.Body!);
```

While SQS messages are internal (produced by the same service), a malformed message could crash the consumer.

**Recommendation:** Add Zod validation at the SQS consumer boundary:
```typescript
const parsed = sqsPayloadSchema.safeParse(JSON.parse(sqsMessage.Body!));
if (!parsed.success) { logger.error(...); deleteMessage(...); return; }
```

### Finding 6.3: DynamoDB results cast without runtime validation
**Severity: Medium**

`control-plane/src/services/dynamo.ts` casts DynamoDB results directly to domain types:
```typescript
return (result.Item as User) ?? null;
```

DynamoDB returns untyped `Record<string, AttributeValue>` — if the table schema drifts from the TypeScript interface, this silently produces incorrect data.

**Recommendation:** Add Zod parsing for critical read paths (user, bot, session) to catch schema drift at runtime.

### Finding 6.4: Non-null assertions on environment variables
**Severity: Medium**

`agent-runtime/src/mcp-server.ts` uses non-null assertions on critical env vars:
```typescript
const botId = process.env.CLAWBOT_BOT_ID!;
const userId = process.env.CLAWBOT_USER_ID!;
```

If these are unset, the process silently uses `undefined`, leading to confusing downstream errors.

**Recommendation:** Validate required env vars at startup and fail fast with a clear error message.

---

## 7. Configuration Management

### 7.1 Environment Variable Handling

The control-plane centralizes config in `src/config.ts` with sensible defaults. Agent-runtime reads env vars inline at module scope.

### Finding 7.1: Agent-runtime lacks centralized config
**Severity: Medium**

Unlike control-plane (which has `config.ts`), agent-runtime scatters `process.env.*` reads across multiple files: `server.ts`, `agent.ts`, `mcp-server.ts`, `scoped-credentials.ts`, `mcp-tools.ts`. There is no single place to see all required configuration.

**Recommendation:** Create `agent-runtime/src/config.ts` that reads, validates, and exports all env vars. Fail fast at startup if required vars are missing.

### Finding 7.2: Dev-mode JWT bypass needs production safeguard
**Severity: High**

`control-plane/src/routes/api/index.ts` decodes JWTs without verification when not in production mode:
```typescript
// Dev mode: Decode without verification
const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
```

If `STAGE` is accidentally set to anything other than `'prod'` in a deployed environment, auth is effectively bypassed.

**Recommendation:** Use an explicit opt-in flag (`DEV_SKIP_AUTH=true`) rather than inferring from stage. Add a startup warning log when auth bypass is active.

### Finding 7.3: Hardcoded OAuth callback URL
**Severity: Medium**

`infra/lib/auth-stack.ts` hardcodes `http://localhost:5173` as the Cognito OAuth callback URL. This only works for local development.

**Recommendation:** Make the callback URL stage-aware. For production, use the CloudFront domain. Pass it as a parameter or resolve it via SSM (similar to webhook base URL pattern).

---

## 8. Extensibility

### 8.1 Adding New Channels

Adding a new channel requires changes in:
1. `shared/src/types.ts` — Add to `ChannelType` union, add fields to `SqsReplyContext`
2. `shared/src/channel-adapter.ts` — Add fields to `ReplyContext`
3. `control-plane/src/channels/{new}.ts` — REST client wrapper
4. `control-plane/src/adapters/{new}/index.ts` — Adapter implementation
5. `control-plane/src/adapters/registry.ts` — Register adapter
6. `control-plane/src/webhooks/{new}.ts` (if webhook-based) or `src/{new}/gateway-manager.ts` (if WebSocket)
7. `control-plane/src/webhooks/signature.ts` — Signature verification
8. `control-plane/src/routes/api/channels.ts` — Channel setup validation
9. `agent-runtime/src/system-prompt.ts` — Channel-specific prompt guidance
10. `web-console/src/pages/ChannelSetup.tsx` — UI setup flow

**Assessment:** The adapter pattern is sound, but the high number of touch points (10+) makes channel addition error-prone.

### Finding 8.1: Channel-specific fields scattered across shared types
**Severity: High**

`SqsReplyContext` and `ReplyContext` use optional fields for each channel:
```typescript
discordChannelId?: string;
slackResponseUrl?: string;
feishuChatId?: string;
dingtalkConversationId?: string;
```

Each new channel adds more optional fields, creating an ever-growing "god object." Eventually, this becomes unwieldy and type-unsafe (nothing prevents setting both Discord and Slack fields simultaneously).

**Recommendation:** Use a discriminated union pattern:
```typescript
type ReplyContext =
  | { channelType: 'discord'; channelId: string; interactionToken?: string }
  | { channelType: 'slack'; responseUrl?: string }
  | { channelType: 'telegram' }
  // ...
```

### Finding 8.2: No plugin system for MCP tools
**Severity: Low**

MCP tools are defined in a single `mcp-server.ts` file. Adding a new tool requires editing this file directly. The Feishu tools show a pattern of conditional registration, but there's no formal plugin mechanism.

**Recommendation:** For now, this is acceptable given the small number of tools. If the tool catalog grows significantly, consider a discovery-based registration pattern.

---

## 9. Testing Strategy

### Finding 9.1: Critically low test coverage
**Severity: Critical**

Test file inventory across the entire codebase:
- `control-plane/src/__tests__/dispatcher.test.ts` — Agent invocation mocking
- `control-plane/src/__tests__/providers.test.ts` — Provider credential resolution
- `control-plane/src/__tests__/secrets.test.ts` — Secrets Manager operations
- `agent-runtime/src/__tests__/system-prompt.test.ts` — System prompt generation
- `agent-runtime/src/__tests__/tool-whitelist.test.ts` — Tool access control
- **web-console:** Zero tests
- **shared:** Zero tests
- **infra:** Zero tests

**5 test files total for ~8,000+ lines of production code.** Critical business logic — SQS consumption, DynamoDB operations, channel adapters, webhook signature verification, session sync, credential proxy — has no test coverage.

**Recommendation (prioritized):**
1. **Immediate:** Add unit tests for `dynamo.ts` (data integrity), `signature.ts` (security boundary), `consumer.ts` (message processing)
2. **Short-term:** Add integration tests for the dispatcher flow, channel adapters, and session sync
3. **Medium-term:** Add CDK snapshot tests for infrastructure, component tests for web-console
4. **Set a coverage target:** Aim for 60%+ on control-plane and agent-runtime within the next milestone

### Finding 9.2: No integration test infrastructure
**Severity: Critical**

There is no test infrastructure for integration testing — no Docker Compose for DynamoDB Local, no SQS mocking, no test fixtures. All tests rely on vi.mock() module mocking.

**Recommendation:** Set up DynamoDB Local (or `@shelf/jest-dynamodb`) for data layer integration tests. Consider `testcontainers` for SQS/S3 integration.

### Finding 9.3: Web-console has no tests
**Severity: High**

The web-console (React SPA) has zero test files — no component tests, no integration tests, no E2E tests. Given that it handles authentication flows, API interactions, and complex state management (e.g., BotDetail with 8+ tabs), this is a significant risk.

**Recommendation:** Add Vitest + React Testing Library for component tests. Priority areas: auth flow, API client error handling, bot CRUD operations.

---

## 10. CDK Infrastructure

### 10.1 Stack Organization

6 stacks with clear separation of concerns and proper dependency ordering:
1. Foundation (VPC, data stores, queues)
2. Auth (Cognito)
3. Agent (IAM ABAC roles)
4. ControlPlane (ECS Fargate, ALB, WAF)
5. Frontend (CloudFront, S3)
6. Monitoring (CloudWatch)

**Strengths:**
- Clean cross-stack references via constructor props
- Stage-aware naming (`nanoclawbot-{stage}-*`)
- Different removal policies for dev vs prod
- Auto-scaling based on SQS queue depth
- PITR enabled on providers table

### Finding 10.1: No Point-in-Time Recovery on most DynamoDB tables
**Severity: High**

Only the `providers` table has Point-in-Time Recovery enabled. The `users`, `bots`, `channels`, `groups`, `sessions`, and `tasks` tables lack PITR. Data loss from accidental deletion or corruption would be unrecoverable.

**Recommendation:** Enable PITR on all production tables, especially `users`, `bots`, and `sessions`. The cost is minimal compared to the data loss risk.

### Finding 10.2: No VPC endpoints for AWS services
**Severity: Medium**

ECS tasks in private subnets reach DynamoDB, SQS, S3, and Secrets Manager via NAT Gateway. This incurs NAT data transfer charges and adds latency.

**Recommendation:** Add VPC Gateway Endpoints for S3 and DynamoDB (free), and Interface Endpoints for SQS and Secrets Manager (reduces cost and latency for high-throughput paths).

### Finding 10.3: Bedrock model invocation permissions are overly broad
**Severity: Medium**

Agent base role grants `bedrock:InvokeModel` on resource `*`. This allows invoking any model.

**Recommendation:** Scope to specific model ARNs or model families using condition keys, or at minimum scope to the account's inference profiles.

### Finding 10.4: No CDK snapshot tests
**Severity: Low**

No tests validate that CDK synthesizes expected CloudFormation. Accidental resource changes could go undetected.

**Recommendation:** Add `cdk synth` snapshot tests that compare synthesized templates against baselines.

---

## 11. Observability

### 11.1 Logging

**Strengths:**
- Structured JSON logging via Pino throughout control-plane and agent-runtime
- Child loggers with context (adapter name, botId, groupJid)
- Request-level logging in Fastify

### Finding 11.1: No request correlation IDs
**Severity: Medium**

Messages flow through webhook -> SQS -> dispatcher -> AgentCore -> reply consumer -> channel adapter, but there's no correlation ID that ties the entire flow together. Debugging a single user message requires correlating logs across multiple systems by timestamp and botId/groupJid.

**Recommendation:** Generate a unique request ID at webhook ingestion and propagate it through SQS message attributes, invocation payload, and reply context. Include it in all log entries along the path.

### Finding 11.2: No metrics emission
**Severity: Medium**

The CloudWatch monitoring stack creates dashboards and alarms for SQS/ECS/DynamoDB infrastructure metrics, but the application emits no custom metrics. Key business metrics are invisible:
- Messages processed per bot/channel
- Agent invocation latency (P50/P95/P99)
- Token consumption rates
- Channel adapter error rates
- Quota utilization

**Recommendation:** Add CloudWatch EMF (Embedded Metric Format) via Pino's log-based metrics pattern, or use the `aws-embedded-metrics` library to emit custom metrics without changing the logging infrastructure.

### Finding 11.3: Health check is minimal
**Severity: Low**

The `/health` endpoint returns `{ status: 'ok', uptime, timestamp }` but doesn't check downstream dependencies (DynamoDB, SQS, Secrets Manager connectivity).

**Recommendation:** Add a `/health/deep` endpoint that validates critical dependencies. Keep `/health` lightweight for ALB probes.

---

## 12. Resilience

### Finding 12.1: No retry logic for channel API calls
**Severity: Critical**

Channel adapters (Telegram, Discord, Slack, Feishu, DingTalk) make outbound API calls with no retry logic. If a channel API returns a transient error (rate limit, 503), the reply is lost.

The reply consumer (`reply-consumer.ts:146`) does have implicit SQS-based retry (don't delete message on error), but this retries the entire flow including potentially re-reading from S3. Individual API calls should have explicit retry with exponential backoff.

**Recommendation:** Add retry with exponential backoff for transient failures (429, 500, 502, 503) in all channel client wrappers. Libraries like `p-retry` or AWS SDK's built-in retry can help. Respect channel-specific rate limit headers (e.g., Discord's `Retry-After`).

### Finding 12.2: No circuit breaker pattern
**Severity: Medium**

When a channel API is down, the system will continuously attempt to send replies, consuming resources. The health checker marks channels as unhealthy after 3 consecutive failures, but this doesn't prevent reply attempts.

**Recommendation:** Integrate the health checker status with the reply consumer: skip reply attempts for channels marked unhealthy and route messages to a retry buffer. Consider a lightweight circuit breaker (e.g., opossum library).

### Finding 12.3: DLQ has no automated processing
**Severity: Medium**

The SQS DLQ receives messages after 3 failed processing attempts and retains them for 14 days. There is a CloudWatch alarm for DLQ depth, but no automated replay mechanism.

**Recommendation:** Add a DLQ replay tool (Lambda or CLI script) that can re-drive messages from DLQ back to the main queue after the root cause is fixed.

### Finding 12.4: In-process cache has no size bounds
**Severity: Medium**

`control-plane/src/services/cache.ts` implements a TTL-based cache with no maximum size limit. Under heavy load with many distinct bots, the cache could grow unbounded and consume significant memory.

**Recommendation:** Add an LRU eviction policy with a configurable max size (e.g., 10,000 entries). The `lru-cache` package is lightweight and battle-tested.

### Finding 12.5: Agent slot leak potential
**Severity: Low**

The slot auto-release mechanism (`SLOT_TTL_MS = 5 minutes`) in `dynamo.ts:154` is a good safeguard, but the detection relies on the next invocation attempt to trigger cleanup. If a bot has no new messages for an extended period, a leaked slot persists until the next message arrives.

**Recommendation:** Add a periodic background job (similar to health checker) that scans for stale slots and releases them proactively.

---

## Summary Table

| # | Finding | Severity | Area |
|---|---------|----------|------|
| 3.1 | Raw error details exposed to end users | **Critical** | Error Handling |
| 9.1 | Critically low test coverage (5 test files for 8k+ LOC) | **Critical** | Testing |
| 9.2 | No integration test infrastructure | **Critical** | Testing |
| 12.1 | No retry logic for channel API calls | **Critical** | Resilience |
| 2.1 | Monolithic dynamo.ts (1058 lines, 8 tables) | **High** | Separation of Concerns |
| 4.1 | SqsReplyContext / ReplyContext near-duplication | **High** | Code Duplication |
| 4.2 | Leader election duplicated across 3 gateway managers | **High** | Code Duplication |
| 6.1 | 20+ `any` types in Feishu tools | **High** | Type Safety |
| 6.2 | Unvalidated SQS message payloads | **High** | Type Safety |
| 7.2 | Dev-mode JWT bypass controlled by STAGE env var | **High** | Configuration |
| 8.1 | Channel-specific fields create god object in reply context | **High** | Extensibility |
| 9.3 | Web-console has zero tests | **High** | Testing |
| 10.1 | No PITR on most DynamoDB tables | **High** | Infrastructure |
| 1.2 | No linting or formatting enforcement | **Medium** | Package Structure |
| 2.2 | Dispatcher combines too many concerns | **Medium** | Separation of Concerns |
| 2.3 | Channel adapter/client layer confusion | **Medium** | Separation of Concerns |
| 3.2 | Inconsistent error typing in catch blocks | **Medium** | Error Handling |
| 3.3 | Silent error swallowing in fire-and-forget patterns | **Medium** | Error Handling |
| 4.3 | API types duplicated between shared and web-console | **Medium** | Code Duplication |
| 4.4 | Deprecated ModelProvider coexists with ProviderType | **Medium** | Code Duplication |
| 5.1 | No API versioning strategy | **Medium** | API Design |
| 6.3 | DynamoDB results cast without runtime validation | **Medium** | Type Safety |
| 6.4 | Non-null assertions on env vars in agent-runtime | **Medium** | Type Safety |
| 7.1 | Agent-runtime lacks centralized config | **Medium** | Configuration |
| 7.3 | Hardcoded OAuth callback URL | **Medium** | Configuration |
| 10.2 | No VPC endpoints for AWS services | **Medium** | Infrastructure |
| 10.3 | Bedrock invocation permissions overly broad | **Medium** | Infrastructure |
| 11.1 | No request correlation IDs across message flow | **Medium** | Observability |
| 11.2 | No custom application metrics | **Medium** | Observability |
| 12.2 | No circuit breaker pattern for channel APIs | **Medium** | Resilience |
| 12.3 | DLQ has no automated replay mechanism | **Medium** | Resilience |
| 12.4 | In-process cache has no size bounds | **Medium** | Resilience |
| 1.1 | Unused Zod dependency in shared | **Low** | Package Structure |
| 3.4 | Webhooks always return 200 (intentional but undocumented) | **Low** | Error Handling |
| 5.2 | Inconsistent PATCH vs PUT for partial updates | **Low** | API Design |
| 5.3 | Admin endpoint prefix inconsistency | **Low** | API Design |
| 8.2 | No plugin system for MCP tools | **Low** | Extensibility |
| 10.4 | No CDK snapshot tests | **Low** | Infrastructure |
| 11.3 | Health check doesn't validate downstream deps | **Low** | Observability |
| 12.5 | Agent slot leak potential between messages | **Low** | Resilience |

---

## Prioritized Recommendations

### Immediate (before next deployment)
1. **Sanitize error messages** sent to channel users (Finding 3.1)
2. **Validate SQS payloads** at consumer boundary (Finding 6.2)
3. **Strengthen dev-mode auth bypass safeguard** (Finding 7.2)

### Short-term (next 2 sprints)
4. **Add retry logic** for channel API calls (Finding 12.1)
5. **Split dynamo.ts** into domain-specific modules (Finding 2.1)
6. **Add unit tests** for critical paths: dynamo, signature verification, SQS consumer (Finding 9.1)
7. **Enable PITR** on all production DynamoDB tables (Finding 10.1)
8. **Add request correlation IDs** (Finding 11.1)

### Medium-term (next quarter)
9. **Consolidate ReplyContext types** using discriminated unions (Findings 4.1, 8.1)
10. **Extract leader election** into shared utility (Finding 4.2)
11. **Add integration test infrastructure** with DynamoDB Local (Finding 9.2)
12. **Add VPC endpoints** for S3/DynamoDB (Finding 10.2)
13. **Add custom metrics** for business KPIs (Finding 11.2)
14. **Centralize agent-runtime config** with startup validation (Finding 7.1)
15. **Add ESLint/Prettier** with pre-commit hooks (Finding 1.2)

### Long-term (backlog)
16. Complete ModelProvider → ProviderType migration (Finding 4.4)
17. API versioning strategy (Finding 5.1)
18. Web-console testing (Finding 9.3)
19. DLQ replay tooling (Finding 12.3)
20. Cache size bounds (Finding 12.4)
