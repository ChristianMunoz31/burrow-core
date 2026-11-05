import { useEffect, useId, useRef, useState } from 'react';
import { Lock } from 'lucide-react';
import Modal from '../shared/Modal';
import OllamaSetup from '../shared/OllamaSetup';
import { btnPrimary, btnSecondary, formErrorClass, inputClass, labelClass } from '../shared/formStyles';
import { useProfile } from '../../hooks/useProfile';
import { useSyncedSetting } from '../../hooks/useSyncedSetting';
import { evalAmount } from '../../utils/evalAmount';
import budgetConfig from '../../data/budgetConfig.json';

const EMPTY_DEFAULTS = {};
const INCOME_GROUP_IDS = new Set(budgetConfig.groups.filter((g) => g.isIncome).map((g) => g.id));
const BUDGET_CATEGORIES = budgetConfig.categories
  .slice()
  .sort((a, b) => a.sortOrder - b.sortOrder)
  .map((c) => ({ id: c.id, name: c.name, isIncome: INCOME_GROUP_IDS.has(c.groupId) }));

const STEP_TITLE = { welcome: 'Welcome to Burrow', ai: 'Set up Javi', budget: 'Starter budget' };

/** Returns { amounts } with one number per filled field, or { invalid: name } for a bad entry. */
function parseAmounts(draft) {
  const amounts = {};
  for (const category of BUDGET_CATEGORIES) {
    const raw = (draft[category.id] ?? '').trim();
    if (raw === '') continue;
    const value = evalAmount(raw);
    if (value === null || value < 0) return { invalid: category.name };
    amounts[category.id] = value;
  }
  return { amounts };
}

/**
 * First-run welcome: privacy promise, optional display name, optional Ollama setup for Javi,
 * optional starter budget amounts. Skip and Finish mark the profile onboarded; Escape/backdrop/close only hide it
 * (welcome step, nothing typed) so typed input is never silently discarded.
 */
export default function OnboardingFlow({ onDismiss }) {
  const { save } = useProfile();
  const [, setDefaults] = useSyncedSetting('budget:defaults', EMPTY_DEFAULTS);
  const [step, setStep] = useState('welcome');
  const [name, setName] = useState('');
  const [draft, setDraft] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [aiReady, setAiReady] = useState(false);
  const nameId = useId();
  const errorId = useId();
  const descId = useId();
  const pullHintId = useId();
  const nameRef = useRef(null);
  const aiIntroRef = useRef(null);
  const firstAmountRef = useRef(null);

  // The modal focuses the first field on mount; later steps move focus themselves. On the Javi
  // step the intro paragraph takes focus so the step change is announced and Tab starts there.
  useEffect(() => {
    if (step === 'budget') firstAmountRef.current?.focus();
    else if (step === 'ai') aiIntroRef.current?.focus();
    else nameRef.current?.focus();
  }, [step]);

  const finish = async ({ withName, withAmounts }) => {
    if (busy) return;
    let amounts = {};
    if (withAmounts) {
      const parsed = parseAmounts(draft);
      if (parsed.invalid) {
        setError(`Enter ${parsed.invalid} as a number, for example 450.`);
        return;
      }
      amounts = parsed.amounts;
    }
    setBusy(true);
    if (Object.keys(amounts).length > 0) {
      setDefaults((prev) => ({ ...(prev && typeof prev === 'object' ? prev : {}), ...amounts }));
    }
    const trimmed = name.trim();
    await save(
      withName && trimmed ? { displayName: trimmed, onboarded: true } : { onboarded: true },
    );
  };

  const dismissible = step === 'welcome' && name.trim() === '' && Boolean(onDismiss);

  const skip = () => finish({ withName: false, withAmounts: false });

  return (
    <Modal
      title={STEP_TITLE[step]}
      onClose={() => onDismiss?.()}
      dismissible={dismissible}
      describedBy={descId}
    >
      {step === 'welcome' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setStep('ai');
          }}
        >
          <div
            id={descId}
            className="mb-4 flex gap-3 rounded-lg bg-slate-slate700/40 p-3 text-sm text-slate-slate300"
          >
            <Lock size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-slate-slate400" />
            <p>
              Your data stays on this device. Nothing calls the internet unless you turn it on in
              Settings.
            </p>
          </div>
          <label htmlFor={nameId} className={labelClass}>
            What should Burrow call you? (optional)
          </label>
          <input
            id={nameId}
            ref={nameRef}
            type="text"
            value={name}
            maxLength={60}
            autoComplete="nickname"
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            className={inputClass}
          />
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={skip} disabled={busy} className={btnSecondary}>
              Skip for now
            </button>
            <button type="submit" disabled={busy} className={btnPrimary}>
              Continue
            </button>
          </div>
        </form>
      ) : step === 'ai' ? (
        <div>
          <p
            id={descId}
            ref={aiIntroRef}
            tabIndex={-1}
            className="mb-3 text-sm text-slate-slate300 focus:outline-none"
          >
            Javi is Burrow&apos;s built-in AI helper. It is optional, and you can set it up later in
            Settings.
          </p>
          <OllamaSetup onReady={() => setAiReady(true)} onBusyChange={setPulling} />
          {pulling && (
            <p id={pullHintId} className="mt-3 text-right text-xs text-slate-slate300">
              Finish or cancel the download to continue
            </p>
          )}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => setStep('welcome')}
              disabled={pulling}
              aria-describedby={pulling ? pullHintId : undefined}
              className={btnSecondary}
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => setStep('budget')}
              disabled={pulling}
              aria-describedby={pulling ? pullHintId : undefined}
              className={aiReady ? btnPrimary : btnSecondary}
            >
              {aiReady ? 'Continue' : 'Skip for now'}
            </button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            finish({ withName: true, withAmounts: true });
          }}
        >
          <p id={descId} className="mb-3 text-sm text-slate-slate300">
            Optional monthly amounts for the starter categories. You can change them any time in
            the Budget planner.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {BUDGET_CATEGORIES.map((category, index) => {
              const id = `onboarding-budget-${category.id}`;
              return (
                <div key={category.id}>
                  <label htmlFor={id} className={labelClass}>
                    {category.isIncome ? `${category.name} (monthly)` : category.name}
                  </label>
                  <input
                    id={id}
                    ref={index === 0 ? firstAmountRef : undefined}
                    type="text"
                    inputMode="decimal"
                    value={draft[category.id] ?? ''}
                    placeholder="0"
                    aria-describedby={error ? errorId : undefined}
                    aria-invalid={error ? true : undefined}
                    onChange={(e) => {
                      setError('');
                      setDraft((prev) => ({ ...prev, [category.id]: e.target.value }));
                    }}
                    className={`${inputClass} tabular-nums`}
                  />
                </div>
              );
            })}
          </div>
          {error && (
            <p id={errorId} role="alert" className={`${formErrorClass} mt-3`}>
              {error}
            </p>
          )}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => setStep('ai')}
              disabled={busy}
              className={btnSecondary}
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => finish({ withName: true, withAmounts: false })}
              disabled={busy}
              className={btnSecondary}
            >
              Skip
            </button>
            <button type="submit" disabled={busy} className={btnPrimary}>
              Finish
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
