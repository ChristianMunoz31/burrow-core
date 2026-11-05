import { useMemo } from 'react';
import { BarChart2 } from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import SectionCard from '../shared/SectionCard';
import { currentStreak, entriesByDay, moodHistogram } from '../../utils/journalStats';
import { topWords, wordCount } from '../../utils/journalText';
import { useChartColors } from '../../hooks/useChartColors';
import { getAccentColor, getTooltipStyle } from '../../utils/chartColors';

const DAY_TICK_FMT = new Intl.DateTimeFormat('en-US', { month: 'numeric', day: 'numeric' });
const MOOD_KEYS = { great: 'green', good: 'teal', okay: 'yellow', down: 'orange', rough: 'red' };

function Kpi({ label, value, sub }) {
  return (
    <div className="rounded-lg p-3 glass-subtle">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-slate400">
        {label}
      </div>
      <div className="text-2xl font-bold text-slate-slate100 tabular-nums leading-none mt-1">
        {value}
      </div>
      {sub && <div className="text-xs text-slate-slate500 mt-1">{sub}</div>}
    </div>
  );
}

export default function JournalStats({ entries }) {
  const chart = useChartColors();
  const stats = useMemo(() => {
    const streak = currentStreak(entries);
    const byDay = entriesByDay(entries, 30);
    const moods = moodHistogram(entries);
    const top = topWords(entries, 8);
    const totalWords = entries.reduce((s, e) => s + wordCount(e.body), 0);
    const thisWeekStart = new Date();
    thisWeekStart.setDate(thisWeekStart.getDate() - 6);
    const thisWeek = entries.filter((e) => e.date && new Date(e.date) >= thisWeekStart).length;
    return { streak, byDay, moods, top, totalWords, thisWeek };
  }, [entries]);

  const chartData = stats.byDay.map((d) => ({
    label: DAY_TICK_FMT.format(new Date(`${d.date}T12:00:00`)),
    count: d.count,
  }));

  return (
    <SectionCard title="Stats" icon={BarChart2} variant="dense">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
        <Kpi label="Streak" value={stats.streak} sub="days in a row" />
        <Kpi label="This week" value={stats.thisWeek} sub="entries" />
        <Kpi label="Total words" value={stats.totalWords.toLocaleString()} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div>
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-slate400 mb-2">
            Entries / day (last 30)
          </div>
          <div className="h-40">
            <ResponsiveContainer>
              <BarChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={chart.axisTick} />
                <XAxis
                  dataKey="label"
                  stroke={chart.axisTick}
                  fontSize={10}
                  interval={4}
                />
                <YAxis stroke={chart.axisTick} fontSize={10} allowDecimals={false} />
                <Tooltip
                  cursor={{ fill: 'rgba(99, 102, 241, 0.1)' }}
                  contentStyle={getTooltipStyle()}
                />
                <Bar dataKey="count" fill={getAccentColor('purple')} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div>
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-slate400 mb-2">
            Mood distribution
          </div>
          <div className="space-y-1.5">
            {stats.moods.map((m) => {
              const max = Math.max(...stats.moods.map((x) => x.count), 1);
              const pct = (m.count / max) * 100;
              return (
                <div key={m.mood} className="flex items-center gap-2">
                  <span className="w-12 text-xs text-slate-slate400">{m.mood}</span>
                  <div className="flex-1 h-3 bg-slate-slate900/60 rounded-sm overflow-hidden">
                    <div
                      className="h-full rounded-sm"
                      style={{ width: `${pct}%`, backgroundColor: getAccentColor(MOOD_KEYS[m.mood] || 'purple') }}
                    />
                  </div>
                  <span className="w-6 text-right text-xs text-slate-slate300 tabular-nums">
                    {m.count}
                  </span>
                </div>
              );
            })}
          </div>

          {stats.top.length > 0 && (
            <>
              <div className="text-xs font-semibold uppercase tracking-widest text-slate-slate400 mt-4 mb-2">
                Top words
              </div>
              <div className="flex flex-wrap gap-1.5">
                {stats.top.map(({ word, count }) => (
                  <span
                    key={word}
                    className="text-xs px-2 py-0.5 rounded-md bg-slate-slate700/60 text-slate-slate200 border border-slate-slate700"
                  >
                    {word} <span className="text-slate-slate500">·{count}</span>
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </SectionCard>
  );
}
