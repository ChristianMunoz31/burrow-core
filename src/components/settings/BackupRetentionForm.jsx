import { useId, useRef, useState } from 'react';
import { BTN } from './pillStyles';

const FIELDS = [
  { key: 'keepDaily', label: 'Days to keep', min: 1, max: 60 },
  { key: 'keepWeekly', label: 'Weeks to keep', min: 0, max: 52 },
  { key: 'keepMonthly', label: 'Months to keep', min: 0, max: 60 },
];
const INPUT =
  'mt-1 block w-24 rounded-md border border-[color:var(--glass-border)] bg-transparent px-2 py-1.5 text-sm text-slate-slate100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)] aria-[invalid=true]:border-accent-amber';

const toDraft = (settings) => Object.fromEntries(FIELDS.map((f) => [f.key, String(settings?.[f.key] ?? '')]));

function validate(draft) {
  const values = {};
  const errors = {};
  for (const f of FIELDS) {
    const raw = draft[f.key].trim();
    const n = Number(raw);
    if (raw === '' || !Number.isInteger(n) || n < f.min || n > f.max) {
      errors[f.key] = `${f.label} must be a whole number from ${f.min} to ${f.max}.`;
    } else {
      values[f.key] = n;
    }
  }
  return { values, errors };
}

export default function BackupRetentionForm({ settings, onSave, saving = false, locked = false }) {
  const baseId = useId();
  const hintId = `${baseId}-hint`;
  const errorId = (key) => `${baseId}-${key}-error`;
  const [draft, setDraft] = useState(() => toDraft(settings));
  const [fieldErrors, setFieldErrors] = useState({});
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved] = useState(false);
  const inputRefs = useRef({});

  // Refill the fields when the saved settings change (adjusting state during render, not in an effect).
  const [seen, setSeen] = useState(settings);
  if (seen !== settings) {
    setSeen(settings);
    setDraft(toDraft(settings));
  }

  const submit = async (event) => {
    event.preventDefault();
    if (saving || locked) return;
    setSaved(false);
    setSaveError(null);
    const { values, errors } = validate(draft);
    setFieldErrors(errors);
    const firstBad = FIELDS.find((f) => errors[f.key]);
    if (firstBad) {
      inputRefs.current[firstBad.key]?.focus();
      return;
    }
    try {
      await onSave(values);
      setSaved(true);
    } catch (e) {
      setSaveError(e?.message || 'Could not save. Try again.');
    }
  };

  const change = (key) => (event) => {
    setSaved(false);
    setFieldErrors((prev) => ({ ...prev, [key]: undefined }));
    setDraft((prev) => ({ ...prev, [key]: event.target.value }));
  };

  return (
    <form onSubmit={submit} noValidate>
      <fieldset>
        <legend className="text-xs font-semibold text-slate-slate300">How many backups to keep</legend>
        <p id={hintId} className="mt-1 text-xs text-slate-slate400">
          Burrow keeps the newest backup from each day, week and month. Set weeks or months to 0 to turn that one off.
          Safety copies made before a restore are kept separately.
        </p>
        <div className="mt-2 flex flex-wrap items-start gap-3">
          {FIELDS.map((f) => {
            const problem = fieldErrors[f.key];
            return (
              <div key={f.key}>
                <label className="block text-xs font-semibold text-slate-slate300">
                  {f.label}
                  <input
                    ref={(node) => {
                      inputRefs.current[f.key] = node;
                    }}
                    type="number"
                    inputMode="numeric"
                    min={f.min}
                    max={f.max}
                    step={1}
                    value={draft[f.key]}
                    onChange={change(f.key)}
                    aria-invalid={problem ? 'true' : undefined}
                    aria-describedby={problem ? `${hintId} ${errorId(f.key)}` : hintId}
                    className={INPUT}
                  />
                </label>
                {problem && (
                  <p id={errorId(f.key)} role="alert" className="mt-1 max-w-[12rem] text-xs text-accent-amber">
                    {problem}
                  </p>
                )}
              </div>
            );
          })}
          <button
            type="submit"
            aria-disabled={saving || locked}
            aria-busy={saving}
            className={`${BTN} mt-5 self-start`}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </fieldset>
      <p role="status" className="sr-only">
        {saved ? 'Backup settings saved.' : ''}
      </p>
      {saved && (
        <p aria-hidden="true" className="mt-2 text-xs text-accent-green">
          Saved.
        </p>
      )}
      {saveError && (
        <p role="alert" className="mt-2 text-xs text-accent-amber">
          {saveError}
        </p>
      )}
    </form>
  );
}
