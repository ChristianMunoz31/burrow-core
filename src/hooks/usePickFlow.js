import { useCallback, useState } from 'react';
import { useToast } from '../contexts/ToastContext';
import { userMessage } from '../utils/apiError';
import { DIALOG_PROBLEMS, ERROR_COPY, GENERIC_ERROR, ONEDRIVE_WARNING } from '../constants/folders';

/**
 * One "choose a folder in the app's window" attempt: the waiting state, the result and its message. `pick(folderId?)`
 * starts it (an imported folder's id re-picks that folder). A cancelled window says nothing; a refused one keeps its
 * message in `problem` (with `again: true` so the UI offers another pick); an added folder shows a toast.
 * @param {(folderId?: string) => Promise<object|null>} pick `useFolders().pick`
 * @returns {{ waiting: boolean, problem: { message: string, again: boolean }|null, run: (folderId?: string) => Promise<void> }}
 */
export function usePickFlow(pick) {
  const toast = useToast();
  const [waiting, setWaiting] = useState(false);
  const [problem, setProblem] = useState(null);

  const run = useCallback(
    async (folderId) => {
      setProblem(null);
      setWaiting(true);
      try {
        const result = await pick(folderId);
        if (result?.status === 'added') {
          toast({ message: `Added ${result.folder?.name ?? 'the folder'}. Burrow is reading it now.`, type: 'success' });
          if (result.folder?.warnings?.includes('onedrive')) {
            toast({ message: ONEDRIVE_WARNING, type: 'info', duration: 8000 });
          }
        } else if (DIALOG_PROBLEMS.includes(result?.status)) {
          const code = result.error?.code;
          setProblem({ message: result.error?.message || ERROR_COPY[code] || GENERIC_ERROR, again: result.status === 'refused' });
        }
      } catch (err) {
        setProblem({ message: userMessage(err, ERROR_COPY[err?.code] ?? GENERIC_ERROR), again: false });
      } finally {
        setWaiting(false);
      }
    },
    [pick, toast],
  );

  return { waiting, problem, run };
}
