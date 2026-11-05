import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '../contexts/ToastContext';
import { lsKey } from '../utils/storageKeys';
import { flushPendingSync, getPendingKeys } from '../utils/syncMode';

/**
 * Renders nothing. On app load, retries saving any settings whose save did not complete, and shows the one-time
 * note left by an erase whose final cleanup did not finish (the server's fixed message).
 */
export default function PendingSyncFlush() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const toasted = useRef(false);
  useEffect(() => {
    try {
      // Same sessionStorage key as EraseDataDialog writes (kept literal: a shared export costs bundle bytes).
      const key = lsKey('erase:note');
      const note = window.sessionStorage.getItem(key);
      window.sessionStorage.removeItem(key);
      if (note) toast({ message: note, duration: 15000 });
    } catch {
      // storage unavailable: no note
    }
    if (getPendingKeys().length > 0) {
      flushPendingSync(queryClient)
        .then((result) => {
          if (result.failed > 0 && !toasted.current) {
            toasted.current = true;
            toast({
              message: "Some settings haven't been saved yet. Burrow will retry.",
              type: 'error',
            });
          }
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient]);
  return null;
}
