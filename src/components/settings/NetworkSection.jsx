import { useState } from 'react';
import { Globe } from 'lucide-react';
import SectionCard from '../shared/SectionCard';
import { SHOW_NETWORK_ACTIVITY_EVENT, sectionProps } from './settingsSections';
import { ListSkeleton } from '../shared/Skeleton';
import { BTN } from './pillStyles';
import { useNetworkSettings } from '../../hooks/useNetworkSettings';
import { useAppInfo } from '../../hooks/useAppInfo';
import SwitchToggle from './SwitchToggle';
import WeatherLocationControl from './WeatherLocationControl';
import { STORE_UPDATES_COPY } from './UpdatesSection';

export { STORE_UPDATES_COPY };

/** The Microsoft Store build has no update check to switch on: the Store delivers updates. */
function StoreUpdatesRow({ feature }) {
  return (
    <li className="py-3" data-testid="store-updates-row">
      <p className="text-sm font-semibold text-slate-slate100">{feature.label}</p>
      <p className="text-xs text-slate-slate400">{STORE_UPDATES_COPY}</p>
    </li>
  );
}

// Where a feature shows up and what it needs, for the features that have no page of their own.
const FEATURE_NOTES = {
  weather: (on) =>
    `The forecast shows in the Javi card on Home${on ? ', for the location you set below.' : '. Turn it on to set your location.'}`,
};

function FeatureRow({ feature, onToggle }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const labelId = `network-${feature.id}-label`;
  const descId = `network-${feature.id}-desc`;

  const change = async (enabled) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onToggle(feature.id, enabled);
    } catch {
      setError("Couldn't save that change. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p id={labelId} className="text-sm font-semibold text-slate-slate100">
            {feature.label}
          </p>
          <p id={descId} className="text-xs text-slate-slate400">
            {feature.description}
          </p>
          {FEATURE_NOTES[feature.id] && (
            <p className="mt-0.5 text-xs text-slate-slate400">{FEATURE_NOTES[feature.id](feature.enabled === true)}</p>
          )}
          <p className="mt-0.5 text-xs text-slate-slate300">
            This calls the internet:{' '}
            <span className="font-mono">{(feature.hosts ?? []).join(', ')}</span>
          </p>
        </div>
        <SwitchToggle
          checked={feature.enabled === true}
          disabled={busy}
          labelledBy={labelId}
          describedBy={descId}
          onChange={change}
        />
      </div>
      {feature.id === 'weather' && feature.enabled === true && <WeatherLocationControl />}
      {error && (
        <p role="alert" className="mt-1.5 text-xs text-accent-amber">
          {error}
        </p>
      )}
    </li>
  );
}

export default function NetworkSection() {
  const { features, isLoading, refetch, setEnabled } = useNetworkSettings();
  const { info, isLoading: infoLoading } = useAppInfo();
  const storeBuild = info?.distribution === 'store';

  return (
    <SectionCard
      {...sectionProps('network')}
      title="Network"
      subtitle="Burrow makes no internet calls on its own. Each feature below is off until you turn it on."
      icon={Globe}
    >
      {isLoading ? (
        <ListSkeleton rows={4} />
      ) : !features ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-accent-amber">
            Couldn&apos;t load network settings.
          </p>
          <button type="button" onClick={() => refetch()} className={BTN}>
            Retry
          </button>
        </div>
      ) : (
        <>
          <ul role="list" aria-label="Network features" className="divide-y divide-white/10">
            {features.map((feature) => {
              // Hold the updates row back until the build is known, so a Store build never flashes the update switch.
              if (feature.id === 'updates' && infoLoading === true) return null;
              return storeBuild && feature.id === 'updates' ? (
                <StoreUpdatesRow key={feature.id} feature={feature} />
              ) : (
                <FeatureRow key={feature.id} feature={feature} onToggle={setEnabled} />
              );
            })}
          </ul>
          <div className="mt-3 border-t border-white/10 pt-3">
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent(SHOW_NETWORK_ACTIVITY_EVENT))}
              className={BTN}
            >
              See network activity
            </button>
          </div>
        </>
      )}
    </SectionCard>
  );
}
