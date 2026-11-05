import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Upload } from 'lucide-react';
import Modal from '../shared/Modal';
import { btnPrimary, btnSecondary, inputClass } from '../shared/formStyles';
import { useNetworkFeature } from '../../hooks/useNetworkFeature';
import { sheetsService } from '../../services/sheetsService';
import { transactionImportService } from '../../services/transactionImportService';
import { isNetworkOptInError } from '../../utils/apiError';
import { formatCurrency } from '../../utils/budgetAggregate';
import {
  CsvImportError,
  buildRows,
  columnValues,
  dateOrderExamples,
  detectDateOrder,
  detectFormat,
  effectiveDateOrder,
  parseCsvTable,
  readCsvFile,
  toImportPayload,
} from '../../utils/csvImport';

const STEPS = [
  { id: 'file', label: 'Choose a file' },
  { id: 'match', label: 'Match columns' },
  { id: 'review', label: 'Check and import' },
  { id: 'done', label: 'Done' },
];
const PREVIEW_ROWS = 10;
const BAD_ROWS_SHOWN = 100;
const NONE = '';
// The server accepts 4 MB of JSON; stay a little under it so a borderline file is caught here.
const MAX_PAYLOAD_BYTES = 3.9 * 1024 * 1024;

const focusRing =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-slateBlueLight';
const touch = 'max-sm:min-h-11';
const busyStyle = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50';
const primaryBtn = `${btnPrimary} ${touch} ${busyStyle}`;
const secondaryBtn = `${btnSecondary} ${touch} ${busyStyle}`;
const fieldClass = `${inputClass} ${touch}`;
const fieldLabel = 'mb-1 block text-sm font-medium text-slate-slate300';
const errorClass = 'text-sm text-accent-red';
const hintClass = 'text-sm text-slate-slate300';
const radioRow = 'flex items-start gap-2 py-2 text-sm text-slate-slate200';
const footer = 'mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between';
const footerEnd = 'mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end';
const plural = (n, one, many) => (n === 1 ? one : many);

const toIdx = (v) => (v === NONE ? null : Number(v));
const fromIdx = (n) => (n === null || n === undefined ? NONE : String(n));

const GENERIC_READ_ERROR = 'We could not read that file. Check that it is a CSV export and try again.';
const SPLIT_FILE_ADVICE =
  'That is too much to import in one go. Split the file into two or more smaller files and import them one at a time.';

function sheetErrorMessage(err) {
  switch (err?.status) {
    case 413:
      return 'That sheet is too big to import. Sheets up to 5 MB can be loaded.';
    case 504:
      return 'Google took too long to answer. Try again in a moment.';
    case 429:
      return 'You have tried that too many times. Wait a few minutes and try again.';
    case 400:
      return 'That link cannot be used. Paste a published Google Sheet link (File, Share, Publish to web).';
    default:
      return 'We could not load that sheet. Check that the link is published as a CSV and try again.';
  }
}

function payloadBytes(body) {
  return new TextEncoder().encode(JSON.stringify(body)).length;
}

function StepIndicator({ current }) {
  const at = STEPS.findIndex((s) => s.id === current);
  return (
    <ol aria-label="Import steps" className="mb-5 flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {STEPS.map((s, i) => {
        const state = i < at ? 'done' : i === at ? 'current' : 'todo';
        return (
          <li
            key={s.id}
            aria-current={state === 'current' ? 'step' : undefined}
            className={
              state === 'current'
                ? 'font-semibold text-slate-slate100'
                : state === 'done'
                  ? 'text-accent-green'
                  : 'text-slate-slate400'
            }
          >
            <span aria-hidden="true">{i + 1}. </span>
            {s.label}
            {state === 'done' && <span className="sr-only"> (finished)</span>}
            {state === 'current' && <span className="sr-only"> (current step)</span>}
          </li>
        );
      })}
    </ol>
  );
}

function SheetsOffNote({ onNavigate }) {
  return (
    <p className={`${hintClass} text-slate-slate400`}>
      Turn on Google Sheets in{' '}
      <Link
        to={{ pathname: '/settings', hash: '#network' }}
        onClick={onNavigate}
        className={`font-medium underline underline-offset-2 hover:text-slate-slate100 ${focusRing}`}
      >
        Settings &gt; Network
      </Link>{' '}
      to import from a link
    </p>
  );
}

function ColumnSelect({ label, value, onChange, headers, noneLabel }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={fieldLabel}>
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={fieldClass}>
        {noneLabel ? <option value={NONE}>{noneLabel}</option> : <option value={NONE}>Choose a column</option>}
        {headers.map((h, i) => (
          <option key={i} value={String(i)}>
            {h || `Column ${i + 1}`}
          </option>
        ))}
      </select>
    </div>
  );
}

function RadioGroup({ legend, name, value, onChange, options, hint }) {
  return (
    <fieldset className="space-y-1">
      <legend className="mb-1 text-sm font-medium text-slate-slate100">{legend}</legend>
      {hint && <p className={hintClass}>{hint}</p>}
      {options.map((o) => (
        <label key={o.value} className={radioRow}>
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            className="mt-0.5"
          />
          <span>{o.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * Import transactions from a CSV file (or a published Google Sheet link). Mounted == open:
 * the Budget page renders it only while open so every open starts fresh. Reading and parsing
 * happen in the browser; only the final preview and import calls go to the local Burrow server.
 * @param {{ onClose: () => void, finalFocusRef?: import('react').RefObject<HTMLElement> }} props
 */
export default function ImportTransactionsDialog({ onClose, finalFocusRef }) {
  const queryClient = useQueryClient();
  const sheets = useNetworkFeature('sheets');
  const fileInputId = useId();
  const sheetInputId = useId();
  const headingId = useId();
  const hintId = useId();
  const headingRef = useRef(null);
  const errorRef = useRef(null);
  const prevStep = useRef('file');
  const mountedRef = useRef(false);
  const busyRef = useRef('');

  const [step, setStep] = useState('file');
  const [source, setSource] = useState('file');
  const [fileName, setFileName] = useState('');
  const [table, setTable] = useState(null);
  const [format, setFormat] = useState(null);
  const [mode, setMode] = useState('single');
  const [cols, setCols] = useState({
    date: NONE, merchant: NONE, amount: NONE, debit: NONE, credit: NONE, category: NONE,
  });
  const [expensesAre, setExpensesAre] = useState('negative');
  const [dateChoice, setDateChoice] = useState(null);
  const [plan, setPlan] = useState(null); // { rows, bad, result }
  const [done, setDone] = useState(null); // { inserted, duplicates, bad }

  const [dragging, setDragging] = useState(false);
  const [sheetUrl, setSheetUrl] = useState('');
  const [sheetOff, setSheetOff] = useState(false);
  const [busy, setBusy] = useState(''); // '' | 'reading' | 'checking' | 'importing'
  const [error, setError] = useState('');
  const [errorTick, setErrorTick] = useState(0);

  const fail = (message) => {
    setError(message);
    setErrorTick((t) => t + 1);
  };
  const startBusy = (kind) => {
    busyRef.current = kind;
    setBusy(kind);
  };
  const endBusy = () => {
    busyRef.current = '';
    if (mountedRef.current) setBusy('');
  };

  // Late results (a slow read or request that finishes after the dialog closed) are ignored.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Move focus to the new step's heading so keyboard and screen reader users land on it.
  useEffect(() => {
    if (prevStep.current === step) return;
    prevStep.current = step;
    headingRef.current?.focus();
  }, [step]);

  // A new error takes focus so it is announced and keyboard users are not left on a control
  // that may have just disabled itself.
  useEffect(() => {
    if (!error) return;
    errorRef.current?.focus();
    errorRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [error, errorTick]);

  // A missed drop on the dialog must not make the browser navigate to the dropped file.
  useEffect(() => {
    const stop = (e) => e.preventDefault();
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, []);

  const mapping = useMemo(
    () => ({
      mode,
      date: toIdx(cols.date),
      merchant: toIdx(cols.merchant),
      amount: toIdx(cols.amount),
      debit: toIdx(cols.debit),
      credit: toIdx(cols.credit),
      category: toIdx(cols.category),
    }),
    [mode, cols],
  );
  const dateValues = useMemo(() => (table ? columnValues(table, mapping.date) : []), [table, mapping.date]);
  const detectedOrder = useMemo(() => detectDateOrder(dateValues), [dateValues]);
  const examples = useMemo(
    () => (detectedOrder === 'ambiguous' ? dateOrderExamples(dateValues) : null),
    [detectedOrder, dateValues],
  );
  const needsDateChoice = detectedOrder === 'ambiguous' && dateChoice === null;
  const amountReady = mode === 'split' ? mapping.debit !== null && mapping.credit !== null : mapping.amount !== null;
  const columnsReady = mapping.date !== null && mapping.merchant !== null && amountReady;
  const setCol = (key) => (value) => {
    setCols((c) => ({ ...c, [key]: value }));
    // The answer was about the old column's dates; ask again for the new one.
    if (key === 'date') setDateChoice(null);
  };

  const loadText = (text, from, name) => {
    try {
      const parsed = parseCsvTable(text);
      const fmt = detectFormat(parsed.headers, parsed.rows.map((r) => r.cells));
      const m = fmt.mapping;
      setTable(parsed);
      setFormat(fmt);
      setSource(from);
      setFileName(name);
      setMode(m.mode);
      setCols({
        date: fromIdx(m.date),
        merchant: fromIdx(m.merchant),
        amount: fromIdx(m.amount),
        debit: fromIdx(m.debit),
        credit: fromIdx(m.credit),
        category: fromIdx(m.category),
      });
      setExpensesAre(fmt.expensesAre);
      setDateChoice(null);
      setPlan(null);
      setError('');
      setStep('match');
    } catch (err) {
      fail(err instanceof CsvImportError ? err.message : GENERIC_READ_ERROR);
    }
  };

  const handleFile = async (file) => {
    if (!file || busyRef.current) return;
    setError('');
    startBusy('reading');
    try {
      const text = await readCsvFile(file);
      if (mountedRef.current) loadText(text, 'file', file.name);
    } catch (err) {
      if (mountedRef.current) {
        fail(err instanceof CsvImportError ? err.message : 'We could not read that file. Try choosing it again.');
      }
    } finally {
      endBusy();
    }
  };

  const handleSheet = async () => {
    const url = sheetUrl.trim();
    if (!url || busyRef.current) return;
    setError('');
    setSheetOff(false);
    startBusy('reading');
    try {
      const csv = await sheetsService.fetchCsv(url);
      if (mountedRef.current) loadText(csv, 'sheet', '');
    } catch (err) {
      if (mountedRef.current) {
        if (isNetworkOptInError(err)) setSheetOff(true);
        else fail(sheetErrorMessage(err));
      }
    } finally {
      endBusy();
    }
  };

  const badSummary = (bad) => `${bad.length} ${plural(bad.length, 'row', 'rows')} could not be read`;

  const handleCheck = async () => {
    if (busyRef.current || !table || !columnsReady || needsDateChoice) return;
    const built = buildRows(table, mapping, {
      dateOrder: effectiveDateOrder(detectedOrder, dateChoice),
      expensesAre,
    });
    if (built.rows.length === 0) {
      fail(
        `None of the rows could be read. Check the columns you picked${
          built.bad[0] ? `. For example, line ${built.bad[0].line}: ${built.bad[0].reason}.` : '.'
        }`,
      );
      return;
    }
    const payload = toImportPayload(built.rows);
    const name = source === 'file' ? fileName : undefined;
    if (payloadBytes({ rows: payload, source, fileName: name }) > MAX_PAYLOAD_BYTES) {
      fail(SPLIT_FILE_ADVICE);
      return;
    }
    setError('');
    startBusy('checking');
    try {
      const result = await transactionImportService.importRows({
        rows: payload,
        source,
        fileName: name,
        dryRun: true,
      });
      if (!mountedRef.current) return;
      setPlan({ rows: built.rows, bad: built.bad, result });
      setStep('review');
    } catch (err) {
      if (mountedRef.current) fail(errorWithLines(err, built.rows));
    } finally {
      endBusy();
    }
  };

  const handleImport = async () => {
    if (busyRef.current || !plan) return;
    setError('');
    startBusy('importing');
    let result;
    try {
      result = await transactionImportService.importRows({
        rows: toImportPayload(plan.rows),
        source,
        fileName: source === 'file' ? fileName : undefined,
      });
    } catch (err) {
      if (mountedRef.current) fail(errorWithLines(err, plan.rows));
      endBusy();
      return;
    }
    // The import worked: show that first. A failed refresh below must never read as "nothing imported".
    if (mountedRef.current) {
      setDone({ inserted: result.inserted, duplicates: result.duplicates, bad: plan.bad.length });
      setStep('done');
    }
    endBusy();
    try {
      await queryClient.invalidateQueries({ queryKey: ['transactions'] });
    } catch {
      // The data refreshes on the next load; the import itself already succeeded.
    }
  };

  const goBack = (to) => {
    if (busyRef.current) return;
    setError('');
    if (to === 'match') setPlan(null);
    setStep(to);
  };

  const working = busy !== '';
  const status =
    busy === 'reading'
      ? 'Reading your file'
      : busy === 'checking'
        ? 'Checking for duplicates'
        : busy === 'importing'
          ? 'Importing your transactions'
          : '';

  const heading = (text, describedBy) => (
    <h3
      ref={headingRef}
      id={headingId}
      tabIndex={-1}
      aria-describedby={describedBy}
      className="mb-3 text-base font-semibold text-slate-slate100 focus:outline-none"
    >
      {text}
    </h3>
  );

  const matchHint = !columnsReady
    ? mode === 'split'
      ? 'Choose a column for Date, Description, Money out and Money in to continue.'
      : 'Choose a column for Date, Description and Amount to continue.'
    : needsDateChoice
      ? 'Pick how dates are written to continue.'
      : '';

  return (
    <Modal
      title="Import transactions"
      onClose={onClose}
      size="lg"
      dismissible={busy !== 'importing'}
      backdropDismiss={step === 'file' || step === 'done'}
      finalFocusRef={finalFocusRef}
    >
      <StepIndicator current={step} />

      <p role="status" className="sr-only">
        {status}
      </p>
      {error && (
        <p ref={errorRef} role="alert" tabIndex={-1} className={`mb-3 ${errorClass} focus:outline-none ${focusRing}`}>
          {error}
        </p>
      )}

      {step === 'file' && (
        <section aria-labelledby={headingId}>
          {heading('Choose a file')}
          <p className={`mb-3 ${hintClass}`}>
            Choose the spreadsheet file (CSV) you downloaded from your bank. Your file is read right here in
            Burrow.
          </p>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (busyRef.current) return;
              handleFile(e.dataTransfer?.files?.[0]);
            }}
            className={`rounded-lg border border-dashed p-5 text-center transition-colors ${
              dragging ? 'border-slate-slateBlue bg-slate-slateBlue/10' : 'border-slate-slate600'
            }`}
          >
            <Upload size={20} aria-hidden="true" className="mx-auto mb-2 text-slate-slate400" />
            <label htmlFor={fileInputId} className="mb-1 block text-sm font-medium text-slate-slate300">
              Choose a CSV file
            </label>
            <input
              id={fileInputId}
              type="file"
              accept=".csv,text/csv"
              aria-disabled={working || undefined}
              onClick={(e) => {
                if (busyRef.current) e.preventDefault();
              }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                handleFile(file);
              }}
              className={`mx-auto block max-w-full text-sm text-slate-slate200 ${touch} file:mr-3 file:rounded-md file:border-0 file:bg-slate-slateBlue file:px-3 file:py-2.5 file:text-sm file:font-semibold file:text-white hover:file:bg-slate-slateBlueDark`}
            />
            <p className={`mt-3 ${dragging ? '' : 'hidden sm:block'} ${hintClass}`}>
              {dragging ? 'Drop the file to load it' : 'or drag it here'}
            </p>
          </div>

          {!sheets.settingsLoading && (
            <div className="mt-5 border-t border-slate-slate700 pt-4">
              <h4 className="mb-2 text-sm font-medium text-slate-slate100">
                Import from a published Google Sheet link
              </h4>
              {sheets.enabled ? (
                <form
                  noValidate
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSheet();
                  }}
                  className="space-y-2"
                >
                  <label htmlFor={sheetInputId} className={fieldLabel}>
                    Published Google Sheet link
                  </label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      id={sheetInputId}
                      type="url"
                      value={sheetUrl}
                      onChange={(e) => setSheetUrl(e.target.value)}
                      placeholder="https://docs.google.com/spreadsheets/d/e/.../pub?output=csv"
                      className={`${fieldClass} min-w-0 flex-1`}
                    />
                    <button
                      type="submit"
                      aria-disabled={working || undefined}
                      disabled={!sheetUrl.trim()}
                      className={primaryBtn}
                    >
                      Load sheet
                    </button>
                  </div>
                  <ol className={`list-decimal space-y-0.5 pl-5 ${hintClass}`}>
                    <li>In Google Sheets, open &quot;File&quot;, then &quot;Share&quot;, then &quot;Publish to web&quot;.</li>
                    <li>Choose &quot;Comma-separated values (.csv)&quot; and select Publish.</li>
                    <li>Paste the link above. Burrow contacts Google to fetch the sheet.</li>
                  </ol>
                </form>
              ) : null}
              {(sheets.offError || sheetOff) && <SheetsOffNote onNavigate={onClose} />}
            </div>
          )}
        </section>
      )}

      {step === 'match' && table && format && (
        <section aria-labelledby={headingId}>
          {heading('Match columns')}
          <p className={`mb-4 ${hintClass}`}>
            {format.recognized
              ? `This looks like a ${format.name} export. Check that the columns below are right.`
              : 'We matched your columns automatically. Check that they are right.'}{' '}
            {table.rows.length} {plural(table.rows.length, 'row', 'rows')} found.
          </p>

          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <ColumnSelect label="Date" value={cols.date} onChange={setCol('date')} headers={table.headers} />
              <ColumnSelect
                label="Description"
                value={cols.merchant}
                onChange={setCol('merchant')}
                headers={table.headers}
              />
            </div>

            <RadioGroup
              legend="How are amounts shown in this file?"
              name="amount-mode"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'single', label: 'My file has one amount column' },
                { value: 'split', label: 'My file has separate columns for money in and money out' },
              ]}
            />

            {mode === 'single' ? (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <ColumnSelect
                    label="Amount"
                    value={cols.amount}
                    onChange={setCol('amount')}
                    headers={table.headers}
                  />
                </div>
                <RadioGroup
                  legend="In this file, money spent shows as"
                  name="expenses-are"
                  value={expensesAre}
                  onChange={setExpensesAre}
                  options={[
                    { value: 'negative', label: 'Negative numbers (like -12.50)' },
                    { value: 'positive', label: 'Positive numbers (like 12.50)' },
                  ]}
                />
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <ColumnSelect
                  label="Money out"
                  value={cols.debit}
                  onChange={setCol('debit')}
                  headers={table.headers}
                />
                <ColumnSelect
                  label="Money in"
                  value={cols.credit}
                  onChange={setCol('credit')}
                  headers={table.headers}
                />
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <ColumnSelect
                label="Category"
                value={cols.category}
                onChange={setCol('category')}
                headers={table.headers}
                noneLabel="Pick automatically"
              />
            </div>

            {detectedOrder === 'ambiguous' && examples && (
              <RadioGroup
                legend="How are dates written in this file?"
                name="date-order"
                value={dateChoice}
                onChange={setDateChoice}
                hint="Every date in this file could be read two ways, so we need you to pick one."
                options={[
                  { value: 'mdy', label: `${examples.sample} means ${examples.mdy}` },
                  { value: 'dmy', label: `${examples.sample} means ${examples.dmy}` },
                ]}
              />
            )}
            {detectedOrder === 'mixed' && (
              <p className="text-sm text-accent-yellow">
                The dates in this file are not all written the same way. Rows that do not fit will be left
                out and listed on the next screen.
              </p>
            )}
          </div>

          <div className={footer}>
            <button
              type="button"
              onClick={() => goBack('file')}
              aria-disabled={working || undefined}
              className={secondaryBtn}
            >
              Back
            </button>
            <div className="flex flex-col items-stretch gap-1 sm:items-end">
              {matchHint && (
                <p id={hintId} className={hintClass}>
                  {matchHint}
                </p>
              )}
              <button
                type="button"
                onClick={handleCheck}
                aria-disabled={working || undefined}
                aria-describedby={matchHint ? hintId : undefined}
                disabled={!columnsReady || needsDateChoice}
                className={primaryBtn}
              >
                {busy === 'checking' ? 'Checking…' : 'Check my transactions'}
              </button>
            </div>
          </div>
        </section>
      )}

      {step === 'review' && plan && (
        <ReviewStep
          plan={plan}
          heading={heading}
          headingId={headingId}
          working={working}
          busy={busy}
          onBack={() => goBack('match')}
          onImport={handleImport}
          badSummary={badSummary}
        />
      )}

      {step === 'done' && done && <DoneStep done={done} heading={heading} headingId={headingId} onClose={onClose} />}
    </Modal>
  );
}

function DoneStep({ done, heading, headingId, onClose }) {
  const summaryId = useId();
  return (
    <section aria-labelledby={headingId}>
      {heading('Done', summaryId)}
      <p id={summaryId} className="flex items-start gap-2 text-sm text-slate-slate100">
        <Check size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-green" />
        <span>
          Imported {done.inserted} {plural(done.inserted, 'transaction', 'transactions')}.
          {done.duplicates > 0 &&
            ` ${done.duplicates} ${plural(done.duplicates, 'duplicate was', 'duplicates were')} skipped.`}
          {done.bad > 0 &&
            ` ${done.bad} ${plural(done.bad, 'row', 'rows')} could not be read and ${plural(done.bad, 'was', 'were')} left out.`}
        </span>
      </p>
      <div className={footerEnd}>
        <button type="button" onClick={onClose} className={primaryBtn}>
          Close
        </button>
      </div>
    </section>
  );
}

function errorWithLines(err, rows) {
  const base = err?.message || 'Something went wrong and nothing was imported. Try again in a moment.';
  if (err?.code !== 'invalid_rows' || !Array.isArray(err.details)) return base;
  const lines = [
    ...new Set(err.details.map((d) => rows[d?.index]?.line).filter((l) => Number.isInteger(l))),
  ].slice(0, 10);
  return lines.length > 0 ? `${base} Check ${plural(lines.length, 'line', 'lines')} ${lines.join(', ')}.` : base;
}

function ReviewStep({ plan, heading, headingId, working, busy, onBack, onImport, badSummary }) {
  const summaryId = useId();
  const nothingId = useId();
  const { rows, bad, result } = plan;
  const dupes = new Set(result.duplicateIndexes ?? []);
  const fresh = result.inserted ?? Math.max(0, rows.length - dupes.size);
  const skipped = result.duplicates ?? dupes.size;
  const preview = rows.slice(0, PREVIEW_ROWS);
  return (
    <section aria-labelledby={headingId}>
      {heading('Check and import', summaryId)}
      <p id={summaryId} className="text-sm font-semibold text-slate-slate100">
        {`${fresh} new, ${skipped} ${plural(skipped, 'duplicate', 'duplicates')} skipped`}
      </p>
      {bad.length > 0 && (
        <details className="mt-2 text-sm text-slate-slate300">
          <summary className={`cursor-pointer py-2 text-accent-red ${touch} ${focusRing}`}>{badSummary(bad)}</summary>
          <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto pl-4 text-slate-slate300">
            {bad.slice(0, BAD_ROWS_SHOWN).map((b) => (
              <li key={b.line}>
                Line {b.line}: {b.reason}
              </li>
            ))}
            {bad.length > BAD_ROWS_SHOWN && <li>and {bad.length - BAD_ROWS_SHOWN} more</li>}
          </ul>
        </details>
      )}

      <div
        role="region"
        aria-label="Transaction preview"
        tabIndex={0}
        className={`mt-3 overflow-x-auto rounded-lg border border-slate-slate700 ${focusRing}`}
      >
        <table className="w-full min-w-[34rem] text-left text-sm text-slate-slate300">
          <caption className="sr-only">
            {`Preview of the first ${preview.length} ${plural(preview.length, 'transaction', 'transactions')}`}
          </caption>
          <thead className="bg-slate-slate800 text-slate-slate300">
            <tr>
              <th scope="col" className="px-2 py-1.5 font-medium">Date</th>
              <th scope="col" className="px-2 py-1.5 font-medium">Description</th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">Amount</th>
              <th scope="col" className="px-2 py-1.5 font-medium">Type</th>
              <th scope="col" className="px-2 py-1.5 font-medium">Category</th>
            </tr>
          </thead>
          <tbody>
            {preview.map((r, i) => {
              const dup = dupes.has(i);
              const plain = dup ? 'text-slate-slate400' : '';
              return (
                <tr key={r.line} className="border-t border-slate-slate800">
                  <td className={`whitespace-nowrap px-2 py-1.5 tabular-nums ${plain}`}>{r.date}</td>
                  <td className={`px-2 py-1.5 ${plain}`}>
                    {r.merchant}
                    {dup && (
                      <span className="ml-2 inline-block rounded bg-yellow-yellow/20 px-1.5 py-0.5 text-sm text-accent-yellow">
                        Duplicate, will be skipped
                      </span>
                    )}
                  </td>
                  <td
                    className={`whitespace-nowrap px-2 py-1.5 text-right tabular-nums ${
                      dup ? 'text-slate-slate400' : r.type === 'credit' ? 'text-accent-green' : 'text-slate-slate200'
                    }`}
                  >
                    {formatCurrency(Math.abs(r.amount))}
                  </td>
                  <td className={`px-2 py-1.5 ${plain}`}>{r.type === 'credit' ? 'Received' : 'Spent'}</td>
                  <td className={`px-2 py-1.5 ${plain}`}>{r.category}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length > preview.length && (
          <p className="bg-slate-slate800/50 px-2 py-1 text-sm text-slate-slate300">
            and {rows.length - preview.length} more
          </p>
        )}
      </div>

      {fresh === 0 && (
        <p id={nothingId} className={`mt-3 ${hintClass}`}>
          Everything in this file is already in Burrow, so there is nothing new to import. Go back to try a
          different file, or close this window.
        </p>
      )}
      <div className={footer}>
        <button
          type="button"
          onClick={onBack}
          aria-disabled={working || undefined}
          className={fresh === 0 ? primaryBtn : secondaryBtn}
        >
          Back
        </button>
        <button
          type="button"
          onClick={onImport}
          aria-disabled={working || undefined}
          aria-describedby={fresh === 0 ? nothingId : undefined}
          disabled={fresh === 0}
          className={primaryBtn}
        >
          {busy === 'importing' ? 'Importing…' : `Import ${fresh} ${plural(fresh, 'transaction', 'transactions')}`}
        </button>
      </div>
    </section>
  );
}
