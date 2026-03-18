# 飞书 (Feishu/Lark) 集成架构设计

**日期**: 2026-03-18
**状态**: Approved

---

## 1. 背景与目标

ClawBot Cloud 当前支持 Telegram、Discord、Slack、WhatsApp 四个消息频道。飞书（Feishu/Lark）是国内企业通讯的主流平台，集成飞书将扩展 ClawBot Cloud 在中国市场的覆盖。

参考 OpenClaw `openclaw/extensions/feishu` 插件的设计（v2026.3.14），本设计文档规划两个方面的集成：

1. **飞书 Channel** — 作为新的消息频道，接收飞书消息并回复
2. **飞书 Skills** — 将飞书文档/云盘/知识库/权限管理能力作为 MCP 工具暴露给 Agent

### 1.1 OpenClaw 飞书插件能力概览

| 能力 | 说明 |
|------|------|
| Channel | 支持 WebSocket + Webhook 双模式、私聊/群聊、@提及触发、话题线程、卡片消息、Typing 指示器 |
| feishu_doc | 飞书文档 CRUD — 读取/写入/追加/创建文档、表格操作、图片上传 |
| feishu_drive | 云盘操作 — 列目录/创建文件夹/移动/删除文件 |
| feishu_wiki | 知识库操作 — 空间列表/节点浏览/创建/移动/重命名 |
| feishu_perm | 权限管理 — 查看/授予/撤销文档协作者权限 |
| feishu_bitable | 多维表格操作（高级数据功能） |
| feishu_chat | 群成员/联系人查找 |

---

## 2. 飞书 Channel 集成

### 2.1 架构决策

| 决策项 | 选择 | 原因 |
|--------|------|------|
| 连接模式 | **Webhook 模式** (首选) | 与 Telegram/Slack 一致的无状态架构，Fargate 多副本无需 Leader 选举 |
| SDK 选择 | `@larksuiteoapi/node-sdk` | OpenClaw 已验证，官方维护，覆盖所有飞书 API |
| 消息格式 | 卡片消息 (Interactive Card) | 比纯文本更好的 Markdown 渲染和交互能力 |
| 回退方案 | 纯文本消息 | 卡片失败时降级为 text 消息 |
| 签名验证 | SHA256(timestamp + nonce + encryptKey + body) | 飞书官方标准验证方式 |

> **WebSocket 模式说明：** OpenClaw 支持 WebSocket 作为默认模式（更低延迟、无需公网 Webhook）。未来可考虑参照 Discord Gateway + Leader 选举模式支持 WebSocket，但初期采用 Webhook 模式以保持架构一致性。

### 2.2 凭证与配置

飞书应用需要用户在[飞书开放平台](https://open.feishu.cn)创建自建应用，获取以下凭证：

```typescript
// Secrets Manager: nanoclawbot/{stage}/{botId}/feishu
interface FeishuCredentials {
  appId: string;           // 飞书应用 App ID
  appSecret: string;       // 飞书应用 App Secret
  encryptKey: string;      // 事件加密密钥 (Webhook 签名验证)
  verificationToken: string; // 事件验证令牌
  // 验证后填入:
  botOpenId?: string;      // 机器人 open_id (ou_xxx)
  botName?: string;        // 机器人名称
}
```

**域名支持：** 飞书 (feishu.cn) 和 Lark (larksuite.com) 使用不同 API 域名，通过 `config.domain` 配置：
- `"feishu"` → `open.feishu.cn` (中国区)
- `"lark"` → `open.larksuite.com` (国际版)

### 2.3 消息流 — 入站

```
飞书用户发送消息
    │
    ▼
飞书服务器 POST → ALB → /webhook/feishu/{botId}
    │
    ▼
Fargate Control Plane (feishu webhook handler):
    │
    ├── 1. 加载 Bot 配置 (缓存 → DynamoDB)
    ├── 2. 加载飞书凭证 (缓存 → Secrets Manager)
    ├── 3. 签名验证
    │      ├── 取 headers: x-lark-request-timestamp, x-lark-request-nonce, x-lark-signature
    │      ├── 计算: sha256(timestamp + nonce + encryptKey + JSON.stringify(body))
    │      └── 常量时间比较签名
    │
    ├── 4. 事件类型路由
    │      ├── url_verification → 返回 challenge (首次注册 Webhook 时)
    │      ├── im.message.receive_v1 → 消息处理流程
    │      └── 其他事件 → 忽略 (返回 200)
    │
    ├── 5. 解析消息
    │      ├── 提取: message_id, chat_id, chat_type (p2p/group), sender open_id
    │      ├── 解析消息内容: text / rich_text / image / file / audio
    │      ├── 检测 @bot 提及 (<at user_id="bot_open_id">)
    │      └── 群聊: 需 @bot 触发 (requireMention = true)
    │
    ├── 6. 下载附件 (图片/文件/音频)
    │      ├── 通过飞书 im.message.resources API 下载
    │      └── 上传到 S3: {userId}/{botId}/attachments/{messageId}/{filename}
    │
    ├── 7. 群组管理 (同现有逻辑)
    │      ├── groupJid = feishu#{chat_id}
    │      ├── 检查群组配额
    │      └── 创建/获取 Group (DynamoDB)
    │
    ├── 8. 存储 Message (DynamoDB, TTL 90 天)
    │
    └── 9. 入队 SQS FIFO
           ├── MessageGroupId: {botId}#feishu#{chat_id}
           └── MessageDeduplicationId: {message_id}
```

### 2.4 消息流 — 出站 (Agent 回复)

```
Agent MCP send_message() → SQS Reply Queue
    │
    ▼
Reply Consumer → AdapterRegistry.get("feishu")
    │
    ▼
FeishuAdapter.sendReply(ctx, text):
    │
    ├── 1. 加载 Bot 的飞书 Channel 凭证
    ├── 2. 创建/获取 Lark Client (按 appId 缓存)
    │
    ├── 3. 发送消息
    │      ├── 优先: 卡片消息 (Interactive Card)
    │      │   └── Markdown 内容包装在 card template 中
    │      │       schema 2.0, 支持 header + markdown body
    │      ├── 回退: 纯文本消息 (如卡片失败)
    │      │
    │      ├── 长文本分块 (max 4000 chars/chunk)
    │      │   └── Markdown 感知分割 (不在代码块中间截断)
    │      │
    │      ├── 私聊: client.im.message.create({ receive_id: chat_id })
    │      ├── 群聊回复: client.im.message.reply({ message_id: original_msg_id })
    │      └── 话题回复: reply_in_thread: true
    │
    └── 4. 错误处理
           ├── 429/限频 → 退避重试
           ├── 401/403 → 标记 Channel unhealthy
           └── 消息已撤回 → 降级为新消息发送
```

### 2.5 签名验证

```typescript
// control-plane/src/webhooks/signature.ts — 新增
export function verifyFeishuSignature(
  timestamp: string,
  nonce: string,
  encryptKey: string,
  body: string,
  signature: string,
): boolean {
  const content = timestamp + nonce + encryptKey + body;
  const hash = createHash('sha256').update(content).digest('hex');
  return timingSafeEqual(
    Buffer.from(hash, 'utf8'),
    Buffer.from(signature, 'utf8'),
  );
}
```

### 2.6 Channel 类型对比 (扩展 8.2)

| | Telegram | Discord | Slack | WhatsApp | **Feishu** |
|---|---|---|---|---|---|
| 认证方式 | Bot Token | Bot Token + Public Key | Bot Token + Signing Secret | Access Token + App Secret | **App ID + App Secret + Encrypt Key** |
| Webhook 注册 | setWebhook API | Application Portal | Events API URL | Meta Business API | **开放平台事件订阅** |
| 消息格式 | Update JSON | Interaction JSON | Event JSON | Webhook JSON | **Event v2.0 JSON** |
| 签名验证 | secret_token header | Ed25519 签名 | HMAC-SHA256 | HMAC-SHA256 | **SHA256(ts+nonce+key+body)** |
| 群组支持 | 是 | 是 (Guild) | 是 (Channel) | 是 | **是 (群组 + 话题)** |
| 回复方式 | sendMessage API | REST API | chat.postMessage | messages API | **im.message.create/reply** |
| 特殊能力 | — | Gateway WebSocket | — | — | **卡片消息、话题线程** |
| 接入难度 | 低 | 中 | 中 | 高 | **中** |

### 2.7 群聊会话作用域

飞书支持群组话题 (Topic Thread)，需要灵活的会话隔离策略：

```
groupSessionScope 选项:
├── "group"                → 同一群组共享一个 Agent 会话
├── "group_sender"         → 群组内按发送者隔离
├── "group_topic"          → 按话题线程隔离 (推荐)
└── "group_topic_sender"   → 话题 + 发送者双重隔离
```

**初期实现：** 使用 `"group"` 模式（与现有 Telegram/Slack 一致），`groupJid = feishu#{chat_id}`。话题支持作为后续增强。

### 2.8 Typing 指示器

OpenClaw 使用飞书 Reaction API 的 `Typing` emoji 实现打字指示器：

```
Agent 开始处理 → 给用户消息添加 "Typing" reaction
Agent 回复完成 → 移除 "Typing" reaction
```

**初期实现：** 暂不实现。后续可通过 `im.message.reaction.create/delete` API 添加。

---

## 3. 飞书 Skills (MCP 工具) 集成

### 3.1 架构决策

| 决策项 | 选择 | 原因 |
|--------|------|------|
| 工具注册位置 | agent-runtime MCP Server | 与现有 send_message/schedule_task 工具同层 |
| 凭证传递 | SQS Payload 携带飞书凭证引用 → Agent Runtime 从 Secrets Manager 加载 | 保持 ABAC 安全模型 |
| 工具启用 | 按 Bot 配置，默认只启用 doc + wiki | 避免过度暴露能力，perm 工具默认禁用 |
| Lark SDK | agent-runtime 新增 `@larksuiteoapi/node-sdk` 依赖 | 统一使用官方 SDK |

### 3.2 工具清单

#### 3.2.1 `feishu_doc` — 文档操作

单一工具，通过 `action` 参数路由到不同操作：

| Action | 说明 | 权限要求 |
|--------|------|---------|
| `read` | 读取文档文本内容 + 块统计 | docs:doc:readonly |
| `write` | 覆写整个文档内容 (Markdown) | docs:doc |
| `append` | 追加 Markdown 到文档末尾 | docs:doc |
| `create` | 创建新文档 (可指定文件夹) | docs:doc |
| `list_blocks` | 获取文档完整块结构 | docs:doc:readonly |
| `get_block` | 获取单个块内容 | docs:doc:readonly |
| `update_block` | 更新块文本 | docs:doc |
| `delete_block` | 删除块 | docs:doc |
| `create_table` | 创建文档表格 | docs:doc |
| `write_table_cells` | 写入表格单元格 | docs:doc |
| `upload_image` | 上传图片到文档 | docs:doc + drive:drive |

**关键实现：**
- 文档 Token 从 URL 自动提取: `https://xxx.feishu.cn/docx/ABC123` → `token = ABC123`
- Markdown → 飞书文档块的转换
- 表格使用飞书原生 Table Block（不支持 Markdown 表格语法）

#### 3.2.2 `feishu_wiki` — 知识库操作

| Action | 说明 |
|--------|------|
| `spaces` | 列出可访问的知识库空间 |
| `nodes` | 列出空间/父节点下的子节点 |
| `get` | 获取节点详情 → 返回 obj_token 用于文档编辑 |
| `create` | 创建新节点 (docx/sheet/bitable) |
| `move` | 移动节点 |
| `rename` | 重命名节点 |

**工作流：** `feishu_wiki.get(node)` → 获得 `obj_token` → `feishu_doc.read(obj_token)` 读取内容

#### 3.2.3 `feishu_drive` — 云盘操作

| Action | 说明 |
|--------|------|
| `list` | 列出文件夹内容 (根目录或指定 folder_token) |
| `info` | 获取文件/文件夹元数据 |
| `create_folder` | 创建文件夹 |
| `move` | 移动文件 |
| `delete` | 删除文件 |

**注意：** Bot 没有 "我的空间" 根目录，只能在共享文件夹中操作。

#### 3.2.4 `feishu_perm` — 权限管理 (默认禁用)

| Action | 说明 |
|--------|------|
| `list` | 列出文档协作者 |
| `add` | 授予权限 (view/edit/full_access) |
| `remove` | 撤销权限 |

**安全注意：** 权限操作敏感，需要用户显式启用。支持按 email/openid/userid 等类型指定对象。

#### 3.2.5 `feishu_bitable` — 多维表格 (后续)

多维表格的 CRUD 操作，适合数据管理场景。作为后续增强实现。

### 3.3 MCP 工具注册架构

```
agent-runtime/src/
├── mcp-tools.ts                    # 现有 MCP 工具 (send_message, schedule_task 等)
├── feishu-tools/                   # 新增: 飞书工具模块
│   ├── index.ts                    # 工具注册入口
│   ├── client.ts                   # Lark SDK 客户端管理 (按 appId 缓存)
│   ├── doc-tool.ts                 # feishu_doc 工具实现
│   ├── wiki-tool.ts                # feishu_wiki 工具实现
│   ├── drive-tool.ts               # feishu_drive 工具实现
│   └── perm-tool.ts                # feishu_perm 工具实现
└── ...
```

**工具注册流程：**

```typescript
// agent-runtime/src/feishu-tools/index.ts
export function registerFeishuTools(
  server: McpServer,
  feishuCredentials: FeishuCredentials | null,
  enabledTools: { doc: boolean; wiki: boolean; drive: boolean; perm: boolean },
) {
  if (!feishuCredentials) return; // Bot 未配置飞书 Channel 则跳过

  const client = getOrCreateLarkClient(feishuCredentials);

  if (enabledTools.doc)  registerDocTool(server, client);
  if (enabledTools.wiki) registerWikiTool(server, client);
  if (enabledTools.drive) registerDriveTool(server, client);
  if (enabledTools.perm) registerPermTool(server, client);
}
```

### 3.4 凭证传递链路

```
Web Console (Bot 配置飞书 Channel)
    │
    ▼
Secrets Manager: nanoclawbot/{stage}/{botId}/feishu
    │
    ▼
SQS FIFO Message Payload (入站消息):
    {
      ...
      channelType: "feishu",
      feishuConfig: {
        enabledTools: { doc: true, wiki: true, drive: false, perm: false },
        domain: "feishu"
      }
    }
    │
    ▼
SQS Consumer → AgentCore Invocation Payload:
    {
      ...
      feishuCredentialSecretArn: "arn:aws:secretsmanager:...",
      feishuToolConfig: { doc: true, wiki: true, drive: false, perm: false }
    }
    │
    ▼
Agent Runtime:
    1. 从 Secrets Manager 加载飞书凭证 (使用 ABAC scoped credentials)
    2. 创建 Lark Client
    3. 注册启用的 MCP 工具
```

---

## 4. 实现计划

### Phase 1: 飞书 Channel (核心消息收发)

需要创建/修改的文件：

| 文件 | 操作 | 说明 |
|------|------|------|
| `shared/src/types.ts` | 修改 | `ChannelType` 添加 `'feishu'` |
| `control-plane/package.json` | 修改 | 添加 `@larksuiteoapi/node-sdk` 依赖 |
| `control-plane/src/channels/feishu.ts` | 新建 | 飞书 API 客户端 (sendMessage, verifyCredentials, createCard) |
| `control-plane/src/webhooks/feishu.ts` | 新建 | Webhook handler (签名验证、事件路由、消息解析) |
| `control-plane/src/webhooks/signature.ts` | 修改 | 添加 `verifyFeishuSignature()` |
| `control-plane/src/webhooks/index.ts` | 修改 | 注册 `/webhook/feishu` 路由 |
| `control-plane/src/adapters/feishu/index.ts` | 新建 | FeishuAdapter (sendReply, sendFile) |
| `control-plane/src/adapters/registry.ts` | 修改 | 注册 FeishuAdapter |
| `control-plane/src/channels/index.ts` | 修改 | 路由函数添加 feishu case |
| `control-plane/src/routes/api/channels.ts` | 修改 | 飞书凭证验证 + Webhook URL 返回 |
| `control-plane/src/services/health-checker.ts` | 修改 | 添加飞书健康检查 |
| `web-console/src/pages/ChannelSetup.tsx` | 修改 | 添加飞书 Channel 配置 UI + 接入指南 |

### Phase 2: 飞书 Skills (MCP 工具)

| 文件 | 操作 | 说明 |
|------|------|------|
| `agent-runtime/package.json` | 修改 | 添加 `@larksuiteoapi/node-sdk` 依赖 |
| `agent-runtime/src/feishu-tools/index.ts` | 新建 | 工具注册入口 |
| `agent-runtime/src/feishu-tools/client.ts` | 新建 | Lark Client 管理 |
| `agent-runtime/src/feishu-tools/doc-tool.ts` | 新建 | feishu_doc 工具 |
| `agent-runtime/src/feishu-tools/wiki-tool.ts` | 新建 | feishu_wiki 工具 |
| `agent-runtime/src/feishu-tools/drive-tool.ts` | 新建 | feishu_drive 工具 |
| `agent-runtime/src/feishu-tools/perm-tool.ts` | 新建 | feishu_perm 工具 |
| `agent-runtime/src/mcp-tools.ts` | 修改 | 集成飞书工具注册 |
| `control-plane/src/sqs/dispatcher.ts` | 修改 | 传递飞书凭证 ARN + 工具配置到 Agent |

### Phase 3: 增强功能 (后续)

- WebSocket 连接模式 + Leader 选举
- 话题线程会话隔离 (`group_topic` scope)
- Typing 指示器 (Reaction API)
- 飞书卡片交互回调处理
- feishu_bitable 多维表格工具
- feishu_chat 群成员查找工具
- 卡片消息流式更新 (streaming card)

---

## 5. Web Console 飞书接入指南

用户在 ChannelSetup 页面选择 "飞书/Lark" 后，需要展示以下步骤：

### 接入前 (Setup Guide)

```
1. 打开飞书开放平台 → 创建自建应用
2. 获取 App ID 和 App Secret
3. 在「事件与回调」中：
   - 配置请求地址（连接后提供）
   - 获取 Encrypt Key 和 Verification Token
4. 在「权限管理」中申请以下权限：
   - im:message (接收/发送消息)
   - im:message:send_as_bot (以机器人身份发消息)
   - im:resource (获取消息中的图片/文件)
   - [可选] docs:doc / wiki:wiki / drive:drive (文档/知识库/云盘工具)
5. 发布应用版本
```

### 接入后 (Post-Connect Guide)

```
请在飞书开放平台完成以下配置：

1. 事件订阅：
   - 请求地址: https://api.clawbot.com/webhook/feishu/{botId}
   - 订阅事件: im.message.receive_v1

2. 机器人配置：
   - 启用「机器人」能力
   - 添加到目标群组

3. 测试：
   - 在群组中 @机器人 发送消息
   - 或在私聊中直接发送消息
```

### 凭证表单字段

```typescript
feishu: [
  { name: 'appId', label: 'App ID', type: 'text', required: true },
  { name: 'appSecret', label: 'App Secret', type: 'password', required: true },
  { name: 'encryptKey', label: 'Encrypt Key', type: 'password', required: true },
  { name: 'verificationToken', label: 'Verification Token', type: 'password', required: true },
  { name: 'domain', label: '域名', type: 'select', options: ['feishu', 'lark'], default: 'feishu' },
]
```

---

## 6. 安全考量

| 层面 | 措施 |
|------|------|
| Webhook 验证 | SHA256 签名验证 + 常量时间比较，防止伪造事件 |
| 凭证存储 | Secrets Manager 加密存储，ABAC 限制访问范围 |
| 工具权限 | feishu_perm 默认禁用，需用户显式启用；feishu_doc/wiki/drive 按 Bot 配置启用 |
| 飞书 Token | Lark SDK 自动管理 tenant_access_token 续期，不缓存明文 Token |
| 消息去重 | 飞书 message_id 作为 SQS MessageDeduplicationId，防止重复处理 |
| 速率限制 | WAF 现有速率限制适用；飞书 API 限频由 SDK 内部处理退避 |
| 数据隔离 | ABAC 确保 Agent 只能访问所属 Bot 的飞书凭证 |

---

## 7. 验证方案

### Phase 1 验证

1. **凭证验证:** 在 Web Console 输入飞书凭证 → 验证通过 → Channel 状态 `connected`
2. **Webhook 注册:** 飞书开放平台配置回调地址 → Challenge 验证通过
3. **消息入站:** 在飞书群聊 @Bot 发送消息 → Control Plane 收到 Webhook → SQS 入队 → Agent 处理
4. **消息出站:** Agent 回复 → Reply Queue → FeishuAdapter → 飞书卡片消息发送成功
5. **健康检查:** 健康检查循环能检测飞书 Channel → 凭证无效时标记 unhealthy
6. **附件处理:** 发送图片/文件 → 下载到 S3 → Agent 可访问

### Phase 2 验证

1. **feishu_doc:** Agent 调用 `feishu_doc read {url}` → 返回文档内容
2. **feishu_doc write:** Agent 调用 `feishu_doc create` → 新文档出现在飞书
3. **feishu_wiki:** Agent 调用 `feishu_wiki spaces` → 返回知识库列表
4. **feishu_drive:** Agent 调用 `feishu_drive list` → 返回文件列表
5. **跨工具流:** `feishu_wiki get` → `feishu_doc read` → 编辑后 `feishu_doc write` 回去

### 测试

- control-plane: 添加 Vitest 单元测试（签名验证、消息解析、凭证验证逻辑）
- 集成测试: 使用飞书测试企业应用进行端到端测试
