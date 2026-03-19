import { clsx } from 'clsx';

type BadgeVariant = 'success' | 'warning' | 'error' | 'neutral' | 'info';

const variantStyles: Record<BadgeVariant, string> = {
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  warning: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  error: 'bg-red-50 text-red-700 ring-red-600/20',
  neutral: 'bg-slate-100 text-slate-600 ring-slate-500/20',
  info: 'bg-sky-50 text-sky-700 ring-sky-600/20',
};

export default function Badge({ children, variant = 'neutral' }: { children: React.ReactNode; variant?: BadgeVariant }) {
  return (
    <span className={clsx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', variantStyles[variant])}>
      {children}
    </span>
  );
}
