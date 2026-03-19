import { useState } from 'react';
import { useParams, useNavigate, Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, Send, Hash, MessageSquare, Bird,
  CheckCircle2, Clipboard,
} from 'lucide-react';
import { clsx } from 'clsx';
import { channels as channelsApi } from '../lib/api';

type ChannelType = 'telegram' | 'discord' | 'slack' | 'feishu';

interface FieldDef {
  name: string;
  label: string;
  placeholder: string;
  type?: string;
}

const channelFields: Record<ChannelType, FieldDef[]> = {
  telegram: [{ name: 'botToken', label: 'Bot Token', placeholder: '123456:ABC-DEF...' }],
  discord: [
    { name: 'botToken', label: 'Bot Token', placeholder: 'MTk...' },
    { name: 'publicKey', label: 'Public Key', placeholder: 'Ed25519 public key' },
  ],
  slack: [
    { name: 'botToken', label: 'Bot Token', placeholder: 'xoxb-...' },
    { name: 'signingSecret', label: 'Signing Secret', placeholder: '32-character hex string' },
  ],
  feishu: [
    { name: 'appId', label: 'App ID', placeholder: 'cli_xxxxxxxxxxxxxxxx' },
    { name: 'appSecret', label: 'App Secret', placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', type: 'password' },
    { name: 'encryptKey', label: 'Encrypt Key', placeholder: 'Encrypt Key from event subscription settings', type: 'password' },
    { name: 'verificationToken', label: 'Verification Token', placeholder: 'Verification Token from event subscription settings', type: 'password' },
    { name: 'domain', label: 'Domain', placeholder: 'feishu' },
  ],
};

const channelMeta: Record<ChannelType, { icon: React.ReactNode; label: string; desc: string }> = {
  telegram: { icon: <Send size={20} />, label: 'Telegram', desc: 'Webhook-based bot' },
  discord: { icon: <Hash size={20} />, label: 'Discord', desc: 'Gateway + interactions' },
  slack: { icon: <MessageSquare size={20} />, label: 'Slack', desc: 'Events API webhook' },
  feishu: { icon: <Bird size={20} />, label: 'Feishu', desc: 'WebSocket gateway' },
};

/* ── Reusable step number badge ────────────────────────────────────── */

function StepNum({ n, variant = 'guide' }: { n: number; variant?: 'guide' | 'success' }) {
  return (
    <span className={clsx(
      'flex-shrink-0 w-6 h-6 rounded-full text-white text-xs flex items-center justify-center font-bold',
      variant === 'success' ? 'bg-green-600' : 'bg-accent-500',
    )}>
      {n}
    </span>
  );
}

/* ── Reusable copy button ──────────────────────────────────────────── */

function CopyBtn({ text, variant = 'success' }: { text: string; variant?: 'guide' | 'success' }) {
  return (
    <button
      type="button"
      onClick={() => navigator.clipboard.writeText(text)}
      className={clsx(
        'flex-shrink-0 inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-medium text-white transition-colors',
        variant === 'success'
          ? 'bg-green-600 hover:bg-green-700'
          : 'bg-accent-500 hover:bg-accent-600',
      )}
      title="Copy"
    >
      <Clipboard size={13} />
      Copy
    </button>
  );
}

/* ── Slack Guide ───────────────────────────────────────────────────── */

function SlackGuide({ botId, step }: { botId: string; step: 'before' | 'after' }) {
  const webhookUrl = `${window.location.origin}/webhook/slack/${botId}`;

  if (step === 'before') {
    return (
      <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-4 text-sm">
        <h3 className="font-semibold text-slate-900 text-base">Slack App Setup Guide</h3>

        <div className="space-y-3">
          <div className="flex gap-3">
            <StepNum n={1} />
            <div>
              <p className="font-medium text-slate-900">Create a Slack App</p>
              <p className="text-slate-600 mt-0.5">
                Go to <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="underline font-medium text-accent-600 hover:text-accent-700">api.slack.com/apps</a> → <strong>Create New App</strong> → <strong>From scratch</strong> → name it and select your workspace.
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={2} />
            <div>
              <p className="font-medium text-slate-900">Configure Bot Token Scopes</p>
              <p className="text-slate-600 mt-0.5">
                Left menu → <strong>OAuth & Permissions</strong> → scroll to <strong>Bot Token Scopes</strong> → add:
              </p>
              <ul className="mt-1 ml-4 list-disc text-slate-600 space-y-0.5">
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">chat:write</code> — Send messages</li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">channels:history</code> — Read public channel messages</li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">groups:history</code> — Read private channel messages</li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">im:history</code> — Read direct messages</li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">im:read</code> — Access DM conversations</li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">im:write</code> — Send direct messages</li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">files:read</code> — Read file attachments sent by users</li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">files:write</code> — Send file attachments in responses</li>
              </ul>
              <p className="text-slate-500 mt-1 text-xs">The <code className="bg-slate-100 px-1 rounded text-slate-700">files:read</code> and <code className="bg-slate-100 px-1 rounded text-slate-700">files:write</code> scopes are needed for sending and receiving file attachments.</p>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={3} />
            <div>
              <p className="font-medium text-slate-900">Enable Direct Messages (App Home)</p>
              <p className="text-slate-600 mt-0.5">
                Left menu → <strong>App Home</strong> → scroll to <strong>Show Tabs</strong>:
              </p>
              <ul className="mt-1 ml-4 list-disc text-slate-600 space-y-0.5">
                <li>Toggle <strong>Messages Tab</strong> to ON</li>
                <li>Check <strong>"Allow users to send Slash commands and messages from the messages tab"</strong></li>
              </ul>
              <p className="text-slate-500 mt-1 text-xs">This enables users to DM the bot directly.</p>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={4} />
            <div>
              <p className="font-medium text-slate-900">Install App to Workspace</p>
              <p className="text-slate-600 mt-0.5">
                Left menu → <strong>OAuth & Permissions</strong> → click <strong>Install to Workspace</strong> → Authorize.
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={5} />
            <div>
              <p className="font-medium text-slate-900">Copy Bot Token</p>
              <p className="text-slate-600 mt-0.5">
                After installing, copy the <strong>Bot User OAuth Token</strong> (starts with <code className="bg-slate-100 px-1 rounded text-slate-800">xoxb-</code>). Paste it below.
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={6} />
            <div>
              <p className="font-medium text-slate-900">Copy Signing Secret</p>
              <p className="text-slate-600 mt-0.5">
                Left menu → <strong>Basic Information</strong> → scroll to <strong>App Credentials</strong> → click <strong>Show</strong> next to <strong>Signing Secret</strong>. Paste it below.
              </p>
            </div>
          </div>
        </div>

        <div className="border-t border-slate-200 pt-3 mt-3">
          <p className="text-slate-700 font-medium">Fill in both fields below, then click Connect. After connecting, you'll get instructions for the final step (Event Subscriptions).</p>
        </div>
      </div>
    );
  }

  // step === 'after'
  return (
    <div className="border border-green-300 bg-green-50 rounded-xl p-5 space-y-4 text-sm">
      <div className="flex items-center gap-2">
        <CheckCircle2 size={20} className="text-green-600" />
        <h3 className="font-semibold text-green-900 text-base">Slack Channel Connected!</h3>
      </div>

      <p className="text-green-800">Credentials verified and stored. Now complete the final step to receive messages:</p>

      <div className="space-y-3">
        <div className="flex gap-3">
          <StepNum n={7} variant="success" />
          <div>
            <p className="font-medium text-green-900">Enable Event Subscriptions</p>
            <p className="text-green-700 mt-0.5">
              In your Slack App settings → left menu → <strong>Event Subscriptions</strong> → toggle <strong>Enable Events</strong> to ON.
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <StepNum n={8} variant="success" />
          <div>
            <p className="font-medium text-green-900">Set Request URL</p>
            <p className="text-green-700 mt-0.5">Paste this URL into the <strong>Request URL</strong> field:</p>
            <div className="mt-1.5 flex items-center gap-2">
              <code className="flex-1 bg-white border border-green-300 rounded-lg px-3 py-2 text-xs font-mono text-green-900 break-all select-all">
                {webhookUrl}
              </code>
              <CopyBtn text={webhookUrl} variant="success" />
            </div>
            <p className="text-green-600 mt-1 text-xs">Slack will send a verification request — you should see a green checkmark ✓</p>
          </div>
        </div>

        <div className="flex gap-3">
          <StepNum n={9} variant="success" />
          <div>
            <p className="font-medium text-green-900">Subscribe to Bot Events</p>
            <p className="text-green-700 mt-0.5">
              Below the Request URL, expand <strong>Subscribe to bot events</strong> → click <strong>Add Bot User Event</strong> → add:
            </p>
            <ul className="mt-1 ml-4 list-disc text-green-700 space-y-0.5">
              <li><code className="bg-green-100 px-1 rounded">message.channels</code></li>
              <li><code className="bg-green-100 px-1 rounded">message.groups</code></li>
              <li><code className="bg-green-100 px-1 rounded">message.im</code></li>
            </ul>
          </div>
        </div>

        <div className="flex gap-3">
          <StepNum n={10} variant="success" />
          <div>
            <p className="font-medium text-green-900">Save, Reinstall & Invite Bot</p>
            <p className="text-green-700 mt-0.5">
              Click <strong>Save Changes</strong>. Then go to <strong>OAuth & Permissions</strong> → <strong>Reinstall to Workspace</strong> (required after adding scopes or event subscriptions). Finally, invite the bot to a channel: type <code className="bg-green-100 px-1 rounded">/invite @YourBotName</code>
            </p>
          </div>
        </div>
      </div>

      <div className="border-t border-green-200 pt-3 mt-3">
        <p className="text-green-800">Once done, send a message mentioning your bot (e.g., <code className="bg-green-100 px-1 rounded">@BotName hello</code>) and it will respond!</p>
      </div>
    </div>
  );
}

function TelegramGuide() {
  return (
    <div className="border border-slate-200 rounded-xl bg-white p-5 text-sm space-y-3">
      <h3 className="font-semibold text-slate-900">How to get your Telegram Bot Token</h3>
      <ol className="space-y-2.5">
        <li className="flex gap-3">
          <StepNum n={1} />
          <span className="text-slate-600">Open Telegram and message <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="underline font-medium text-accent-600 hover:text-accent-700">@BotFather</a></span>
        </li>
        <li className="flex gap-3">
          <StepNum n={2} />
          <span className="text-slate-600">Send <code className="bg-slate-100 px-1 rounded text-slate-800">/newbot</code> and follow the prompts</span>
        </li>
        <li className="flex gap-3">
          <StepNum n={3} />
          <span className="text-slate-600">Copy the token (looks like <code className="bg-slate-100 px-1 rounded text-slate-800">123456:ABC-DEF...</code>)</span>
        </li>
      </ol>
      <p className="text-slate-500 text-xs mt-2">The webhook will be auto-registered when you connect.</p>
    </div>
  );
}

function DiscordGuide({ botId, step }: { botId: string; step: 'before' | 'after' }) {
  const webhookUrl = `${window.location.origin}/webhook/discord/${botId}`;

  if (step === 'before') {
    return (
      <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-4 text-sm">
        <h3 className="font-semibold text-slate-900 text-base">Discord Bot Setup Guide</h3>

        <div className="space-y-3">
          <div className="flex gap-3">
            <StepNum n={1} />
            <div>
              <p className="font-medium text-slate-900">Create a Discord Application</p>
              <p className="text-slate-600 mt-0.5">
                Go to <a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer" className="underline font-medium text-accent-600 hover:text-accent-700">Discord Developer Portal</a> → <strong>New Application</strong> → give it a name → <strong>Create</strong>.
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={2} />
            <div>
              <p className="font-medium text-slate-900">Get Bot Token</p>
              <p className="text-slate-600 mt-0.5">
                Left menu → <strong>Bot</strong> → click <strong>Reset Token</strong> → copy it immediately (you can only see it once).
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={3} />
            <div>
              <p className="font-medium text-slate-900">Enable Privileged Gateway Intents</p>
              <p className="text-slate-600 mt-0.5">
                On the same <strong>Bot</strong> page, scroll to <strong>Privileged Gateway Intents</strong> and enable:
              </p>
              <ul className="mt-1 ml-4 list-disc text-slate-600 space-y-0.5">
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">Message Content Intent</code> — required to read message text</li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">Server Members Intent</code> — optional, for member display names</li>
              </ul>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={4} />
            <div>
              <p className="font-medium text-slate-900">Get Public Key</p>
              <p className="text-slate-600 mt-0.5">
                Left menu → <strong>General Information</strong> → copy the <strong>Public Key</strong> (64-character hex string).
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={5} />
            <div>
              <p className="font-medium text-slate-900">Invite Bot to Your Server</p>
              <p className="text-slate-600 mt-0.5">
                Left menu → <strong>OAuth2</strong> → <strong>URL Generator</strong>:
              </p>
              <ul className="mt-1 ml-4 list-disc text-slate-600 space-y-0.5">
                <li>Scopes: select <code className="bg-slate-100 px-1 rounded text-slate-800">bot</code> and <code className="bg-slate-100 px-1 rounded text-slate-800">applications.commands</code></li>
                <li>Bot Permissions: select:
                  <ul className="mt-0.5 ml-4 list-[circle] text-slate-600 space-y-0.5">
                    <li><code className="bg-slate-100 px-1 rounded text-slate-800">Send Messages</code></li>
                    <li><code className="bg-slate-100 px-1 rounded text-slate-800">Send Messages in Threads</code></li>
                    <li><code className="bg-slate-100 px-1 rounded text-slate-800">Embed Links</code> — for rich reply formatting</li>
                    <li><code className="bg-slate-100 px-1 rounded text-slate-800">Read Message History</code></li>
                    <li><code className="bg-slate-100 px-1 rounded text-slate-800">View Channels</code></li>
                    <li><code className="bg-slate-100 px-1 rounded text-slate-800">Attach Files</code> — for sending file attachments</li>
                    <li><code className="bg-slate-100 px-1 rounded text-slate-800">Use Slash Commands</code></li>
                  </ul>
                </li>
              </ul>
              <p className="text-slate-600 mt-1">
                Copy the generated URL → open in browser → select your server → <strong>Authorize</strong>.
              </p>
            </div>
          </div>
        </div>

        <div className="border-t border-slate-200 pt-3 mt-3">
          <p className="text-slate-700 font-medium">Fill in both fields below, then click Connect.</p>
        </div>
      </div>
    );
  }

  // step === 'after'
  return (
    <div className="border border-green-300 bg-green-50 rounded-xl p-5 space-y-4 text-sm">
      <div className="flex items-center gap-2">
        <CheckCircle2 size={20} className="text-green-600" />
        <h3 className="font-semibold text-green-900 text-base">Discord Channel Connected!</h3>
      </div>

      <p className="text-green-800">Credentials verified and stored. Complete the remaining steps:</p>

      <div className="space-y-3">
        <div className="flex gap-3">
          <StepNum n={6} variant="success" />
          <div>
            <p className="font-medium text-green-900">Set Interactions Endpoint URL</p>
            <p className="text-green-700 mt-0.5">
              In Discord Developer Portal → your app → <strong>General Information</strong> → paste this into <strong>Interactions Endpoint URL</strong>:
            </p>
            <div className="mt-1.5 flex items-center gap-2">
              <code className="flex-1 bg-white border border-green-300 rounded-lg px-3 py-2 text-xs font-mono text-green-900 break-all select-all">
                {webhookUrl}
              </code>
              <CopyBtn text={webhookUrl} variant="success" />
            </div>
            <p className="text-green-600 mt-1 text-xs">Discord will send a verification ping — you should see a success message.</p>
          </div>
        </div>

        <div className="flex gap-3">
          <StepNum n={7} variant="success" />
          <div>
            <p className="font-medium text-green-900">Private Channel Access (Optional)</p>
            <p className="text-green-700 mt-0.5">
              To use the bot in <strong>private channels</strong>, you must add it explicitly:
            </p>
            <ul className="mt-1 ml-4 list-disc text-green-700 space-y-0.5">
              <li>Open the private channel → click the channel name (gear icon) → <strong>Permissions</strong></li>
              <li>Click <strong>+</strong> to add members/roles → search for your bot name</li>
              <li>Ensure <strong>View Channel</strong>, <strong>Send Messages</strong>, and <strong>Read Message History</strong> are enabled</li>
            </ul>
            <p className="text-green-600 mt-1 text-xs">Public channels work automatically — the bot can see any channel it has access to.</p>
          </div>
        </div>

        <div className="flex gap-3">
          <StepNum n={8} variant="success" />
          <div>
            <p className="font-medium text-green-900">Test in Discord</p>
            <p className="text-green-700 mt-0.5">
              The bot supports multiple interaction methods:
            </p>
            <ul className="mt-1 ml-4 list-disc text-green-700 space-y-0.5">
              <li><strong>@mention</strong> — type <code className="bg-green-100 px-1 rounded">@YourBotName hello</code> in any channel</li>
              <li><strong>Slash commands</strong> — type <code className="bg-green-100 px-1 rounded">/ask</code> to send a private question, <code className="bg-green-100 px-1 rounded">/status</code> for bot info, <code className="bg-green-100 px-1 rounded">/help</code> for usage guide</li>
              <li><strong>Direct messages</strong> — DM the bot directly for private conversations</li>
            </ul>
            <p className="text-green-600 mt-1 text-xs">Replies use rich embeds with response time. Slash command replies are private by default.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function FeishuGuide({ step }: { step: 'before' | 'after' }) {
  if (step === 'before') {
    return (
      <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-4 text-sm">
        <h3 className="font-semibold text-slate-900 text-base">飞书机器人配置指南</h3>

        <div className="space-y-3">
          <div className="flex gap-3">
            <StepNum n={1} />
            <div>
              <p className="font-medium text-slate-900">创建自建应用</p>
              <p className="text-slate-600 mt-0.5">
                打开 <a href="https://open.feishu.cn" target="_blank" rel="noopener noreferrer" className="underline font-medium text-accent-600 hover:text-accent-700">飞书开放平台 (open.feishu.cn)</a> &rarr; <strong>创建自建应用</strong>
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={2} />
            <div>
              <p className="font-medium text-slate-900">获取 App ID 和 App Secret</p>
              <p className="text-slate-600 mt-0.5">
                在应用的 <strong>凭证与基础信息</strong> 页面获取 App ID 和 App Secret
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={3} />
            <div>
              <p className="font-medium text-slate-900">获取 Encrypt Key 和 Verification Token</p>
              <p className="text-slate-600 mt-0.5">
                在「<strong>事件与回调</strong>」中获取 Encrypt Key 和 Verification Token
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={4} />
            <div>
              <p className="font-medium text-slate-900">申请权限</p>
              <p className="text-slate-600 mt-0.5">
                在「<strong>权限管理</strong>」中申请以下权限：
              </p>
              <p className="mt-1 text-slate-500 text-xs">推荐使用「批量开通」导入以下 JSON，或手动逐个申请：</p>
              <details className="mt-2 mb-2">
                <summary className="cursor-pointer text-accent-600 text-xs font-medium hover:text-accent-700">点击展开批量导入 JSON</summary>
                <div className="mt-1.5 relative">
                  <pre className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-800 overflow-x-auto max-h-48 overflow-y-auto font-mono leading-relaxed">{`{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "cardkit:card:read",
      "cardkit:card:write",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "docs:doc",
      "docs:doc:readonly",
      "docx:document",
      "docx:document:readonly",
      "drive:drive",
      "drive:drive:readonly",
      "docs:permission.member:create",
      "event:ip_list",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource",
      "wiki:wiki",
      "wiki:wiki:readonly"
    ],
    "user": [
      "aily:file:read",
      "aily:file:write",
      "im:chat.access_event.bot_p2p_chat:read"
    ]
  }
}`}</pre>
                  <button
                    type="button"
                    onClick={() => navigator.clipboard.writeText(JSON.stringify({"scopes":{"tenant":["aily:file:read","aily:file:write","application:application.app_message_stats.overview:readonly","application:application:self_manage","application:bot.menu:write","cardkit:card:read","cardkit:card:write","contact:user.employee_id:readonly","corehr:file:download","docs:doc","docs:doc:readonly","docx:document","docx:document:readonly","drive:drive","drive:drive:readonly","docs:permission.member:create","event:ip_list","im:chat.access_event.bot_p2p_chat:read","im:chat.members:bot_access","im:message","im:message.group_at_msg:readonly","im:message.p2p_msg:readonly","im:message:readonly","im:message:send_as_bot","im:resource","wiki:wiki","wiki:wiki:readonly"],"user":["aily:file:read","aily:file:write","im:chat.access_event.bot_p2p_chat:read"]}}, null, 2))}
                    className="absolute top-2 right-2 inline-flex items-center gap-1 px-2 py-1 bg-accent-500 text-white rounded-lg text-xs hover:bg-accent-600 transition-colors"
                  >
                    <Clipboard size={12} />
                    Copy
                  </button>
                </div>
              </details>
              <p className="mt-2 mb-0.5 font-medium text-slate-700 text-xs">消息（必需）</p>
              <ul className="ml-4 list-disc text-slate-600 space-y-0.5">
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">im:message</code> — 获取与发送消息</li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">im:message:send_as_bot</code> — 以机器人身份发送消息</li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">im:message:readonly</code> — 读取消息内容</li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">im:message.p2p_msg:readonly</code> — 读取私聊消息</li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">im:message.group_at_msg:readonly</code> — 读取群聊 @机器人 消息</li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">im:resource</code> — 读取消息中的资源文件</li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">im:chat.members:bot_access</code> — 获取群成员信息</li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">im:chat.access_event.bot_p2p_chat:read</code> — 接收私聊事件</li>
              </ul>
              <p className="mt-2 mb-0.5 font-medium text-slate-700 text-xs">卡片与用户</p>
              <ul className="ml-4 list-disc text-slate-600 space-y-0.5">
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">cardkit:card:read</code> — 读取卡片消息</li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">cardkit:card:write</code> — 发送卡片消息</li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">contact:user.employee_id:readonly</code> — 读取用户信息</li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">application:bot.menu:write</code> — 管理机器人菜单</li>
              </ul>
              <p className="mt-2 mb-0.5 font-medium text-slate-700 text-xs">文档与知识库（启用飞书文档工具时需要）</p>
              <ul className="ml-4 list-disc text-slate-600 space-y-0.5">
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">docs:doc</code> — 读写文档</li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">docs:doc:readonly</code> — 只读文档</li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">docx:document</code> — 新版文档读写</li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">docx:document:readonly</code> — 新版文档只读</li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">wiki:wiki</code> — 读写知识库</li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">wiki:wiki:readonly</code> — 只读知识库</li>
              </ul>
              <p className="mt-2 mb-0.5 font-medium text-slate-700 text-xs">云盘与权限管理（启用相应工具时需要）</p>
              <ul className="ml-4 list-disc text-slate-600 space-y-0.5">
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">drive:drive</code> — 读写云盘文件</li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">drive:drive:readonly</code> — 只读云盘文件</li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">docs:permission.member:create</code> — 管理文档权限</li>
              </ul>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={5} />
            <div>
              <p className="font-medium text-slate-900">发布应用版本</p>
              <p className="text-slate-600 mt-0.5">
                创建并发布一个应用版本，等待管理员审核通过
              </p>
            </div>
          </div>
        </div>

        <div className="border-t border-slate-200 pt-3 mt-3">
          <p className="text-slate-700 font-medium">填写以下凭证信息，然后点击「Connect Channel」。WebSocket 连接将自动建立，无需额外配置回调地址。</p>
        </div>
      </div>
    );
  }

  // step === 'after'
  return (
    <div className="border border-green-300 bg-green-50 rounded-xl p-5 space-y-4 text-sm">
      <div className="flex items-center gap-2">
        <CheckCircle2 size={20} className="text-green-600" />
        <h3 className="font-semibold text-green-900 text-base">飞书渠道已连接!</h3>
      </div>

      <p className="text-green-800">凭证验证通过并已安全存储。WebSocket 长连接已自动建立，无需额外配置回调地址。</p>

      <p className="text-green-800">请确认飞书开放平台已完成以下配置：</p>

      <div className="space-y-3">
        <div className="flex gap-3">
          <StepNum n={1} variant="success" />
          <div>
            <p className="font-medium text-green-900">配置事件订阅方式</p>
            <p className="text-green-700 mt-0.5">
              在「<strong>事件与回调</strong>」的事件订阅设置中，选择「<strong>使用长连接接收事件</strong>」方式
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <StepNum n={2} variant="success" />
          <div>
            <p className="font-medium text-green-900">订阅事件</p>
            <p className="text-green-700 mt-0.5">
              添加事件：<code className="bg-green-100 px-1 rounded">im.message.receive_v1</code>（接收消息）
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <StepNum n={3} variant="success" />
          <div>
            <p className="font-medium text-green-900">启用机器人能力</p>
            <p className="text-green-700 mt-0.5">
              在「<strong>应用能力</strong>」中启用「<strong>机器人</strong>」能力
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <StepNum n={4} variant="success" />
          <div>
            <p className="font-medium text-green-900">添加机器人到群组</p>
            <p className="text-green-700 mt-0.5">
              将机器人添加到目标群组
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <StepNum n={5} variant="success" />
          <div>
            <p className="font-medium text-green-900">测试</p>
            <p className="text-green-700 mt-0.5">
              在群组中 @机器人 或私聊发消息进行测试
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ChannelSetup() {
  const { botId } = useParams<{ botId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const resumeType = searchParams.get('resume') as ChannelType | null;
  const [channelType, setChannelType] = useState<ChannelType | ''>(resumeType || '');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(!!resumeType);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!channelType) return;
    setLoading(true);
    setError('');
    try {
      await channelsApi.create(botId!, { channelType, credentials });
      setConnected(true);
      // For Telegram, auto-redirect (webhook is auto-registered)
      if (channelType === 'telegram') {
        navigate(`/bots/${botId}`);
      }
      // For Slack/Discord, show post-connect instructions
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // After successful connection — show post-connect guide for Slack
  if (connected && channelType === 'slack') {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <Link to={`/bots/${botId}`} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors">
          <ArrowLeft size={16} />
          Back to Bot
        </Link>
        <h1 className="text-2xl font-semibold text-slate-900">Add Channel</h1>
        <SlackGuide botId={botId!} step="after" />
        <button
          onClick={() => navigate(`/bots/${botId}`)}
          className="w-full rounded-lg bg-accent-500 text-white px-4 py-2.5 text-sm font-medium hover:bg-accent-600 transition-colors"
        >
          Done — Back to Bot
        </button>
      </div>
    );
  }

  if (connected && channelType === 'discord') {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <Link to={`/bots/${botId}`} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors">
          <ArrowLeft size={16} />
          Back to Bot
        </Link>
        <h1 className="text-2xl font-semibold text-slate-900">Add Channel</h1>
        <DiscordGuide botId={botId!} step="after" />
        <button
          onClick={() => navigate(`/bots/${botId}`)}
          className="w-full rounded-lg bg-accent-500 text-white px-4 py-2.5 text-sm font-medium hover:bg-accent-600 transition-colors"
        >
          Done — Back to Bot
        </button>
      </div>
    );
  }

  if (connected && channelType === 'feishu') {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <Link to={`/bots/${botId}`} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors">
          <ArrowLeft size={16} />
          Back to Bot
        </Link>
        <h1 className="text-2xl font-semibold text-slate-900">Add Channel</h1>
        <FeishuGuide step="after" />
        <button
          onClick={() => navigate(`/bots/${botId}`)}
          className="w-full rounded-lg bg-accent-500 text-white px-4 py-2.5 text-sm font-medium hover:bg-accent-600 transition-colors"
        >
          Done — Back to Bot
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      <Link to={`/bots/${botId}`} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors mb-4">
        <ArrowLeft size={16} />
        Back to Bot
      </Link>
      <h1 className="text-2xl font-semibold text-slate-900 mb-6">Add Channel</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
            {error}
          </div>
        )}

        <div className="bg-white border border-slate-200 p-6 rounded-xl">
          <label className="block text-sm font-medium text-slate-700 mb-3">Channel Type</label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {(['telegram', 'discord', 'slack', 'feishu'] as ChannelType[]).map((type) => {
              const meta = channelMeta[type];
              const selected = channelType === type;
              return (
                <button key={type} type="button"
                  onClick={() => { setChannelType(type); setCredentials(type === 'feishu' ? { domain: 'feishu' } : {}); setError(''); setConnected(false); }}
                  className={clsx(
                    'flex flex-col items-center gap-1.5 p-4 rounded-xl border-2 text-center transition-all',
                    selected
                      ? 'border-accent-500 bg-accent-50 ring-2 ring-accent-500/20'
                      : 'border-slate-200 hover:border-slate-300 bg-white',
                  )}>
                  <span className={clsx(
                    'w-10 h-10 rounded-lg flex items-center justify-center',
                    selected ? 'bg-accent-100 text-accent-600' : 'bg-slate-100 text-slate-500',
                  )}>
                    {meta.icon}
                  </span>
                  <span className={clsx(
                    'text-sm font-medium',
                    selected ? 'text-accent-700' : 'text-slate-700',
                  )}>
                    {meta.label}
                  </span>
                  <span className="text-[11px] text-slate-400 leading-tight">{meta.desc}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Channel-specific setup guide */}
        {channelType === 'slack' && <SlackGuide botId={botId!} step="before" />}
        {channelType === 'telegram' && <TelegramGuide />}
        {channelType === 'discord' && <DiscordGuide botId={botId!} step="before" />}
        {channelType === 'feishu' && <FeishuGuide step="before" />}

        {/* Credential fields */}
        {channelType && (
          <div className="bg-white border border-slate-200 p-6 rounded-xl space-y-4">
            <h2 className="text-sm font-semibold text-slate-900">Enter Credentials</h2>
            {channelFields[channelType].map((field) => (
              <div key={field.name}>
                <label className="block text-sm font-medium text-slate-700 mb-1">{field.label}</label>
                {channelType === 'feishu' && field.name === 'domain' ? (
                  <select
                    value={credentials.domain || 'feishu'}
                    onChange={e => setCredentials(prev => ({ ...prev, domain: e.target.value }))}
                    className="block w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none transition-colors"
                  >
                    <option value="feishu">飞书 (feishu.cn)</option>
                    <option value="lark">Lark (larksuite.com)</option>
                  </select>
                ) : (
                  <input type={field.type || 'text'} required placeholder={field.placeholder}
                    value={credentials[field.name] || ''}
                    onChange={e => setCredentials(prev => ({ ...prev, [field.name]: e.target.value }))}
                    className="block w-full rounded-lg border border-slate-300 px-3 py-2.5 font-mono text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none transition-colors" />
                )}
              </div>
            ))}

            <div className="flex gap-3 pt-2">
              <button type="submit" disabled={!channelType || loading}
                className="flex-1 rounded-lg bg-accent-500 text-white px-4 py-2.5 text-sm font-medium hover:bg-accent-600 disabled:opacity-50 transition-colors">
                {loading ? 'Connecting...' : 'Connect Channel'}
              </button>
              <button type="button" onClick={() => navigate(`/bots/${botId}`)}
                className="rounded-lg border border-slate-300 text-slate-700 px-4 py-2.5 text-sm font-medium hover:bg-slate-50 transition-colors">
                Cancel
              </button>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
