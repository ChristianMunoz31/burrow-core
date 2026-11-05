import { useId, useState } from 'react';
import { SaveError } from './aiFormParts';
import {
  CLOUD_CATEGORY_DEFAULTS,
  CLOUD_CATEGORY_IDS,
  CLOUD_CATEGORY_LABELS,
} from '../../constants/cloudAi';

/**
 * Which kinds of data cloud AI may see. Every change saves at once; the checkboxes always show
 * what the server last reported, so a failed save leaves them as they were.
 * @param {{ categories?: Record<string, boolean>, host: string|null,
 *   onChange: (patch: Record<string, boolean>) => Promise<unknown> }} props
 */
export default function CloudCategoryList({ categories, host, onChange }) {
  const baseId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const toggle = async (id, checked) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await onChange({ [id]: checked });
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="min-w-0" aria-busy={busy || undefined}>
      <legend className="text-sm font-semibold text-slate-slate100">What cloud AI can see</legend>
      <p className="mt-0.5 text-xs text-slate-slate400">
        Only the kinds you tick are ever sent to {host ?? 'your provider'}. Javi tells you when it can&apos;t
        see something.
      </p>
      <ul role="list" className="mt-2 grid gap-x-4 gap-y-2 sm:grid-cols-2">
        {CLOUD_CATEGORY_IDS.map((id) => {
          const { label, hint } = CLOUD_CATEGORY_LABELS[id];
          const checked = (categories?.[id] ?? CLOUD_CATEGORY_DEFAULTS[id]) === true;
          const hintId = `${baseId}-${id}-hint`;
          return (
            <li key={id}>
              <label
                className={`flex items-start gap-2 text-sm text-slate-slate100 ${busy ? 'cursor-not-allowed opacity-60' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  aria-disabled={busy || undefined}
                  aria-describedby={hint ? hintId : undefined}
                  onChange={(e) => toggle(id, e.target.checked)}
                  className="mt-0.5 shrink-0"
                />
                <span>{label}</span>
              </label>
              {hint && (
                <p id={hintId} className="ml-6 text-xs text-slate-slate400">
                  {hint}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <SaveError error={error} kind="cloud" />
      <p role="status" className="mt-1 text-xs text-slate-slate300 empty:hidden">
        {saved ? 'Saved.' : ''}
      </p>
    </fieldset>
  );
}
