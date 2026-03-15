import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { channels as channelsApi } from '../lib/api';

const channelConfigs = {
  telegram: { label: 'Telegram', fields: [{ name: 'botToken', label: 'Bot Token', placeholder: '123456:ABC-DEF...' }] },
  discord: { label: 'Discord', fields: [
    { name: 'botToken', label: 'Bot Token', placeholder: 'MTk...' },
    { name: 'publicKey', label: 'Public Key', placeholder: 'Ed25519 public key' },
  ]},
  slack: { label: 'Slack', fields: [
    { name: 'botToken', label: 'Bot Token', placeholder: 'xoxb-...' },
    { name: 'signingSecret', label: 'Signing Secret', placeholder: 'Signing secret from app settings' },
  ]},
};

type ChannelType = keyof typeof channelConfigs;

export default function ChannelSetup() {
  const { botId } = useParams<{ botId: string }>();
  const navigate = useNavigate();
  const [channelType, setChannelType] = useState<ChannelType | ''>('');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!channelType) return;
    setLoading(true);
    setError('');
    try {
      await channelsApi.create(botId!, { channelType, credentials });
      navigate(`/bots/${botId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-lg mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Add Channel</h1>
      <form onSubmit={handleSubmit} className="space-y-6 bg-white p-6 rounded-lg shadow">
        {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">{error}</div>}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Channel Type</label>
          <div className="grid grid-cols-3 gap-3">
            {(Object.entries(channelConfigs) as [ChannelType, typeof channelConfigs[ChannelType]][]).map(([type, config]) => (
              <button key={type} type="button" onClick={() => { setChannelType(type); setCredentials({}); }}
                className={`p-3 rounded-lg border-2 text-center text-sm font-medium transition-colors ${
                  channelType === type ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-gray-200 hover:border-gray-300'
                }`}>
                {config.label}
              </button>
            ))}
          </div>
        </div>

        {channelType && channelConfigs[channelType].fields.map((field) => (
          <div key={field.name}>
            <label className="block text-sm font-medium text-gray-700">{field.label}</label>
            <input type="text" required placeholder={field.placeholder}
              value={credentials[field.name] || ''} onChange={e => setCredentials(prev => ({ ...prev, [field.name]: e.target.value }))}
              className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm" />
          </div>
        ))}

        <div className="flex gap-3">
          <button type="submit" disabled={!channelType || loading}
            className="flex-1 py-2 px-4 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50 text-sm">
            {loading ? 'Connecting...' : 'Connect Channel'}
          </button>
          <button type="button" onClick={() => navigate(`/bots/${botId}`)}
            className="py-2 px-4 text-gray-600 hover:text-gray-800 text-sm">Cancel</button>
        </div>
      </form>
    </div>
  );
}
