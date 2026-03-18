import { useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { channels as channelsApi } from '../lib/api';

type ChannelType = 'telegram' | 'discord' | 'slack';

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
};

function SlackGuide({ botId, step }: { botId: string; step: 'before' | 'after' }) {
  const webhookUrl = `${window.location.origin}/webhook/slack/${botId}`;

  if (step === 'before') {
    return (
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-4 text-sm">
        <h3 className="font-semibold text-blue-900 text-base">Slack App Setup Guide</h3>

        <div className="space-y-3">
          <div className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">1</span>
            <div>
              <p className="font-medium text-blue-900">Create a Slack App</p>
              <p className="text-blue-700 mt-0.5">
                Go to <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="underline font-medium">api.slack.com/apps</a> → <strong>Create New App</strong> → <strong>From scratch</strong> → name it and select your workspace.
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">2</span>
            <div>
              <p className="font-medium text-blue-900">Configure Bot Token Scopes</p>
              <p className="text-blue-700 mt-0.5">
                Left menu → <strong>OAuth & Permissions</strong> → scroll to <strong>Bot Token Scopes</strong> → add:
              </p>
              <ul className="mt-1 ml-4 list-disc text-blue-700 space-y-0.5">
                <li><code className="bg-blue-100 px-1 rounded">chat:write</code> — Send messages</li>
                <li><code className="bg-blue-100 px-1 rounded">channels:history</code> — Read public channel messages</li>
                <li><code className="bg-blue-100 px-1 rounded">groups:history</code> — Read private channel messages</li>
                <li><code className="bg-blue-100 px-1 rounded">im:history</code> — Read direct messages</li>
                <li><code className="bg-blue-100 px-1 rounded">im:read</code> — Access DM conversations</li>
                <li><code className="bg-blue-100 px-1 rounded">im:write</code> — Send direct messages</li>
                <li><code className="bg-blue-100 px-1 rounded">files:read</code> — Read file attachments sent by users</li>
                <li><code className="bg-blue-100 px-1 rounded">files:write</code> — Send file attachments in responses</li>
              </ul>
              <p className="text-blue-600 mt-1 text-xs">The <code className="bg-blue-100 px-1 rounded">files:read</code> and <code className="bg-blue-100 px-1 rounded">files:write</code> scopes are needed for sending and receiving file attachments.</p>
            </div>
          </div>

          <div className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">3</span>
            <div>
              <p className="font-medium text-blue-900">Enable Direct Messages (App Home)</p>
              <p className="text-blue-700 mt-0.5">
                Left menu → <strong>App Home</strong> → scroll to <strong>Show Tabs</strong>:
              </p>
              <ul className="mt-1 ml-4 list-disc text-blue-700 space-y-0.5">
                <li>Toggle <strong>Messages Tab</strong> to ON</li>
                <li>Check <strong>"Allow users to send Slash commands and messages from the messages tab"</strong></li>
              </ul>
              <p className="text-blue-600 mt-1 text-xs">This enables users to DM the bot directly.</p>
            </div>
          </div>

          <div className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">4</span>
            <div>
              <p className="font-medium text-blue-900">Install App to Workspace</p>
              <p className="text-blue-700 mt-0.5">
                Left menu → <strong>OAuth & Permissions</strong> → click <strong>Install to Workspace</strong> → Authorize.
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">5</span>
            <div>
              <p className="font-medium text-blue-900">Copy Bot Token</p>
              <p className="text-blue-700 mt-0.5">
                After installing, copy the <strong>Bot User OAuth Token</strong> (starts with <code className="bg-blue-100 px-1 rounded">xoxb-</code>). Paste it below.
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">6</span>
            <div>
              <p className="font-medium text-blue-900">Copy Signing Secret</p>
              <p className="text-blue-700 mt-0.5">
                Left menu → <strong>Basic Information</strong> → scroll to <strong>App Credentials</strong> → click <strong>Show</strong> next to <strong>Signing Secret</strong>. Paste it below.
              </p>
            </div>
          </div>
        </div>

        <div className="border-t border-blue-200 pt-3 mt-3">
          <p className="text-blue-800 font-medium">Fill in both fields below, then click Connect. After connecting, you'll get instructions for the final step (Event Subscriptions).</p>
        </div>
      </div>
    );
  }

  // step === 'after'
  return (
    <div className="bg-green-50 border border-green-200 rounded-lg p-4 space-y-4 text-sm">
      <div className="flex items-center gap-2">
        <svg className="w-5 h-5 text-green-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <h3 className="font-semibold text-green-900 text-base">Slack Channel Connected!</h3>
      </div>

      <p className="text-green-800">Credentials verified and stored. Now complete the final step to receive messages:</p>

      <div className="space-y-3">
        <div className="flex gap-3">
          <span className="flex-shrink-0 w-6 h-6 rounded-full bg-green-600 text-white text-xs flex items-center justify-center font-bold">7</span>
          <div>
            <p className="font-medium text-green-900">Enable Event Subscriptions</p>
            <p className="text-green-700 mt-0.5">
              In your Slack App settings → left menu → <strong>Event Subscriptions</strong> → toggle <strong>Enable Events</strong> to ON.
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <span className="flex-shrink-0 w-6 h-6 rounded-full bg-green-600 text-white text-xs flex items-center justify-center font-bold">8</span>
          <div>
            <p className="font-medium text-green-900">Set Request URL</p>
            <p className="text-green-700 mt-0.5">Paste this URL into the <strong>Request URL</strong> field:</p>
            <div className="mt-1.5 flex items-center gap-2">
              <code className="flex-1 bg-white border border-green-300 rounded px-3 py-2 text-xs font-mono text-green-900 break-all select-all">
                {webhookUrl}
              </code>
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(webhookUrl)}
                className="flex-shrink-0 px-2 py-2 bg-green-600 text-white rounded hover:bg-green-700 text-xs"
                title="Copy URL"
              >
                Copy
              </button>
            </div>
            <p className="text-green-600 mt-1 text-xs">Slack will send a verification request — you should see a green checkmark ✓</p>
          </div>
        </div>

        <div className="flex gap-3">
          <span className="flex-shrink-0 w-6 h-6 rounded-full bg-green-600 text-white text-xs flex items-center justify-center font-bold">9</span>
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
          <span className="flex-shrink-0 w-6 h-6 rounded-full bg-green-600 text-white text-xs flex items-center justify-center font-bold">10</span>
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
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm space-y-2">
      <h3 className="font-semibold text-blue-900">How to get your Telegram Bot Token</h3>
      <ol className="list-decimal ml-5 text-blue-700 space-y-1">
        <li>Open Telegram and message <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="underline font-medium">@BotFather</a></li>
        <li>Send <code className="bg-blue-100 px-1 rounded">/newbot</code> and follow the prompts</li>
        <li>Copy the token (looks like <code className="bg-blue-100 px-1 rounded">123456:ABC-DEF...</code>)</li>
      </ol>
      <p className="text-blue-600 text-xs mt-2">The webhook will be auto-registered when you connect.</p>
    </div>
  );
}

function DiscordGuide({ botId, step }: { botId: string; step: 'before' | 'after' }) {
  const webhookUrl = `${window.location.origin}/webhook/discord/${botId}`;

  if (step === 'before') {
    return (
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-4 text-sm">
        <h3 className="font-semibold text-blue-900 text-base">Discord Bot Setup Guide</h3>

        <div className="space-y-3">
          <div className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">1</span>
            <div>
              <p className="font-medium text-blue-900">Create a Discord Application</p>
              <p className="text-blue-700 mt-0.5">
                Go to <a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer" className="underline font-medium">Discord Developer Portal</a> → <strong>New Application</strong> → give it a name → <strong>Create</strong>.
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">2</span>
            <div>
              <p className="font-medium text-blue-900">Get Bot Token</p>
              <p className="text-blue-700 mt-0.5">
                Left menu → <strong>Bot</strong> → click <strong>Reset Token</strong> → copy it immediately (you can only see it once).
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">3</span>
            <div>
              <p className="font-medium text-blue-900">Enable Privileged Gateway Intents</p>
              <p className="text-blue-700 mt-0.5">
                On the same <strong>Bot</strong> page, scroll to <strong>Privileged Gateway Intents</strong> and enable:
              </p>
              <ul className="mt-1 ml-4 list-disc text-blue-700 space-y-0.5">
                <li><code className="bg-blue-100 px-1 rounded">Message Content Intent</code> — required to read message text</li>
                <li><code className="bg-blue-100 px-1 rounded">Server Members Intent</code> — optional, for member display names</li>
              </ul>
            </div>
          </div>

          <div className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">4</span>
            <div>
              <p className="font-medium text-blue-900">Get Public Key</p>
              <p className="text-blue-700 mt-0.5">
                Left menu → <strong>General Information</strong> → copy the <strong>Public Key</strong> (64-character hex string).
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold">5</span>
            <div>
              <p className="font-medium text-blue-900">Invite Bot to Your Server</p>
              <p className="text-blue-700 mt-0.5">
                Left menu → <strong>OAuth2</strong> → <strong>URL Generator</strong>:
              </p>
              <ul className="mt-1 ml-4 list-disc text-blue-700 space-y-0.5">
                <li>Scopes: select <code className="bg-blue-100 px-1 rounded">bot</code> and <code className="bg-blue-100 px-1 rounded">applications.commands</code></li>
                <li>Bot Permissions: select:
                  <ul className="mt-0.5 ml-4 list-[circle] text-blue-700 space-y-0.5">
                    <li><code className="bg-blue-100 px-1 rounded">Send Messages</code></li>
                    <li><code className="bg-blue-100 px-1 rounded">Send Messages in Threads</code></li>
                    <li><code className="bg-blue-100 px-1 rounded">Embed Links</code> — for rich reply formatting</li>
                    <li><code className="bg-blue-100 px-1 rounded">Read Message History</code></li>
                    <li><code className="bg-blue-100 px-1 rounded">View Channels</code></li>
                    <li><code className="bg-blue-100 px-1 rounded">Attach Files</code> — for sending file attachments</li>
                    <li><code className="bg-blue-100 px-1 rounded">Use Slash Commands</code></li>
                  </ul>
                </li>
              </ul>
              <p className="text-blue-700 mt-1">
                Copy the generated URL → open in browser → select your server → <strong>Authorize</strong>.
              </p>
            </div>
          </div>
        </div>

        <div className="border-t border-blue-200 pt-3 mt-3">
          <p className="text-blue-800 font-medium">Fill in both fields below, then click Connect.</p>
        </div>
      </div>
    );
  }

  // step === 'after'
  return (
    <div className="bg-green-50 border border-green-200 rounded-lg p-4 space-y-4 text-sm">
      <div className="flex items-center gap-2">
        <svg className="w-5 h-5 text-green-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <h3 className="font-semibold text-green-900 text-base">Discord Channel Connected!</h3>
      </div>

      <p className="text-green-800">Credentials verified and stored. Complete the remaining steps:</p>

      <div className="space-y-3">
        <div className="flex gap-3">
          <span className="flex-shrink-0 w-6 h-6 rounded-full bg-green-600 text-white text-xs flex items-center justify-center font-bold">6</span>
          <div>
            <p className="font-medium text-green-900">Set Interactions Endpoint URL</p>
            <p className="text-green-700 mt-0.5">
              In Discord Developer Portal → your app → <strong>General Information</strong> → paste this into <strong>Interactions Endpoint URL</strong>:
            </p>
            <div className="mt-1.5 flex items-center gap-2">
              <code className="flex-1 bg-white border border-green-300 rounded px-3 py-2 text-xs font-mono text-green-900 break-all select-all">
                {webhookUrl}
              </code>
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(webhookUrl)}
                className="flex-shrink-0 px-2 py-2 bg-green-600 text-white rounded hover:bg-green-700 text-xs"
                title="Copy URL"
              >
                Copy
              </button>
            </div>
            <p className="text-green-600 mt-1 text-xs">Discord will send a verification ping — you should see a success message.</p>
          </div>
        </div>

        <div className="flex gap-3">
          <span className="flex-shrink-0 w-6 h-6 rounded-full bg-green-600 text-white text-xs flex items-center justify-center font-bold">7</span>
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
          <span className="flex-shrink-0 w-6 h-6 rounded-full bg-green-600 text-white text-xs flex items-center justify-center font-bold">8</span>
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
      <div className="max-w-2xl mx-auto space-y-4">
        <h1 className="text-2xl font-bold text-gray-900">Add Channel</h1>
        <SlackGuide botId={botId!} step="after" />
        <button
          onClick={() => navigate(`/bots/${botId}`)}
          className="w-full py-2 px-4 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 text-sm"
        >
          Done — Back to Bot
        </button>
      </div>
    );
  }

  if (connected && channelType === 'discord') {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <h1 className="text-2xl font-bold text-gray-900">Add Channel</h1>
        <DiscordGuide botId={botId!} step="after" />
        <button
          onClick={() => navigate(`/bots/${botId}`)}
          className="w-full py-2 px-4 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 text-sm"
        >
          Done — Back to Bot
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Add Channel</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">{error}</div>}

        <div className="bg-white p-6 rounded-lg shadow">
          <label className="block text-sm font-medium text-gray-700 mb-2">Channel Type</label>
          <div className="grid grid-cols-3 gap-3">
            {(['telegram', 'discord', 'slack'] as ChannelType[]).map((type) => (
              <button key={type} type="button"
                onClick={() => { setChannelType(type); setCredentials({}); setError(''); setConnected(false); }}
                className={`p-3 rounded-lg border-2 text-center text-sm font-medium transition-colors capitalize ${
                  channelType === type ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-gray-200 hover:border-gray-300'
                }`}>
                {type === 'telegram' ? 'Telegram' : type === 'discord' ? 'Discord' : 'Slack'}
              </button>
            ))}
          </div>
        </div>

        {/* Channel-specific setup guide */}
        {channelType === 'slack' && <SlackGuide botId={botId!} step="before" />}
        {channelType === 'telegram' && <TelegramGuide />}
        {channelType === 'discord' && <DiscordGuide botId={botId!} step="before" />}

        {/* Credential fields */}
        {channelType && (
          <div className="bg-white p-6 rounded-lg shadow space-y-4">
            <h2 className="text-sm font-semibold text-gray-900">Enter Credentials</h2>
            {channelFields[channelType].map((field) => (
              <div key={field.name}>
                <label className="block text-sm font-medium text-gray-700">{field.label}</label>
                <input type={field.type || 'text'} required placeholder={field.placeholder}
                  value={credentials[field.name] || ''}
                  onChange={e => setCredentials(prev => ({ ...prev, [field.name]: e.target.value }))}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm" />
              </div>
            ))}

            <div className="flex gap-3 pt-2">
              <button type="submit" disabled={!channelType || loading}
                className="flex-1 py-2 px-4 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50 text-sm font-medium">
                {loading ? 'Connecting...' : 'Connect Channel'}
              </button>
              <button type="button" onClick={() => navigate(`/bots/${botId}`)}
                className="py-2 px-4 text-gray-600 hover:text-gray-800 text-sm">Cancel</button>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
