import { useState, useEffect } from 'react';
import { user as userApi, proxyRules as proxyRulesApi, type ProxyRuleSummary, type ProxyRuleInput } from '../lib/api';
import Badge from '../components/Badge';
import { Plus, Trash2, Edit2, Shield, Key } from 'lucide-react';

type Tab = 'anthropic' | 'credentials';

// ── Anthropic API Tab ─────────────────────────────────────────────────────

function AnthropicTab() {
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

  if (loading) return <div className="text-center py-12 text-slate-400">Loading...</div>;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
      <h2 className="text-lg font-semibold text-slate-900 mb-1">Anthropic API Configuration</h2>
      <p className="text-sm text-slate-500 mb-4">
        Configure your Anthropic API credentials to use direct API access instead of Bedrock for individual bots.
      </p>
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">API Key</label>
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasExistingKey ? 'Key configured (enter new to replace)' : 'sk-ant-...'}
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
            />
            {hasExistingKey && <Badge variant="success">Configured</Badge>}
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Base URL (optional)</label>
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.anthropic.com"
            className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
          />
          <p className="text-xs text-slate-400 mt-1">Leave empty to use default Anthropic API endpoint. Set for proxies or compatible APIs.</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={saveProvider}
            disabled={saving || (!apiKey.trim() && !baseUrl.trim())}
            className="rounded-lg bg-accent-500 text-white px-4 py-2.5 text-sm font-medium hover:bg-accent-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          {status === 'saved' && <span className="text-sm text-emerald-600">Saved</span>}
          {status === 'error' && <span className="text-sm text-red-600">Failed to save</span>}
        </div>
      </div>
    </div>
  );
}

// ── API Credentials Tab ───────────────────────────────────────────────────

const AUTH_TYPE_LABELS: Record<string, string> = {
  'bearer': 'Bearer Token',
  'api-key': 'API Key Header',
  'basic': 'Basic Auth',
};

function CredentialsTab() {
  const [rules, setRules] = useState<ProxyRuleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<ProxyRuleInput>({ name: '', prefix: '', target: '', authType: 'bearer', value: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { loadRules(); }, []);

  async function loadRules() {
    try {
      const data = await proxyRulesApi.list();
      setRules(data);
    } catch (err) {
      console.error('Failed to load proxy rules:', err);
    } finally {
      setLoading(false);
    }
  }

  function startNew() {
    setEditing('new');
    setForm({ name: '', prefix: '/', target: 'https://', authType: 'bearer', value: '' });
    setError('');
  }

  function startEdit(rule: ProxyRuleSummary) {
    setEditing(rule.id);
    setForm({ name: rule.name, prefix: rule.prefix, target: rule.target, authType: rule.authType, headerName: rule.headerName, value: '' });
    setError('');
  }

  function cancel() {
    setEditing(null);
    setError('');
  }

  function handleNameChange(name: string) {
    const prefix = '/' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    setForm((f) => ({ ...f, name, prefix }));
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      if (editing === 'new') {
        await proxyRulesApi.create(form);
      } else {
        // Strip empty value to preserve existing secret
        const payload = { ...form };
        if (!payload.value) delete (payload as Partial<ProxyRuleInput>).value;
        await proxyRulesApi.update(editing!, payload);
      }
      setEditing(null);
      await loadRules();
    } catch (err: any) {
      setError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!confirm('Delete this credential rule?')) return;
    try {
      await proxyRulesApi.remove(id);
      await loadRules();
    } catch (err) {
      console.error('Failed to delete rule:', err);
    }
  }

  if (loading) return <div className="text-center py-12 text-slate-400">Loading...</div>;

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold text-slate-900">API Credential Proxy Rules</h2>
          {!editing && (
            <button onClick={startNew} className="inline-flex items-center gap-1.5 rounded-lg bg-accent-500 text-white px-3 py-2 text-sm font-medium hover:bg-accent-600">
              <Plus size={16} /> Add Rule
            </button>
          )}
        </div>
        <p className="text-sm text-slate-500 mb-4">
          Configure credentials injected into agent API calls. Keys are never exposed to the agent — they are injected by a secure local proxy.
        </p>

        {rules.length > 0 && (
          <table className="w-full text-sm mb-4">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="py-2 font-medium">Name</th>
                <th className="py-2 font-medium">Target</th>
                <th className="py-2 font-medium">Auth Type</th>
                <th className="py-2 font-medium">Prefix</th>
                <th className="py-2 font-medium">Status</th>
                <th className="py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className="border-b border-slate-100">
                  <td className="py-2.5 font-medium text-slate-900">{rule.name}</td>
                  <td className="py-2.5 text-slate-600 truncate max-w-[200px]">{rule.target}</td>
                  <td className="py-2.5 text-slate-600">{AUTH_TYPE_LABELS[rule.authType]}</td>
                  <td className="py-2.5"><code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded">{rule.prefix}</code></td>
                  <td className="py-2.5">{rule.hasValue ? <Badge variant="success">Configured</Badge> : <Badge variant="warning">No Key</Badge>}</td>
                  <td className="py-2.5 text-right">
                    <button onClick={() => startEdit(rule)} className="text-slate-400 hover:text-accent-600 p-1"><Edit2 size={15} /></button>
                    <button onClick={() => remove(rule.id)} className="text-slate-400 hover:text-red-600 p-1 ml-1"><Trash2 size={15} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {rules.length === 0 && !editing && (
          <div className="text-center py-8 text-slate-400">
            No credential rules configured. Add one to securely inject API keys into agent requests.
          </div>
        )}
      </div>

      {editing && (
        <div className="bg-white rounded-xl shadow-sm border border-accent-200 p-6">
          <h3 className="text-md font-semibold text-slate-900 mb-4">{editing === 'new' ? 'Add Rule' : 'Edit Rule'}</h3>
          {error && <div className="text-sm text-red-600 mb-3">{error}</div>}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Name</label>
              <input
                value={form.name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="e.g. GitHub"
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Path Prefix</label>
              <input
                value={form.prefix}
                onChange={(e) => setForm((f) => ({ ...f, prefix: e.target.value }))}
                placeholder="/github"
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm font-mono focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">Target URL</label>
              <input
                value={form.target}
                onChange={(e) => setForm((f) => ({ ...f, target: e.target.value }))}
                placeholder="https://api.github.com"
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Auth Type</label>
              <select
                value={form.authType}
                onChange={(e) => setForm((f) => ({ ...f, authType: e.target.value as ProxyRuleInput['authType'] }))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              >
                <option value="bearer">Bearer Token</option>
                <option value="api-key">API Key Header</option>
                <option value="basic">Basic Auth</option>
              </select>
            </div>
            {form.authType === 'api-key' && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Header Name</label>
                <input
                  value={form.headerName || ''}
                  onChange={(e) => setForm((f) => ({ ...f, headerName: e.target.value }))}
                  placeholder="x-api-key"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
                />
              </div>
            )}
            <div className={form.authType === 'api-key' ? 'col-span-2' : ''}>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Secret {editing !== 'new' && <span className="text-slate-400 font-normal">(leave empty to keep current)</span>}
              </label>
              <input
                type="password"
                value={form.value}
                onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
                placeholder={editing !== 'new' ? 'Enter new value to replace' : 'Enter secret value'}
                className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
              />
            </div>
          </div>
          <div className="flex items-center gap-3 mt-4">
            <button
              onClick={save}
              disabled={saving || !form.name || !form.target || (editing === 'new' && !form.value)}
              className="rounded-lg bg-accent-500 text-white px-4 py-2.5 text-sm font-medium hover:bg-accent-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving...' : 'Save Rule'}
            </button>
            <button onClick={cancel} className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Settings Page ────────────────────────────────────────────────────

export default function Settings() {
  const [tab, setTab] = useState<Tab>('anthropic');

  return (
    <div className="animate-fade-in space-y-6">
      <h1 className="text-2xl font-semibold text-slate-900">Settings</h1>

      <div className="flex gap-1 border-b border-slate-200">
        <button
          onClick={() => setTab('anthropic')}
          className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            tab === 'anthropic'
              ? 'border-accent-500 text-accent-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <Key size={16} /> Anthropic API
        </button>
        <button
          onClick={() => setTab('credentials')}
          className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            tab === 'credentials'
              ? 'border-accent-500 text-accent-600'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          <Shield size={16} /> API Credentials
        </button>
      </div>

      {tab === 'anthropic' && <AnthropicTab />}
      {tab === 'credentials' && <CredentialsTab />}
    </div>
  );
}
