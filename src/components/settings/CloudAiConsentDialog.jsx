import { useId, useRef, useState } from 'react';
import Modal from '../shared/Modal';
import { BTN } from './pillStyles';
import { PRIMARY_BTN } from './aiFormStyles';
import {
  CLOUD_CATEGORY_DEFAULTS,
  CLOUD_CATEGORY_IDS,
  CLOUD_CONSENT_ACKS,
  CLOUD_CONSENT_VERSION,
} from '../../constants/cloudAi';
import { categoryLabels, joinList } from '../../utils/cloudLabels';

const SUBMIT_ERROR_COPY = {
  consent_outdated: 'These terms were updated. Close this and try again.',
  host_changed: 'The provider address changed. Close this and try again.',
  cloud_not_configured: 'Add the provider address, model and API key first.',
};

const ackText = (host) => ({
  sends_data: `I understand my data goes to ${host}, and that company's privacy policy applies to it, not Burrow's.`,
  pay_provider: `I understand I pay ${host} directly for this. Burrow doesn't charge for it and can't see or limit the cost.`,
});

/**
 * The one place cloud AI is turned on. Both statements must be ticked first; the confirm button
 * stays focusable (aria-disabled) so that pressing it early explains what is missing.
 * `onConfirm` receives the exact body for POST /api/settings/ai/cloud/enable and may reject.
 * @param {{ host: string, baseUrl: string, categories: Record<string, boolean>,
 *   onConfirm: (input: { version: number, host: string, baseUrl: string, acknowledgements: string[] }) => Promise<unknown>,
 *   onCancel: () => void, finalFocusRef?: import('react').RefObject<HTMLElement | null> }} props
 */
export default function CloudAiConsentDialog({ host, baseUrl, categories, onConfirm, onCancel, finalFocusRef }) {
  const errorId = useId();
  const introId = useId();
  const boxes = useRef({});
  const [ticked, setTicked] = useState({ sends_data: false, pay_provider: false });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const allowed = CLOUD_CATEGORY_IDS.filter((id) => (categories?.[id] ?? CLOUD_CATEGORY_DEFAULTS[id]) === true);
  const withheld = CLOUD_CATEGORY_IDS.filter((id) => !allowed.includes(id));
  const allowedLabels = categoryLabels(allowed);
  const withheldLabels = categoryLabels(withheld);
  const texts = ackText(host);
  const ready = CLOUD_CONSENT_ACKS.every((id) => ticked[id]);

  const toggle = (id) => (e) => {
    const next = { ...ticked, [id]: e.target.checked };
    setTicked(next);
    if (CLOUD_CONSENT_ACKS.every((ack) => next[ack])) setError(null);
  };

  const confirm = async () => {
    if (busy) return;
    if (!ready) {
      setError('Tick both boxes to continue.');
      const first = CLOUD_CONSENT_ACKS.find((id) => !ticked[id]);
      boxes.current[first]?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConfirm({
        version: CLOUD_CONSENT_VERSION,
        host,
        baseUrl,
        acknowledgements: [...CLOUD_CONSENT_ACKS],
      });
    } catch (err) {
      setError(SUBMIT_ERROR_COPY[err?.code] ?? "Couldn't turn on cloud AI. Try again.");
      setBusy(false);
    }
  };

  return (
    <Modal title="Turn on your own cloud AI" onClose={onCancel} dismissible={!busy} describedBy={introId} finalFocusRef={finalFocusRef}>
      <div className="space-y-4 text-sm text-slate-slate200">
        <p id={introId}>Javi will send requests to {host} instead of running on this computer.</p>

        <section aria-labelledby={`${errorId}-leaves`}>
          <h3 id={`${errorId}-leaves`} className="font-semibold text-slate-slate100">
            What leaves your computer:
          </h3>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>What you ask Javi, and your recent conversation with Javi.</li>
            <li>
              {allowedLabels.length > 0
                ? `Data from the kinds you allow: ${joinList(allowedLabels)}.`
                : 'No saved data. Javi will only see what you type.'}
            </li>
            <li>Your display name, if you set one.</li>
          </ul>
        </section>

        <section aria-labelledby={`${errorId}-stays`}>
          <h3 id={`${errorId}-stays`} className="font-semibold text-slate-slate100">
            What stays here:
          </h3>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {withheldLabels.length > 0 && (
              <li>{joinList(withheldLabels)}. You can change this any time in Settings &gt; AI.</li>
            )}
            <li>Javi&apos;s saved memory about you.</li>
            <li>Your API key. It is stored encrypted on this computer and only sent to {host}.</li>
          </ul>
        </section>

        <div className="space-y-2">
          {CLOUD_CONSENT_ACKS.map((id) => (
            <label key={id} className="flex items-start gap-2">
              <input
                ref={(el) => {
                  boxes.current[id] = el;
                }}
                type="checkbox"
                checked={ticked[id]}
                onChange={toggle(id)}
                aria-describedby={error ? errorId : undefined}
                className="mt-0.5 shrink-0"
              />
              <span>{texts[id]}</span>
            </label>
          ))}
        </div>

        <p className="text-xs text-slate-slate400">
          This also turns on &quot;Cloud AI provider&quot; in Settings &gt; Network.
        </p>

        <p id={errorId} role="alert" className="text-xs text-accent-amber empty:hidden">
          {error}
        </p>

        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className={BTN}>
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            aria-disabled={!ready || busy || undefined}
            aria-describedby={error ? errorId : undefined}
            className={PRIMARY_BTN}
          >
            {busy ? 'Turning on…' : 'Turn on cloud AI'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
