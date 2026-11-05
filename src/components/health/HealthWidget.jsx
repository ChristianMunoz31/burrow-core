import { HeartPulse } from 'lucide-react';
import WidgetCard from '../shared/WidgetCard';
import { WidgetSkeleton } from '../shared/Skeleton';
import { useOura } from '../../hooks/useOura';
import NetworkOptInNotice from '../shared/NetworkOptInNotice';
import { isNetworkOptInError } from '../../utils/apiError';

function scoreColor(score) {
  if (score == null) return 'text-slate-slate500';
  if (score >= 85) return 'text-accent-green';
  if (score >= 70) return 'text-accent-yellow';
  return 'text-accent-orange';
}

function Score({ label, value }) {
  return (
    <div className="text-center">
      <div className={`text-2xl font-bold tabular-nums leading-none ${scoreColor(value)}`}>
        {value ?? 'n/a'}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-slate-slate500 mt-1">{label}</div>
    </div>
  );
}

export default function HealthWidget() {
  const { latest, loading, error } = useOura();

  return (
    <WidgetCard busy={loading} to="/health" title="Sleep & activity" icon={HeartPulse} accent="text-accent-red">
      {loading && <WidgetSkeleton />}
      {!loading && isNetworkOptInError(error) && <NetworkOptInNotice name="Oura" link={false} />}
      {!loading && error && !isNetworkOptInError(error) && (
        <p className="text-xs text-slate-slate400">
          {error.status === 503 ? 'Add your Oura token in Settings > Connected services.' : 'Could not load Oura data.'}
        </p>
      )}
      {!loading && !error && !latest && (
        <p className="text-xs text-slate-slate400">No recent Oura data.</p>
      )}
      {!loading && !error && latest && (
        <>
          <div className="flex items-center justify-between gap-2">
            <Score label="Readiness" value={latest.readiness} />
            <Score label="Sleep" value={latest.sleep} />
            <Score label="Activity" value={latest.activity} />
          </div>
          <div className="text-xs text-slate-slate500 mt-3 text-center tabular-nums">
            {latest.restingHr != null && <>RHR {latest.restingHr} bpm</>}
            {latest.hrv != null && <> · HRV {latest.hrv} ms</>}
            {latest.steps != null && <> · {latest.steps.toLocaleString()} steps</>}
          </div>
        </>
      )}
    </WidgetCard>
  );
}
