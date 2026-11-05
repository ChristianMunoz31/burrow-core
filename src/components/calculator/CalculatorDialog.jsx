import { useId, useRef, useState } from 'react';
import Modal from '../shared/Modal';
import { btnPrimary, formErrorClass, inputClass, labelClass } from '../shared/formStyles';
import { evaluate } from '../../utils/calc';

const HISTORY_MAX = 10;
// Session history: in memory only, survives close and reopen, gone on reload (never stored).
let session = [];
let nextHistoryId = 1; // stable keys for history rows

const MESSAGES = {
  invalid: "Burrow can't read that calculation. Use numbers, + - × ÷, parentheses and %.",
  divide_by_zero: "You can't divide by zero. Change the number you divide by.",
  too_long: 'That calculation is too long. Use 200 characters or fewer.',
  too_deep: 'That calculation has too many parentheses inside each other. Use 20 levels or fewer.',
  out_of_range: 'The result is too big or too small to show. Check the numbers and try again.',
};

/**
 * Calculator dialog over the shared Modal. Exact decimal math through utils/calc; display uses the runtime locale.
 * @param {{ onClose: () => void, finalFocusRef: { current: Element | null } }} props
 */
export default function CalculatorDialog({ onClose, finalFocusRef }) {
  const inputId = useId();
  const outId = useId();
  const historyId = useId();
  const inputRef = useRef(null);
  const [expr, setExpr] = useState('');
  const [out, setOut] = useState(null); // null | { display } | { error }
  const [history, setHistory] = useState(session);

  const submit = (e) => {
    e.preventDefault();
    const r = evaluate(expr);
    if (!r.ok) {
      if (r.error === 'empty') return;
      setOut({ error: MESSAGES[r.error] ?? MESSAGES.invalid });
      return;
    }
    const repeat = session[0]?.value === r.value;
    if (!repeat) {
      session = [{ id: nextHistoryId++, expr: expr.trim(), value: r.value, display: r.display }, ...session].slice(
        0,
        HISTORY_MAX,
      );
      setHistory(session);
    }
    if (repeat && out?.display) {
      // Same result again: a polite live region only speaks on a change, so clear it and set it again a tick later.
      setOut(null);
      queueMicrotask(() => setOut({ display: r.display }));
    } else {
      setOut({ display: r.display });
    }
    setExpr(r.value);
  };

  const recall = (value) => {
    setExpr(value);
    setOut(null);
    inputRef.current?.focus();
  };

  return (
    <Modal title="Calculator" size="sm" onClose={onClose} initialFocusRef={inputRef} finalFocusRef={finalFocusRef}>
      <form noValidate onSubmit={submit}>
        <label htmlFor={inputId} className={labelClass}>
          Calculation
        </label>
        <div className="flex gap-2">
          <input
            id={inputId}
            ref={inputRef}
            type="text"
            value={expr}
            onChange={(e) => {
              setExpr(e.target.value);
              if (out?.error) setOut(null);
            }}
            autoComplete="off"
            spellCheck={false}
            placeholder="For example 200 + 10%"
            aria-invalid={out?.error ? true : undefined}
            aria-describedby={outId}
            className={`${inputClass} tabular-nums`}
          />
          <button type="submit" className={btnPrimary}>
            Calculate
          </button>
        </div>
        <p
          id={outId}
          aria-live="polite"
          aria-atomic="true"
          className="mt-3 min-h-7 tabular-nums text-slate-slate100"
        >
          {out?.error && <span className={formErrorClass}>{out.error}</span>}
          {out?.display && (
            <>
              <span className="sr-only">Result: </span>
              <span className="select-all text-lg font-semibold">{out.display}</span>
            </>
          )}
        </p>
        {history.length > 0 && (
          <section aria-labelledby={historyId} className="mt-4">
            <h3 id={historyId} className="text-[10px] uppercase tracking-widest text-slate-slate400">
              Recent results
            </h3>
            <ol className="mt-1">
              {history.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => recall(h.value)}
                    className="w-full truncate rounded-md px-2 py-1 text-left text-sm tabular-nums text-slate-slate300 hover:bg-slate-slate700/60 hover:text-slate-slate100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-slateBlueLight"
                  >
                    {h.expr} = {h.display}
                  </button>
                </li>
              ))}
            </ol>
          </section>
        )}
      </form>
    </Modal>
  );
}
