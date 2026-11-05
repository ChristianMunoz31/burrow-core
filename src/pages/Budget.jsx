import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Upload } from 'lucide-react';
import BudgetPage from '../components/budget/BudgetPage';
import ImportTransactionsDialog from '../components/budget/ImportTransactionsDialog';
import {
  IMPORT_QUERY_PARAM,
  TRANSACTION_IMPORT_EVENT,
} from '../components/budget/openTransactionImport';

export default function Budget() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const importButtonRef = useRef(null);
  const openDialog = useCallback(() => setOpen(true), []);
  const closeDialog = useCallback(() => setOpen(false), []);

  // `?import=1` (command palette, links) opens the dialog; the param is then removed so a
  // reload or the Back button does not reopen it. Derived during render, no effect-driven state.
  const wantsImport = searchParams.get(IMPORT_QUERY_PARAM) === '1';
  if (wantsImport && !open) setOpen(true);
  useEffect(() => {
    if (!wantsImport) return;
    const next = new URLSearchParams(searchParams);
    next.delete(IMPORT_QUERY_PARAM);
    setSearchParams(next, { replace: true });
  }, [wantsImport, searchParams, setSearchParams]);

  // Opened from elsewhere while this page is mounted (Javi panel).
  useEffect(() => {
    window.addEventListener(TRANSACTION_IMPORT_EVENT, openDialog);
    return () => window.removeEventListener(TRANSACTION_IMPORT_EVENT, openDialog);
  }, [openDialog]);

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-slate-slate100 tracking-tight">Budget</h2>
          <p className="text-sm text-slate-slate400 mt-1">
            See what you planned to spend next to what you spent, based on your transactions.
          </p>
        </div>
        <button
          ref={importButtonRef}
          type="button"
          onClick={openDialog}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-slate600 px-3 py-1.5 max-sm:min-h-11 text-sm font-semibold text-slate-slate100 hover:bg-slate-slate700/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-slateBlueLight"
        >
          <Upload size={14} aria-hidden="true" />
          Import transactions
        </button>
      </div>
      <BudgetPage />
      {open && <ImportTransactionsDialog onClose={closeDialog} finalFocusRef={importButtonRef} />}
    </div>
  );
}
