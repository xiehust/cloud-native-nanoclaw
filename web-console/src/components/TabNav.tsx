import { clsx } from 'clsx';

interface Tab {
  key: string;
  label: string;
  icon?: React.ReactNode;
}

interface TabNavProps {
  tabs: Tab[];
  activeTab: string;
  onChange: (key: string) => void;
}

export default function TabNav({ tabs, activeTab, onChange }: TabNavProps) {
  return (
    <div className="border-b border-slate-200">
      <nav className="flex gap-1" aria-label="Tabs">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => onChange(tab.key)}
            className={clsx(
              'flex items-center gap-2 rounded-t-lg border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              activeTab === tab.key
                ? 'border-accent-500 text-accent-600'
                : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
