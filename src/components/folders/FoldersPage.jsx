import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import AddButton from '../shared/AddButton';
import ConfirmDialog from '../shared/ConfirmDialog';
import LoadError from '../shared/LoadError';
import { ListSkeleton } from '../shared/Skeleton';
import { useToast } from '../../contexts/ToastContext';
import { useFolders } from '../../hooks/useFolders';
import { usePickFlow } from '../../hooks/usePickFlow';
import AddFolderDialog from './AddFolderDialog';
import FolderCard from './FolderCard';
import PickStatus from './PickStatus';
import {
  ADD_BUTTON,
  EMPTY_BUTTON,
  EMPTY_TEXT,
  ERROR_COPY,
  ONEDRIVE_WARNING,
  REMOVE_MESSAGE,
  REMOVE_TITLE,
} from '../../constants/folders';

/**
 * The Folders page: the list of folders Burrow reads, the add dialog and the remove confirmation.
 * Everything runs on this computer; the files themselves are never changed.
 */
export default function FoldersPage() {
  const folders = useFolders();
  const toast = useToast();
  const addRef = useRef(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(null);
  const location = useLocation();
  const navigate = useNavigate();
  const menuHandled = useRef(false);
  const { canPickFolder, pick, cancelDialog, dialogActive } = folders;
  const flow = usePickFlow(pick);

  // With the app's window available, Add folder opens it; otherwise the paste dialog. Same for File > Add a folder.
  const startAdd = () => {
    if (dialogActive) return;
    if (canPickFolder) flow.run();
    else setAdding(true);
  };
  const ready = !folders.loading && !folders.error;
  useEffect(() => {
    if (location.hash !== '#add-folder') {
      menuHandled.current = false;
      return;
    }
    if (!ready || menuHandled.current) return;
    menuHandled.current = true;
    navigate({ hash: '' }, { replace: true });
    startAdd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, location.hash]);

  const shell = {
    canPickFolder,
    canSaveFile: folders.canSaveFile,
    busy: dialogActive,
    pick,
    cancel: cancelDialog,
    confirm: folders.confirm,
    exportToChosen: folders.exportToChosen,
  };

  const atLimit = folders.limits ? folders.folders.length >= folders.limits.maxFolders : false;

  const add = async (input) => {
    const result = await folders.add(input);
    if (result?.folder?.warnings?.includes('onedrive')) {
      toast({ message: ONEDRIVE_WARNING, type: 'info', duration: 8000 });
    }
    return result;
  };

  // /folders?folder=<id> (a Javi "new for you" row): only a UUID that is a loaded folder's id counts; the card heading
  // is found by an id built from that folder's own id, never from the query string.
  useEffect(() => {
    const want = new URLSearchParams(location.search).get('folder');
    const folder = ready && /^[0-9a-f-]{36}$/i.test(want) && folders.folders.find((f) => f.id === want);
    // Focus scrolls the card into view.
    if (folder) document.getElementById(`folder-${folder.id}`)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, location.search]);

  // Javi's folders item is read once a summary renders here (again when a newer one lands); never on #add-folder or
  // while the add flow it starts is open.
  const newestSummary = folders.folders.reduce((max, f) => (f.summary?.status === 'ok' && f.summary.at > max ? f.summary.at : max), '');
  const sentSummary = useRef('');
  useEffect(() => {
    if (newestSummary > sentSummary.current && location.hash !== '#add-folder' && !adding && !dialogActive) {
      sentSummary.current = newestSummary;
      window.dispatchEvent(new CustomEvent('javi:inbox-read', { detail: ['folders'] }));
    }
  }, [newestSummary, location.hash, adding, dialogActive]);

  const addProps = { 'aria-haspopup': canPickFolder ? undefined : 'dialog', 'aria-disabled': dialogActive || undefined };
  const status = <PickStatus flow={flow} onStop={cancelDialog} onAgain={() => flow.run()} />;

  if (folders.loading) return <ListSkeleton rows={3} label="Loading folders" />;
  if (folders.error) return <LoadError thing="folders" onRetry={folders.refresh} />;

  return (
    <div className="space-y-5">
      {folders.folders.length === 0 ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-slate400">{EMPTY_TEXT}</p>
          <AddButton ref={addRef} label={EMPTY_BUTTON} onClick={startAdd} {...addProps} />
          {status}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <AddButton ref={addRef} label={ADD_BUTTON} onClick={startAdd} disabled={atLimit} {...addProps} />
          {atLimit && <p className="text-xs text-slate-slate400">{ERROR_COPY.folder_limit}</p>}
          {status}
        </div>
      )}

      {folders.folders.map((folder) => (
        <FolderCard
          key={folder.id}
          folder={folder}
          onScan={folders.scan}
          onCancel={folders.cancel}
          onRemove={setRemoving}
          onUpdate={folders.update}
          onExport={folders.exportFolder}
          shell={shell}
        />
      ))}

      {adding && <AddFolderDialog onAdd={add} onClose={() => setAdding(false)} finalFocusRef={addRef} />}
      {removing && (
        <ConfirmDialog
          title={REMOVE_TITLE}
          message={REMOVE_MESSAGE}
          confirmLabel="Remove"
          finalFocusRef={addRef}
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            await folders.remove(removing.id);
            setRemoving(null);
          }}
        />
      )}
    </div>
  );
}
