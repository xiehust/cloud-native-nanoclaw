import { useState, useEffect, useCallback, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { bots as botsApi, user as userApi, Bot } from '../lib/api';
import Sidebar from './Sidebar';

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebar-collapsed') === 'true');
  const [botList, setBotList] = useState<Bot[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);

  // Extract botId from the URL path since Layout is outside <Route> context
  const activeBotId = useMemo(() => {
    const match = location.pathname.match(/^\/bots\/([^/]+)/);
    return match?.[1];
  }, [location.pathname]);

  const loadBots = useCallback(async () => {
    try {
      const [bots, me] = await Promise.all([botsApi.list(), userApi.me()]);
      setBotList(bots);
      setIsAdmin(me.isAdmin || false);
    } catch (err) {
      console.error('Failed to load sidebar data:', err);
    }
  }, []);

  useEffect(() => { loadBots(); }, [loadBots]);

  const handleToggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem('sidebar-collapsed', String(next));
  };

  const handleCreateBot = async (name: string) => {
    try {
      await botsApi.create({ name });
      await loadBots();
    } catch (err) {
      console.error('Failed to create bot:', err);
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50">
      <Sidebar
        collapsed={collapsed}
        onToggle={handleToggle}
        bots={botList}
        activeBotId={activeBotId}
        userEmail={user?.email || ''}
        isAdmin={isAdmin}
        onCreateBot={handleCreateBot}
        onLogout={logout}
      />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl px-6 py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
