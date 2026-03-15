# ClawBot Cloud

Multi-tenant AI assistant platform on AWS, evolved from [NanoClaw](../README.md).

Users create Bots via a web console, connect messaging channels (Telegram, Discord, Slack), and Bots run Claude Agents in isolated cloud environments — each with independent memory, conversations, and scheduled tasks.

## Architecture

```
User (Telegram/Discord/Slack)
  │
  ▼ Webhook
ALB ──► ECS Fargate (Control Plane)
         ├── Webhook Handler → SQS FIFO
         ├── SQS Consumer → AgentCore Runtime (microVM)
         │                    └── Claude Agent SDK
         │                        └── Bedrock Claude
         ├── Reply Consumer → Channel API → User
         └── REST API (JWT auth) ◄── Web Console (React SPA on CloudFront)

Data Layer: DynamoDB (state) │ S3 (sessions, memory) │ Secrets Manager (credentials)
Scheduling: EventBridge Scheduler → SQS → Agent
Auth: Cognito User Pool (JWT)
Security: WAF │ ABAC via STS SessionTags │ Per-tenant S3/DynamoDB isolation
```

## Packages

| Package | Description |
|---------|-------------|
| `shared/` | TypeScript types and utilities (ported from NanoClaw) |
| `infra/` | AWS CDK — 6 stacks (Foundation, Auth, Agent, ControlPlane, Frontend, Monitoring) |
| `control-plane/` | Fastify HTTP server + SQS consumers (runs on ECS Fargate) |
| `agent-runtime/` | Claude Agent SDK wrapper (runs in AgentCore microVMs) |
| `web-console/` | React SPA — bot management, channel config, message history, tasks |

## Key Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Tenant model | One user, many Bots | Per-scenario isolation |
| Channel credentials | BYOK (Bring Your Own Key) | User controls their bots |
| Control plane | ECS Fargate (always-on) | No 15-min Lambda timeout |
| Agent runtime | AgentCore (microVM) | Serverless, per-session isolation |
| Agent SDK | Claude Agent SDK + Bedrock | Full tool access, IAM-native auth |
| Message queue | SQS FIFO | Per-group ordering, cross-group parallelism |
| Database | DynamoDB | Serverless, millisecond latency |
| Auth | Cognito | Managed JWT, self-service signup |
| IaC | CDK (TypeScript) | Type-safe, same language as app |

## NanoClaw → Cloud Mapping

| NanoClaw (single-user) | ClawBot Cloud (multi-tenant) |
|------------------------|------------------------------|
| SQLite | DynamoDB (7 tables) |
| Local filesystem (`groups/`) | S3 (sessions, CLAUDE.md memory) |
| Docker containers | AgentCore microVMs |
| File-based IPC | MCP tools → AWS SDK (SQS, DynamoDB, EventBridge) |
| Polling loop | SQS FIFO consumer |
| Channel self-registration | Webhook HTTP endpoints |
| Credential proxy | IAM Roles + STS ABAC |

## Prerequisites

- Node.js >= 20
- AWS account with CDK bootstrapped
- AWS CLI configured (`aws configure`)

## Quick Start

```bash
# Install dependencies
npm install

# Build all packages
npm run build --workspaces

# Deploy infrastructure (first time)
cd infra
npx cdk bootstrap   # once per account/region
npx cdk deploy --all

# Run control plane locally (pointing at deployed AWS resources)
cd ../control-plane
cp .env.example .env   # fill in values from CDK outputs
npm run dev

# Run web console locally
cd ../web-console
npm run dev            # opens http://localhost:5173
```

## Project Structure

```
cloud_native_nanoclaw/
├── shared/src/
│   ├── types.ts              # User, Bot, Channel, Message, Task, Session...
│   ├── xml-formatter.ts      # Agent context formatting (from NanoClaw)
│   └── text-utils.ts         # Output processing
├── infra/
│   ├── bin/app.ts            # CDK app entry
│   └── lib/
│       ├── foundation-stack.ts   # VPC, S3, DynamoDB, SQS, ECR
│       ├── auth-stack.ts         # Cognito
│       ├── agent-stack.ts        # IAM Roles (ABAC)
│       ├── control-plane-stack.ts# ALB, ECS Fargate, WAF
│       ├── frontend-stack.ts     # CloudFront + S3
│       └── monitoring-stack.ts   # CloudWatch, alarms
├── control-plane/src/
│   ├── index.ts              # Fastify app + SQS consumer startup
│   ├── webhooks/             # Telegram, Discord, Slack handlers
│   ├── sqs/                  # Message dispatcher + reply consumer
│   ├── routes/api/           # REST API (bots, channels, groups, tasks)
│   ├── services/             # DynamoDB, cache, credential lookups
│   └── channels/             # Channel API clients
├── agent-runtime/src/
│   ├── server.ts             # HTTP server (/invocations, /ping)
│   ├── agent.ts              # Claude Agent SDK integration
│   ├── session.ts            # S3 session sync
│   ├── memory.ts             # Multi-layer CLAUDE.md
│   ├── scoped-credentials.ts # STS ABAC
│   ├── mcp-tools.ts          # send_message, schedule_task, etc.
│   └── mcp-server.ts         # MCP stdio server
└── web-console/src/
    ├── pages/                # Login, Dashboard, BotDetail, ChannelSetup...
    ├── lib/                  # Auth (Cognito), API client
    └── components/           # Layout
```

## Message Flow

1. User sends `@Bot hello` in Telegram group
2. Telegram POST → `/webhook/telegram/{bot_id}` (ALB → Fargate)
3. Webhook handler verifies signature, stores message in DynamoDB, enqueues to SQS FIFO
4. SQS consumer dequeues, loads recent messages, formats XML context
5. Invokes AgentCore Runtime → Claude Agent SDK `query()`
6. Agent generates response, optionally uses MCP tools (schedule_task, send_message)
7. Response stored in DynamoDB, sent back via Telegram API
8. User sees reply in Telegram

## Security

- **Auth**: Cognito JWT on all `/api/*` routes
- **Webhooks**: Per-channel signature verification (Telegram secret token, Discord Ed25519, Slack HMAC-SHA256)
- **Data isolation**: ABAC via STS SessionTags — agents can only access their owner's S3 paths and DynamoDB records
- **Network**: Fargate in private subnets, WAF rate limiting (2000 req/5min/IP)
- **Credentials**: Channel tokens stored in Secrets Manager, never exposed to agents

## Cost Estimate (single user)

| Component | ~Monthly Cost |
|-----------|--------------|
| AgentCore (30 msgs/day, 18s avg) | $0.40 |
| Bedrock Claude tokens | $5.40 |
| Fargate (2 tasks, 0.5 vCPU) | $30 |
| ALB | $16 |
| DynamoDB (on-demand) | $0.50 |
| S3 + CloudFront | $0.60 |
| **Total (1 user)** | **~$53/mo** |
| **100 users (amortized)** | **~$8/user/mo** |

## Design Document

Full architecture details: [`docs/CLOUD_ARCHITECTURE.md`](./docs/CLOUD_ARCHITECTURE.md)
