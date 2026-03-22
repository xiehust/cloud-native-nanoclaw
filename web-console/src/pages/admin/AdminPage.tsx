import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Users, CreditCard, Save, Plus, Ban, PlayCircle, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import TabNav from '../../components/TabNav';
import Badge from '../../components/Badge';
import { admin, AdminUser, PlanQuotasConfig } from '../../lib/api';

/* ── Quota field keys ────────────────────────────────────────────── */

const QUOTA_KEYS = ['maxBots', 'maxGroupsPerBot', 'maxTasksPerBot', 'maxConcurrentAgents', 'maxMonthlyTokens'] as const;

type QuotaKey = (typeof QUOTA_KEYS)[number];

const PLAN_NAMES = ['free', 'pro', 'enterprise'] as const;
type PlanName = (typeof PLAN_NAMES)[number];

const PLAN_BADGE_VARIANT: Record<PlanName, 'neutral' | 'success' | 'info'> = {
  free: 'neutral',
  pro: 'success',
  enterprise: 'info',
};

/* ── Users tab ───────────────────────────────────────────────────── */

function UsersTab() {
  const { t } = useTranslation();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newPlan, setNewPlan] = useState('free');
  const [creating, setCreating] = useState(false);

  function loadUsers() {
    setLoading(true);
    admin.listUsers()
      .then(setUsers)
      .catch((err) => console.error('Failed to load users:', err))
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadUsers(); }, []);

  function formatDate(dateStr?: string): string {
    if (!dateStr) return '\u2014';
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? '\u2014' : d.toLocaleDateString();
  }

  async function createUser() {
    if (!newEmail.trim()) return;
    setCreating(true);
    try {
      await admin.createUser(newEmail.trim(), newPlan);
      setShowCreate(false);
      setNewEmail('');
      setNewPlan('free');
      loadUsers();
    } catch (err) {
      console.error('Failed to create user:', err);
    } finally {
      setCreating(false);
    }
  }

  async function handleSuspend(userId: string) {
    if (!window.confirm(t('admin.users.suspendConfirm'))) return;
    try {
      await admin.updateUserStatus(userId, 'suspended');
      loadUsers();
    } catch (err) {
      console.error('Failed to suspend user:', err);
    }
  }

  async function handleActivate(userId: string) {
    if (!window.confirm(t('admin.users.activateConfirm'))) return;
    try {
      await admin.updateUserStatus(userId, 'active');
      loadUsers();
    } catch (err) {
      console.error('Failed to activate user:', err);
    }
  }

  async function handleDelete(userId: string) {
    if (!window.confirm(t('admin.users.deleteConfirm'))) return;
    try {
      await admin.deleteUser(userId);
      loadUsers();
    } catch (err) {
      console.error('Failed to delete user:', err);
    }
  }

  const visibleUsers = users.filter((u) => u.status !== 'deleted');

  if (loading) return <div className="text-center py-12 text-slate-400">{t('common.loading')}</div>;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent-500 text-white px-4 py-2 text-sm font-medium hover:bg-accent-600 transition-colors"
        >
          <Plus size={16} /> {t('admin.users.addUser')}
        </button>
      </div>

      {showCreate && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-3">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t('admin.users.email')}</label>
            <input
              type="email"
              placeholder={t('admin.users.emailPlaceholder')}
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t('admin.users.plan')}</label>
            <select
              value={newPlan}
              onChange={(e) => setNewPlan(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
            >
              <option value="free">{t('admin.plans.free')}</option>
              <option value="pro">{t('admin.plans.pro')}</option>
              <option value="enterprise">{t('admin.plans.enterprise')}</option>
            </select>
          </div>
          <div className="flex gap-2 pt-1">
            <button
              onClick={createUser}
              disabled={creating || !newEmail.trim()}
              className="rounded-lg bg-accent-500 text-white px-4 py-2 text-sm font-medium hover:bg-accent-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {creating ? t('common.creating') : t('common.create')}
            </button>
            <button
              onClick={() => { setShowCreate(false); setNewEmail(''); setNewPlan('free'); }}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-400 font-medium">{t('admin.users.email')}</th>
              <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-400 font-medium">{t('admin.users.plan')}</th>
              <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-400 font-medium">{t('admin.users.status')}</th>
              <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-400 font-medium">{t('admin.users.tokensUsed')}</th>
              <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-400 font-medium">{t('admin.users.bots')}</th>
              <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-400 font-medium">{t('admin.users.lastLogin')}</th>
              <th className="px-6 py-3 text-left text-xs uppercase tracking-wider text-slate-400 font-medium">{t('admin.users.actions')}</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-slate-200">
            {visibleUsers.map((u) => {
              const userStatus = u.status || 'active';
              return (
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
                  <td className="px-6 py-4 whitespace-nowrap">
                    <Badge variant={
                      userStatus === 'active' ? 'success' :
                      userStatus === 'suspended' ? 'warning' :
                      'error'
                    }>{userStatus}</Badge>
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
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center gap-1">
                      {userStatus === 'active' ? (
                        <button
                          onClick={() => handleSuspend(u.userId)}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-amber-600 hover:bg-amber-50 transition-colors"
                          title={t('admin.users.suspend')}
                        >
                          <Ban size={14} /> {t('admin.users.suspend')}
                        </button>
                      ) : userStatus === 'suspended' ? (
                        <button
                          onClick={() => handleActivate(u.userId)}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-50 transition-colors"
                          title={t('admin.users.activate')}
                        >
                          <PlayCircle size={14} /> {t('admin.users.activate')}
                        </button>
                      ) : null}
                      <button
                        onClick={() => handleDelete(u.userId)}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"
                        title={t('common.delete')}
                      >
                        <Trash2 size={14} /> {t('common.delete')}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {visibleUsers.length === 0 && (
              <tr>
                <td colSpan={7} className="px-6 py-8 text-center text-slate-500">{t('admin.users.noUsers')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Plans tab ───────────────────────────────────────────────────── */

function PlansTab() {
  const { t } = useTranslation();
  const quotaFields = QUOTA_KEYS.map((key) => ({ key, label: t(`admin.plans.${key}`) }));
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

  if (loading) return <div className="text-center py-12 text-slate-400">{t('common.loading')}</div>;
  if (!quotas) return <div className="text-center py-12 text-red-500">{t('admin.plans.failedToLoad')}</div>;

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
              {quotaFields.map(({ key, label }) => (
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
          {saving ? t('common.saving') : t('admin.plans.savePlans')}
        </button>
        {status === 'saved' && (
          <span className="text-sm text-emerald-600 font-medium">{t('admin.plans.plansSaved')}</span>
        )}
        {status === 'error' && (
          <span className="text-sm text-red-600 font-medium">{t('admin.plans.plansSaveFailed')}</span>
        )}
      </div>
    </div>
  );
}

/* ── Main AdminPage ──────────────────────────────────────────────── */

export default function AdminPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState('users');

  const tabs = [
    { key: 'users', label: t('admin.tabs.users'), icon: <Users size={16} /> },
    { key: 'plans', label: t('admin.tabs.plans'), icon: <CreditCard size={16} /> },
  ];

  return (
    <div className="animate-fade-in">
      <h1 className="text-2xl font-semibold text-slate-900 mb-6">{t('admin.title')}</h1>

      <TabNav tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

      <div className="mt-5">
        {activeTab === 'users' && <UsersTab />}
        {activeTab === 'plans' && <PlansTab />}
      </div>
    </div>
  );
}
