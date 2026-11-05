import { Check } from 'lucide-react';
import ItemActions from '../shared/ItemActions';
import { isTempId } from '../../hooks/useCrudDialogs';
import { buildGrid, currentStreak, isoToday } from '../../utils/habits';

// Map habit color tag -> tailwind accent class for the filled grid squares.
const COLOR_CLASSES = {
  blue: 'bg-blue-blueLight1',
  green: 'bg-green-greenLight1',
  teal: 'bg-teal-tealLight1',
  purple: 'bg-purple-purpleLight1',
  orange: 'bg-orange-orangeLight1',
  red: 'bg-red-redLight1',
  yellow: 'bg-yellow-yellowLight1',
  cyan: 'bg-cyan-cyanLight1',
};

const DAY_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

function dayLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return DAY_FMT.format(new Date(y, m - 1, d));
}

function colorClass(color) {
  return COLOR_CLASSES[color] || 'bg-teal-tealLight1';
}

export default function HabitRow({ habit, onToggle, onEdit, onRemove }) {
  const today = isoToday();
  const completions = Array.isArray(habit.completions) ? habit.completions : [];
  const grid = buildGrid(completions, 30, today);
  const streak = currentStreak(completions, today);
  const doneToday = completions.includes(today);
  const filled = colorClass(habit.color);
  const doneCount = grid.filter((cell) => cell.done).length;

  return (
    <li className="group flex items-center gap-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-slate-slate100 truncate">{habit.title}</div>
        <div className="flex items-center gap-2 text-xs mt-0.5 text-slate-slate400">
          <span>{habit.frequency || 'daily'}</span>
        </div>
      </div>

      <div
        className="text-sm tabular-nums text-slate-slate200 font-semibold shrink-0"
        title={`${streak}-day streak`}
      >
        <span aria-hidden="true">🔥</span> {streak}
      </div>

      <button
        type="button"
        onClick={() => onToggle(habit.id, today, doneToday)}
        disabled={isTempId(habit.id)}
        aria-pressed={doneToday}
        aria-label={`Done today: ${habit.title}`}
        title={doneToday ? 'Done today. Click to undo.' : 'Mark done today'}
        className={`w-9 h-9 sm:w-7 sm:h-7 shrink-0 inline-flex items-center justify-center rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-slateBlueLight ${
          doneToday
            ? 'bg-green-greenDark1/30 border-green-green/50 text-accent-green'
            : 'border-slate-slate600 text-slate-slate400 hover:text-slate-slate100 hover:bg-slate-slate700/60'
        }`}
      >
        <Check size={16} aria-hidden="true" />
      </button>

      <div className="flex gap-0.5 shrink-0" role="group" aria-label="Last 30 days">
        <span className="sr-only">{doneCount} of 30 days done</span>
        {grid.map((cell) => {
          const isToday = cell.date === today;
          const base = 'w-2.5 h-2.5 rounded-sm';
          const tone = cell.done ? filled : 'bg-slate-slate700/70';
          const ring = isToday ? 'ring-1 ring-slate-slate300' : '';
          return (
            <span
              key={cell.date}
              title={`${dayLabel(cell.date)}: ${cell.done ? 'done' : 'not done'}`}
              className={`${base} ${tone} ${ring}`}
            />
          );
        })}
      </div>

      {!isTempId(habit.id) && (
        <ItemActions
          name={habit.title}
          onEdit={() => onEdit(habit)}
          onRemove={() => onRemove(habit)}
        />
      )}
    </li>
  );
}
