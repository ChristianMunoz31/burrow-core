import { useMemo } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from 'recharts';
import { HeartPulse } from 'lucide-react';
import SectionCard from '../shared/SectionCard';
import LastUpdated from '../shared/LastUpdated';
import NetworkOptInNotice from '../shared/NetworkOptInNotice';
import { isNetworkOptInError } from '../../utils/apiError';
import { Skeleton } from '../shared/Skeleton';
import { useOura } from '../../hooks/useOura';
import { useChartColors } from '../../hooks/useChartColors';
import { getAccentColor, getTooltipStyle } from '../../utils/chartColors';
import { usePageContext } from '../../contexts/PageContextContext';
import { buildHealthContext } from '../../utils/javiBuilders/health';

const DAY_FMT = new Intl.DateTimeFormat('en-US', { weekday: 'short' });

function scoreColor(score) {
  if (score == null) return 'text-slate-slate500';
  if (score >= 85) return 'text-accent-green';
  if (score >= 70) return 'text-accent-yellow';
  return 'text-accent-orange';
}

function fmtDay(day) {
  // day is 'YYYY-MM-DD'; render at local noon to avoid tz drift.
  return DAY_FMT.format(new Date(`${day}T12:00:00`));
}

function Stat({ label, value, unit }) {
  return (
    <div>
      <div className="text-xs text-slate-slate500">{label}</div>
      <div className="text-lg font-semibold text-slate-slate100 tabular-nums">
        {value == null ? 'n/a' : value}
        {value != null && unit ? <span className="text-xs text-slate-slate400"> {unit}</span> : null}
      </div>
    </div>
  );
}

export default function HealthPage() {
  const { days, latest, loading, error, updatedAt } = useOura();
  const chartColors = useChartColors();
  usePageContext(
    'health',
    () => buildHealthContext({ days, latest, loading, error }),
    days.length > 0 && days,
  );

  const chart = useMemo(
    () =>
      days.map((d) => ({
        day: fmtDay(d.day),
        Readiness: d.readiness,
        Sleep: d.sleep,
        Activity: d.activity,
      })),
    [days],
  );

  if (loading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5" role="status" aria-label="Loading health">
        <SectionCard title="Latest" className="lg:col-span-1">
          <Skeleton className="h-24 w-full" />
        </SectionCard>
        <SectionCard title="7-day trend" className="lg:col-span-2">
          <Skeleton className="h-64 w-full" />
        </SectionCard>
      </div>
    );
  }

  if (error) {
    return (
      <SectionCard
        title={isNetworkOptInError(error) ? 'Sleep & activity' : 'Sleep & activity unavailable'}
        icon={HeartPulse}
      >
        {isNetworkOptInError(error) ? (
          <NetworkOptInNotice name="Oura" className="text-sm text-slate-slate300" />
        ) : (
          <p className="text-sm text-slate-slate300">
            {error.status === 503
              ? 'Add your Oura token in Settings > Connected services.'
              : "Burrow couldn't load your Oura data. Check your internet connection and try again in a moment."}
          </p>
        )}
      </SectionCard>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
      <SectionCard title="Latest" icon={HeartPulse} className="lg:col-span-1" action={<LastUpdated at={updatedAt} />}>
        {!latest ? (
          <p className="text-sm text-slate-slate400">No recent Oura data.</p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              {[
                ['Readiness', latest.readiness],
                ['Sleep', latest.sleep],
                ['Activity', latest.activity],
              ].map(([label, value]) => (
                <div key={label} className="text-center">
                  <div className={`text-3xl font-bold tabular-nums leading-none ${scoreColor(value)}`}>
                    {value ?? 'n/a'}
                  </div>
                  <div className="text-[10px] uppercase tracking-wider text-slate-slate500 mt-1">
                    {label}
                  </div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3 pt-3 border-t border-slate-slate700/60">
              <Stat label="Resting HR" value={latest.restingHr} unit="bpm" />
              <Stat label="HRV" value={latest.hrv} unit="ms" />
              <Stat label="Sleep" value={latest.sleepHours} unit="h" />
              <Stat label="Steps" value={latest.steps?.toLocaleString()} />
              <Stat label="Active cal" value={latest.activeCalories} unit="kcal" />
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard title="7-day trend" className="lg:col-span-2" variant="dense">
        <div className="h-64">
          <ResponsiveContainer>
            <LineChart data={chart}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
              <XAxis dataKey="day" stroke={chartColors.axisTick} fontSize={11} />
              <YAxis stroke={chartColors.axisTick} fontSize={11} domain={[0, 100]} />
              <Tooltip
                contentStyle={getTooltipStyle()}
                itemStyle={{ color: 'var(--tooltip-text)' }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="Readiness" stroke={getAccentColor('cyan')} strokeWidth={2} dot={{ r: 3 }} connectNulls />
              <Line type="monotone" dataKey="Sleep" stroke={getAccentColor('purple')} strokeWidth={2} dot={{ r: 3 }} connectNulls />
              <Line type="monotone" dataKey="Activity" stroke={getAccentColor('green')} strokeWidth={2} dot={{ r: 3 }} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </SectionCard>
    </div>
  );
}
