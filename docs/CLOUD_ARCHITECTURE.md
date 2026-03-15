# ClawBot Cloud 架构设计文档

> 基于 NanoClaw 架构，面向多用户的 AWS 云原生 AI 助手平台

---

## 目录

1. [产品定位](#1-产品定位)
2. [核心架构决策](#2-核心架构决策)
3. [系统全景图](#3-系统全景图)
4. [分层架构详解](#4-分层架构详解)
5. [数据模型](#5-数据模型)
6. [消息生命周期](#6-消息生命周期)
7. [Bot 生命周期](#7-bot-生命周期)
8. [Channel 管理](#8-channel-管理)
9. [Agent 执行层](#9-agent-执行层)
10. [任务调度](#10-任务调度)
11. [安全架构](#11-安全架构)
12. [可观测性](#12-可观测性)
13. [成本模型](#13-成本模型)
14. [NanoClaw → ClawBot Cloud 映射](#14-nanoclaw--clawbot-cloud-映射)
15. [CDK 部署架构](#15-cdk-部署架构)

---

## 1. 产品定位

ClawBot Cloud 是基于 NanoClaw 架构的多用户 AI 助手平台。用户通过 Web 控制台创建自己的 ClawBot，配置消息频道（Telegram、Discord、Slack 等），ClawBot 在云端隔离环境中运行 Claude Agent，自动响应用户的消息。

**核心用户场景：**

```
1. 用户注册 → 登录 Web 控制台
2. 创建一个 ClawBot（如 "工作助手"）
3. 配置 Telegram 频道（填入自己的 Bot Token）
4. 平台自动注册 Webhook，Bot 上线
5. 用户在 Telegram 群里 @Bot，Bot 通过 Claude Agent 回复
6. 用户可创建多个 Bot（如 "生活助手"、"代码审查 Bot"）
7. 每个 Bot 有独立记忆、独立频道、独立对话历史
```

---

## 2. 核心架构决策

| 决策项 | 选择 | 原因 |
|--------|------|------|
| 租户模型 | 一用户多 Bot | 用户可按场景创建不同助手 |
| Channel 凭证 | 用户自带 (BYOK) | 灵活、无平台单点、用户完全控制 |
| Control Plane | ECS Fargate Service (常驻) | 无超时限制、内存缓存、HTTP + SQS Consumer 合一 |
| Webhook 路由 | 统一入口 + ALB 路径路由 | 一个 ALB 搞定，Fargate 直接处理 |
| Agent 运行时 | AgentCore Runtime | 自动扩缩、按 CPU 计费、microVM 隔离 |
| Agent SDK | Claude Agent SDK + `CLAUDE_CODE_USE_BEDROCK=1` | 保留全套 claude-code 工具，Bedrock 原生调用 |
| 消息队列 | SQS FIFO + MessageGroupId | 保证 per-group 有序，跨 group 并行 |
| 数据库 | DynamoDB | 无服务器、按需扩缩、毫秒级延迟 |
| 文件存储 | S3 | Session 文件、群组记忆、对话归档 |
| 用户认证 | Cognito User Pool | 托管认证、支持 OAuth/OIDC |
| 定时任务 | EventBridge Scheduler | 原生 cron、精确到秒、无需自建调度器 |

---

## 3. 系统全景图

```
┌─────────────────────────────────────────────────────────────────┐
│                         用户终端                                 │
│  Telegram / Discord / Slack / WhatsApp ←──── 频道消息收发         │
│  Web 浏览器 ←──── 控制台管理                                     │
└───────┬─────────────────────────────────────────┬───────────────┘
        │                                         │
        │ HTTPS                                   │ Webhook
        ▼                                         ▼
┌──────────────┐                        ┌─────────────────────┐
│  CloudFront  │                        │  ALB               │
│  + S3 (SPA)  │                        │  (Application      │
│  Web 控制台   │                        │   Load Balancer)   │
└──────┬───────┘                        │  /api/*   → 控制面  │
       │                                │  /webhook/* → 消息  │
       │ API 调用                        └────────┬────────────┘
       │                                         │
       ▼                                         │
┌──────────────────────────────────────────────────────────────┐
│         ECS Fargate Service (常驻, Control Plane)             │
│                                                              │
│  ┌──────────────────────────────────────────────────┐       │
│  │  HTTP Server (Express/Fastify)                    │       │
│  │  ├── /api/*       → REST API (Bot/Channel CRUD)   │       │
│  │  ├── /webhook/*   → Webhook 接收 + 签名验证        │       │
│  │  └── /health      → ALB 健康检查                   │       │
│  ├──────────────────────────────────────────────────┤       │
│  │  SQS Consumer (后台线程, 长轮询)                    │       │
│  │  ├── 消费消息 → 加载 Bot 配置                       │       │
│  │  ├── InvokeAgentRuntime (无超时限制)                │       │
│  │  └── 回复路由 → Channel API                        │       │
│  ├──────────────────────────────────────────────────┤       │
│  │  Cognito JWT 验证 (中间件)                         │       │
│  └──────────────────────────────────────────────────┘       │
│                                                              │
│  SQS FIFO Queue ← Webhook 入队                               │
│  MessageGroupId = {bot_id}#{group_jid}                       │
│                                                              │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           │ InvokeAgentRuntime
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                     Agent Execution Layer                     │
│                                                              │
│  AgentCore Runtime                                           │
│  ┌──────────────────────────────────────────────────┐       │
│  │  microVM (per session)                            │       │
│  │  ├── Claude Agent SDK                             │       │
│  │  │   └── CLAUDE_CODE_USE_BEDROCK=1                │       │
│  │  │       └── Bedrock Claude (IAM Role)            │       │
│  │  ├── 工具: Read/Write/Edit/Bash/Glob/Grep         │       │
│  │  ├── S3 session 恢复/回写                          │       │
│  │  └── 结果 → DynamoDB + Channel API (回复)          │       │
│  └──────────────────────────────────────────────────┘       │
│  ┌──────────────────────────────────────────────────┐       │
│  │  microVM (另一个 session)                          │       │
│  │  └── ...                                          │       │
│  └──────────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                     Data Layer                                │
│                                                              │
│  ┌──────────┐  ┌────┐  ┌─────────────┐  ┌────────────────┐ │
│  │ DynamoDB  │  │ S3 │  │ Secrets Mgr │  │ EventBridge    │ │
│  │ (状态)    │  │    │  │ (Channel    │  │ Scheduler      │ │
│  │          │  │    │  │  凭证)       │  │ (定时任务)      │ │
│  └──────────┘  └────┘  └─────────────┘  └────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. 分层架构详解

### 4.1 Web 控制台

```
技术栈: React / Next.js
部署:   S3 (静态资源) + CloudFront (CDN + HTTPS)
认证:   Cognito Hosted UI 或自建登录页 + Cognito SDK
```

**页面结构：**

| 页面 | 功能 |
|------|------|
| 登录/注册 | Cognito 认证 |
| Dashboard | Bot 列表、状态概览、用量统计 |
| Bot 详情 | 配置、Channel 管理、记忆编辑 |
| Channel 配置 | 添加/删除频道、填写凭证、连接状态 |
| 对话历史 | 按 Group 查看消息记录 |
| 定时任务 | 创建/暂停/恢复/删除任务 |
| 日志 | Agent 执行日志、错误追踪 |

### 4.2 ECS Fargate Service (Control Plane + Dispatcher)

Control Plane 和 Dispatcher 合并为一个常驻 Fargate Service，消除 Lambda 15 分钟超时限制。

```
技术栈: ECS Fargate Service (Node.js/TypeScript, Express/Fastify)
部署:   ALB (Application Load Balancer) → Fargate Task
认证:   Cognito JWT (Express 中间件验证)
规格:   0.5 vCPU / 1GB Memory, 最小 2 Task (高可用)
```

**进程内部结构：**

```
Fargate Task (单进程, 多线程)
├── HTTP Server (主线程)
│   ├── /api/*       → REST API 端点 (需 JWT 认证)
│   ├── /webhook/*   → Webhook 接收端点 (无需认证, 签名验证)
│   └── /health      → ALB 健康检查
│
├── SQS Consumer (后台线程, 长轮询)
│   ├── sqs.receiveMessage({ WaitTimeSeconds: 20 })
│   ├── 消费消息 → InvokeAgentRuntime (无超时限制)
│   └── 结果 → Channel API 回复
│
└── Session Tracker (内存缓存)
    └── Map<botId#groupJid, { sessionId, lastActiveAt }>
```

**API 端点设计：**

```
# 用户相关 (需 JWT)
GET    /api/me                              # 当前用户信息

# Bot 管理 (需 JWT)
POST   /api/bots                            # 创建 Bot
GET    /api/bots                            # 列出用户的所有 Bot
GET    /api/bots/{bot_id}                   # Bot 详情
PUT    /api/bots/{bot_id}                   # 更新 Bot 配置
DELETE /api/bots/{bot_id}                   # 删除 Bot

# Channel 管理 (需 JWT)
POST   /api/bots/{bot_id}/channels          # 添加 Channel
GET    /api/bots/{bot_id}/channels          # 列出 Bot 的 Channels
DELETE /api/bots/{bot_id}/channels/{ch_id}  # 删除 Channel
POST   /api/bots/{bot_id}/channels/{ch_id}/test  # 测试连接

# Group 管理 (需 JWT)
GET    /api/bots/{bot_id}/groups            # 列出 Bot 的 Groups
PUT    /api/bots/{bot_id}/groups/{group_id} # 更新 Group 配置

# 消息历史 (需 JWT)
GET    /api/bots/{bot_id}/groups/{gid}/messages  # 对话历史

# 定时任务 (需 JWT)
POST   /api/bots/{bot_id}/tasks             # 创建任务
GET    /api/bots/{bot_id}/tasks             # 列出任务
PUT    /api/bots/{bot_id}/tasks/{task_id}   # 更新/暂停/恢复
DELETE /api/bots/{bot_id}/tasks/{task_id}   # 删除任务

# 记忆管理 (需 JWT)
GET    /api/shared-memory                   # 获取用户共享记忆 (跨 Bot)
PUT    /api/shared-memory                   # 更新用户共享记忆
GET    /api/bots/{bot_id}/memory            # 获取 Bot 全局记忆
PUT    /api/bots/{bot_id}/memory            # 更新 Bot 全局记忆
GET    /api/bots/{bot_id}/groups/{gid}/memory  # Group 记忆
PUT    /api/bots/{bot_id}/groups/{gid}/memory  # 更新 Group 记忆

# Webhook (无需 JWT, 签名验证)
POST   /webhook/telegram/{bot_id}           # Telegram Webhook
POST   /webhook/discord/{bot_id}            # Discord Webhook
POST   /webhook/slack/{bot_id}              # Slack Events API
POST   /webhook/whatsapp/{bot_id}           # WhatsApp Webhook
GET    /webhook/whatsapp/{bot_id}           # WhatsApp 验证
```

### 4.3 Webhook 接收 (HTTP Server 内)

Webhook 请求由同一个 Fargate Service 的 HTTP Server 处理：

```
POST /webhook/telegram/{bot_id}
    │
    ▼
HTTP Server (Fargate 内)
    │
    ├── 1. 从路径提取 bot_id
    ├── 2. 从 DynamoDB 加载 Bot + Channel 配置
    ├── 3. 从 Secrets Manager 获取 Channel 凭证 (带缓存)
    ├── 4. 验证 Webhook 签名 (防伪造)
    │      ├── Telegram: 验证 secret_token header
    │      ├── Discord: 验证 Ed25519 签名
    │      ├── Slack: 验证 signing secret
    │      └── WhatsApp: 验证 app secret
    ├── 5. 解析消息格式 → 统一 Message 结构
    ├── 6. 写入 DynamoDB (messages 表, ttl = now + 90天)
    ├── 7. 检查触发条件 (@mention / 私聊)
    ├── 8. 如果触发 → 发送到 SQS FIFO
    │      MessageGroupId = {bot_id}#{group_jid}
    └── 9. 立即返回 200 (Webhook 要求快速响应)
```

**常驻进程的缓存优势：**

```
Lambda 模式: 每次冷启动都要查 DynamoDB + Secrets Manager
Fargate 模式: 进程内缓存 (TTL 5min)
  ├── Bot 配置缓存:     Map<bot_id, BotConfig>
  ├── Channel 凭证缓存: Map<channel_id, Credentials>
  └── Session 映射缓存: Map<bot_id#group_jid, SessionInfo>
  → 热路径零 DB 查询，Secrets Manager 调用量降低 90%+
```

### 4.4 SQS Consumer (后台线程)

同一 Fargate 进程内的后台消费者，无超时限制：

```
SQS Consumer (后台长轮询)
    │
    │ sqs.receiveMessage({ WaitTimeSeconds: 20 })
    │
    ├── 1. 从消息提取 bot_id, group_jid
    ├── 2. 查内存缓存: 该 group 是否有活跃 AgentCore Session
    │      ├── 有 (< 15min) → 直接 InvokeAgentRuntime (复用)
    │      └── 无 / 过期 → 创建新 session
    ├── 3. 从 DynamoDB 加载近期消息 (逆序取最近 50 条)
    │      Query(PK={bot_id}#{group_jid}, ScanIndexForward=false, Limit=50)
    ├── 4. 格式化为 XML (复用 NanoClaw router 逻辑)
    ├── 5. InvokeAgentRuntime (同步等待, 无超时限制):
    │      {
    │        agentRuntimeArn: CLAWBOT_AGENT_ARN,
    │        runtimeSessionId: "{bot_id}#{group_jid}",
    │        payload: { prompt, botConfig, groupJid }
    │      }
    ├── 6. 解析 Agent 返回结果
    ├── 7. 写入 DynamoDB (bot 消息记录)
    ├── 8. 调用 Channel API 发送回复
    │      (从内存缓存获取凭证)
    └── 9. sqs.deleteMessage() 确认消费
```

**并发控制：** SQS Consumer 并行处理多条消息，通过信号量控制并发：

```typescript
const MAX_CONCURRENT_DISPATCHES = 20; // 单 Task 最大并发
const semaphore = new Semaphore(MAX_CONCURRENT_DISPATCHES);

async function consumeLoop() {
  while (running) {
    const messages = await sqs.receiveMessage({
      QueueUrl: QUEUE_URL,
      MaxNumberOfMessages: 10,     // 批量拉取
      WaitTimeSeconds: 20,         // 长轮询
      VisibilityTimeout: 600,      // 10 分钟处理窗口
    });

    for (const msg of messages.Messages ?? []) {
      await semaphore.acquire();
      dispatch(msg).finally(() => semaphore.release());
    }
  }
}
```

**多 Task 分摊负载：**

```
ECS Service: desiredCount = 2 (最小高可用)
  Task-1: SQS Consumer × 20 并发 + HTTP Server
  Task-2: SQS Consumer × 20 并发 + HTTP Server

ALB 在两个 Task 间做 HTTP 负载均衡。
SQS FIFO 的 MessageGroupId 保证同一 group 的消息
被同一个 consumer 顺序处理 (同一时刻只有一个 consumer 可见)。

SQS FIFO 吞吐:
  使用高吞吐模式 (PER_MESSAGE_GROUP_ID):
  每个 MessageGroupId 独立 300 msg/s 限额
  整体队列吞吐 = 300 × 活跃 MessageGroupId 数
  1000 个活跃 group → 300,000 msg/s (远超需求)

Auto Scaling:
  指标: SQS ApproximateNumberOfMessagesVisible
  阈值: > 50 → 扩容, 持续 0 达 30min → 缩至 2 (不缩到 0, 保高可用)
```

---

## 5. 数据模型

### 5.1 DynamoDB 表设计

采用**多表设计**（比单表更清晰，多租户场景下查询模式明确）：

#### users 表

```
PK: user_id (Cognito sub)
─────────────────────────
email, display_name, created_at, last_login,

# 配额与计划
plan (free/pro/enterprise),
quota (JSON): {
  max_bots: 3,                    # 最大 Bot 数
  max_groups_per_bot: 10,         # 每 Bot 最大 Group 数
  max_tasks_per_bot: 20,          # 每 Bot 最大定时任务数
  max_concurrent_agents: 2,       # 最大并发 Agent 数
  max_monthly_tokens: 500000,     # 每月最大 Bedrock token 用量
},

# 用量追踪 (按月滚动)
usage_month: "2026-03",           # 当前计费月
usage_tokens: 123456,             # 当月已用 token 数
usage_invocations: 456,           # 当月 Agent 调用次数
active_agents: 1,                 # 当前活跃 Agent 数 (实时)
```

#### bots 表

```
PK: user_id    SK: bot_id
─────────────────────────
name, description, system_prompt, status (active/paused/deleted),
trigger_pattern, container_config (JSON), created_at, updated_at

GSI: bot_id-index
  PK: bot_id  → 用于 Webhook 路由 (通过 bot_id 查 Bot)
```

#### channels 表

```
PK: bot_id    SK: channel_type#channel_id
─────────────────────────────────────────
channel_type (telegram/discord/slack/whatsapp),
credential_secret_arn (Secrets Manager ARN),
webhook_url, status (connected/disconnected/error),
config (JSON), created_at,

# 凭证健康检查
last_health_check: "2026-03-14T10:00:00Z",  # 上次检查时间
health_status: "healthy" | "unhealthy" | "unknown",
health_error: "401 Unauthorized",             # 最近的错误信息 (如有)
consecutive_failures: 0,                      # 连续失败次数
user_notified_at: null                        # 通知用户的时间 (避免重复通知)
```

#### groups 表

```
PK: bot_id    SK: group_jid
─────────────────────────────
name, channel_type, is_group (bool),
requires_trigger (bool), last_message_at,
agentcore_session_id, session_status (active/idle/terminated)
```

#### messages 表

```
PK: bot_id#group_jid    SK: timestamp (ISO 8601, 毫秒精度)
─────────────────────────────────────
message_id, sender, sender_name, content,
is_from_me (bool), is_bot_message (bool), channel_type,
ttl (Number, Unix epoch seconds)   # DynamoDB TTL 自动过期

TTL 策略: created_at + 90 天 (7,776,000 秒)
  → 90 天前的消息自动删除，无需手动清理
  → 对话归档已通过 PreCompact hook 持久化到 S3

热分区缓解:
  DynamoDB 按需模式会对高流量分区自适应分裂 (adaptive capacity)。
  单分区写入上限 1,000 WCU/s，对应约 1,000 条消息/秒/group。
  超出此限制的极端场景 (如 Bot 被拉入万人群):
    1. Webhook 层的 WAF 速率限制先拦截 (2000 req/5min/IP)
    2. SQS FIFO 的 MessageGroupId 天然限流 (300 msg/s/group)
    3. 如仍不够 → 消息写入改为批量写入 (BatchWriteItem, 25条/批)

查询优化:
  加载上下文时使用 ScanIndexForward=false + Limit，只取最近 N 条:
    Query(PK=xx, ScanIndexForward=false, Limit=50)
  → 无论历史消息多少，查询时间恒定 O(1)
  → 不使用 Scan，不做全量加载
```

#### tasks 表

```
PK: bot_id    SK: task_id
──────────────────────────
group_jid, prompt, schedule_type (cron/interval/once),
schedule_value, context_mode (isolated/group),
next_run, last_run, last_result, status (active/paused/cancelled),
eventbridge_schedule_arn, created_at
```

#### sessions 表

```
PK: bot_id#group_jid    SK: "current"
──────────────────────────────────────
agentcore_session_id, s3_session_path,
last_active_at, status
```

### 5.2 S3 存储结构

```
s3://clawbot-data/
├── {user_id}/
│   ├── shared/                          # 用户级共享知识 (跨 Bot 只读)
│   │   └── CLAUDE.md                    # 用户共享记忆 (如公司上下文)
│   │
│   └── {bot_id}/
│       ├── memory/
│       │   ├── global/CLAUDE.md         # Bot 全局记忆
│       │   └── {group_jid}/CLAUDE.md    # Group 记忆
│       ├── sessions/
│       │   └── {group_jid}/
│       │       └── .claude/             # Claude Agent SDK session 文件
│       │           ├── session.jsonl
│       │           └── projects/...
│       ├── archives/
│       │   └── conversations/           # 对话归档
│       └── attachments/                 # 多媒体附件 (图片/文件/语音)
│           └── {message_id}/
│               ├── image.jpg
│               ├── voice.ogg
│               └── document.pdf

记忆加载优先级 (Agent 启动时):
  1. {userId}/shared/CLAUDE.md          → /workspace/shared/ (只读, 跨 Bot)
  2. {userId}/{botId}/memory/global/    → /workspace/global/ (只读, Bot 级)
  3. {userId}/{botId}/memory/{groupJid}/ → /workspace/group/ (读写, Group 级)

记忆写入权限:
  - shared/CLAUDE.md:   仅用户通过 Web UI 编辑 (Agent 只读)
  - global/CLAUDE.md:   Agent 可写 (Bot 级持久记忆)
  - {groupJid}/CLAUDE.md: Agent 可写 (Group 级持久记忆)
```

### 5.3 Secrets Manager 结构

```
每个 Channel 一个 Secret:
clawbot/{bot_id}/telegram/{channel_id}
  → { "bot_token": "123456:ABC-DEF..." }

clawbot/{bot_id}/discord/{channel_id}
  → { "bot_token": "...", "public_key": "..." }

clawbot/{bot_id}/slack/{channel_id}
  → { "bot_token": "xoxb-...", "signing_secret": "..." }

clawbot/{bot_id}/whatsapp/{channel_id}
  → { "phone_number_id": "...", "access_token": "...", "app_secret": "..." }
```

---

## 6. 消息生命周期

```
步骤 1: 用户在 Telegram 群里发消息
  Telegram Server → POST /webhook/telegram/{bot_id}

步骤 2: Fargate HTTP Server (Webhook 处理)
  ├── 验证签名 (从内存缓存获取凭证)
  ├── 解析消息 → 统一 Message 格式
  ├── 写入 DynamoDB messages 表
  ├── 检查触发条件
  │   ├── 私聊 → 始终触发
  │   └── 群聊 → 检查 @mention 或 trigger_pattern
  ├── 触发 → SQS FIFO (MessageGroupId = {bot_id}#{group_jid})
  └── 立即返回 200 OK (< 100ms)

步骤 3: Fargate SQS Consumer (同一进程, 后台线程)
  ├── 长轮询拉取消息
  ├── 加载 Bot 配置 (内存缓存, 命中率 > 95%)
  ├── 加载近期消息 (Query, 逆序最近 50 条, 过滤 bot 自身消息)
  ├── 格式化为 XML (NanoClaw router 格式)
  ├── 查询 session 映射 (内存缓存 → DynamoDB 兜底)
  └── InvokeAgentRuntime(runtimeSessionId, payload)
      → 同步等待, 无超时限制

步骤 4: AgentCore Runtime (microVM)
  ├── /invocations 端点收到请求
  ├── 从 S3 恢复 session 文件 (如果新 session)
  ├── 从 S3 加载 CLAUDE.md 记忆
  ├── Claude Agent SDK 处理消息
  │   └── Bedrock Claude (通过 IAM Role)
  ├── 生成回复
  ├── 回写 session 文件到 S3
  └── 返回结果给 Fargate SQS Consumer

步骤 5: Fargate SQS Consumer (收到结果)
  ├── 写入 DynamoDB messages 表 (Bot 回复)
  ├── 更新 session 缓存 + DynamoDB sessions 表
  ├── 从内存缓存获取 Channel 凭证
  ├── 调用 Telegram Bot API 发送回复
  └── sqs.deleteMessage() 确认消费

步骤 6: 用户在 Telegram 收到回复
```

**错误恢复：**
- Webhook 处理失败 → ALB 返回 500，Telegram 会重试
- SQS 消息处理失败 → VisibilityTimeout 到期后自动重新可见 → 重试
- 重试 3 次仍失败 → 进入 DLQ (死信队列)，触发告警
- AgentCore 调用失败 → 不删除 SQS 消息，等待重试
- Session 恢复失败 → 创建新 session，丢失上下文但不丢消息
- Fargate Task 崩溃 → ECS 自动重启 + ALB 健康检查摘除

---

## 7. Bot 生命周期

```
┌─────────┐    创建     ┌──────────┐   添加 Channel   ┌────────────┐
│ (不存在)  │──────────→│  created  │────────────────→│  ready     │
└─────────┘            └──────────┘                  └─────┬──────┘
                                                           │
                                              激活 (自动)   │
                                                           ▼
                       ┌──────────┐    暂停    ┌────────────┐
                       │  paused  │←──────────│   active    │
                       └────┬─────┘           └────────────┘
                            │                      ▲
                            │    恢复               │
                            └──────────────────────┘

                       任何状态 → deleted (软删除, 30天后硬删除)
```

**创建 Bot 流程：**

```typescript
// POST /api/bots
{
  name: "工作助手",
  description: "帮我处理日常工作事务",
  system_prompt: "你是一个专业的工作助手...",  // 可选
  trigger_pattern: "@Andy"                    // 可选，默认 @BotName
}
```

**配置项：**

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `name` | 必填 | Bot 显示名 |
| `system_prompt` | 默认 prompt | 注入到 CLAUDE.md 的全局指令 |
| `trigger_pattern` | `@{name}` | 群聊触发模式 |
| `max_turns` | 50 | 单次对话最大 Agent 轮次 |
| `timeout` | 300s | 单次执行超时 |
| `idle_memory_prompt` | 默认 | 空闲时写入记忆的指令 |

---

## 8. Channel 管理

### 8.1 添加 Channel 流程

```
用户在 Web UI 点击 "添加 Telegram"
    │
    ▼
Web UI 显示表单: 填入 Bot Token
    │
    ▼
POST /api/bots/{bot_id}/channels
  { type: "telegram", credentials: { bot_token: "123:ABC" } }
    │
    ▼
Fargate Control Plane (HTTP API):
  ├── 1. 验证凭证有效性
  │      └── 调用 Telegram getMe API → 确认 Token 有效
  ├── 2. 存储凭证到 Secrets Manager
  │      └── clawbot/{bot_id}/telegram/{channel_id}
  ├── 3. 注册 Webhook
  │      └── 调用 Telegram setWebhook API
  │          url: https://api.clawbot.com/webhook/telegram/{bot_id}
  │          secret_token: {随机生成，存入 Secret}
  ├── 4. 写入 DynamoDB channels 表
  └── 5. 返回 Channel 状态
```

### 8.2 各 Channel 类型对比

| | Telegram | Discord | Slack | WhatsApp |
|---|---|---|---|---|
| 认证方式 | Bot Token | Bot Token + Public Key | Bot Token + Signing Secret | Access Token + App Secret |
| Webhook 注册 | setWebhook API | Application Portal 或 API | Events API URL | Meta Business API |
| 消息格式 | Update JSON | Interaction JSON | Event JSON | Webhook JSON |
| 签名验证 | secret_token header | Ed25519 签名 | HMAC-SHA256 | HMAC-SHA256 |
| 群组支持 | 是 | 是 (Guild) | 是 (Channel) | 是 |
| 回复方式 | sendMessage API | 直接响应 / REST API | chat.postMessage | messages API |
| 用户侧配置 | 只需 Bot Token | Token + 回调 URL 配置 | App 安装 + 权限 | Meta 开发者账号 |
| 接入难度 | 低 | 中 | 中 | 高 |

### 8.3 Webhook 签名验证

每种 Channel 的签名验证在 Fargate HTTP Server 内完成：

```typescript
// Telegram: 验证 X-Telegram-Bot-Api-Secret-Token header
function verifyTelegram(headers, secretToken): boolean {
  return headers['x-telegram-bot-api-secret-token'] === secretToken;
}

// Discord: 验证 Ed25519 签名
function verifyDiscord(headers, body, publicKey): boolean {
  const signature = headers['x-signature-ed25519'];
  const timestamp = headers['x-signature-timestamp'];
  return nacl.sign.detached.verify(
    Buffer.from(timestamp + body),
    Buffer.from(signature, 'hex'),
    Buffer.from(publicKey, 'hex')
  );
}

// Slack: 验证 HMAC-SHA256
function verifySlack(headers, body, signingSecret): boolean {
  const timestamp = headers['x-slack-request-timestamp'];
  const sig = 'v0=' + hmacSha256(signingSecret, `v0:${timestamp}:${body}`);
  return timingSafeEqual(sig, headers['x-slack-signature']);
}
```

### 8.4 删除 Channel 流程

```
DELETE /api/bots/{bot_id}/channels/{channel_id}
    │
    ├── 1. 注销 Webhook (调用 Channel API)
    ├── 2. 删除 Secrets Manager 中的凭证
    ├── 3. 更新 DynamoDB channels 表 (标记 deleted)
    └── 4. 该 Channel 相关的 Groups 标记为 disconnected
```

### 8.5 Channel 凭证健康检查

用户的 Bot Token 可能被撤销、过期或泄露。平台需要主动检测并通知用户。

**检查机制：** Fargate Control Plane 内运行定时健康检查循环（每小时）。

```
健康检查循环 (每 60 分钟)
    │
    ├── 1. 扫描 DynamoDB channels 表
    │      条件: status = "connected" AND
    │            (last_health_check < 1 小时前 OR last_health_check 为空)
    │
    ├── 2. 对每个 Channel 调用验证 API
    │      ├── Telegram: getMe (验证 Bot Token)
    │      ├── Discord:  /users/@me (验证 Bot Token)
    │      ├── Slack:    auth.test (验证 Bot Token)
    │      └── WhatsApp:  /{phone_number_id} (验证 Access Token)
    │
    ├── 3. 更新 DynamoDB channels 表
    │      ├── 成功 → health_status="healthy", consecutive_failures=0
    │      └── 失败 → health_status="unhealthy", consecutive_failures++
    │
    └── 4. 如果 consecutive_failures >= 3 且 user_notified_at 为空
           ├── 通过 Channel 所属 Bot 的其他健康 Channel 通知用户
           │   "⚠️ Your Telegram Bot Token for bot 'xxx' is invalid.
           │    Please update it at https://app.clawbot.com/bots/{bot_id}/channels"
           ├── 如果无其他健康 Channel → 发邮件 (通过 SES)
           └── 更新 user_notified_at，避免重复通知
```

**Webhook 触发时的实时检测：**

```
Webhook 收到消息 → 调 Channel API 回复 → 失败 (401/403)
    │
    ├── 更新 health_status = "unhealthy"
    ├── 记录 health_error
    └── 如果是首次失败 → 立即触发一次完整健康检查
```

**Channel 验证 API 参考：**

```typescript
const healthCheckers: Record<string, (creds: any) => Promise<boolean>> = {
  telegram: async (creds) => {
    const res = await fetch(`https://api.telegram.org/bot${creds.bot_token}/getMe`);
    return res.ok;
  },
  discord: async (creds) => {
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${creds.bot_token}` },
    });
    return res.ok;
  },
  slack: async (creds) => {
    const res = await fetch('https://slack.com/api/auth.test', {
      headers: { Authorization: `Bearer ${creds.bot_token}` },
    });
    const data = await res.json();
    return data.ok === true;
  },
  whatsapp: async (creds) => {
    const res = await fetch(
      `https://graph.facebook.com/v18.0/${creds.phone_number_id}`,
      { headers: { Authorization: `Bearer ${creds.access_token}` } },
    );
    return res.ok;
  },
};
```

**凭证更新流程（用户在 Web UI 操作）：**

```
用户在 Web UI 更新 Token
    │
    ▼
PUT /api/bots/{bot_id}/channels/{ch_id}
  { credentials: { bot_token: "new-token-xxx" } }
    │
    ├── 1. 验证新 Token 有效性
    ├── 2. 更新 Secrets Manager
    ├── 3. 重新注册 Webhook (使用新 Token)
    ├── 4. 重置健康检查状态
    │      health_status="healthy", consecutive_failures=0,
    │      user_notified_at=null
    └── 5. 刷新 Fargate 内存缓存 (凭证缓存 TTL 到期自动刷新)
```

### 8.6 多媒体消息处理

Telegram/Discord/Slack/WhatsApp 消息可能包含图片、文件、语音、视频。当前核心流程只处理文本，多媒体需要额外的处理链路。

#### 处理链路

```
频道 Webhook (含附件)
    │
    ▼
Fargate HTTP Server (Webhook 处理)
    │
    ├── 1. 解析消息, 检测附件
    │      ├── Telegram: file_id → getFile API → 下载 URL
    │      ├── Discord:  attachments[].url → 直接下载
    │      ├── Slack:    files[].url_private → 需 Bot Token 下载
    │      └── WhatsApp:  media_id → media URL API → 下载 URL
    │
    ├── 2. 下载附件到临时内存
    │      大小限制: 单文件 ≤ 20MB, 单消息附件总计 ≤ 50MB
    │      超限 → 忽略附件, 仅处理文本 + 通知 "附件过大"
    │
    ├── 3. 上传到 S3
    │      路径: {userId}/{botId}/attachments/{messageId}/{filename}
    │      使用 Scoped S3 client (Control Plane 的 Task Role)
    │
    ├── 4. 写入 DynamoDB messages 表
    │      附加字段: attachments (JSON array)
    │      [{ type, s3Key, fileName, mimeType, size }]
    │
    └── 5. 入队 SQS (payload 包含 attachments 元数据)
```

#### Agent 内处理

```
Agent Runner 收到 InvocationPayload (含 attachments)
    │
    ├── 下载附件到 /workspace/group/attachments/
    │   (使用 Scoped S3 client, ABAC 限定路径)
    │
    ├── 根据类型处理:
    │
    │   图片 (image/jpeg, image/png, image/webp):
    │   ├── Claude Agent SDK 原生支持多模态
    │   └── 在 prompt 中引用: "用户发送了图片，见 /workspace/group/attachments/photo.jpg"
    │       SDK 的 Read 工具可读取图片文件，Claude 视觉能力处理
    │
    │   语音 (audio/ogg, audio/mpeg):
    │   ├── Agent 通过 Bash 调用 whisper 转文字 (如果容器内安装了 whisper)
    │   └── 或在 Webhook 层预处理: 使用 Amazon Transcribe → 文本
    │       文本追加到消息 content 中, Agent 无需感知语音
    │
    │   文档 (application/pdf, text/*, office):
    │   ├── Agent 通过 Bash 调用 pdftotext (PDF)
    │   ├── 或直接 Read 工具读取文本文件
    │   └── Claude 可直接处理 PDF (多模态)
    │
    │   视频 (video/mp4):
    │   └── 暂不处理视频内容, 仅记录元数据
    │       通知用户 "视频暂不支持分析"
    │
    └── Agent 生成回复 (可能引用附件内容)
```

#### 语音预处理 (推荐: Webhook 层处理)

避免在 Agent 容器内安装 Whisper（增加镜像大小），用 Amazon Transcribe 在 Webhook 层预处理：

```typescript
// Webhook 处理语音消息
if (attachment.type === 'voice') {
  // 上传到 S3 (Transcribe 需要 S3 输入)
  await s3.putObject({ Bucket, Key: s3Key, Body: audioBuffer });

  // 启动转录
  const job = await transcribe.startTranscriptionJob({
    TranscriptionJobName: `clawbot-${messageId}`,
    LanguageCode: 'zh-CN',  // 或 auto-detect
    Media: { MediaFileUri: `s3://${Bucket}/${s3Key}` },
    OutputBucketName: Bucket,
    OutputKey: `${s3Key}.transcript.json`,
  });

  // 等待完成 (通常 < 30s 对于短语音)
  // 或: 异步处理, 转录完成后再入队 SQS

  // 将转录文本追加到消息 content
  message.content += `\n[语音转文字]: ${transcriptText}`;
}
```

#### DynamoDB messages 表扩展

```
PK: bot_id#group_jid    SK: timestamp
─────────────────────────────────────
...(原有字段)...

# 多媒体扩展
attachments (JSON, 可选): [
  {
    "type": "image",
    "s3Key": "u-123/b-456/attachments/msg-789/photo.jpg",
    "fileName": "photo.jpg",
    "mimeType": "image/jpeg",
    "size": 245678
  },
  {
    "type": "voice",
    "s3Key": "u-123/b-456/attachments/msg-789/voice.ogg",
    "fileName": "voice.ogg",
    "mimeType": "audio/ogg",
    "size": 34567,
    "transcript": "你好，帮我查一下明天的会议安排"   # 语音转文字结果
  }
]
```

#### 容器镜像扩展 (可选)

如果需要在 Agent 容器内直接处理多媒体：

```dockerfile
# 在 Dockerfile 中添加 (按需)
RUN apt-get install -y \
    poppler-utils    # pdftotext (PDF 转文本)
    # ffmpeg         # 音视频处理 (如需本地转码)
    # 不安装 whisper, 语音转文字由 Amazon Transcribe 处理
```

---

## 9. Agent 执行层

> 对应 NanoClaw 的 `container/agent-runner/` + `container/Dockerfile`。
> 从 stdin/stdout + 文件 IPC 模式改造为 HTTP 服务 + AWS SDK 直调。

### 9.1 AgentCore Runtime 部署配置

```python
create_agent_runtime(
    agentRuntimeName='clawbot-agent',
    agentRuntimeArtifact={
        'containerConfiguration': {
            'containerUri': '{account}.dkr.ecr.{region}.amazonaws.com/clawbot-agent:latest'
        }
    },
    roleArn='arn:aws:iam::{account}:role/ClawBotAgentRole',
    networkConfiguration={'networkMode': 'PUBLIC'},
    environmentVariables={
        'CLAUDE_CODE_USE_BEDROCK': '1',
        'AWS_REGION': '{region}',
        'CLAWBOT_S3_BUCKET': 'clawbot-data',
        'CLAWBOT_DYNAMODB_TABLE_PREFIX': 'clawbot-',
    }
)
```

### 9.2 容器架构

```
clawbot-agent 容器 (ARM64, node:22-slim)
│
├── Fastify HTTP 服务 (:8080)
│   ├── POST /invocations   → Agent 执行入口
│   └── GET  /ping          → 健康检查 (Healthy / HealthyBusy)
│
├── Claude Agent SDK (@anthropic-ai/claude-agent-sdk)
│   ├── query() — 流式消息处理
│   ├── MessageStream — 保持 AsyncIterable 开启 (支持 Agent Teams)
│   ├── Hooks: PreCompact → 归档对话到 S3
│   └── CLAUDE_CODE_USE_BEDROCK=1 → Bedrock Claude (IAM Role)
│
├── MCP Server (clawbot-tools)
│   ├── send_message     → SQS (回复队列)
│   ├── schedule_task    → DynamoDB + EventBridge Scheduler
│   ├── list_tasks       → DynamoDB 查询
│   ├── pause/resume/cancel_task → DynamoDB 更新
│   └── (不再有 register_group, 改由 Web UI 完成)
│
├── S3 Client
│   ├── 启动时: 恢复 session 文件 + CLAUDE.md 记忆
│   └── 结束时: 回写 session 文件 + 记忆变更
│
├── 系统依赖
│   ├── Chromium (agent-browser 浏览器自动化)
│   ├── git, curl (Agent Bash 工具需要)
│   └── agent-browser CLI (全局安装)
│
└── 工作目录结构
    /workspace/
    ├── group/            # 工作目录 (cwd), S3 恢复的群组文件
    │   ├── CLAUDE.md     # 群组记忆 (从 S3 加载, 读写)
    │   ├── conversations/ # 对话归档 (PreCompact hook 写入)
    │   └── attachments/  # 多媒体附件 (从 S3 下载)
    ├── global/           # Bot 全局记忆 (从 S3 加载, 只读)
    │   └── CLAUDE.md
    ├── shared/           # 用户共享知识 (从 S3 加载, 只读, 跨 Bot)
    │   └── CLAUDE.md
    └── .claude/          # Claude SDK session 文件 (从 S3 恢复)
        └── projects/
```

### 9.3 Dockerfile

```dockerfile
# ClawBot Agent Container (ARM64)
FROM --platform=linux/arm64 node:22-slim

# 系统依赖: Chromium + 字体 + 构建工具
RUN apt-get update && apt-get install -y \
    chromium fonts-liberation fonts-noto-cjk fonts-noto-color-emoji \
    libgbm1 libnss3 libatk-bridge2.0-0 libgtk-3-0 libx11-xcb1 \
    libxcomposite1 libxdamage1 libxrandr2 libasound2 \
    libpangocairo-1.0-0 libcups2 libdrm2 libxshmfence1 \
    curl git \
    && rm -rf /var/lib/apt/lists/*

ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# 全局安装 agent-browser 和 claude-code CLI
RUN npm install -g agent-browser @anthropic-ai/claude-code

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . ./
RUN npm run build

# 工作目录
RUN mkdir -p /workspace/group /workspace/global /home/node/.claude
RUN chown -R node:node /workspace /home/node/.claude

USER node
WORKDIR /workspace/group

EXPOSE 8080
CMD ["node", "/app/dist/server.js"]
```

### 9.4 HTTP 服务实现

#### 入口 `server.ts`

```typescript
import Fastify from 'fastify';
import { handleInvocation } from './handler.js';
import { isAgentBusy } from './state.js';

const app = Fastify({ logger: true });

// AgentCore 健康检查 — 必须快速返回，不能被 Agent 执行阻塞
app.get('/ping', async () => ({
  status: isAgentBusy() ? 'HealthyBusy' : 'Healthy',
  time_of_last_update: Math.floor(Date.now() / 1000),
}));

// Agent 调用入口
app.post('/invocations', async (req, reply) => {
  const result = await handleInvocation(req.body as InvocationPayload);
  return reply.send({ output: result });
});

app.listen({ port: 8080, host: '0.0.0.0' });
```

**关键：`/ping` 必须在独立线程响应。** AgentCore 通过 `/ping` 判断 session 是否存活。如果主线程被 `query()` 阻塞导致 `/ping` 不响应，AgentCore 会在 15 分钟后终止 session。Fastify 在 Node.js 事件循环中处理 HTTP，而 `query()` 是 async 的（内部 spawn 子进程），不会阻塞事件循环。

#### 调用处理 `handler.ts`

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { syncFromS3, syncToS3 } from './s3-sync.js';
import { createScopedClients, ScopedClients } from './scoped-credentials.js';
import { MessageStream } from './message-stream.js';
import { createMcpConfig } from './mcp-tools.js';
import { createPreCompactHook } from './hooks.js';
import { formatMessages, stripInternalTags } from './router.js';
import { setBusy, setIdle } from './state.js';

export interface InvocationPayload {
  input: {
    botId: string;
    botName: string;
    groupJid: string;
    userId: string;
    prompt: string;           // 已格式化的 XML 消息
    systemPrompt?: string;    // Bot 自定义 system prompt
    sessionPath: string;      // S3: {userId}/{botId}/sessions/{groupJid}/
    memoryPath: string;       // S3: {userId}/{botId}/memory/{groupJid}/
    globalMemoryPath: string; // S3: {userId}/{botId}/memory/global/
    sharedMemoryPath: string; // S3: {userId}/shared/ (跨 Bot 共享, 只读)
    attachments?: Attachment[];  // 多媒体附件 (Webhook 预上传到 S3)
    isScheduledTask?: boolean;
    maxTurns?: number;
  };
}

export interface Attachment {
  type: 'image' | 'voice' | 'document' | 'video';
  s3Key: string;             // S3 对象 key
  fileName: string;          // 原始文件名
  mimeType: string;          // MIME 类型
  size: number;              // 字节数
}

export interface InvocationResult {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

// 按 session 维度跟踪状态，防止 microVM 被 AgentCore 复用给不同 session 时污染
// 关键假设: AgentCore 当前保证 1 microVM = 1 runtimeSessionId。
// 此处用 sessionKey 防御该假设被破坏的情况。
let currentSessionKey: string | null = null;     // "{botId}#{groupJid}"
let scopedClients: ScopedClients | null = null;

export async function handleInvocation(payload: InvocationPayload): Promise<InvocationResult> {
  const { botId, botName, groupJid, userId, prompt, systemPrompt,
          sessionPath, memoryPath, globalMemoryPath, sharedMemoryPath,
          attachments, isScheduledTask, maxTurns } = payload.input;

  setBusy();

  try {
    const sessionKey = `${botId}#${groupJid}`;

    // ── 0. 检测 session 切换 (防御 microVM 复用) ──
    // 如果 AgentCore 将此 microVM 路由给了不同的 bot/group,
    // 必须清空本地文件系统并重新获取 scoped 凭证
    if (currentSessionKey !== null && currentSessionKey !== sessionKey) {
      console.warn(`Session switch detected: ${currentSessionKey} → ${sessionKey}, resetting`);
      await cleanLocalWorkspace();   // rm -rf /workspace/group/* /workspace/global/* /home/node/.claude/*
      scopedClients = null;
    }
    currentSessionKey = sessionKey;

    // ── 1. 获取 Scoped 凭证 (ABAC: IAM 层面限定 {userId}/{botId}/) ──
    if (!scopedClients) {
      scopedClients = await createScopedClients(userId, botId);
    }

    // ── 2. S3 同步 (session 切换或首次调用时恢复, 使用 scoped S3 client) ──
    if (!scopedClients._restored) {
      await syncFromS3(scopedClients.s3, {
        sessionPath,                           // → /home/node/.claude/
        memoryPath,                            // → /workspace/group/
        globalMemoryPath,                      // → /workspace/global/
        sharedMemoryPath,                      // → /workspace/shared/ (跨 Bot 只读)
      });
      scopedClients._restored = true;
    }

    // ── 2. 构建 prompt ──
    let formattedPrompt = prompt;
    if (isScheduledTask) {
      formattedPrompt = `[SCHEDULED TASK]\n\n${prompt}`;
    }

    // ── 3. 加载多层记忆 (追加到 system prompt) ──
    const memoryParts: string[] = [];

    // 用户共享记忆 (跨 Bot, 如公司上下文)
    try {
      const shared = fs.readFileSync('/workspace/shared/CLAUDE.md', 'utf-8');
      if (shared.trim()) memoryParts.push(`# Shared Knowledge\n${shared}`);
    } catch { /* 无共享记忆 */ }

    // Bot 全局记忆
    try {
      const global = fs.readFileSync('/workspace/global/CLAUDE.md', 'utf-8');
      if (global.trim()) memoryParts.push(global);
    } catch { /* 无全局记忆 */ }

    const combinedMemory = memoryParts.length > 0 ? memoryParts.join('\n\n---\n\n') : undefined;

    // ── 3.5 下载并引用附件 (图片/文件/语音) ──
    if (attachments?.length) {
      await downloadAttachments(scopedClients.s3, attachments, '/workspace/group/attachments/');
    }

    // ── 4. 构建 MCP 工具配置 (传入 scoped clients 供 MCP 工具使用) ──
    const mcpConfig = createMcpConfig({ botId, groupJid, userId });

    // ── 5. 执行 Claude Agent SDK ──
    const stream = new MessageStream();
    stream.push(formattedPrompt);

    let newSessionId: string | undefined;
    let lastResult: string | null = null;

    for await (const message of query({
      prompt: stream,
      options: {
        cwd: '/workspace/group',
        systemPrompt: combinedMemory
          ? { type: 'preset', preset: 'claude_code', append: combinedMemory }
          : undefined,
        allowedTools: [
          'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'WebSearch', 'WebFetch',
          'Task', 'TaskOutput', 'TaskStop',
          'TeamCreate', 'TeamDelete', 'SendMessage',
          'NotebookEdit',
          'mcp__clawbot__*',
        ],
        maxTurns: maxTurns || 50,
        env: { ...process.env },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project'],
        mcpServers: mcpConfig,
        hooks: {
          PreCompact: [{ hooks: [createPreCompactHook(botName, sessionPath)] }],
        },
      }
    })) {
      // 捕获 session ID
      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
      }

      // 捕获最终结果
      if (message.type === 'result') {
        const text = 'result' in message ? (message as any).result : null;
        if (text) lastResult = text;
      }
    }

    stream.end();

    // ── 6. 回写变更到 S3 (使用 scoped S3 client) ──
    await syncToS3(scopedClients.s3, {
      sessionPath,   // /home/node/.claude/ → S3
      memoryPath,    // /workspace/group/CLAUDE.md → S3 (如果有变更)
    });

    setIdle();

    return {
      status: 'success',
      result: lastResult ? stripInternalTags(lastResult) : null,
      newSessionId,
    };

  } catch (err) {
    setIdle();
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { status: 'error', result: null, error: errorMessage };
  }
}
```

### 9.5 MCP 工具 (替代文件 IPC)

> 对应 NanoClaw 的 `container/agent-runner/src/ipc-mcp-stdio.ts`。
> 核心变化：**从文件 IPC 改为直接调用 AWS SDK。**

```typescript
// mcp-tools.ts — Agent 容器内的 MCP Server

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient, PutItemCommand, ... } from '@aws-sdk/client-dynamodb';
import { SchedulerClient, CreateScheduleCommand, ... } from '@aws-sdk/client-scheduler';

const sqs = new SQSClient({});
const dynamodb = new DynamoDBClient({});
const scheduler = new SchedulerClient({});

export function createMcpConfig(ctx: { botId: string; groupJid: string; userId: string }) {
  return {
    clawbot: {
      command: 'node',
      args: [MCP_SERVER_PATH],
      env: {
        CLAWBOT_BOT_ID: ctx.botId,
        CLAWBOT_GROUP_JID: ctx.groupJid,
        CLAWBOT_USER_ID: ctx.userId,
        CLAWBOT_REPLY_QUEUE_URL: process.env.CLAWBOT_REPLY_QUEUE_URL!,
      },
    },
  };
}
```

**工具对比 (NanoClaw vs Cloud):**

| NanoClaw 工具 | 实现方式 | Cloud 工具 | 实现方式 |
|--------------|---------|-----------|---------|
| `send_message` | 写文件到 IPC/messages/ | `send_message` | SQS SendMessage (回复队列) |
| `schedule_task` | 写文件到 IPC/tasks/ | `schedule_task` | DynamoDB PutItem + EventBridge CreateSchedule |
| `list_tasks` | 读 IPC/current_tasks.json | `list_tasks` | DynamoDB Query |
| `pause_task` | 写文件到 IPC/tasks/ | `pause_task` | DynamoDB UpdateItem + EventBridge UpdateSchedule |
| `resume_task` | 写文件到 IPC/tasks/ | `resume_task` | DynamoDB UpdateItem + EventBridge UpdateSchedule |
| `cancel_task` | 写文件到 IPC/tasks/ | `cancel_task` | DynamoDB DeleteItem + EventBridge DeleteSchedule |
| `update_task` | 写文件到 IPC/tasks/ | `update_task` | DynamoDB UpdateItem + EventBridge UpdateSchedule |
| `register_group` | 写文件到 IPC/tasks/ (主群组) | _(移除)_ | 由 Web UI 管理 |

**send_message 实现：**

```typescript
server.tool(
  'send_message',
  'Send a message to the user/group immediately.',
  {
    text: z.string().describe('Message text'),
    sender: z.string().optional().describe('Sender identity name'),
  },
  async (args) => {
    // 发到 SQS 回复队列，Fargate Control Plane 消费后调 Channel API
    await sqs.send(new SendMessageCommand({
      QueueUrl: process.env.CLAWBOT_REPLY_QUEUE_URL,
      MessageBody: JSON.stringify({
        type: 'reply',
        botId: process.env.CLAWBOT_BOT_ID,
        groupJid: process.env.CLAWBOT_GROUP_JID,
        text: args.text,
        sender: args.sender,
        timestamp: new Date().toISOString(),
      }),
    }));

    return { content: [{ type: 'text', text: 'Message sent.' }] };
  },
);
```

**schedule_task 实现：**

```typescript
server.tool(
  'schedule_task',
  '(同 NanoClaw 的 schedule_task 描述)',
  { /* 同 NanoClaw 的参数 schema */ },
  async (args) => {
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const botId = process.env.CLAWBOT_BOT_ID!;

    // 1. 写入 DynamoDB
    await dynamodb.send(new PutItemCommand({
      TableName: `${process.env.CLAWBOT_DYNAMODB_TABLE_PREFIX}tasks`,
      Item: {
        bot_id: { S: botId },
        task_id: { S: taskId },
        group_jid: { S: process.env.CLAWBOT_GROUP_JID! },
        prompt: { S: args.prompt },
        schedule_type: { S: args.schedule_type },
        schedule_value: { S: args.schedule_value },
        context_mode: { S: args.context_mode || 'group' },
        status: { S: 'active' },
        created_at: { S: new Date().toISOString() },
      },
    }));

    // 2. 创建 EventBridge Schedule
    const scheduleExpression = args.schedule_type === 'cron'
      ? `cron(${args.schedule_value})`
      : args.schedule_type === 'interval'
        ? `rate(${Math.round(parseInt(args.schedule_value) / 60000)} minutes)`
        : `at(${args.schedule_value})`;

    await scheduler.send(new CreateScheduleCommand({
      Name: `clawbot-${botId}-${taskId}`,
      ScheduleExpression: scheduleExpression,
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: {
        Arn: process.env.CLAWBOT_TASK_QUEUE_ARN!,
        Input: JSON.stringify({
          type: 'scheduled_task', botId, taskId,
          groupJid: process.env.CLAWBOT_GROUP_JID,
        }),
        RoleArn: process.env.CLAWBOT_SCHEDULER_ROLE_ARN!,
      },
      State: 'ENABLED',
    }));

    return {
      content: [{ type: 'text', text: `Task ${taskId} scheduled.` }],
    };
  },
);
```

### 9.6 S3 同步模块

> 对应 NanoClaw 的本地文件挂载。microVM 文件系统临时性，需要与 S3 双向同步。

```typescript
// s3-sync.ts

import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand,
  ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

// 注意: 不创建全局 S3Client。所有 S3 操作使用 ABAC scoped client (由调用方传入)。
const BUCKET = process.env.CLAWBOT_S3_BUCKET!;

interface SyncPaths {
  sessionPath: string;      // S3: {userId}/{botId}/sessions/{groupJid}/
  memoryPath: string;       // S3: {userId}/{botId}/memory/{groupJid}/
  globalMemoryPath: string; // S3: {userId}/{botId}/memory/global/
  sharedMemoryPath: string; // S3: {userId}/shared/
}

/**
 * Session 启动时: 从 S3 恢复文件到本地
 * @param s3 - ABAC scoped S3 client (限定 {userId}/{botId}/ 路径)
 * @param sharedS3 - 用户级 S3 client (限定 {userId}/ 路径, 用于共享记忆)
 */
export async function syncFromS3(s3: S3Client, paths: SyncPaths): Promise<void> {
  // 恢复 Claude session 文件
  await downloadPrefix(s3, paths.sessionPath, '/home/node/.claude/');

  // 恢复群组记忆 (读写)
  await downloadPrefix(s3, paths.memoryPath, '/workspace/group/');

  // 恢复 Bot 全局记忆 (只读)
  await downloadPrefix(s3, paths.globalMemoryPath, '/workspace/global/');

  // 恢复用户共享记忆 (只读, 跨 Bot)
  // 注: sharedMemoryPath 在 {userId}/ 前缀下, ABAC scoped role 也有权限
  // (因为 S3 policy 用 ${aws:PrincipalTag/userId}/* 通配)
  await downloadPrefix(s3, paths.sharedMemoryPath, '/workspace/shared/');
}

/**
 * Agent 执行结束后: 回写变更到 S3
 * @param s3 - ABAC scoped S3 client (限定 {userId}/{botId}/ 路径)
 */
export async function syncToS3(s3: S3Client, paths: Pick<SyncPaths, 'sessionPath' | 'memoryPath'>): Promise<void> {
  // 回写 Claude session 文件
  await uploadDirectory(s3, '/home/node/.claude/', paths.sessionPath);

  // 回写群组记忆 (仅 CLAUDE.md 和 conversations/)
  await uploadFileIfChanged(s3, '/workspace/group/CLAUDE.md', `${paths.memoryPath}CLAUDE.md`);
  await uploadDirectory(s3, '/workspace/group/conversations/', `${paths.memoryPath}conversations/`);
}

async function downloadPrefix(s3: S3Client, s3Prefix: string, localDir: string): Promise<void> {
  let continuationToken: string | undefined;
  let totalFiles = 0;

  do {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: s3Prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }));

    for (const obj of response.Contents ?? []) {
      const relativePath = obj.Key!.slice(s3Prefix.length);
      if (!relativePath) continue;  // 跳过前缀本身

      const localPath = path.join(localDir, relativePath);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });

      const data = await s3.send(new GetObjectCommand({
        Bucket: BUCKET, Key: obj.Key!,
      }));
      const body = await data.Body!.transformToByteArray();
      fs.writeFileSync(localPath, body);
      totalFiles++;
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  if (totalFiles > 0) {
    console.log(`Downloaded ${totalFiles} files from s3://${BUCKET}/${s3Prefix}`);
  }
}

async function uploadFileIfChanged(s3: S3Client, localPath: string, s3Key: string): Promise<void> {
  if (!fs.existsSync(localPath)) return;

  const content = fs.readFileSync(localPath);

  // 对比 ETag 避免无变更的重复上传
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: s3Key }));
    const localMd5 = createHash('md5').update(content).digest('hex');
    // S3 ETag 对单次上传的对象就是 MD5 (加引号)
    if (head.ETag === `"${localMd5}"`) return;  // 无变更，跳过
  } catch {
    // 对象不存在或 HeadObject 失败，继续上传
  }

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: s3Key, Body: content,
  }));
}

async function uploadDirectory(s3: S3Client, localDir: string, s3Prefix: string): Promise<void> {
  if (!fs.existsSync(localDir)) return;

  const files = walkDir(localDir);
  for (const file of files) {
    const relativePath = path.relative(localDir, file);
    await uploadFileIfChanged(s3, file, s3Prefix + relativePath);
  }
}

/**
 * 清空本地工作目录 (session 切换时调用)
 */
export async function cleanLocalWorkspace(): Promise<void> {
  for (const dir of ['/workspace/group', '/workspace/global', '/home/node/.claude']) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
```

### 9.7 PreCompact Hook (对话归档)

> 直接移植 NanoClaw 的 `createPreCompactHook`，区别是归档文件同时写 S3。

```typescript
// hooks.ts

import { HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { uploadFileIfChanged } from './s3-sync.js';
import fs from 'fs';

export function createPreCompactHook(botName: string, sessionPath: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) return {};

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);   // 复用 NanoClaw 的 parseTranscript
      if (messages.length === 0) return {};

      const date = new Date().toISOString().split('T')[0];
      const name = sanitizeFilename(messages[0]?.content || 'conversation');
      const filename = `${date}-${name}.md`;

      // 写本地
      const localPath = `/workspace/group/conversations/${filename}`;
      fs.mkdirSync('/workspace/group/conversations', { recursive: true });
      const markdown = formatTranscriptMarkdown(messages, null, botName);
      fs.writeFileSync(localPath, markdown);

      // 同步到 S3
      await uploadFileIfChanged(localPath, `${sessionPath}conversations/${filename}`);
    } catch (err) {
      console.error(`PreCompact hook error: ${err}`);
    }

    return {};
  };
}
```

### 9.8 MessageStream (保留 NanoClaw 设计)

> 直接复用 NanoClaw 的 `MessageStream` 类。在 AgentCore 场景下，同一 session 内的后续
> `/invocations` 调用通过 push 新消息到 stream，支持 Agent Teams 子代理。

```typescript
// message-stream.ts — 与 NanoClaw 完全相同

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

export class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}
```

### 9.9 Session 映射策略

```
AgentCore runtimeSessionId = "{bot_id}---{group_jid}"
                              (用 --- 分隔, 避免 # 在 URL 中转义)

每个 Bot 的每个 Group 有独立 Session:
  bot-abc---tg:-1001234     → microVM-1 (独立文件系统、CPU、内存)
  bot-abc---tg:-1005678     → microVM-2
  bot-xyz---tg:-1001234     → microVM-3 (不同 Bot 完全隔离)
```

**Session 生命周期 (AgentCore 管理):**

```
首次消息到达 (该 group 无活跃 session)
    │
    ▼
Dispatcher: InvokeAgentRuntime(runtimeSessionId=新)
    │
    ▼
AgentCore: 创建 microVM → 拉取容器镜像 → 启动 HTTP 服务
    │
    ▼
Agent: /invocations 收到请求
    ├── syncFromS3() 恢复 session + 记忆 (~1-2s)
    ├── query() 执行 Claude Agent SDK
    ├── syncToS3() 回写变更
    └── 返回结果
    │
    ▼
AgentCore: session 状态 → Idle
    │
    ├── 15 分钟内有新消息 → /invocations 再次调用
    │   └── 复用 microVM (无需 S3 恢复, < 100ms)
    │
    └── 15 分钟无消息 → session 终止
        └── microVM 销毁, 内存清零
            下次消息 → 创建新 session → syncFromS3() 恢复
```

**优化与防御：**
- S3 恢复状态绑定到 `scopedClients._restored`，凭证重建时自动重置
- 通过 `sessionKey` 检测 microVM 是否被 AgentCore 路由给了不同的 bot/group
- 如果 session 切换，清空本地文件系统 + 重新获取 scoped 凭证 + 重新从 S3 恢复
- 同一 session 内的后续 `/invocations` 调用跳过 S3 下载（< 100ms）

### 9.10 Agent IAM — 双 Role ABAC 隔离

采用 **STS AssumeRole + Session Tags** 实现 IAM 层面的 per-user/per-bot 数据隔离。Agent 基础 Role 没有 S3 权限，所有数据访问必须通过 Scoped Role 的临时凭证。

```
InvokeAgentRuntime(payload: { userId, botId, ... })
    │
    ▼
Agent Runner (基础 Role: ClawBotAgentRole)
    │  ← 只有 Bedrock + STS + SQS 权限，无 S3 权限
    │
    ├── sts.assumeRole({
    │     RoleArn: ClawBotAgentScopedRole,
    │     Tags: [{ userId: "u-123" }, { botId: "b-456" }]
    │   })
    │
    ▼
Scoped 临时凭证
    └── S3 路径限定: clawbot-data/u-123/b-456/*
    └── DynamoDB 限定: LeadingKeys = "b-456"
    └── Scheduler 限定: clawbot-b-456-*
```

#### 基础 Role (ClawBotAgentRole) — AgentCore Runtime 绑定

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockModelAccess",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": "arn:aws:bedrock:*::foundation-model/anthropic.*"
    },
    {
      "Sid": "AssumeScopedRole",
      "Effect": "Allow",
      "Action": ["sts:AssumeRole", "sts:TagSession"],
      "Resource": "arn:aws:iam::ACCOUNT:role/ClawBotAgentScopedRole"
    },
    {
      "Sid": "SQSSendReply",
      "Effect": "Allow",
      "Action": "sqs:SendMessage",
      "Resource": "arn:aws:sqs:*:*:clawbot-reply-*"
    }
  ]
}
```

**注意：基础 Role 没有 S3、DynamoDB、EventBridge 权限。** 即使 Agent 通过 Bash 执行 `aws s3 ls`，也会因权限不足而失败。

#### Scoped Role (ClawBotAgentScopedRole) — Session Tags 动态限定

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "S3BotDataAccess",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::clawbot-data/${aws:PrincipalTag/userId}/${aws:PrincipalTag/botId}/*"
    },
    {
      "Sid": "S3SharedMemoryReadOnly",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::clawbot-data/${aws:PrincipalTag/userId}/shared/*"
    },
    {
      "Sid": "S3ListScopedPrefix",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::clawbot-data",
      "Condition": {
        "StringLike": {
          "s3:prefix": [
            "${aws:PrincipalTag/userId}/${aws:PrincipalTag/botId}/*",
            "${aws:PrincipalTag/userId}/shared/*"
          ]
        }
      }
    },
    {
      "Sid": "DynamoDBScopedAccess",
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
                 "dynamodb:DeleteItem", "dynamodb:Query"],
      "Resource": "arn:aws:dynamodb:*:*:table/clawbot-tasks",
      "Condition": {
        "ForAllValues:StringEquals": {
          "dynamodb:LeadingKeys": ["${aws:PrincipalTag/botId}"]
        }
      }
    },
    {
      "Sid": "SchedulerScopedAccess",
      "Effect": "Allow",
      "Action": ["scheduler:CreateSchedule", "scheduler:UpdateSchedule",
                 "scheduler:DeleteSchedule", "scheduler:GetSchedule"],
      "Resource": "arn:aws:scheduler:*:*:schedule/default/clawbot-${aws:PrincipalTag/botId}-*"
    }
  ]
}
```

#### Scoped Role Trust Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::ACCOUNT:role/ClawBotAgentRole"
      },
      "Action": ["sts:AssumeRole", "sts:TagSession"],
      "Condition": {
        "StringLike": {
          "aws:RequestTag/userId": "*",
          "aws:RequestTag/botId": "*"
        }
      }
    }
  ]
}
```

#### Agent Runner 中获取 Scoped Credentials

```typescript
// scoped-credentials.ts

import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SchedulerClient } from '@aws-sdk/client-scheduler';

const sts = new STSClient({});

export interface ScopedClients {
  s3: S3Client;
  dynamodb: DynamoDBClient;
  scheduler: SchedulerClient;
  _restored: boolean;  // S3 恢复完成标记，绑定到凭证生命周期
}

export async function createScopedClients(userId: string, botId: string): Promise<ScopedClients> {
  const assumed = await sts.send(new AssumeRoleCommand({
    RoleArn: process.env.CLAWBOT_SCOPED_ROLE_ARN!,
    RoleSessionName: `${userId}--${botId}`.slice(0, 64),
    Tags: [
      { Key: 'userId', Value: userId },
      { Key: 'botId', Value: botId },
    ],
    DurationSeconds: 3600,
  }));

  const credentials = {
    accessKeyId: assumed.Credentials!.AccessKeyId!,
    secretAccessKey: assumed.Credentials!.SecretAccessKey!,
    sessionToken: assumed.Credentials!.SessionToken!,
  };

  return {
    s3: new S3Client({ credentials }),
    dynamodb: new DynamoDBClient({ credentials }),
    scheduler: new SchedulerClient({ credentials }),
    _restored: false,
  };
}
```

#### 安全效果

| 攻击场景 | 仅应用层隔离 | ABAC 双 Role |
|---------|------------|-------------|
| Agent 代码 bug 拼错 S3 路径 | 访问到其他用户数据 | IAM 403 拒绝 |
| Prompt 注入构造恶意 S3 请求 | 可能成功 | IAM 403 拒绝 |
| Bash 执行 `aws s3 ls s3://clawbot-data/` | 列出所有用户目录 | 基础 Role 无 S3 权限，失败 |
| Bash 执行 `aws dynamodb scan` | 扫描所有 bot 任务 | 基础 Role 无 DynamoDB 权限，失败 |
| MCP 工具传错 botId | 操作其他 bot 的 schedule | Scheduler 资源名限定 botId |

### 9.11 NanoClaw Agent Runner → Cloud Agent Runner 映射

| NanoClaw (container/agent-runner) | Cloud (clawbot-agent) | 变更原因 |
|---|---|---|
| stdin 读取 ContainerInput JSON | `/invocations` POST body | AgentCore 服务契约 |
| stdout OUTPUT_START/END marker | HTTP JSON response | AgentCore 服务契约 |
| 文件 IPC (`/workspace/ipc/input/`) 接收后续消息 | 同一 session 多次 `/invocations` 调用 | AgentCore 自动保持 session |
| `_close` sentinel 文件退出 | AgentCore 15min 空闲自动回收 | 无需手动关闭 |
| `drainIpcInput()` 轮询 IPC 目录 | _(移除)_ | 无文件 IPC |
| `waitForIpcMessage()` 等待新消息 | _(移除)_ | Dispatcher 直接调用 |
| MCP 写文件 → Host IPC watcher 消费 | MCP 直调 AWS SDK | 无 Host 中转 |
| 挂载 `/workspace/group` (Docker volume) | S3 同步到 `/workspace/group` | 无持久挂载 |
| `process.env` 凭证代理 URL | IAM Role (自动注入临时凭证) | 零凭证管理 |
| MessageStream (保留) | MessageStream (保留) | Agent Teams 支持不变 |
| PreCompact hook → 写本地文件 | PreCompact hook → 写本地 + S3 | 增加 S3 持久化 |
| `query()` 调用和参数 (保留大部分) | `query()` 调用和参数 (保留大部分) | 核心逻辑不变 |

---

## 10. 任务调度

### 10.1 创建定时任务

NanoClaw 用文件 IPC 创建任务。Cloud 版通过两个路径：

```
路径 A: 用户通过 Web UI 创建
  Web UI → POST /api/bots/{bot_id}/tasks → DynamoDB + EventBridge Scheduler

路径 B: Agent 在对话中创建 (MCP 工具)
  Agent → send_message / schedule_task (MCP)
  → Agent Runner 直接调用 AWS SDK
  → DynamoDB + EventBridge Scheduler
```

### 10.2 EventBridge Scheduler 集成

每个定时任务对应一个 EventBridge Schedule：

```typescript
// 创建定时任务
await scheduler.createSchedule({
  Name: `clawbot-${botId}-${taskId}`,
  ScheduleExpression: 'cron(0 9 ? * MON-FRI *)',  // 工作日 9 点
  FlexibleTimeWindow: { Mode: 'OFF' },
  Target: {
    Arn: DISPATCHER_LAMBDA_ARN,
    Input: JSON.stringify({
      type: 'scheduled_task',
      botId, taskId, groupJid, prompt
    }),
    RoleArn: SCHEDULER_ROLE_ARN,
  },
  State: 'ENABLED',
});
```

**任务触发链：**

```
EventBridge Schedule (到期)
    │
    ▼
SQS FIFO (type: "scheduled_task", taskId, botId)
    │
    ▼
Fargate SQS Consumer
    ├── 从 DynamoDB 加载 Task 详情
    ├── 构建 prompt
    ├── InvokeAgentRuntime (context_mode 决定是否新 session)
    ├── 结果写入 DynamoDB (task.last_result)
    └── 结果发送到 Channel (如果配置了通知)
```

EventBridge Schedule 的 Target 设为 SQS（而非直接调用 Lambda），由 Fargate SQS Consumer 统一消费。所有 Agent 调用走同一条路径，简化运维。

---

## 11. 安全架构

### 11.1 安全分层

```
┌─────────────────────────────────────┐
│ 层级 1: 用户认证                      │
│ ├── Cognito User Pool (JWT)          │
│ ├── Express 中间件 JWT 验证           │
│ └── 所有 /api/* 端点需要认证           │
├─────────────────────────────────────┤
│ 层级 2: 资源隔离 (Control Plane)      │
│ ├── Bot 查询附加 user_id 条件         │
│ ├── 用户只能操作自己的 Bot            │
│ └── S3 路径包含 user_id 前缀          │
├─────────────────────────────────────┤
│ 层级 3: Agent 数据隔离 (ABAC)        │
│ ├── 双 Role 架构: 基础 Role 无 S3    │
│ ├── STS AssumeRole + Session Tags   │
│ ├── S3 路径: ${userId}/${botId}/*    │
│ ├── DynamoDB: LeadingKeys = botId   │
│ └── Scheduler: 资源名含 botId        │
├─────────────────────────────────────┤
│ 层级 4: 凭证安全                      │
│ ├── Channel 凭证存 Secrets Manager   │
│ ├── Agent 通过 IAM Role 访问 Bedrock │
│ ├── Agent 容器内无 Channel 凭证       │
│ └── Bash 工具继承基础 Role (无 S3)    │
├─────────────────────────────────────┤
│ 层级 5: Agent 执行隔离                │
│ ├── AgentCore microVM (进程+内存隔离) │
│ ├── 每 session 独立文件系统            │
│ ├── 15 分钟空闲后销毁 + 内存清零       │
│ └── 网络隔离 (可选 VPC 模式)          │
├─────────────────────────────────────┤
│ 层级 6: Webhook 安全                  │
│ ├── 每种 Channel 的签名验证           │
│ ├── bot_id 合法性检查                 │
│ ├── 速率限制 (ALB + 应用层限流)       │
│ └── WAF 防 DDoS (ALB 关联 WAF)      │
└─────────────────────────────────────┘
```

### 11.2 租户数据隔离 (双层防御)

**第一层：Control Plane 应用层隔离 (API 请求)**

```
所有 DynamoDB 查询强制附加 owner 校验:

// ❌ 不安全
const bot = await getBot(botId);

// ✅ 安全 (查询层面隔离)
const bot = await dynamodb.get({
  TableName: 'bots',
  Key: { user_id: currentUserId, bot_id: botId }
});
```

**第二层：Agent 容器 IAM ABAC 隔离 (数据访问)**

```
Agent 基础 Role (AgentCore 绑定)
  ├── Bedrock: ✅ (所有 session 共享，无需隔离)
  ├── STS AssumeRole: ✅ (获取 scoped 凭证)
  ├── SQS 回复队列: ✅ (公共通道)
  ├── S3: ❌ 无权限
  ├── DynamoDB: ❌ 无权限
  └── Scheduler: ❌ 无权限

Agent Scoped Role (STS AssumeRole 获取, 带 Session Tags)
  ├── S3: ✅ 仅 {userId}/{botId}/* (IAM 条件)
  ├── DynamoDB: ✅ 仅 LeadingKeys={botId} (IAM 条件)
  └── Scheduler: ✅ 仅 clawbot-{botId}-* (资源名)

安全效果:
  - Agent 代码 bug → IAM 403 (跨租户路径被拒绝)
  - Bash 工具 aws s3 ls → 基础 Role 无 S3 权限，失败
  - Prompt 注入 → Scoped 凭证只能访问当前 bot 数据
```

详见 [9.10 Agent IAM — 双 Role ABAC 隔离](#910-agent-iam--双-role-abac-隔离)。

### 11.3 Channel 凭证安全

```
用户输入 Token → HTTPS → Fargate API
    │
    ├── 验证 Token 有效性 (调用 Channel API)
    ├── 加密存入 Secrets Manager
    │   └── KMS 加密，IAM Policy 限制访问
    ├── DynamoDB 只存 Secret ARN (不存明文)
    │
    └── Agent 执行时:
        Fargate SQS Consumer 从内存缓存获取 Token
        仅在回复时使用，不传入 Agent 容器
```

**Agent 容器内没有 Channel 凭证。** Agent 通过 SQS 回复队列发送消息，Fargate Control Plane 消费后调 Channel API。Agent 只生产文本，不接触任何 Channel 凭证。

### 11.4 用量配额与限流

多租户平台必须防止单用户耗尽共享资源。在 Dispatcher 调度 Agent 之前进行配额检查。

#### 配额模型

```
Plan 配置 (users 表 quota 字段):

| 配额项                  | Free   | Pro     | Enterprise |
|------------------------|--------|---------|------------|
| max_bots               | 1      | 5       | 50         |
| max_groups_per_bot     | 3      | 20      | 200        |
| max_tasks_per_bot      | 5      | 50      | 500        |
| max_concurrent_agents  | 1      | 3       | 10         |
| max_monthly_tokens     | 100K   | 1M      | 10M        |
| max_message_length     | 4K     | 16K     | 64K        |
```

#### 检查时机

```
Webhook 接收消息
    │
    ├── 检查 1: Bot 状态 (active?)
    ├── 检查 2: 消息长度 (< max_message_length?)
    └── 入队 SQS
          │
          ▼
SQS Consumer (Dispatcher)
    │
    ├── 检查 3: 月度 token 配额
    │   └── users.usage_tokens < users.quota.max_monthly_tokens?
    │       ├── 是 → 继续
    │       └── 否 → 回复 "本月用量已达上限" + 不调 Agent
    │
    ├── 检查 4: 并发 Agent 数
    │   └── users.active_agents < users.quota.max_concurrent_agents?
    │       ├── 是 → 继续
    │       └── 否 → SQS 消息不删除，等待重试 (VisibilityTimeout 后重新可见)
    │
    └── 通过 → InvokeAgentRuntime
          │
          ▼
Agent 返回结果
    │
    ├── 更新 users.usage_tokens += response_tokens
    ├── 更新 users.usage_invocations += 1
    └── 更新 users.active_agents -= 1
```

#### 资源创建时配额检查

```
POST /api/bots (创建 Bot)
    └── 检查: 用户当前 bot 数 < quota.max_bots

POST /api/bots/{bot_id}/channels (添加 Channel)
    └── 无 Channel 数限制 (每种类型最多 1 个自然限制)

Webhook 自动发现 Group
    └── 检查: bot 当前 group 数 < quota.max_groups_per_bot
        超限 → 消息不入队，不自动注册 Group

schedule_task (MCP 工具, Agent 内)
    └── 检查: bot 当前 task 数 < quota.max_tasks_per_bot
        超限 → MCP 工具返回错误信息给 Agent
```

#### 并发计数的原子性

```typescript
// 使用 DynamoDB 原子操作更新 active_agents

// 获取 Agent slot (调度前)
const acquired = await dynamodb.send(new UpdateItemCommand({
  TableName: 'clawbot-users',
  Key: { user_id: { S: userId } },
  UpdateExpression: 'SET active_agents = active_agents + :one',
  ConditionExpression: 'active_agents < quota.max_concurrent_agents',
  ExpressionAttributeValues: { ':one': { N: '1' } },
}));
// ConditionExpression 失败 → ConditionalCheckFailedException → 不调度

// 释放 Agent slot (完成后, 在 finally 块中)
await dynamodb.send(new UpdateItemCommand({
  TableName: 'clawbot-users',
  Key: { user_id: { S: userId } },
  UpdateExpression: 'SET active_agents = active_agents - :one',
  ExpressionAttributeValues: { ':one': { N: '1' } },
}));
```

**防泄漏：** 如果 Dispatcher 进程崩溃导致 `active_agents` 没有 -1，加一个补偿机制：

```
每 5 分钟扫描: 查询所有 active_agents > 0 的用户
对比实际 AgentCore 活跃 session 数 (ListRuntimeSessions API)
如有差异 → 修正 active_agents 计数
```

#### 月度用量自动重置

```
每月 1 号 00:00 UTC (EventBridge Scheduler)
    │
    ▼
扫描所有 users 表
    ├── 如果 usage_month != 当前月 → 重置:
    │   usage_month = "2026-04"
    │   usage_tokens = 0
    │   usage_invocations = 0
    └── 如果 usage_month == 当前月 → 跳过
```

#### 超限用户通知

```
Token 配额用到 80% → 通知: "您本月已使用 80% token 配额"
Token 配额用到 100% → 通知: "本月 token 配额已用完，Agent 暂停响应"
并发 Agent 达上限 → 排队，不通知 (自动等待)
Bot/Group/Task 数达上限 → 创建时拒绝 + 返回错误信息
```

---

## 12. 可观测性

### 12.1 监控指标

| 指标 | 来源 | 告警阈值 |
|------|------|---------|
| Webhook 延迟 (p99) | ALB access log | > 1s |
| SQS 队列深度 | CloudWatch | > 50 条 |
| Agent 执行时长 (p95) | AgentCore Observability | > 120s |
| Agent 错误率 | AgentCore Observability | > 5% |
| Session 创建频率 | AgentCore | 突增告警 |
| DynamoDB 读写容量 | CloudWatch | > 80% 预置容量 |
| Fargate CPU/内存 | CloudWatch | > 80% |
| Fargate Task 数量 | ECS metrics | auto-scaling 触发 |
| Secrets Manager 调用量 | CloudWatch | 成本告警 |
| 配额拒绝次数 | Custom CloudWatch | > 10/min (可能有滥用) |
| Channel 健康检查失败数 | Custom CloudWatch | > 0 (需通知用户) |
| Token 用量 top 10 用户 | Custom Dashboard | 监控大户 |

### 12.2 日志结构

```
Fargate Service   → CloudWatch Logs (JSON structured, pino)
  ├── HTTP 请求日志 (Webhook + API)
  ├── SQS Consumer 日志 (消费 + 分发)
  └── 错误 + 异常日志
Agent Runtime     → AgentCore Observability (traces + spans)
                  → CloudWatch Logs (agent-runner 日志)
```

### 12.3 用户可见日志

Web 控制台展示给用户的日志（脱敏后）：

```
[2026-03-14 14:30:01] Telegram 消息接收: group-123, sender: Alice
[2026-03-14 14:30:02] Agent 开始处理 (session: active, 复用)
[2026-03-14 14:30:15] Agent 调用工具: Read("report.md")
[2026-03-14 14:30:28] Agent 回复发送 (耗时: 27s, tokens: 1,234)
```

---

## 13. 成本模型

### 13.1 单用户月成本估算

假设: 1 个 Bot, 1 个 Telegram Channel, 每天 30 次对话, 每次平均 60 秒 (其中 70% I/O 等待)

| 组件 | 计算 | 月成本 |
|------|------|--------|
| AgentCore CPU | 30 × 30 × 18s × 1vCPU × $0.0895/3600 | ~$0.40 |
| AgentCore Memory | 30 × 30 × 60s × 2GB × $0.00945/3600 | ~$0.28 |
| Bedrock Claude | 30 × 30 × ~2K tokens × $0.003/1K | ~$5.40 |
| DynamoDB | 按需模式，低流量 | ~$0.50 |
| S3 | < 1GB 存储 + 少量请求 | ~$0.10 |
| Secrets Manager | 极少调用 (Fargate 内存缓存) | ~$0.05 |
| EventBridge | 少量定时任务 | ~$0.01 |
| CloudFront + S3 | 静态站点 | ~$0.50 |
| **单用户边际合计** | | **~$7.24/月** |

**注:** Bedrock Claude 模型调用费是最大头。Fargate 内存缓存大幅减少 Secrets Manager 调用量。

### 13.2 平台固定成本

| 组件 | 月成本 |
|------|--------|
| Fargate Service (2 Task, 0.5vCPU/1GB) | ~$30 |
| ALB | ~$18 |
| CloudFront 分发 | ~$1 |
| Cognito (< 50K MAU 免费) | $0 |
| Route 53 域名 | ~$0.50 |
| ACM 证书 | $0 |
| CloudWatch 日志 | ~$5 (视量) |
| **平台固定合计** | **~$55/月** |

**注:** 相比纯 Lambda 方案，Fargate + ALB 增加了约 $48/月的固定成本。这是用常驻进程换取无超时限制和内存缓存优势的代价。用户数超过 ~7 人后，缓存省下的 Secrets Manager 和 DynamoDB 调用费开始回本。

### 13.3 规模经济

| 用户数 | 月成本 (估算) | 人均成本 |
|--------|-------------|---------|
| 1 | $62 | $62 |
| 10 | $127 | $12.70 |
| 100 | $779 | $7.79 |
| 1000 | $7,295 | $7.30 |

固定成本 ($55) 在用户增长后被摊薄。100+ 用户后人均成本趋近纯边际成本。

**Auto Scaling 可优化固定成本：** 低峰时段缩至 2 Task (高可用最低配)，高峰扩至 N Task。Fargate Spot 可再降 ~70% 计算成本（代价是偶尔中断，SQS 重试兜底）。

---

## 14. NanoClaw → ClawBot Cloud 映射

| NanoClaw 组件 | ClawBot Cloud 对应 | 变更说明 |
|--------------|-------------------|---------|
| `src/index.ts` (主循环) | Fargate SQS Consumer | 从轮询 SQLite 变长轮询 SQS |
| `src/channels/registry.ts` | DynamoDB channels 表 | 从代码注册变数据驱动 |
| Channel SDK 连接 | Webhook + Fargate HTTP | 从长连接变 Webhook |
| `src/router.ts` (消息路由) | Fargate HTTP + SQS Consumer | HTTP 接收 + 后台消费 |
| `src/container-runner.ts` | AgentCore Runtime | 从 Docker 变托管 microVM |
| `container/agent-runner` | AgentCore 容器 `/invocations` | 从 stdin/stdout 变 HTTP |
| `src/ipc.ts` (文件 IPC) | AWS SDK 直接调用 | 无需文件中转 |
| `src/db.ts` (SQLite) | DynamoDB | 从单文件变分布式 |
| `src/group-queue.ts` | SQS FIFO + MessageGroupId | 从内存队列变托管队列 |
| `src/task-scheduler.ts` | EventBridge Scheduler → SQS | 从自建循环变托管调度 |
| `src/credential-proxy.ts` | IAM Role | 完全消除 |
| `src/mount-security.ts` | AgentCore microVM 隔离 | 完全消除 |
| `src/sender-allowlist.ts` | DynamoDB + Webhook Lambda | 从文件配置变数据驱动 |
| `groups/*/CLAUDE.md` | S3 + Agent 启动时加载 | 从本地文件变对象存储 |
| `data/sessions/` | S3 + AgentCore Session | 跨 session 需 S3 持久化 |
| launchd / systemd | Serverless (无进程管理) | 完全消除 |
| Web 控制台 | 新增 | NanoClaw 无此组件 |
| 用户认证 | 新增 (Cognito) | NanoClaw 无此需求 |
| 多 Bot 管理 | 新增 | NanoClaw 单 Bot |

---

## 15. CDK 部署架构

### 15.1 项目结构

```
infra/
├── bin/
│   └── clawbot.ts                  # CDK App 入口
├── lib/
│   ├── stacks/
│   │   ├── foundation-stack.ts     # VPC, ECR, S3, DynamoDB
│   │   ├── auth-stack.ts           # Cognito User Pool
│   │   ├── control-plane-stack.ts  # ALB + ECS Fargate Service
│   │   ├── agent-stack.ts          # AgentCore Runtime (Custom Resource)
│   │   ├── frontend-stack.ts       # CloudFront + S3 (SPA)
│   │   └── monitoring-stack.ts     # CloudWatch Dashboards, Alarms
│   ├── constructs/
│   │   ├── dynamodb-tables.ts      # 所有 DynamoDB 表定义
│   │   ├── sqs-queues.ts           # SQS FIFO + DLQ
│   │   ├── agentcore-runtime.ts    # AgentCore Custom Resource
│   │   └── waf-rules.ts           # WAF ACL
│   └── config.ts                   # 环境配置 (dev/staging/prod)
├── cdk.json
├── tsconfig.json
└── package.json
```

### 15.2 Stack 依赖关系

```
FoundationStack (VPC, S3, DynamoDB, ECR, SQS)
    │
    ├──→ AuthStack (Cognito)
    │
    ├──→ ControlPlaneStack (ALB + Fargate)
    │       依赖: Foundation, Auth
    │
    ├──→ AgentStack (AgentCore Runtime)
    │       依赖: Foundation
    │
    ├──→ FrontendStack (CloudFront + S3)
    │       依赖: Auth, ControlPlane (ALB domain)
    │
    └──→ MonitoringStack (Dashboards, Alarms)
            依赖: All
```

### 15.3 Foundation Stack

```typescript
// lib/stacks/foundation-stack.ts

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { DynamoDbTables } from '../constructs/dynamodb-tables';
import { Construct } from 'constructs';

export class FoundationStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly dataBucket: s3.Bucket;
  public readonly agentRepo: ecr.Repository;
  public readonly controlPlaneRepo: ecr.Repository;
  public readonly tables: DynamoDbTables;
  public readonly messageQueue: sqs.Queue;
  public readonly replyQueue: sqs.Queue;
  public readonly taskQueue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── VPC ──
    this.vpc = new ec2.Vpc(this, 'ClawBotVpc', {
      maxAzs: 2,
      natGateways: 1,  // Fargate 需要 NAT 访问外网
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ],
    });

    // ── S3: 数据存储 ──
    this.dataBucket = new s3.Bucket(this, 'DataBucket', {
      bucketName: `clawbot-data-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      lifecycleRules: [
        {
          // Session 文件 90 天后转 Infrequent Access
          prefix: '*/sessions/',
          transitions: [
            { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: cdk.Duration.days(90) },
          ],
        },
        {
          // 对话归档 180 天后转 Glacier
          prefix: '*/archives/',
          transitions: [
            { storageClass: s3.StorageClass.GLACIER, transitionAfter: cdk.Duration.days(180) },
          ],
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── ECR: 容器镜像仓库 ──
    this.agentRepo = new ecr.Repository(this, 'AgentRepo', {
      repositoryName: 'clawbot-agent',
      lifecycleRules: [{ maxImageCount: 10 }],  // 保留最近 10 个镜像
    });

    this.controlPlaneRepo = new ecr.Repository(this, 'ControlPlaneRepo', {
      repositoryName: 'clawbot-control-plane',
      lifecycleRules: [{ maxImageCount: 10 }],
    });

    // ── SQS: 消息队列 ──
    this.deadLetterQueue = new sqs.Queue(this, 'DLQ', {
      queueName: 'clawbot-dlq.fifo',
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.messageQueue = new sqs.Queue(this, 'MessageQueue', {
      queueName: 'clawbot-messages.fifo',
      fifo: true,
      fifoThroughputLimit: sqs.FifoThroughputLimit.PER_MESSAGE_GROUP_ID,  // 高吞吐模式
      deduplicationScope: sqs.DeduplicationScope.MESSAGE_GROUP,           // 配合高吞吐
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.minutes(10),
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 3,
      },
    });
    // 高吞吐 FIFO: 每个 MessageGroupId 独立 300 msg/s 限额,
    // 整体队列吞吐 = 300 × 活跃 MessageGroupId 数, 无全局瓶颈。
    // 标准 FIFO 模式下整个队列共享 300 msg/s, 不适合多租户。

    // Agent → Control Plane 的回复队列 (标准队列, 不需要 FIFO)
    this.replyQueue = new sqs.Queue(this, 'ReplyQueue', {
      queueName: 'clawbot-replies',
      visibilityTimeout: cdk.Duration.seconds(30),
    });

    // EventBridge Scheduler → Fargate 的任务队列
    this.taskQueue = new sqs.Queue(this, 'TaskQueue', {
      queueName: 'clawbot-tasks.fifo',
      fifo: true,
      fifoThroughputLimit: sqs.FifoThroughputLimit.PER_MESSAGE_GROUP_ID,
      deduplicationScope: sqs.DeduplicationScope.MESSAGE_GROUP,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.minutes(10),
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: 3,
      },
    });

    // ── DynamoDB: 所有表 ──
    this.tables = new DynamoDbTables(this, 'Tables');
  }
}
```

### 15.4 DynamoDB 表定义

```typescript
// lib/constructs/dynamodb-tables.ts

import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class DynamoDbTables extends Construct {
  public readonly users: dynamodb.Table;
  public readonly bots: dynamodb.Table;
  public readonly channels: dynamodb.Table;
  public readonly groups: dynamodb.Table;
  public readonly messages: dynamodb.Table;
  public readonly tasks: dynamodb.Table;
  public readonly sessions: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.users = new dynamodb.Table(this, 'Users', {
      tableName: 'clawbot-users',
      partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // 属性: email, display_name, plan, quota (JSON),
      //       usage_month, usage_tokens, usage_invocations, active_agents
    });

    this.bots = new dynamodb.Table(this, 'Bots', {
      tableName: 'clawbot-bots',
      partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'bot_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // GSI: 通过 bot_id 查找 (Webhook 路由用)
    this.bots.addGlobalSecondaryIndex({
      indexName: 'bot-id-index',
      partitionKey: { name: 'bot_id', type: dynamodb.AttributeType.STRING },
    });

    this.channels = new dynamodb.Table(this, 'Channels', {
      tableName: 'clawbot-channels',
      partitionKey: { name: 'bot_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'channel_key', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    this.groups = new dynamodb.Table(this, 'Groups', {
      tableName: 'clawbot-groups',
      partitionKey: { name: 'bot_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'group_jid', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    this.messages = new dynamodb.Table(this, 'Messages', {
      tableName: 'clawbot-messages',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },  // {bot_id}#{group_jid}
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',  // 90 天自动过期 (created_at + 7,776,000s)
      // 热分区缓解: 按需模式自适应分裂，单分区 1,000 WCU/s
      // 查询优化: ScanIndexForward=false + Limit=50 取最近消息
    });

    this.tasks = new dynamodb.Table(this, 'Tasks', {
      tableName: 'clawbot-tasks',
      partitionKey: { name: 'bot_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'task_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    this.sessions = new dynamodb.Table(this, 'Sessions', {
      tableName: 'clawbot-sessions',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },  // {bot_id}#{group_jid}
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },       // "current"
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });
  }
}
```

### 15.5 Auth Stack

```typescript
// lib/stacks/auth-stack.ts

import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'clawbot-users',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.userPoolClient = this.userPool.addClient('WebClient', {
      authFlows: {
        userSrp: true,
        userPassword: false,  // 禁止明文密码认证
      },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: ['https://app.clawbot.com/callback', 'http://localhost:3000/callback'],
        logoutUrls: ['https://app.clawbot.com', 'http://localhost:3000'],
      },
      idTokenValidity: cdk.Duration.hours(1),
      accessTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    this.userPoolDomain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: 'clawbot' },
    });
  }
}
```

### 15.6 Control Plane Stack

```typescript
// lib/stacks/control-plane-stack.ts

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { FoundationStack } from './foundation-stack';
import { AuthStack } from './auth-stack';

interface ControlPlaneProps extends cdk.StackProps {
  foundation: FoundationStack;
  auth: AuthStack;
  domainName: string;           // e.g. "api.clawbot.com"
  certificateArn: string;       // ACM 证书 ARN
  agentRuntimeArn: string;      // AgentCore Runtime ARN
}

export class ControlPlaneStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly service: ecs.FargateService;

  constructor(scope: Construct, id: string, props: ControlPlaneProps) {
    super(scope, id, props);

    const { foundation, auth } = props;

    // ── ECS Cluster ──
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: foundation.vpc,
      clusterName: 'clawbot',
      containerInsights: true,
    });

    // ── Task Role (Control Plane 进程的权限) ──
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // DynamoDB 全表访问
    foundation.tables.users.grantReadWriteData(taskRole);
    foundation.tables.bots.grantReadWriteData(taskRole);
    foundation.tables.channels.grantReadWriteData(taskRole);
    foundation.tables.groups.grantReadWriteData(taskRole);
    foundation.tables.messages.grantReadWriteData(taskRole);
    foundation.tables.tasks.grantReadWriteData(taskRole);
    foundation.tables.sessions.grantReadWriteData(taskRole);

    // SQS 读写
    foundation.messageQueue.grantSendMessages(taskRole);
    foundation.messageQueue.grantConsumeMessages(taskRole);
    foundation.replyQueue.grantConsumeMessages(taskRole);
    foundation.taskQueue.grantConsumeMessages(taskRole);

    // S3 读写
    foundation.dataBucket.grantReadWrite(taskRole);

    // Secrets Manager (Channel 凭证)
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'secretsmanager:GetSecretValue',
        'secretsmanager:CreateSecret',
        'secretsmanager:UpdateSecret',
        'secretsmanager:DeleteSecret',
      ],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:clawbot/*`],
    }));

    // AgentCore Runtime 调用
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [props.agentRuntimeArn],
    }));

    // EventBridge Scheduler 管理
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'scheduler:CreateSchedule', 'scheduler:UpdateSchedule',
        'scheduler:DeleteSchedule', 'scheduler:GetSchedule',
      ],
      resources: [`arn:aws:scheduler:${this.region}:${this.account}:schedule/default/clawbot-*`],
    }));
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [`arn:aws:iam::${this.account}:role/ClawBotSchedulerRole`],
    }));

    // ── Task Definition ──
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: 512,       // 0.5 vCPU
      memoryLimitMiB: 1024,   // 1 GB
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const container = taskDef.addContainer('ControlPlane', {
      image: ecs.ContainerImage.fromEcrRepository(foundation.controlPlaneRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'control-plane',
        logRetention: logs.RetentionDays.ONE_MONTH,
      }),
      environment: {
        NODE_ENV: 'production',
        AWS_REGION: this.region,
        COGNITO_USER_POOL_ID: auth.userPool.userPoolId,
        COGNITO_CLIENT_ID: auth.userPoolClient.userPoolClientId,
        MESSAGE_QUEUE_URL: foundation.messageQueue.queueUrl,
        REPLY_QUEUE_URL: foundation.replyQueue.queueUrl,
        TASK_QUEUE_URL: foundation.taskQueue.queueUrl,
        DATA_BUCKET: foundation.dataBucket.bucketName,
        AGENTCORE_RUNTIME_ARN: props.agentRuntimeArn,
        DYNAMODB_TABLE_PREFIX: 'clawbot-',
      },
      portMappings: [{ containerPort: 8080 }],
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:8080/health || exit 1'],
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
      },
    });

    // ── ALB ──
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc: foundation.vpc,
      internetFacing: true,
      loadBalancerName: 'clawbot-alb',
    });

    const certificate = acm.Certificate.fromCertificateArn(this, 'Cert', props.certificateArn);

    const httpsListener = this.alb.addListener('HTTPS', {
      port: 443,
      certificates: [certificate],
      protocol: elbv2.ApplicationProtocol.HTTPS,
    });

    // HTTP → HTTPS 重定向
    this.alb.addListener('HTTP', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS', port: '443', permanent: true,
      }),
    });

    // ── Fargate Service ──
    this.service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 2,     // 高可用最少 2 个 Task
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
      serviceName: 'clawbot-control-plane',
      assignPublicIp: false,  // 在 Private Subnet，通过 NAT 访问外网
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      capacityProviderStrategies: [
        { capacityProvider: 'FARGATE', weight: 1, base: 2 },        // 基础 2 个用 On-Demand
        { capacityProvider: 'FARGATE_SPOT', weight: 3 },             // 扩容用 Spot (省 70%)
      ],
    });

    httpsListener.addTargets('ControlPlane', {
      port: 8080,
      targets: [this.service],
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(15),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // ── Auto Scaling ──
    const scaling = this.service.autoScaleTaskCount({
      minCapacity: 2,
      maxCapacity: 10,
    });

    // 基于 SQS 队列深度扩缩
    scaling.scaleOnMetric('QueueDepthScaling', {
      metric: foundation.messageQueue.metricApproximateNumberOfMessagesVisible(),
      scalingSteps: [
        { upper: 0, change: 0 },     // 0 条消息 → 维持当前
        { lower: 50, change: +2 },   // 50+ → 加 2 个 Task
        { lower: 200, change: +4 },  // 200+ → 加 4 个 Task
      ],
      cooldown: cdk.Duration.minutes(3),
    });

    // 基于 CPU 使用率扩缩
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.minutes(5),
      scaleOutCooldown: cdk.Duration.minutes(2),
    });

    // ── WAF ──
    const waf = new wafv2.CfnWebACL(this, 'WAF', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'clawbot-waf',
      },
      rules: [
        {
          name: 'RateLimit',
          priority: 1,
          action: { block: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'clawbot-rate-limit',
          },
          statement: {
            rateBasedStatement: {
              limit: 2000,  // 5 分钟内 2000 请求
              aggregateKeyType: 'IP',
            },
          },
        },
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'clawbot-common-rules',
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
        },
      ],
    });

    new wafv2.CfnWebACLAssociation(this, 'WAFAssociation', {
      resourceArn: this.alb.loadBalancerArn,
      webAclArn: waf.attrArn,
    });
  }
}
```

### 15.7 Agent Stack

AgentCore Runtime 尚无 CDK L2 construct，使用 Custom Resource 封装 boto3 调用。

```typescript
// lib/stacks/agent-stack.ts

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { FoundationStack } from './foundation-stack';

interface AgentStackProps extends cdk.StackProps {
  foundation: FoundationStack;
}

export class AgentStack extends cdk.Stack {
  public readonly agentRuntimeArn: string;
  public readonly agentRole: iam.Role;
  public readonly scopedRole: iam.Role;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);

    const { foundation } = props;

    // ── 基础 Role (AgentCore 绑定, 无 S3/DynamoDB 权限) ──
    this.agentRole = new iam.Role(this, 'AgentRole', {
      roleName: 'ClawBotAgentRole',
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
    });

    // Bedrock 模型调用
    this.agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['arn:aws:bedrock:*::foundation-model/anthropic.*'],
    }));

    // SQS 回复队列 (公共通道, 不需要 per-user 隔离)
    foundation.replyQueue.grantSendMessages(this.agentRole);

    // ── Scoped Role (ABAC: Session Tags 限定 per-user/per-bot) ──
    this.scopedRole = new iam.Role(this, 'ScopedRole', {
      roleName: 'ClawBotAgentScopedRole',
      assumedBy: new iam.ArnPrincipal(this.agentRole.roleArn),
    });

    // S3: Bot 数据读写 (通过 Session Tags 限定路径)
    this.scopedRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [
        `${foundation.dataBucket.bucketArn}/\${aws:PrincipalTag/userId}/\${aws:PrincipalTag/botId}/*`,
      ],
    }));

    // S3: 用户共享记忆只读 (跨 Bot 共享知识)
    this.scopedRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [
        `${foundation.dataBucket.bucketArn}/\${aws:PrincipalTag/userId}/shared/*`,
      ],
    }));

    // S3: ListBucket (限定前缀)
    this.scopedRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [foundation.dataBucket.bucketArn],
      conditions: {
        StringLike: {
          's3:prefix': [
            '${aws:PrincipalTag/userId}/${aws:PrincipalTag/botId}/*',
            '${aws:PrincipalTag/userId}/shared/*',
          ],
        },
      },
    }));

    // DynamoDB: 通过 LeadingKeys 限定 botId
    this.scopedRole.addToPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem',
                'dynamodb:DeleteItem', 'dynamodb:Query'],
      resources: [foundation.tables.tasks.tableArn],
      conditions: {
        'ForAllValues:StringEquals': {
          'dynamodb:LeadingKeys': ['${aws:PrincipalTag/botId}'],
        },
      },
    }));

    // EventBridge Scheduler: 资源名限定 botId
    this.scopedRole.addToPolicy(new iam.PolicyStatement({
      actions: ['scheduler:CreateSchedule', 'scheduler:UpdateSchedule',
                'scheduler:DeleteSchedule', 'scheduler:GetSchedule'],
      resources: [
        `arn:aws:scheduler:${this.region}:${this.account}:schedule/default/clawbot-\${aws:PrincipalTag/botId}-*`,
      ],
    }));

    // 基础 Role: 允许 AssumeRole + TagSession 到 Scoped Role
    this.agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole', 'sts:TagSession'],
      resources: [this.scopedRole.roleArn],
    }));

    // ── EventBridge Scheduler 执行角色 ──
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      roleName: 'ClawBotSchedulerRole',
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    foundation.taskQueue.grantSendMessages(schedulerRole);

    // Scheduler 角色需要被 Agent 的 MCP 工具 PassRole
    this.scopedRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [schedulerRole.roleArn],
    }));

    // ── AgentCore Runtime (Custom Resource) ──
    const agentRuntime = new cr.AwsCustomResource(this, 'AgentRuntime', {
      onCreate: {
        service: 'BedrockAgentCoreControl',
        action: 'createAgentRuntime',
        parameters: {
          agentRuntimeName: 'clawbot-agent',
          agentRuntimeArtifact: {
            containerConfiguration: {
              containerUri: `${foundation.agentRepo.repositoryUri}:latest`,
            },
          },
          roleArn: this.agentRole.roleArn,
          networkConfiguration: { networkMode: 'PUBLIC' },
          environmentVariables: {
            CLAUDE_CODE_USE_BEDROCK: '1',
            AWS_REGION: this.region,
            CLAWBOT_S3_BUCKET: foundation.dataBucket.bucketName,
            CLAWBOT_DYNAMODB_TABLE_PREFIX: 'clawbot-',
            CLAWBOT_REPLY_QUEUE_URL: foundation.replyQueue.queueUrl,
            CLAWBOT_TASK_QUEUE_ARN: foundation.taskQueue.queueArn,
            CLAWBOT_SCHEDULER_ROLE_ARN: schedulerRole.roleArn,
            CLAWBOT_SCOPED_ROLE_ARN: this.scopedRole.roleArn,
          },
        },
        physicalResourceId: cr.PhysicalResourceId.fromResponse('agentRuntimeArn'),
      },
      onDelete: {
        service: 'BedrockAgentCoreControl',
        action: 'deleteAgentRuntime',
        parameters: {
          agentRuntimeName: 'clawbot-agent',
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'bedrock-agentcore:CreateAgentRuntime',
            'bedrock-agentcore:DeleteAgentRuntime',
            'bedrock-agentcore:UpdateAgentRuntime',
          ],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [this.agentRole.roleArn],
        }),
      ]),
    });

    this.agentRuntimeArn = agentRuntime.getResponseField('agentRuntimeArn');
  }
}
```

### 15.8 Frontend Stack

```typescript
// lib/stacks/frontend-stack.ts

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';

interface FrontendStackProps extends cdk.StackProps {
  domainName: string;           // e.g. "app.clawbot.com"
  certificateArn: string;       // us-east-1 ACM 证书 (CloudFront 要求)
  apiDomainName: string;        // e.g. "api.clawbot.com"
}

export class FrontendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const certificate = acm.Certificate.fromCertificateArn(
      this, 'Cert', props.certificateArn,
    );

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      domainNames: [props.domainName],
      certificate,
      defaultRootObject: 'index.html',
      // SPA: 所有 404 返回 index.html
      errorResponses: [
        {
          httpStatus: 404,
          responsePagePath: '/index.html',
          responseHttpStatus: 200,
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    // 部署前端构建产物 (可选, 也可用 CI/CD)
    // new s3deploy.BucketDeployment(this, 'Deploy', {
    //   sources: [s3deploy.Source.asset('../frontend/dist')],
    //   destinationBucket: siteBucket,
    //   distribution,
    // });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
    });
  }
}
```

### 15.9 CDK App 入口

```typescript
// bin/clawbot.ts

import * as cdk from 'aws-cdk-lib';
import { FoundationStack } from '../lib/stacks/foundation-stack';
import { AuthStack } from '../lib/stacks/auth-stack';
import { AgentStack } from '../lib/stacks/agent-stack';
import { ControlPlaneStack } from '../lib/stacks/control-plane-stack';
import { FrontendStack } from '../lib/stacks/frontend-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-west-2',
};

// ── Stack 实例化 (顺序体现依赖关系) ──

const foundation = new FoundationStack(app, 'ClawBot-Foundation', { env });

const auth = new AuthStack(app, 'ClawBot-Auth', { env });

const agent = new AgentStack(app, 'ClawBot-Agent', {
  env,
  foundation,
});

const controlPlane = new ControlPlaneStack(app, 'ClawBot-ControlPlane', {
  env,
  foundation,
  auth,
  domainName: 'api.clawbot.com',
  certificateArn: 'arn:aws:acm:us-west-2:ACCOUNT:certificate/CERT_ID',
  agentRuntimeArn: agent.agentRuntimeArn,
});

const frontend = new FrontendStack(app, 'ClawBot-Frontend', {
  env: { ...env, region: 'us-east-1' },  // CloudFront 证书必须在 us-east-1
  domainName: 'app.clawbot.com',
  certificateArn: 'arn:aws:acm:us-east-1:ACCOUNT:certificate/CERT_ID',
  apiDomainName: 'api.clawbot.com',
});
```

### 15.10 部署流程

```
# 1. 初始化 (首次)
cd infra && npm install
cdk bootstrap

# 2. 构建 Agent 容器镜像并推送 ECR
cd container
docker buildx build --platform linux/arm64 \
  -t {account}.dkr.ecr.{region}.amazonaws.com/clawbot-agent:latest \
  --push .

# 3. 构建 Control Plane 镜像并推送 ECR
cd control-plane
docker buildx build --platform linux/arm64 \
  -t {account}.dkr.ecr.{region}.amazonaws.com/clawbot-control-plane:latest \
  --push .

# 4. 部署基础设施
cd infra
cdk deploy ClawBot-Foundation ClawBot-Auth
cdk deploy ClawBot-Agent
cdk deploy ClawBot-ControlPlane
cdk deploy ClawBot-Frontend

# 5. 更新 Agent 代码 (无需 cdk deploy)
docker buildx build ... --push .
# AgentCore 自动拉取 latest 标签
# 或显式更新: aws bedrock-agentcore update-agent-runtime ...

# 6. 更新 Control Plane 代码
docker buildx build ... --push .
aws ecs update-service --cluster clawbot --service clawbot-control-plane --force-new-deployment
```

### 15.11 环境管理 (dev / staging / prod)

```typescript
// lib/config.ts

export interface EnvironmentConfig {
  envName: string;
  domainPrefix: string;          // "dev", "staging", ""
  fargateDesiredCount: number;
  fargateMaxCount: number;
  fargateCpu: number;
  fargateMemory: number;
  enableWaf: boolean;
  s3VersioningEnabled: boolean;
  dynamoDbRemovalPolicy: cdk.RemovalPolicy;
}

export const environments: Record<string, EnvironmentConfig> = {
  dev: {
    envName: 'dev',
    domainPrefix: 'dev',               // dev-api.clawbot.com
    fargateDesiredCount: 1,             // 省钱: 1 个 Task
    fargateMaxCount: 2,
    fargateCpu: 256,                    // 0.25 vCPU
    fargateMemory: 512,
    enableWaf: false,
    s3VersioningEnabled: false,
    dynamoDbRemovalPolicy: cdk.RemovalPolicy.DESTROY,
  },
  staging: {
    envName: 'staging',
    domainPrefix: 'staging',
    fargateDesiredCount: 2,
    fargateMaxCount: 4,
    fargateCpu: 512,
    fargateMemory: 1024,
    enableWaf: true,
    s3VersioningEnabled: true,
    dynamoDbRemovalPolicy: cdk.RemovalPolicy.RETAIN,
  },
  prod: {
    envName: 'prod',
    domainPrefix: '',                   // api.clawbot.com
    fargateDesiredCount: 2,
    fargateMaxCount: 10,
    fargateCpu: 512,
    fargateMemory: 1024,
    enableWaf: true,
    s3VersioningEnabled: true,
    dynamoDbRemovalPolicy: cdk.RemovalPolicy.RETAIN,
  },
};
```

### 15.12 CI/CD Pipeline (概要)

```
GitHub Actions / CodePipeline

┌─────────────┐     ┌───────────────┐     ┌──────────────┐
│  git push    │────→│  Build & Test  │────→│  Deploy Dev   │
│  (main)      │     │  (lint, test)  │     │  (auto)       │
└─────────────┘     └───────────────┘     └──────┬───────┘
                                                  │
                                          手动审批 │
                                                  ▼
                                          ┌──────────────┐
                                          │ Deploy Prod   │
                                          │ (cdk deploy)  │
                                          └──────────────┘

步骤:
1. TypeScript 编译 + Vitest 测试
2. Docker build (ARM64) + push ECR
3. cdk diff → cdk deploy (dev)
4. 集成测试 (Webhook 端到端)
5. 手动审批 → cdk deploy (prod)
6. ECS force-new-deployment (Control Plane 滚动更新)
```
