import { useId } from 'react';
import { Check } from 'lucide-react';
import { BACKGROUND_PRESETS } from '../../constants/settingsDefaults';

/**
 * Background preset picker: a native radio group (arrow keys work for free) where
 * each option shows a light + dark swatch. The swatches reuse the same
 * --mesh-<preset>-<theme>-<n> blob colors as the page background (see index.css),
 * laid out at swatch scale, so they never drift from what is applied.
 *
 * Props: legend (e.g. "Dark mode background"), value (preset id),
 * onChange(presetId), name (optional radio group name).
 */
export default function BackgroundPicker({ legend, value, onChange, name }) {
  const autoName = useId();
  const groupName = name ?? autoName;
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-sm font-semibold text-slate-slate100">{legend}</legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {BACKGROUND_PRESETS.map((preset) => {
          const selected = value === preset.id;
          return (
            <label key={preset.id} className="block cursor-pointer">
              <input
                type="radio"
                name={groupName}
                value={preset.id}
                checked={selected}
                onChange={() => onChange(preset.id)}
                className="peer sr-only"
              />
              <span
                className={`glass-subtle glass-hover block rounded-lg border-2 p-2 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:[outline-color:var(--focus-ring)] ${
                  selected
                    ? 'border-[color:var(--focus-ring)] hover:border-[color:var(--focus-ring)]'
                    : 'border-[color:var(--glass-border-strong)]'
                }`}
              >
                <span className="flex gap-1" aria-hidden="true">
                  {['dark', 'light'].map((variant) => (
                    <span
                      key={variant}
                      className="bg-swatch h-10 flex-1 rounded border border-[color:var(--glass-border-strong)]"
                      data-preset={preset.id}
                      data-variant={variant}
                    />
                  ))}
                </span>
                <span className="mt-1.5 flex items-center justify-between gap-1">
                  <span className="text-sm font-semibold text-slate-slate100">{preset.label}</span>
                  {selected && (
                    <Check size={14} className="shrink-0 text-slate-slate100" aria-hidden="true" />
                  )}
                </span>
                <span className="block text-xs text-slate-slate400">{preset.description}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
