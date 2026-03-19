import { useState, useRef, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import clsx from 'clsx';
import {
  LayoutDashboard,
  Settings,
  Shield,
  ChevronsLeft,
  ChevronsRight,
  LogOut,
  Plus,
} from 'lucide-react';
import type { Bot } from '../lib/api';

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  bots: Bot[];
  activeBotId?: string;
  userEmail: string;
  isAdmin: boolean;
  onCreateBot: (name: string) => void;
  onLogout: () => void;
}

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export default function Sidebar({
  collapsed,
  onToggle,
  bots,
  activeBotId,
  userEmail,
  isAdmin,
  onCreateBot,
  onLogout,
}: SidebarProps) {
  const location = useLocation();
  const [creatingBot, setCreatingBot] = useState(false);
  const [newBotName, setNewBotName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creatingBot && inputRef.current) {
      inputRef.current.focus();
    }
  }, [creatingBot]);

  const handleCreateSubmit = () => {
    const name = newBotName.trim();
    if (name) {
      onCreateBot(name);
    }
    setNewBotName('');
    setCreatingBot(false);
  };

  const handleCreateKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleCreateSubmit();
    } else if (e.key === 'Escape') {
      setNewBotName('');
      setCreatingBot(false);
    }
  };

  const isNavActive = (to: string) => {
    if (to === '/') return location.pathname === '/';
    return location.pathname.startsWith(to);
  };

  return (
    <aside
      className={clsx(
        'flex flex-col h-screen bg-sidebar-900 text-slate-400 transition-all duration-200 ease-in-out flex-shrink-0',
        collapsed ? 'w-16' : 'w-64'
      )}
    >
      {/* Logo */}
      <Link
        to="/"
        className="flex items-center h-16 px-4 border-b border-sidebar-700 hover:bg-sidebar-800 transition-colors"
        title="NanoClaw on Cloud"
      >
        <span className="text-xl flex-shrink-0">🦞</span>
        {!collapsed && (
          <span className="ml-3 text-white font-semibold text-sm whitespace-nowrap overflow-hidden">
            NanoClaw on Cloud
          </span>
        )}
      </Link>

      {/* Nav section */}
      <nav className="mt-4 px-2 space-y-1">
        {navItems.map(({ to, icon: Icon, label }) => {
          const active = isNavActive(to);
          return (
            <Link
              key={to}
              to={to}
              title={collapsed ? label : undefined}
              className={clsx(
                'flex items-center h-9 rounded-md transition-colors',
                collapsed ? 'justify-center px-0' : 'px-3',
                active
                  ? 'bg-accent-500/10 text-white border-l-2 border-accent-500'
                  : 'hover:bg-sidebar-800 hover:text-white'
              )}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {!collapsed && <span className="ml-3 text-sm">{label}</span>}
            </Link>
          );
        })}
        {isAdmin && (
          <Link
            to="/admin/users"
            title={collapsed ? 'Admin' : undefined}
            className={clsx(
              'flex items-center h-9 rounded-md transition-colors',
              collapsed ? 'justify-center px-0' : 'px-3',
              isNavActive('/admin')
                ? 'bg-accent-500/10 text-white border-l-2 border-accent-500'
                : 'hover:bg-sidebar-800 hover:text-white'
            )}
          >
            <Shield className="w-4 h-4 flex-shrink-0" />
            {!collapsed && <span className="ml-3 text-sm">Admin</span>}
          </Link>
        )}
      </nav>

      {/* Bots section */}
      <div className="mt-6 flex-1 min-h-0 flex flex-col">
        {!collapsed && (
          <div className="px-4 mb-2">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
              My Bots
            </span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto sidebar-scroll px-2 space-y-0.5">
          {bots.map((bot) => {
            const active = bot.botId === activeBotId;
            const isRunning = bot.status === 'active';
            return (
              <Link
                key={bot.botId}
                to={`/bots/${bot.botId}`}
                title={collapsed ? bot.name : undefined}
                className={clsx(
                  'flex items-center h-8 rounded-md transition-colors',
                  collapsed ? 'justify-center px-0' : 'px-3',
                  active
                    ? 'bg-accent-500/10 text-white'
                    : 'hover:bg-sidebar-800 hover:text-white'
                )}
              >
                <span
                  className={clsx(
                    'w-2 h-2 rounded-full flex-shrink-0',
                    isRunning ? 'bg-accent-500' : 'bg-slate-500'
                  )}
                />
                {!collapsed && (
                  <span className="ml-3 text-sm truncate">{bot.name}</span>
                )}
              </Link>
            );
          })}
        </div>

        {/* New Bot button / inline input */}
        <div className="px-2 py-2">
          {creatingBot && !collapsed ? (
            <input
              ref={inputRef}
              type="text"
              value={newBotName}
              onChange={(e) => setNewBotName(e.target.value)}
              onKeyDown={handleCreateKeyDown}
              onBlur={handleCreateSubmit}
              placeholder="Bot name..."
              className="w-full h-8 px-3 text-sm bg-sidebar-800 text-white rounded-md border border-sidebar-700 placeholder-slate-500 focus:outline-none focus:border-accent-500"
            />
          ) : (
            <button
              onClick={() => {
                if (collapsed) {
                  onCreateBot('New Bot');
                } else {
                  setCreatingBot(true);
                }
              }}
              title={collapsed ? 'New Bot' : undefined}
              className={clsx(
                'flex items-center h-8 rounded-md transition-colors hover:bg-sidebar-800 hover:text-white w-full',
                collapsed ? 'justify-center px-0' : 'px-3'
              )}
            >
              <Plus className="w-4 h-4 flex-shrink-0" />
              {!collapsed && <span className="ml-3 text-sm">New Bot</span>}
            </button>
          )}
        </div>
      </div>

      {/* Bottom section */}
      <div className="border-t border-sidebar-700 px-2 py-3 space-y-1">
        {/* Collapse toggle */}
        <button
          onClick={onToggle}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={clsx(
            'flex items-center h-8 rounded-md transition-colors hover:bg-sidebar-800 hover:text-white w-full',
            collapsed ? 'justify-center px-0' : 'px-3'
          )}
        >
          {collapsed ? (
            <ChevronsRight className="w-4 h-4 flex-shrink-0" />
          ) : (
            <ChevronsLeft className="w-4 h-4 flex-shrink-0" />
          )}
          {!collapsed && <span className="ml-3 text-sm">Collapse</span>}
        </button>

        {/* User email */}
        {!collapsed && (
          <div className="px-3 py-1">
            <span className="text-xs text-slate-500 truncate block" title={userEmail}>
              {userEmail}
            </span>
          </div>
        )}

        {/* Sign out */}
        <button
          onClick={onLogout}
          title={collapsed ? 'Sign out' : undefined}
          className={clsx(
            'flex items-center h-8 rounded-md transition-colors hover:bg-sidebar-800 hover:text-white w-full',
            collapsed ? 'justify-center px-0' : 'px-3'
          )}
        >
          <LogOut className="w-4 h-4 flex-shrink-0" />
          {!collapsed && <span className="ml-3 text-sm">Sign out</span>}
        </button>
      </div>
    </aside>
  );
}
