import { useMemo, useRef } from 'react';
import { Bookmark, ExternalLink } from 'lucide-react';
import SectionCard from '../shared/SectionCard';
import { ListSkeleton } from '../shared/Skeleton';
import Modal from '../shared/Modal';
import ConfirmDialog from '../shared/ConfirmDialog';
import AddButton from '../shared/AddButton';
import LoadError from '../shared/LoadError';
import ItemActions from '../shared/ItemActions';
import { useBookmarks } from '../../hooks/useBookmarks';
import { useCrudDialogs, isTempId } from '../../hooks/useCrudDialogs';
import { useNewIntent } from '../../hooks/useNewIntent';
import { useToast } from '../../contexts/ToastContext';
import BookmarkForm from './BookmarkForm';
import LetterAvatar from './LetterAvatar';
import { usePageContext } from '../../contexts/PageContextContext';
import { buildBookmarksContext } from '../../utils/javiBuilders/bookmarks';

export default function BookmarksPage() {
  const { bookmarks, loading, error, refresh, add, update, remove } = useBookmarks();
  usePageContext(
    'bookmarks',
    () => buildBookmarksContext({ bookmarks, loading, error }),
    bookmarks.length > 0 && bookmarks,
  );
  const crud = useCrudDialogs();
  const toast = useToast();
  const addRef = useRef(null);
  useNewIntent(crud.openAdd);

  const groups = useMemo(() => {
    const map = new Map();
    for (const b of bookmarks) {
      const key = b.category || 'Ungrouped';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(b);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [bookmarks]);

  const submit = async (values, dialog) => {
    if (dialog.mode === 'edit') {
      await update(dialog.item.id, values);
      toast({ message: 'Bookmark updated', type: 'success' });
    } else {
      await add(values);
      toast({ message: 'Bookmark added', type: 'success' });
    }
  };

  const confirmRemove = async () => {
    await remove(crud.pendingRemove.id);
    crud.cancelRemove();
    toast({ message: 'Bookmark removed', type: 'success' });
  };

  if (error?.status === 503) {
    return (
      <SectionCard title="Bookmarks unavailable" icon={Bookmark}>
        <p className="text-sm text-slate-slate300">
          Burrow can&apos;t open your data file. Try restarting Burrow.
        </p>
      </SectionCard>
    );
  }

  const loadFailed = !loading && Boolean(error) && bookmarks.length === 0;
  const isEmpty = !loading && !loadFailed && bookmarks.length === 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-slate400">
          {loading || loadFailed ? '' : `${bookmarks.length} bookmark${bookmarks.length === 1 ? '' : 's'}`}
        </p>
        {!isEmpty && !loadFailed && (
          <AddButton ref={addRef} label="Add bookmark" onClick={() => crud.openAdd()} />
        )}
      </div>

      {loading ? (
        <ListSkeleton rows={4} />
      ) : loadFailed ? (
        <LoadError thing="bookmarks" onRetry={refresh} />
      ) : isEmpty ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-slate400">No bookmarks yet.</p>
          <AddButton ref={addRef} label="Add your first bookmark" onClick={() => crud.openAdd()} />
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map(([group, items]) => (
            <SectionCard key={group} title={group}>
              <ul className="space-y-1.5">
                {items.map((b) => (
                  <li key={b.id} className="group flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-slate-slate700/40">
                    <LetterAvatar url={b.url} />
                    <a
                      href={b.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 min-w-0 flex items-center gap-1.5 text-sm text-slate-slate100 hover:text-accent-indigo"
                    >
                      <span className="truncate">{b.title}</span>
                      <ExternalLink size={12} className="shrink-0 text-slate-slate500" />
                    </a>
                    {!isTempId(b.id) && (
                      <ItemActions
                        name={b.title}
                        onEdit={() => crud.openEdit(b)}
                        onRemove={() => crud.askRemove(b)}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </SectionCard>
          ))}
        </div>
      )}

      {crud.dialog && (
        <Modal
          title={crud.dialog.mode === 'edit' ? 'Edit bookmark' : 'Add bookmark'}
          onClose={crud.close}
          dismissible={!crud.submitting}
          finalFocusRef={addRef}
        >
          <BookmarkForm
            mode={crud.dialog.mode}
            initialValues={crud.dialog.mode === 'edit' ? crud.dialog.item : crud.dialog.defaults}
            onSubmit={crud.runSubmit(submit)}
          />
        </Modal>
      )}
      {crud.pendingRemove && (
        <ConfirmDialog
          title="Remove bookmark?"
          message={`"${crud.pendingRemove.title}" will be permanently deleted.`}
          onConfirm={confirmRemove}
          onCancel={crud.cancelRemove}
          finalFocusRef={addRef}
        />
      )}
    </div>
  );
}
