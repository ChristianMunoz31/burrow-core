import { useCallback, useEffect, useRef, useState } from 'react';

/** Optimistic items carry a `temp-` id until the server confirms them. */
export const isTempId = (id) => String(id).startsWith('temp-');

/** State for an add/edit dialog plus a remove-confirmation, shared by CRUD pages. */
export function useCrudDialogs() {
  const [dialog, setDialog] = useState(null);
  const [pendingRemove, setPendingRemove] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useRef(null);
  useEffect(() => {
    dialogRef.current = dialog;
  }, [dialog]);

  const openAdd = useCallback((defaults = {}) => setDialog({ mode: 'add', item: null, defaults }), []);
  const openEdit = useCallback((item) => setDialog({ mode: 'edit', item }), []);
  const close = useCallback(() => setDialog(null), []);
  const askRemove = useCallback((item) => setPendingRemove(item), []);
  const cancelRemove = useCallback(() => setPendingRemove(null), []);

  /**
   * Wraps a form submit handler `fn(values, dialog)`. Marks the dialog as submitting
   * (pages disable dismissal), closes it on success only if that same dialog is still
   * open, and always rethrows so the form can show the error.
   */
  const runSubmit = useCallback(
    (fn) => async (values) => {
      const opened = dialogRef.current;
      setSubmitting(true);
      try {
        await fn(values, opened);
      } finally {
        setSubmitting(false);
      }
      if (dialogRef.current === opened) setDialog(null);
    },
    [],
  );

  return { dialog, openAdd, openEdit, close, pendingRemove, askRemove, cancelRemove, submitting, runSubmit };
}
