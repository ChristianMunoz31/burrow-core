import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';

// `busy` marks the card aria-busy while its body is a loading skeleton.

export default function WidgetCard({ to, title, icon: Icon, accent = 'text-slate-slate300', busy = false, children }) {
  return (
    <Link
      to={to}
      aria-busy={busy || undefined}
      className="group relative glass glass-hover rounded-2xl p-5 block h-full min-h-[150px]"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {Icon && <Icon size={14} className={accent} />}
          <h3 className="text-[10px] font-semibold uppercase tracking-widest text-slate-slate400">
            {title}
          </h3>
        </div>
        <ArrowUpRight
          size={14}
          className="text-slate-slate500 opacity-0 group-hover:opacity-100 transition-opacity"
        />
      </div>
      {children}
    </Link>
  );
}
