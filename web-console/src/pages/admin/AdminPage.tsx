import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Users, CreditCard, Save } from 'lucide-react';
import { clsx } from 'clsx';
import TabNav from '../../components/TabNav';
import Badge from '../../components/Badge';
import { admin, AdminUser, PlanQuotasConfig } from '../../lib/api';

/* ── Tab definitions ─────────────────────────────────────────────── */

const tabs = [
  { key: 'users', label: 'Users', icon: <Users size={16} /> },
  { key: 'plans', label: 'Plans', icon: <CreditCard size={16} /> },
];

/* ── Quota field metadata ────────────────────────────────────────── */

const QUOTA_FIELDS = [
  { key: 'maxBots', label: 'Max Bots' },
  { key: 'maxGroupsPerBot', label: 'Max Groups per Bot' },
  { key: 'maxTasksPerBot', label: 'Max Tasks per Bot' },
  { key: 'maxConcurrentAgents', label: 'Max Concurrent Agents' },
  { key: 'maxMonthlyTokens', label: 'Max Monthly Tokens' },
] as const;

type QuotaKey = (typeof QUOTA_FIELDS)[number]['key'];

const PLAN_NAMES = ['free', 'pro', 'enterprise'] as const;
type PlanName = (typeof PLAN_NAMES)[number];

const PLAN_BADGE_VARIANT: Record<PlanName, 'neutral' | 'success' | 'info'> = {
  free: 'neutral',
  pro: 'success',
  enterprise: 'info',
};

/* ── Users tab ───────────────────────────────────────────────────── */

function UsersTab() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    admin.listUsers()
      .then(setUsers)
      .catch((err) => console.error('Failed to load users:', err))
      .finally(() => setLoading(false));
  }, []);

  function formatDate(dateStr?: string): string {
    if (!dateStr) return '\u2014';
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? '\u2014' : d.toLocaleDateString();
  }

  if (loading) return <div className="text-center py-12 text-slate-400">Loading...</div>;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
      <table className="min-w-full divide-y divide-slate-200">
        <thead className="bg-slate-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-400 font-medium">Email</th>
            <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-400 font-medium">Plan</th>
            <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-400 font-medium">Tokens (used / max)</th>
            <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-400 font-medium">Bots</th>
            <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-400 font-medium">Last Login</th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-slate-200">
          {users.map((u) => (
            <tr key={u.userId} className="hover:bg-slate-50 transition-colors">
              <td className="px-6 py-4 whitespace-nowrap">
                <Link to={`/admin/users/${u.userId}`} className="text-accent-600 hover:text-accent-500 font-medium">
                  {u.email || u.userId}
                </Link>
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
                <Badge variant={
                  u.plan === 'enterprise' ? 'info' :
                  u.plan === 'pro' ? 'success' :
                  'neutral'
                }>{u.plan}</Badge>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-700">
                {u.usageTokens.toLocaleString()} / {u.quota?.maxMonthlyTokens?.toLocaleString() ?? '\u2014'}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-700">
                {(u.botCount ?? 0).toLocaleString()} / {u.quota?.maxBots?.toLocaleString() ?? '\u2014'}
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-500">
                {formatDate(u.lastLogin)}
              </td>
            </tr>
          ))}
          {users.length === 0 && (
            <tr>
              <td colSpan={5} className="px-6 py-8 text-center text-slate-500">No users found.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ── Plans tab ───────────────────────────────────────────────────── */

function PlansTab() {
  const [quotas, setQuotas] = useState<PlanQuotasConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'saved' | 'error' | null>(null);

  useEffect(() => {
    admin.getPlans()
      .then(setQuotas)
      .catch((err) => console.error('Failed to load plans:', err))
      .finally(() => setLoading(false));
  }, []);

  function handleChange(plan: PlanName, field: QuotaKey, value: string) {
    if (!quotas) return;
    const num = value === '' ? 0 : parseInt(value, 10);
    if (isNaN(num)) return;
    setQuotas({
      ...quotas,
      [plan]: { ...quotas[plan], [field]: num },
    });
    setStatus(null);
  }

  async function handleSave() {
    if (!quotas) return;
    setSaving(true);
    setStatus(null);
    try {
      await admin.updatePlans(quotas);
      setStatus('saved');
    } catch (err) {
      console.error('Failed to save plans:', err);
      setStatus('error');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="text-center py-12 text-slate-400">Loading...</div>;
  if (!quotas) return <div className="text-center py-12 text-red-500">Failed to load plan quotas.</div>;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {PLAN_NAMES.map((plan) => (
          <div key={plan} className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
            <div className="flex items-center gap-2 mb-4">
              <h3 className="text-base font-semibold text-slate-900 capitalize">{plan}</h3>
              <Badge variant={PLAN_BADGE_VARIANT[plan]}>{plan}</Badge>
            </div>
            <div className="space-y-3">
              {QUOTA_FIELDS.map(({ key, label }) => (
                <div key={key}>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{label}</label>
                  <input
                    type="number"
                    min={0}
                    value={quotas[plan][key]}
                    onChange={(e) => handleChange(plan, key, e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className={clsx(
            'inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors',
            saving ? 'bg-accent-400 cursor-not-allowed' : 'bg-accent-600 hover:bg-accent-700',
          )}
        >
          <Save size={16} />
          {saving ? 'Saving...' : 'Save Plans'}
        </button>
        {status === 'saved' && (
          <span className="text-sm text-emerald-600 font-medium">Plans saved successfully.</span>
        )}
        {status === 'error' && (
          <span className="text-sm text-red-600 font-medium">Failed to save plans. Please try again.</span>
        )}
      </div>
    </div>
  );
}

/* ── Main AdminPage ──────────────────────────────────────────────── */

export default function AdminPage() {
  const [activeTab, setActiveTab] = useState('users');

  return (
    <div className="animate-fade-in">
      <h1 className="text-2xl font-semibold text-slate-900 mb-6">Admin</h1>

      <TabNav tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

      <div className="mt-5">
        {activeTab === 'users' && <UsersTab />}
        {activeTab === 'plans' && <PlansTab />}
      </div>
    </div>
  );
}
