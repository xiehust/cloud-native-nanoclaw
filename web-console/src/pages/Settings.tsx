import { useState, useEffect } from 'react';
import { user as userApi } from '../lib/api';

export default function Settings() {
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [hasExistingKey, setHasExistingKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'saved' | 'error' | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadProvider(); }, []);

  async function loadProvider() {
    try {
      const config = await userApi.getProvider();
      setHasExistingKey(config.hasApiKey);
      setBaseUrl(config.anthropicBaseUrl || '');
    } catch (err) {
      console.error('Failed to load provider config:', err);
    } finally {
      setLoading(false);
    }
  }

  async function saveProvider() {
    setSaving(true);
    setStatus(null);
    try {
      const data: Record<string, string> = {};
      if (apiKey.trim()) data.anthropicApiKey = apiKey.trim();
      if (baseUrl.trim()) data.anthropicBaseUrl = baseUrl.trim();
      const result = await userApi.updateProvider(data);
      setHasExistingKey(result.hasApiKey);
      setApiKey('');
      setStatus('saved');
      setTimeout(() => setStatus(null), 2000);
    } catch (err) {
      console.error('Failed to save provider config:', err);
      setStatus('error');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="text-center py-12 text-gray-500">Loading...</div>;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold text-gray-900">Settings</h1>

      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Anthropic API Configuration</h2>
        <p className="text-sm text-gray-500 mb-4">
          Configure your Anthropic API credentials to use direct API access instead of Bedrock for individual bots.
        </p>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={hasExistingKey ? 'Key configured (enter new to replace)' : 'sk-ant-...'}
                className="flex-1 text-sm border rounded-md p-2 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              {hasExistingKey && (
                <span className="text-xs text-green-600 font-medium">Configured</span>
              )}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Base URL (optional)</label>
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.anthropic.com"
              className="w-full text-sm border rounded-md p-2 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <p className="text-xs text-gray-400 mt-1">Leave empty to use default Anthropic API endpoint. Set for proxies or compatible APIs.</p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={saveProvider}
              disabled={saving || (!apiKey.trim() && !baseUrl.trim())}
              className="px-4 py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            {status === 'saved' && <span className="text-sm text-green-600">Saved</span>}
            {status === 'error' && <span className="text-sm text-red-600">Failed to save</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
