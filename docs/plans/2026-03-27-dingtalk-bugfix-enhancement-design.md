# DingTalk 集成修复与增强设计

**日期**: 2026-03-27
**状态**: Implemented
**影响范围**: control-plane (adapters/dingtalk, channels/dingtalk, dingtalk/)

## 背景

DingTalk 集成存在三个产品级问题：

1. **文件/富媒体消息无法发送** — `sendFile()` 是 stub，入站也不处理非文本消息
2. **非创建者私聊无回复** — sessionWebhook 对 DM 静默失败，且未检查 DingTalk errcode
3. **多机器人配置不生效** — Leader 选举架构与 Discord/Feishu 不一致，`addBot()` 在非 Leader 实例失败

## 修复 1: DM 回复静默失败

### 根因

`adapters/dingtalk/index.ts:176-183` — DM 回复错误地走了 sessionWebhook 快速路径：

```typescript
// 注释说 "for group replies" 但实际对 DM 也执行
if (ctx.dingtalkSessionWebhook) {
  await sendViaSessionWebhook(ctx.dingtalkSessionWebhook, chunk);
  continue;  // ← 认为成功，跳过 API 路径
}
```

`sendViaSessionWebhook` 仅检查 HTTP 状态码，但钉钉 webhook API 失败时也返回 HTTP 200：
```json
{"errcode": 310000, "errmsg": "conversation not found"}
```

结果：DM 回复走 webhook → HTTP 200 → 代码认为成功 → `continue` → 永远不走 `sendMarkdownMessage` API → 用户收不到回复。

### 根因 B: senderStaffId fallback 使用了错误 ID

`adapters/dingtalk/index.ts:204`：

```typescript
const senderStaffId = ctx.dingtalkSenderStaffId || ctx.groupJid.replace(/^dt:/, '');
```

当 `dingtalkSenderStaffId` 为空时，fallback 提取的是 `conversationId`（因为 `groupJid = dt:{conversationId}`），但 `oToMessages/batchSend` 的 `userIds` 参数需要 **staffId**。传 conversationId 进去会导致 API 返回错误或静默丢弃。

### 根因 C: sendChannelReply 吞没异常

`sqs/dispatcher.ts:699-704`：

```typescript
} catch (err) {
  logger.error({ err, botId, groupJid, channelType }, 'Failed to send channel reply');
  // ← 异常被吞没，调用方认为成功
}
```

即使修了 sessionWebhook 和 senderStaffId 问题，如果 `sendMarkdownMessage` API 本身失败（权限不足等），错误同样被静默吞掉。直接路径（dispatcher → adapter）和 SQS 回复路径都有此问题。

### 修复方案

**改动 1**: sessionWebhook 仅用于群聊回复，DM 直接走 API 路径。

```typescript
// adapters/dingtalk/index.ts — sendReply()
// 仅在群聊场景使用 sessionWebhook
if (isGroup && ctx.dingtalkSessionWebhook) {
  try {
    await sendViaSessionWebhook(ctx.dingtalkSessionWebhook, chunk);
    continue;
  } catch (err) {
    // Fall through to API
  }
}
```

**改动 2**: `sendViaSessionWebhook` 检查响应体 errcode。

```typescript
// adapters/dingtalk/index.ts — sendViaSessionWebhook()
const body = await resp.json() as { errcode?: number; errmsg?: string };
if (body.errcode && body.errcode !== 0) {
  throw new Error(`Session webhook errcode ${body.errcode}: ${body.errmsg}`);
}
```

**改动 3**: 修复 senderStaffId fallback — 缺失时抛错而非用错误 ID。

```typescript
// adapters/dingtalk/index.ts — sendReply() DM 路径
if (!ctx.dingtalkSenderStaffId) {
  this.logger.error(
    { botId: ctx.botId, groupJid: ctx.groupJid },
    'Missing dingtalkSenderStaffId for DM reply, cannot send',
  );
  return;
}
await sendMarkdownMessage(token, [ctx.dingtalkSenderStaffId], 'Reply', chunk, robotCode);
```

**改动 4**: `sendChannelReply` 中记录回复投递失败状态。

```typescript
// sqs/dispatcher.ts — sendChannelReply() catch 块
} catch (err) {
  logger.error({ err, botId, groupJid, channelType }, 'Failed to send channel reply');
  // 标记消息投递失败，写入 DynamoDB 供 Web Console 展示
  await markReplyFailed(botId, groupJid, messageId, (err as Error).message).catch(() => {});
}
```

> **注意**: `markReplyFailed` 是新增的 DynamoDB helper，在消息记录上设置 `deliveryStatus: 'failed'`。这样用户在 Web Console 中能看到投递失败的消息，便于排查。此为可选增强，不阻塞核心修复。

### 错误格式差异

两类 DingTalk API 的错误格式不同，需分开处理：

| API 类型 | 域名 | 成功响应 | 失败响应 |
|---------|------|---------|---------|
| **sessionWebhook** | `oapi.dingtalk.com` | `{"errcode": 0, "errmsg": "ok"}` | `{"errcode": 310000, "errmsg": "..."}` (HTTP 200) |
| **v1.0 REST API** | `api.dingtalk.com` | `{"processQueryKey": "..."}` | HTTP 非 200 状态码 |

因此：`sendViaSessionWebhook` 需要检查 `errcode`；v1.0 API 函数维持现有 HTTP 状态码检查即可。不使用统一的 `assertDingTalkResponse`。

### 影响文件

| 文件 | 改动 |
|------|------|
| `control-plane/src/adapters/dingtalk/index.ts` | sessionWebhook 仅群聊、检查 errcode、修复 senderStaffId fallback |
| `control-plane/src/sqs/dispatcher.ts` | sendChannelReply catch 块记录投递失败（可选增强） |

---

## 修复 2: 文件与富媒体消息支持

### 现状

| 方向 | 现状 | 目标 |
|------|------|------|
| 出站(发送文件) | Stub — 仅发文件名文本 | 上传 → mediaId → 发送 |
| 入站(接收媒体) | 跳过所有非 text 类型 | 下载 → S3 → Agent 上下文 |

### 出站: 文件发送

#### 新增 API 函数 (`channels/dingtalk.ts`)

**1) `uploadMedia`** — 上传文件获取 mediaId

```typescript
export async function uploadMedia(
  accessToken: string,
  robotCode: string,
  file: Buffer,
  fileName: string,
  mediaType: 'image' | 'file' | 'audio' | 'video',
): Promise<string> // 返回 mediaId
```

- 端点: `POST https://api.dingtalk.com/v1.0/robot/messageFiles/upload`
- Content-Type: `multipart/form-data`
- 参数: `robotCode`, `mediaType`, `file` (binary)
- 返回: `{ mediaId: "..." }`

**2) `sendMediaMessage`** — 用 mediaId 发送媒体消息

```typescript
export async function sendMediaMessage(
  accessToken: string,
  target: { userIds?: string[]; openConversationId?: string },
  mediaId: string,
  msgKey: 'sampleFile' | 'sampleImageMsg' | 'sampleAudio' | 'sampleVideo',
  robotCode: string,
): Promise<void>
```

- 私聊: `POST /v1.0/robot/oToMessages/batchSend` + `userIds`
- 群聊: `POST /v1.0/robot/groupMessages/send` + `openConversationId`
- `msgParam`: `JSON.stringify({ mediaId })` (sampleFile/sampleAudio/sampleVideo) 或 `JSON.stringify({ photoURL: mediaId })` (sampleImageMsg)

#### 更新 Adapter (`adapters/dingtalk/index.ts`)

替换 stub `sendFile()`:

```typescript
async sendFile(ctx, file, fileName, mimeType, caption?) {
  // 1. 加载凭证 + 获取 token
  // 2. 判断类型: image / file / audio / video
  const mediaType = mimeType.startsWith('image/') ? 'image'
    : mimeType.startsWith('audio/') ? 'audio'
    : mimeType.startsWith('video/') ? 'video'
    : 'file';
  const msgKey = mediaType === 'image' ? 'sampleImageMsg'
    : mediaType === 'audio' ? 'sampleAudio'
    : mediaType === 'video' ? 'sampleVideo'
    : 'sampleFile';
  // 3. uploadMedia → mediaId
  // 4. sendMediaMessage(target, mediaId, msgKey)
  // 5. 如有 caption，单独发 sendReply(ctx, caption)
}
```

### 入站: 接收富媒体消息

#### 更新 Message Handler (`dingtalk/message-handler.ts`)

当前 `line 136` 跳过所有非 text：
```typescript
if (data.msgtype !== 'text') { return; }  // ← 移除这个
```

替换为按类型处理：

```typescript
let content = '';
const attachments: Attachment[] = [];

switch (data.msgtype) {
  case 'text':
    content = data.text?.content || '';
    break;
  case 'richText':
    content = extractRichText(data);  // 提取纯文本
    break;
  case 'picture':
  case 'file':
  case 'audio':
  case 'video':
    // DingTalk Stream 消息中包含 downloadCode
    // 通过 POST /v1.0/robot/messageFiles/download 下载
    // 存储到 S3: {userId}/{botId}/attachments/{messageId}/{filename}
    // 完整下载流水线已实现（Phase 2 complete）
    content = `[${data.msgtype} attachment]`;
    break;
}
```

#### 入站媒体实现状态

DingTalk 的媒体下载 API (`/v1.0/robot/messageFiles/download`) 需要 `downloadCode` 和 `robotCode`。

**Phase 1**：识别非 text 消息类型，生成文本占位符（如 `[image attachment]`、`[file: report.pdf]`），让 Agent 至少知道用户发了什么类型的内容。已完成。

**Phase 2**：参照飞书的附件处理模式（`feishu/message-handler.ts:262-306`），实现完整的下载流水线：下载媒体 → `storeFromBuffer()` 存 S3 → 在 `SqsInboundPayload.attachments` 中传递元数据。已完成。

### 影响文件

| 文件 | 改动 |
|------|------|
| `control-plane/src/channels/dingtalk.ts` | 新增 `uploadMedia()`, `sendMediaMessage()` |
| `control-plane/src/adapters/dingtalk/index.ts` | 重写 `sendFile()` |
| `control-plane/src/dingtalk/message-handler.ts` | 处理 picture/file/audio/video/richText |

---

## 修复 3: 架构对齐 — Leader 选举移至 Adapter 层

### 根因

当前架构不一致：

```
Discord:  Adapter 内含 leader → 无独立 Gateway → 无 addBot
Feishu:   Adapter 内含 leader → Gateway 无 leader → addBot 无 leader 检查 ✓
DingTalk: Adapter 无 leader  → Gateway 内含 leader → addBot 有 leader 检查 ✗
```

### 目标架构

DingTalk 对齐 Feishu 模式：

```
DingTalk: Adapter 内含 leader → Gateway 无 leader → addBot 无 leader 检查 ✓
```

### 具体改动

#### A) `DingTalkGatewayManager` — 移除 Leader 选举

从 `dingtalk/gateway-manager.ts` 中移除：
- `isLeader` 字段
- `tryAcquireLock()`, `renewLock()`, `releaseLock()`, `isLockExpired()` 方法
- `startRenewLoop()`, `startStandbyPoll()`, `becomeLeader()` 方法
- DynamoDB client (`ddb`) 和 leader 常量 (`LOCK_TABLE`, `LOCK_PK`, `LOCK_SK`, etc.)

简化后的 `start()`:

```typescript
async start(): Promise<void> {
  this.stopped = false;
  const channels = await this.discoverDingTalkChannels();
  if (channels.length === 0) {
    this.logger.info('No DingTalk channels configured, gateway idle');
    return;
  }
  for (const ch of channels) {
    try {
      await this.connectBot(ch);
    } catch (err) {
      this.logger.error({ err, botId: ch.botId }, 'Failed to start DingTalk stream client');
    }
  }
}
```

简化后的 `addBot()`:

```typescript
async addBot(botId: string): Promise<void> {
  if (this.stopped) return;  // ← 仅检查 stopped，与飞书一致
  if (this.connections.has(botId)) {
    this.logger.info({ botId }, 'DingTalk bot already connected, skipping');
    return;
  }
  // ... discover + connectBot (不变)
}
```

保留的方法：
- `start()` (简化)
- `stopAll()`
- `addBot()` (移除 isLeader 检查)
- `removeBot()`
- `connectBot()` (不变)
- `discoverDingTalkChannels()` (不变)
- `loadCredentials()` (不变)

#### B) `DingTalkAdapter` — 添加 Leader 选举

在 `adapters/dingtalk/index.ts` 中，参照 `adapters/feishu/index.ts` 的模式添加：

```typescript
export class DingTalkAdapter extends BaseChannelAdapter {
  readonly channelType = 'dingtalk';
  private gateway: DingTalkGatewayManager | null = null;

  // --- 新增: Leader 选举字段 ---
  private isLeader = false;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private initialPollTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  async start(): Promise<void> {
    this.stopped = false;
    // 1. 初始化 gateway singleton
    this.gateway = initDingTalkGatewayManager(this.logger);
    // 2. Leader 选举
    const acquired = await this.tryAcquireLock();
    if (acquired) {
      await this.becomeLeader();
    } else {
      this.logger.info('DingTalk: another instance is leader, entering standby');
      this.startStandbyPoll();
    }
  }

  private async becomeLeader(): Promise<void> {
    this.isLeader = true;
    this.logger.info('DingTalk: became leader, starting gateway connections');
    try {
      await this.gateway!.start();
    } catch (err) {
      this.logger.error(err, 'Failed to start DingTalk gateway');
      this.isLeader = false;
      await this.releaseLock();
      return;
    }
    this.startRenewLoop();
  }

  // Leader 选举方法 — 从 adapters/feishu/index.ts:192-332 复制，改动：
  // - LOCK_SK: 'dingtalk-gateway-leader' (保持与现有值一致)
  // - RENEW_INTERVAL_MS: 15_000 (与飞书一致)
  // - POLL_INTERVAL_MS: 15_000 (与飞书一致)
  //
  // 需要复制的 6 个方法:
  //   tryAcquireLock(), renewLock(), releaseLock(), isLockExpired()
  //   startRenewLoop(), startStandbyPoll()
  //
  // 注意: BaseChannelAdapter 没有内置 leader 选举支持，
  // 当前项目中每个 Gateway 渠道的 Adapter 独立实现（copy-paste 模式）。
  // 未来可抽取为 LeaderElectionMixin，但不在本次范围内。
}
```

#### C) 消息去重保证

DingTalk Stream 模式下，同一 bot 如果多个 DWClient 连接同一个 clientId，会收到重复消息。Leader 选举确保**只有一个实例**运行 `gateway.start()`，避免重复。

但 `addBot()` 在非 Leader 实例上也能被调用（新 Channel 创建时），这不会导致重复，因为：
- 非 Leader 实例的 gateway 从未调用 `start()`
- `addBot()` 只添加单个新 bot 的连接
- Leader 实例在 standby takeover 时会重新发现所有 channels

> **关键**: 与 Feishu 不同，DingTalk Stream 可能对多实例连接同一 bot 产生重复消息。Leader 选举在 Adapter 层保证只有 Leader 调用 `gateway.start()`。Gateway 本身无 leader 感知，`addBot()` 对所有调用者一视同仁（与 Feishu 一致）。即使非 Leader 实例创建了个别连接，SQS FIFO deduplication (`MessageDeduplicationId = messageId`) 提供最终去重保障。

### 影响文件

| 文件 | 改动 |
|------|------|
| `control-plane/src/dingtalk/gateway-manager.ts` | 移除 leader 选举代码，简化为纯连接管理 |
| `control-plane/src/adapters/dingtalk/index.ts` | 添加 leader 选举（从 gateway 迁移），对齐 Feishu Adapter |

---

## 额外改进

### 日志增强

在关键路径添加 debug/info 日志：

1. `gateway-manager.ts addBot()` — 记录为什么跳过（stopped）
2. `adapters/dingtalk/index.ts sendReply()` — 记录走了哪条路径（webhook vs API）及结果
3. `message-handler.ts` — 记录非 text 消息的类型，便于排查

### 响应体错误检查

两类 API 分开处理（参见修复 1 的"错误格式差异"表格）：

- **sessionWebhook**（`oapi.dingtalk.com`）：在 `sendViaSessionWebhook` 中解析 JSON body 检查 `errcode`
- **v1.0 REST API**（`api.dingtalk.com`）：维持现有 HTTP 状态码检查，不额外解析 body

不引入统一的 `assertDingTalkResponse` 工具函数，因为两类 API 的错误格式不兼容。

---

## 实现顺序

1. **修复 1 (DM 回复)** — 最高优先级，影响所有非创建者用户的核心体验，改动最小最安全
2. **修复 3 (架构对齐)** — 解决多机器人问题，需要迁移代码，为文件功能提供稳定基础
3. **修复 2 (文件/富媒体)** — 功能增强，改动量最大

## 测试计划

### 修复 1: DM 回复
- [ ] 创建者私聊 → 收到回复 (回归)
- [ ] 非创建者私聊 → 收到回复 (核心修复验证)
- [ ] 群聊 @Bot → 收到回复，走 sessionWebhook 快速路径 (回归)
- [ ] 群聊 sessionWebhook 过期 → 自动降级到 API 路径 (回归)
- [ ] dingtalkSenderStaffId 缺失 → 日志报错，不发送错误 ID (修复验证)

### 修复 2: 文件/富媒体
- [ ] 发送文件到私聊用户 → 用户收到文件 (新功能)
- [ ] 发送图片到群聊 → 群内用户收到图片 (新功能)
- [ ] 用户发送图片给 Bot → 下载到 S3，Agent 收到附件元数据 (Phase 2 已实现)
- [ ] 用户发送文件给 Bot → 下载到 S3，Agent 收到附件元数据 (Phase 2 已实现)

### 修复 3: 架构对齐
- [ ] 单实例创建新 DingTalk 机器人 → Stream 连接建立 (修复验证)
- [ ] 删除 DingTalk 机器人 → Stream 连接断开 (回归)
- [ ] 多 ECS 实例 → 仅 Leader 实例建立 Stream 连接 (架构验证)
- [ ] Leader 实例重启 → Standby 接管并重新发现所有 Channel (架构验证)
- [ ] 飞书功能不受影响 → 飞书私聊/群聊正常收发 (跨渠道回归)
