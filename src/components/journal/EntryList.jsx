import { useMemo } from 'react';
import { BookOpen } from 'lucide-react';
import SectionCard from '../shared/SectionCard';
import ItemActions from '../shared/ItemActions';
import { isTempId } from '../../hooks/useCrudDialogs';
import { dateOnly } from '../../utils/journalStats';
import { entryName, entryTime } from './entryName';

const DAY_FMT = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});

const MOOD_CLASS = {
  great: 'text-accent-green border-green-green/40 bg-green-greenDark1/20',
  good: 'text-accent-teal border-teal-tealDusty/40 bg-teal-tealDark1/20',
  okay: 'text-accent-yellow border-yellow-yellowDusty/40 bg-yellow-yellowDark1/20',
  down: 'text-accent-orange border-orange-orangeDusty/40 bg-orange-orangeDark1/20',
  rough: 'text-accent-red border-red-red/40 bg-red-redDark1/20',
};

export default function EntryList({ entries, action, onEdit, onRemove }) {
  const grouped = useMemo(() => {
    const map = new Map();
    for (const e of entries || []) {
      const key = dateOnly(e.date) || 'undated';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(e);
    }
    return Array.from(map.entries());
  }, [entries]);

  if (!entries || entries.length === 0) {
    return (
      <SectionCard title="Entries" icon={BookOpen} action={action}>
        <p className="text-sm text-slate-slate400">No entries yet.</p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title={`Entries · ${entries.length}`} icon={BookOpen} action={action}>
      <div className="space-y-5">
        {grouped.map(([day, list]) => (
          <div key={day}>
            <div className="text-xs font-semibold uppercase tracking-widest text-slate-slate400 mb-2">
              {day === 'undated' ? 'Undated' : DAY_FMT.format(new Date(`${day}T12:00:00`))}
            </div>
            <ul className="space-y-3 border-l-2 border-slate-slate700/60 pl-4">
              {list.map((e) => (
                <li key={e.id} className="group">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        {e.title && (
                          <span className="text-sm font-semibold text-slate-slate100">
                            {e.title}
                          </span>
                        )}
                        {e.mood && (
                          <span
                            className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-md border ${
                              MOOD_CLASS[e.mood] || ''
                            }`}
                          >
                            {e.mood}
                          </span>
                        )}
                        <span className="text-xs text-slate-slate500">
                          {entryTime(e)}
                        </span>
                      </div>
                      <p className="text-sm text-slate-slate200 whitespace-pre-wrap leading-relaxed">
                        {e.body}
                      </p>
                      {e.tags?.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {e.tags.map((t) => (
                            <span
                              key={t}
                              className="text-[10px] px-1.5 py-0.5 rounded-md bg-slate-slate700/60 text-slate-slate300 border border-slate-slate700"
                            >
                              #{t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    {!isTempId(e.id) && (
                      <ItemActions
                        name={entryName(e)}
                        onEdit={() => onEdit(e)}
                        onRemove={() => onRemove(e)}
                      />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
