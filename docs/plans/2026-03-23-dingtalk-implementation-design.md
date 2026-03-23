# 钉钉频道接入 — 实现设计文档

> 关联 Feature Request: [2026-03-23-dingtalk-feature-request.md](./2026-03-23-dingtalk-feature-request.md)

## 1. 现有频道接入模式分析

### 1.1 两种接入架构

项目中存在两种频道接入架构：

| 架构 | 代表频道 | 原理 | 特点 |
|------|----------|------|------|
| **Webhook（HTTP 推送）** | Telegram, Slack | IM 平台主动 POST 到 ALB 暴露的 Webhook 端点 | 无状态、多实例可并行处理、需公网暴露 |
| **Gateway（WebSocket 长连接）** | Discord, Feishu | 控制平面主动连接 IM 平台的 WebSocket 网关 | 需 Leader Election 保证单连接、零公网暴露 |

### 1.2 四个频道对比

| 维度 | Telegram | Discord | Slack | Feishu |
|------|----------|---------|-------|--------|
| 连接方式 | Webhook | Gateway (discord.js) | Webhook | Gateway (Lark WSClient) |
| 入口文件 | `webhooks/telegram.ts` | `adapters/discord/index.ts` + `discord/gateway-manager.ts` | `webhooks/slack.ts` | `adapters/feishu/index.ts` + `feishu/gateway-manager.ts` |
| 凭证字段 | botToken | botToken, publicKey | botToken, signingSecret | appId, appSecret, encryptKey, verificationToken, domain |
| 凭证验证 | `getMe()` → botId | `GET /users/@me` → applicationId | `auth.test()` → botUserId | `tenant_access_token` + `GET /bot/v3/info` → botOpenId |
| 签名验证 | Secret Token Header | Ed25519 | HMAC-SHA256 | SDK 内部处理 |
| groupJid 格式 | `tg:{chatId}` | `dc:{channelId}` | `sl:{channelId}` | `feishu#{chatId}` |
| Leader Election | 无 | DynamoDB 锁 (30s TTL) | 无 | DynamoDB 锁 (30s TTL) |
| 消息分片 | 无（4096 字符限制） | 2000 字符硬限制 | 无 | 4000 字符（智能分割代码块） |
| 文件发送 | REST API (sendDocument) | FormData multipart | 3 步预签名 URL | upload → send file_key |
| 回复格式 | Markdown | Embed | mrkdwn | Interactive Card (Markdown) |

### 1.3 Gateway 模式通用模式（飞书为模板）

钉钉 Stream 模式与飞书 WSClient 最为相似，以飞书实现为模板：

```
┌─ ECS Task A (Leader) ──────────────────┐
│  FeishuGatewayManager                  │
│  ├─ acquireLock() → DynamoDB           │
│  ├─ renewLock() every 10s              │
│  ├─ WSClient.connect(appId, appSecret) │
│  ├─ onMessage → parse → SQS FIFO      │
│  └─ stop() → release lock, disconnect  │
└────────────────────────────────────────┘

┌─ ECS Task B (Standby) ─────────────────┐
│  FeishuGatewayManager                  │
│  ├─ checkLock() → "another is leader"  │
│  ├─ poll every 10s for lock expiry     │
│  └─ if expired → attemptTakeover()     │
└────────────────────────────────────────┘
```

**关键组件：**
1. **GatewayManager** — 生命周期管理（start/stop/addBot/removeBot）
2. **MessageHandler** — 消息解析、groupJid 构造、附件下载、SQS 派发
3. **Adapter** — 实现 `ChannelAdapter` 接口，注册到 `AdapterRegistry`
4. **Leader Election** — DynamoDB 条件更新 + TTL + 定期续租

## 2. 钉钉接入设计

### 2.1 架构选择

采用 **Stream 模式（Gateway 架构）**，复用飞书的 Gateway Manager + Leader Election 模式。

```
钉钉用户 → @Bot 消息
       ↓ (WebSocket Stream)
ECS Fargate (Leader 实例)
  └─ DingTalkGatewayManager
       ├─ dingtalk-stream SDK 连接
       ├─ ChatbotHandler 回调
       ├─ 解析消息 → SqsInboundPayload
       └─ SQS FIFO (MessageGroupId: botId#groupJid)
              ↓
       SQS Consumer → dispatchMessage()
              ↓
       AgentCore (Claude Agent SDK)
              ↓
       InvocationResult
              ↓
       SQS Reply Queue → Reply Consumer
              ↓
       DingTalkAdapter.sendReply()
              ↓
       钉钉 API → 用户收到回复
```

### 2.2 凭证与认证

| 字段 | 用途 | 来源 |
|------|------|------|
| `clientId` | 应用标识（AppKey） | 钉钉开放平台 → 应用凭证 |
| `clientSecret` | 应用密钥（AppSecret） | 钉钉开放平台 → 应用凭证 |

- Stream SDK 使用 `clientId` + `clientSecret` 自动获取和刷新 access_token
- 无需手动管理 OAuth token 生命周期
- 存储在 AWS Secrets Manager：`nanoclawbot/{stage}/{botId}/dingtalk`

### 2.3 凭证验证

```typescript
// control-plane/src/channels/dingtalk.ts
export async function verifyCredentials(
  clientId: string,
  clientSecret: string,
): Promise<{ robotId: string; robotName: string }> {
  // 1. 获取 access_token
  const tokenResp = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
  });
  const { accessToken } = await tokenResp.json();

  // 2. 获取机器人信息
  const botResp = await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/...', {
    headers: { 'x-acs-dingtalk-access-token': accessToken },
  });
  // 返回机器人 ID 和名称
}
```

### 2.4 groupJid 格式

```
dt:{conversationId}
```

- `dt:` 前缀标识钉钉频道
- `conversationId` 来自钉钉消息回调中的 `conversationId` 字段
- 私聊和群聊使用同一格式

## 3. 逐文件实现计划

### 3.1 Phase 1 — 共享类型 & API 客户端

#### `shared/src/types.ts`

```diff
- export type ChannelType = 'telegram' | 'discord' | 'slack' | 'feishu';
+ export type ChannelType = 'telegram' | 'discord' | 'slack' | 'feishu' | 'dingtalk';
```

#### `control-plane/src/channels/dingtalk.ts` (新建)

钉钉 REST API 客户端，负责：
- `getAccessToken(clientId, clientSecret)` — 获取 access_token
- `verifyCredentials(clientId, clientSecret)` — 验证凭证有效性
- `sendMessage(accessToken, conversationId, text)` — 发送文本消息
- `sendMarkdownMessage(accessToken, conversationId, title, text)` — 发送 Markdown 消息
- `replyMessage(accessToken, msgId, text)` — 回复消息
- `uploadMedia(accessToken, filePath, mediaType)` — 上传文件/图片
- `downloadMedia(accessToken, downloadCode)` — 下载文件/图片

Token 缓存策略：内存缓存 + 提前 5 分钟刷新（与飞书实现一致）。

#### `control-plane/src/channels/index.ts`

```diff
+ import * as dingtalk from './dingtalk.js';

  // verifyChannelCredentials switch
+ case 'dingtalk': {
+   const result = await dingtalk.verifyCredentials(creds.clientId, creds.clientSecret);
+   return { robotId: result.robotId, robotName: result.robotName };
+ }

  // sendChannelMessage switch (fallback path)
+ case 'dingtalk':
+   // Handled by adapter; not needed here
+   break;
```

### 3.2 Phase 2 — Gateway Manager & 消息处理

#### `control-plane/src/dingtalk/gateway-manager.ts` (新建)

参照 `feishu/gateway-manager.ts` 实现：

```typescript
import DingTalkStream, { ChatbotHandler } from 'dingtalk-stream';

export class DingTalkGatewayManager {
  private clients = new Map<string, DingTalkStream.DingTalkStreamClient>();

  async addBot(botId: string): Promise<void> {
    const channel = await getChannelsByBot(botId, 'dingtalk');
    const creds = await getChannelCredentials(channel.credentialSecretArn);

    const client = new DingTalkStream.DingTalkStreamClient({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
    });

    client.registerCallbackHandler(
      '/v1.0/im/bot/messages/get',
      new BotMessageHandler(botId, this.logger),
    );

    await client.start();
    this.clients.set(botId, client);
  }

  async removeBot(botId: string): Promise<void> {
    const client = this.clients.get(botId);
    if (client) {
      // SDK 目前无显式 stop()，通过移除引用让 GC 清理
      this.clients.delete(botId);
    }
  }

  async stopAll(): Promise<void> {
    for (const [botId] of this.clients) {
      await this.removeBot(botId);
    }
  }
}
```

**Leader Election** — 复用飞书模式：
- DynamoDB 锁键：`__system__#dingtalk-gateway-leader`
- TTL：30 秒
- 续租间隔：10 秒
- Standby 实例轮询过期锁并尝试接管

#### `control-plane/src/dingtalk/message-handler.ts` (新建)

```typescript
class BotMessageHandler extends ChatbotHandler {
  async process(callback: CallbackMessage): Promise<[number, string]> {
    const { text, senderStaffId, conversationId, msgId, isInAtList, chatbotUserId } = callback;

    // 1. 构造 groupJid
    const groupJid = `dt:${conversationId}`;
    const isGroup = conversationId !== senderStaffId; // 群聊 vs 私聊

    // 2. 自动创建 Group
    await getOrCreateGroup(this.botId, groupJid, chatName, 'dingtalk', isGroup);

    // 3. 存储消息到 DynamoDB
    const msg: Message = {
      botId: this.botId,
      groupJid,
      timestamp: new Date().toISOString(),
      messageId: `dt-${msgId}`,
      sender: senderStaffId,
      senderName: senderNick || senderStaffId,
      content: text?.content || '',
      isFromMe: false,
      isBotMessage: false,
      channelType: 'dingtalk',
      ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 3600,
    };
    await putMessage(msg);

    // 4. 触发判断（私聊直接触发，群聊需 @Bot）
    if (!isGroup && !isInAtList) {
      return [AckMessage.STATUS_OK, ''];
    }

    // 5. 派发到 SQS FIFO
    const sqsPayload: SqsInboundPayload = {
      type: 'inbound_message',
      botId: this.botId,
      groupJid,
      userId: this.userId,
      messageId: msg.messageId,
      content: msg.content,
      channelType: 'dingtalk',
      timestamp: msg.timestamp,
      replyContext: { dingtalkConversationId: conversationId, dingtalkMsgId: msgId },
    };

    await sqs.send(new SendMessageCommand({
      QueueUrl: config.queues.messages,
      MessageBody: JSON.stringify(sqsPayload),
      MessageGroupId: `${this.botId}#${groupJid}`,
      MessageDeduplicationId: msg.messageId,
    }));

    return [AckMessage.STATUS_OK, ''];
  }
}
```

### 3.3 Phase 3 — 频道适配器

#### `control-plane/src/adapters/dingtalk/index.ts` (新建)

```typescript
import { BaseChannelAdapter } from '../base.js';
import type { ReplyContext, ReplyOptions } from '@clawbot/shared/channel-adapter';
import * as dingtalk from '../../channels/dingtalk.js';

export class DingTalkAdapter extends BaseChannelAdapter {
  readonly channelType = 'dingtalk';

  private gatewayManager: DingTalkGatewayManager | null = null;

  async start(): Promise<void> {
    // Leader election + gateway manager 初始化
    this.gatewayManager = new DingTalkGatewayManager(this.logger);
    await this.gatewayManager.start(); // 内含 leader election
  }

  async stop(): Promise<void> {
    await this.gatewayManager?.stopAll();
  }

  async sendReply(
    botId: string,
    groupJid: string,
    text: string,
    credentials: Record<string, string>,
    replyContext?: ReplyContext,
    options?: ReplyOptions,
  ): Promise<void> {
    const accessToken = await dingtalk.getAccessToken(credentials.clientId, credentials.clientSecret);
    const conversationId = replyContext?.dingtalkConversationId || groupJid.replace('dt:', '');

    // 使用 Markdown 格式回复
    await dingtalk.sendMarkdownMessage(accessToken, conversationId, 'Reply', text);
  }

  async sendFile(
    botId: string,
    groupJid: string,
    filePath: string,
    credentials: Record<string, string>,
    replyContext?: ReplyContext,
  ): Promise<void> {
    const accessToken = await dingtalk.getAccessToken(credentials.clientId, credentials.clientSecret);
    const mediaId = await dingtalk.uploadMedia(accessToken, filePath, 'file');
    const conversationId = replyContext?.dingtalkConversationId || groupJid.replace('dt:', '');
    await dingtalk.sendFileMessage(accessToken, conversationId, mediaId);
  }
}
```

#### `control-plane/src/index.ts`

```diff
+ import { DingTalkAdapter } from './adapters/dingtalk/index.js';

  // 在 adapter registry 注册处
+ registry.register(new DingTalkAdapter(logger));
```

### 3.4 Phase 4 — 路由 & 凭证管理

#### `control-plane/src/routes/api/channels.ts`

```diff
  const createChannelSchema = z.object({
-   channelType: z.enum(['telegram', 'discord', 'slack', 'whatsapp', 'feishu']),
+   channelType: z.enum(['telegram', 'discord', 'slack', 'whatsapp', 'feishu', 'dingtalk']),
    credentials: z.record(z.string(), z.string()),
  });
```

在 webhook setup 逻辑中新增：
```typescript
} else if (body.channelType === 'dingtalk') {
  // Stream 模式 — 无需 webhook URL，自动通过 gateway manager 连接
  autoConnected = true;

  // 通知 gateway manager 新增 bot
  const dingtalkGw = getDingTalkGatewayManager();
  if (dingtalkGw) {
    dingtalkGw.addBot(botId);
  }
}
```

### 3.5 Phase 5 — Web 控制台

#### `web-console/src/pages/ChannelSetup.tsx`

**ChannelType 联合类型：**
```diff
- type ChannelType = 'telegram' | 'discord' | 'slack' | 'feishu';
+ type ChannelType = 'telegram' | 'discord' | 'slack' | 'feishu' | 'dingtalk';
```

**凭证字段定义：**
```typescript
dingtalk: [
  { name: 'clientId', label: t('channelSetup.fields.clientId'), placeholder: 'dingxxxxxxxxxx' },
  { name: 'clientSecret', label: t('channelSetup.fields.clientSecret'), placeholder: 'xxxxxxxxxxxxxxxx', type: 'password' },
],
```

**频道元数据：**
```typescript
dingtalk: {
  icon: <MessageSquareDashed size={20} />,  // 或自定义钉钉图标
  label: t('channelSetup.dingtalk.label'),
  desc: t('channelSetup.dingtalk.desc'),
},
```

**配置引导组件 DingTalkGuide：**

引导步骤（before）：
1. 打开 [钉钉开放平台](https://open.dingtalk.com) → 创建企业内部应用
2. 在「应用能力」中启用「机器人」
3. 在「机器人配置」中开启 Stream 模式
4. 在「凭证与基础信息」页面获取 ClientId (AppKey) 和 ClientSecret (AppSecret)
5. 将凭证填入下方表单

引导步骤（after/connected）：
1. 在「权限管理」中申请所需权限（企业内机器人）
2. 发布应用版本
3. 在钉钉群中添加机器人 → 选择自建应用
4. @Bot 发送消息测试

#### `web-console/src/locales/zh.json`

```json
{
  "channelSetup": {
    "dingtalk": {
      "label": "钉钉",
      "desc": "Stream 长连接",
      "guideTitle": "钉钉企业机器人配置指南",
      "step1title": "创建应用",
      "step1desc": "打开 <a>钉钉开放平台</a> → 创建企业内部应用",
      "step2title": "启用机器人",
      "step2desc": "在「应用能力」中启用「机器人」能力",
      "step3title": "开启 Stream 模式",
      "step3desc": "在「机器人配置」中选择 Stream 模式接收消息",
      "step4title": "获取凭证",
      "step4desc": "在「凭证与基础信息」页面获取 ClientId 和 ClientSecret",
      "connectedTitle": "钉钉已连接",
      "connectedDesc": "Stream 连接已建立，请完成以下步骤：",
      "afterStep1title": "申请权限",
      "afterStep1desc": "在「权限管理」中申请企业内机器人所需权限",
      "afterStep2title": "发布应用",
      "afterStep2desc": "点击「版本管理与发布」发布应用",
      "afterStep3title": "添加到群聊",
      "afterStep3desc": "在钉钉群设置 → 智能群助手 → 添加机器人 → 选择你的应用",
      "afterStep4title": "测试",
      "afterStep4desc": "在群聊中 @Bot 发送消息，或直接私聊 Bot",
      "fillCredentials": "请填入 ClientId 和 ClientSecret："
    },
    "fields": {
      "clientId": "ClientId (AppKey)",
      "clientSecret": "ClientSecret (AppSecret)"
    }
  }
}
```

### 3.6 Phase 6 — Agent 系统提示词

#### `agent-runtime/src/system-prompt.ts`

在 `CHANNEL_GUIDANCE` 记录中新增：

```typescript
dingtalk: `
## DingTalk Formatting
- Use Markdown for formatting (钉钉支持标准 Markdown)
- Support: **bold**, *italic*, [links](url), \`code\`, code blocks
- Headers: # to ######
- Images: ![alt](url)
- Ordered/unordered lists supported
- Max message length: ~20000 chars (recommend keeping under 4000)
- DingTalk renders Markdown natively in card messages
- Use concise, structured replies — enterprise users prefer efficiency
`,
```

## 4. 依赖管理

### 新增 npm 包

```bash
cd control-plane
npm install dingtalk-stream
```

- 包名：`dingtalk-stream`
- 版本：`^2.1.6`
- 用途：WebSocket Stream 连接 + 消息回调处理

### Dockerfile 影响

无额外系统依赖（纯 Node.js 包），无需修改 Dockerfile。

## 5. 钉钉 vs 飞书实现对比

| 维度 | 飞书实现 | 钉钉实现（计划） |
|------|----------|-----------------|
| SDK | `@larksuiteoapi/node-sdk` WSClient | `dingtalk-stream` DingTalkStreamClient |
| 连接方式 | `WSClient(appId, appSecret)` | `DingTalkStreamClient({clientId, clientSecret})` |
| 消息回调 | `EventDispatcher` → event handler | `ChatbotHandler.process()` |
| Token 管理 | SDK 自动管理 | SDK 自动管理 |
| Leader Election | DynamoDB 锁 (`feishu-gateway-leader`) | DynamoDB 锁 (`dingtalk-gateway-leader`) |
| 回复方式 | REST API `/im/v1/messages` | REST API `/v1.0/robot/oToMessages/...` |
| 回复格式 | Interactive Card (Markdown) | Markdown 消息 |
| groupJid | `feishu#{chatId}` | `dt:{conversationId}` |
| 文件上传 | `/im/v1/files` → file_key | `/v1.0/robot/...` → mediaId |

## 6. 实施计划

### Task 清单

| # | 任务 | 预估 | 依赖 |
|---|------|------|------|
| 1 | `shared/src/types.ts` 新增 ChannelType | 10min | 无 |
| 2 | `control-plane/src/channels/dingtalk.ts` API 客户端 | 2h | Task 1 |
| 3 | `control-plane/src/channels/index.ts` 注册 | 15min | Task 2 |
| 4 | `control-plane/src/dingtalk/gateway-manager.ts` | 3h | Task 2 |
| 5 | `control-plane/src/dingtalk/message-handler.ts` | 2h | Task 4 |
| 6 | `control-plane/src/adapters/dingtalk/index.ts` | 2h | Task 2, 4 |
| 7 | `control-plane/src/routes/api/channels.ts` 更新 | 30min | Task 2 |
| 8 | `control-plane/src/index.ts` 注册适配器 | 15min | Task 6 |
| 9 | `web-console/src/pages/ChannelSetup.tsx` UI | 2h | Task 1 |
| 10 | `web-console/src/locales/*.json` i18n | 30min | Task 9 |
| 11 | `agent-runtime/src/system-prompt.ts` | 15min | Task 1 |
| 12 | 端到端测试 | 2h | All |

### 关键风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| `dingtalk-stream` SDK 连接稳定性（已知 Issue #13：~2天后断连） | Gateway 连接丢失 | 实现心跳检测 + 自动重连逻辑 |
| Node v20+ 兼容性问题（Issue #12） | 运行时崩溃 | 锁定 SDK 版本、测试兼容性 |
| 钉钉 API 频率限制未明确文档化 | 高并发场景可能被限流 | 实现指数退避重试 |
| 企业内部应用需要管理员审批发布 | 用户配置后无法立即使用 | 在引导中明确说明发布流程 |
