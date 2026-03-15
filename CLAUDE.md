# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClawBot Cloud — a multi-tenant AI assistant platform on AWS. Users create Bots via a web console, connect messaging channels (Telegram, Discord, Slack), and Bots run Claude Agents in AgentCore microVMs with independent memory, conversations, and scheduled tasks.

## Commands

```bash
# Install all dependencies (from repo root)
npm install

# Build all packages
npm run build --workspaces

# Build a single package
npm run build -w shared
npm run build -w control-plane
npm run build -w agent-runtime
npm run build -w web-console
npm run build -w infra

# Type-check without emitting
npm run typecheck -w control-plane
npm run typecheck -w agent-runtime
npm run typecheck -w infra
npm run typecheck -w shared

# Run tests (control-plane only — vitest)
npm test -w control-plane
npm run test:watch -w control-plane   # watch mode

# Local development
npm run dev -w control-plane          # tsx watch, port 3000
npm run dev -w web-console            # vite, port 5173

# CDK infrastructure
cd infra
npx cdk synth                         # synthesize CloudFormation
npx cdk deploy --all                  # deploy all stacks
npx cdk bootstrap                     # one-time per account/region
```

**Build order matters:** `shared` must be built before packages that depend on it (`control-plane`, `agent-runtime`).

## Architecture

NPM workspaces monorepo with 5 packages. ESM throughout (`"type": "module"`), TypeScript strict mode, target ES2022.

### Package dependency graph

```
shared ◄── control-plane
       ◄── agent-runtime

infra (standalone — references no other packages)
web-console (standalone — talks to control-plane via REST)
```

### Package roles

- **shared** (`@clawbot/shared`) — Domain types (User, Bot, Channel, Message, Task, Session), XML formatter for agent context, text utilities. Exports via subpath exports: `@clawbot/shared/types`, `@clawbot/shared/xml-formatter`, `@clawbot/shared/text-utils`.
- **control-plane** (`@clawbot/control-plane`) — Fastify HTTP server on ECS Fargate. Handles webhook ingestion (Telegram/Discord/Slack), REST API for the web console (JWT-authed via Cognito), SQS FIFO message dispatching to AgentCore, and reply consumption back to channel APIs.
- **agent-runtime** (`@clawbot/agent-runtime`) — Runs inside AgentCore microVMs. Wraps Claude Agent SDK with MCP tools (send_message, schedule_task, etc.). Manages S3 session sync, multi-layer CLAUDE.md memory, and STS ABAC scoped credentials. Exposes `/invocations` and `/ping` endpoints.
- **infra** (`@clawbot/infra`) — AWS CDK (TypeScript). 6 stacks: Foundation (VPC, S3, DynamoDB, SQS, ECR), Auth (Cognito), Agent (IAM ABAC roles), ControlPlane (ALB, ECS, WAF), Frontend (CloudFront + S3), Monitoring (CloudWatch).
- **web-console** (`@clawbot/web-console`) — React 19 SPA with Vite, TailwindCSS, AWS Amplify for Cognito auth. Pages: Login, Dashboard, BotDetail, ChannelSetup, Messages, Tasks.

### Message flow

User message → Channel webhook → Control Plane (signature verification, DynamoDB store) → SQS FIFO → SQS consumer → AgentCore invocation → Claude Agent SDK `query()` → MCP tools → response stored in DynamoDB → Channel API reply.

SQS FIFO provides per-group message ordering with cross-group parallelism.

### Security model

- Cognito JWT on all `/api/*` routes
- Per-channel webhook signature verification (Telegram secret token, Discord Ed25519, Slack HMAC-SHA256)
- ABAC via STS SessionTags — agents can only access their owner's S3 paths and DynamoDB records
- Channel tokens in Secrets Manager, never exposed to agents
- Fargate in private subnets, WAF rate limiting

### Data layer

- **DynamoDB** — 7 tables for Users, Bots, Channels, Messages, Tasks, Sessions, Groups
- **S3** — Session state and CLAUDE.md memory files
- **Secrets Manager** — Channel API tokens (Telegram, Discord, Slack)
- **EventBridge Scheduler** — Scheduled tasks → SQS → Agent

## Key Libraries

| Library | Version | Used in |
|---------|---------|---------|
| Fastify | 5.2 | control-plane, agent-runtime |
| AWS SDK v3 | 3.700+ | control-plane, agent-runtime |
| Claude Agent SDK | 0.2.76 | agent-runtime |
| MCP SDK | 1.0.0 | agent-runtime |
| Zod | 4.0 | shared, control-plane, agent-runtime |
| React | 19 | web-console |
| AWS Amplify | 6.12 | web-console |
| AWS CDK | 2.170 | infra |
| Vitest | 2.1 | control-plane (testing) |
| Pino | 9.6 | control-plane, agent-runtime (logging) |

## Conventions

- IDs generated with ULID (control-plane)
- Logging via Pino (structured JSON)
- Schema validation with Zod 4
- Docker images target ARM64 (Graviton for Fargate)
- Agent runtime container includes Chromium + fonts for browser-based MCP tools
- `.npmrc` has `install-links=true` for workspace symlinks

## Design Document
Full architecture details: [`docs/CLOUD_ARCHITECTURE.md`](./docs/CLOUD_ARCHITECTURE.md)