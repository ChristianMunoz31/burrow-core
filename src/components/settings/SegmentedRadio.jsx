import { useId } from 'react';
import { Check } from 'lucide-react';

// Selected state carries a non-color cue (check icon) and a forced-colors outline,
// so it survives high-contrast modes and low-contrast color pairs. min-h keeps a
// ~36px touch target on small screens.
const OPTION_BASE =
  'flex min-h-9 cursor-pointer select-none items-center gap-1 rounded px-3 py-1 font-semibold text-slate-slate300 transition hover:text-slate-slate100 sm:min-h-0 forced-colors:peer-checked:outline forced-colors:peer-checked:outline-2 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:[outline-color:var(--focus-ring)]';
// The filled look is for settings; the quiet look is for toolbar filters, where Add todo stays the only filled control.
const OPTION_TONE = {
  filled: 'text-sm peer-checked:bg-slate-slateBlue peer-checked:text-white',
  quiet: 'text-xs peer-checked:bg-slate-slate700/60 peer-checked:text-slate-slate100',
};

/**
 * Segmented single-choice control built on native radios (arrow keys, form
 * semantics and screen reader grouping come for free). Matches the Budget
 * Dashboard/Planner view switcher look.
 *
 * Props: legend (visible group label), value, onChange(value), options
 * ([{ value, label }]), hint (optional muted helper text), name (optional), disabled (optional),
 * hideLegend (optional, default false: the legend stays the group's accessible name but is
 * visually hidden, for toolbar filters), tone (optional, 'filled' default or 'quiet': a tinted
 * selected pill for toolbar filters).
 */
export default function SegmentedRadio({
  legend,
  value,
  onChange,
  options,
  hint,
  name,
  disabled = false,
  hideLegend = false,
  tone = 'filled',
}) {
  const autoName = useId();
  const hintId = useId();
  const groupName = name ?? autoName;
  return (
    <fieldset className="min-w-0" disabled={disabled} aria-describedby={hint ? hintId : undefined}>
      <legend className={hideLegend ? 'sr-only' : 'mb-1.5 text-sm font-semibold text-slate-slate100'}>{legend}</legend>
      <div className="glass-subtle inline-flex flex-wrap gap-y-0.5 rounded-lg p-0.5">
        {options.map((opt) => (
          <label key={opt.value}>
            <input
              type="radio"
              name={groupName}
              value={opt.value}
              checked={value === opt.value}
              onChange={() => onChange(opt.value)}
              className="peer sr-only"
            />
            <span className={`${OPTION_BASE} ${OPTION_TONE[tone] ?? OPTION_TONE.filled}`}>
              {value === opt.value && <Check size={14} className="shrink-0" aria-hidden="true" />}
              {opt.label}
            </span>
          </label>
        ))}
      </div>
      {hint && <p id={hintId} className="mt-1.5 text-xs text-slate-slate400">{hint}</p>}
    </fieldset>
  );
}
