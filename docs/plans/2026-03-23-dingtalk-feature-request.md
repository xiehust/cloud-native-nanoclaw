# Feature Request: 企业钉钉频道接入

## 概述

为 NanoClaw on Cloud 平台新增**企业钉钉（DingTalk）**频道支持，使用户可以在钉钉群聊或私聊中与 AI Bot 交互。这是继 Telegram、Discord、Slack、飞书之后的第五个 IM 频道集成。

## 动机

- 钉钉是国内企业使用最广泛的 IM 平台之一，拥有超过 6 亿用户
- 当前平台已支持飞书（国内）和 Slack/Discord/Telegram（国际），钉钉是国内市场的关键缺口
- 钉钉提供 Stream 模式（WebSocket 长连接），与飞书的 WSClient 架构高度类似，可复用现有的 Gateway + Leader Election 模式

## 需求描述

### 用户故事

1. **作为管理员**，我希望在 Web 控制台的「Add Channel」页面看到钉钉选项，并通过填入 ClientId 和 ClientSecret 完成接入
2. **作为钉钉用户**，我希望在群聊中 @Bot 或私聊 Bot 时，Bot 能够使用 Claude 回复
3. **作为钉钉用户**，我希望 Bot 支持接收和发送图片、文件等富媒体消息

### 功能范围

| 功能 | 优先级 | 说明 |
|------|--------|------|
| Stream 模式连接 | P0 | 使用 `dingtalk-stream` SDK 建立 WebSocket 长连接 |
| 文本消息收发 | P0 | 群聊 @Bot 触发、私聊直接触发 |
| Markdown 消息回复 | P0 | 钉钉支持 Markdown 格式卡片消息 |
| Web 控制台配置 | P0 | ChannelSetup 页面新增钉钉选项及配置引导 |
| 凭证验证 | P0 | 创建频道时验证 ClientId/ClientSecret 有效性 |
| Leader Election | P0 | 多 ECS 实例下单一 Gateway 连接（复用飞书模式） |
| 图片/文件收发 | P1 | MediaId 机制下载和上传附件 |
| 互动卡片消息 | P2 | 使用钉钉 Interactive Card 格式回复 |

### 不在范围内

- 钉钉审批流、日程等非消息类集成
- 钉钉 Webhook（Outgoing）模式（仅实现 Stream 模式）
- 钉钉小程序集成

## 技术方案

### 接入模式选择

选择 **Stream 模式**（WebSocket 长连接），而非 HTTP Webhook，理由：
- 无需公网 IP 或域名暴露（零公网 IP 部署）
- 无需签名验证（SDK 自动处理身份认证）
- 无需防火墙配置（仅需出站网络访问）
- 与飞书 WSClient 模式架构一致，可复用 Gateway Manager + Leader Election 模式

### 所需凭证

| 字段 | 说明 | 示例 |
|------|------|------|
| `clientId` | 钉钉应用 AppKey | `dingxxxxxxxxxx` |
| `clientSecret` | 钉钉应用 AppSecret | `vlDWox885jM...` |

### 消息流转

```
钉钉用户 @Bot 发消息
  ↓
DingTalk Stream (WebSocket)
  ↓
ECS Fargate (Control Plane) — Gateway Manager
  ↓ parse + store DynamoDB
SQS FIFO
  ↓
SQS Consumer → AgentCore (Claude Agent SDK)
  ↓
Reply → SQS Reply Queue → DingTalk API → 钉钉用户收到回复
```

### 需要修改的文件

**共享层**
- `shared/src/types.ts` — ChannelType 联合类型新增 `'dingtalk'`

**控制平面**
- `control-plane/src/channels/dingtalk.ts` — 新建：钉钉 API 客户端
- `control-plane/src/channels/index.ts` — 注册钉钉凭证验证和消息发送
- `control-plane/src/dingtalk/gateway-manager.ts` — 新建：Stream Gateway 生命周期管理
- `control-plane/src/dingtalk/message-handler.ts` — 新建：消息解析
- `control-plane/src/adapters/dingtalk/index.ts` — 新建：频道适配器
- `control-plane/src/routes/api/channels.ts` — Schema 新增 `'dingtalk'`
- `control-plane/src/index.ts` — 注册适配器

**Web 控制台**
- `web-console/src/pages/ChannelSetup.tsx` — 新增钉钉配置界面和引导
- `web-console/src/locales/en.json` — 英文 i18n
- `web-console/src/locales/zh.json` — 中文 i18n

**Agent 运行时**
- `agent-runtime/src/system-prompt.ts` — 新增钉钉频道格式化指引

### 依赖

- npm: `dingtalk-stream` (v2.1.6+)

## 验收标准

- [ ] Web 控制台可选择钉钉频道并填入 ClientId + ClientSecret
- [ ] 凭证验证通过后自动建立 Stream 连接
- [ ] 钉钉群聊中 @Bot 发送消息，Bot 通过 Claude 回复
- [ ] 钉钉私聊中直接发送消息，Bot 通过 Claude 回复
- [ ] 回复使用 Markdown 卡片格式
- [ ] 多 ECS 实例下仅一个实例持有 Gateway 连接（Leader Election）
- [ ] Bot 可接收和发送图片/文件附件
- [ ] i18n 支持中英文

## 参考

- [钉钉 Stream 模式文档](https://opensource.dingtalk.com/developerpedia/docs/learn/stream/overview/)
- [dingtalk-stream Node.js SDK](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs)
- [钉钉开放平台](https://open.dingtalk.com)
