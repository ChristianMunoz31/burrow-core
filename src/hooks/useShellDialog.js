import { useCallback, useEffect, useRef, useState } from 'react';
import { foldersService } from '../services/foldersService';
import { DIALOG_POLL_MS, ERROR_COPY } from '../constants/folders';

const OPEN = ['waiting', 'checking'];
const MAX_POLL_FAILURES = 5;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Follows one request to a window the Burrow app opens (choose a folder, choose where to save). `start` takes the
 * call that creates the request (a promise of `{ dialog }`), then asks about it every `DIALOG_POLL_MS` until it
 * ends or the component unmounts. It resolves to the final dialog view (null after an unmount) and rejects when
 * the request could not be created. Only one request is followed at a time.
 * @returns {{ active: boolean, start: (created: Promise<{ dialog: object }>) => Promise<object|null>,
 *   cancel: () => Promise<void> }}
 */
export function useShellDialog() {
  const [active, setActive] = useState(false);
  const runRef = useRef(0);
  const idRef = useRef(null);

  useEffect(
    () => () => {
      runRef.current += 1;
    },
    [],
  );

  const start = useCallback(async (created) => {
    const run = ++runRef.current;
    const stale = () => runRef.current !== run;
    setActive(true);
    try {
      let view = (await created).dialog;
      let failures = 0;
      while (!stale() && OPEN.includes(view.status)) {
        idRef.current = view.id;
        await sleep(DIALOG_POLL_MS);
        if (stale()) return null;
        try {
          view = (await foldersService.dialog(view.id)).dialog;
          failures = 0;
        } catch (err) {
          if (err?.code === 'dialog_not_found') {
            view = { ...view, status: 'failed', error: { code: err.code, message: err.message || ERROR_COPY.dialog_not_found } };
          } else if (++failures >= MAX_POLL_FAILURES) {
            throw err;
          }
        }
      }
      if (stale()) return null;
      return view;
    } finally {
      if (!stale()) {
        idRef.current = null;
        setActive(false);
      }
    }
  }, []);

  const cancel = useCallback(async () => {
    const id = idRef.current;
    if (!id) return;
    // The next poll reports the ending, so the caller sees one result path for every outcome.
    await foldersService.cancelDialog(id).catch(() => {});
  }, []);

  return { active, start, cancel };
}
