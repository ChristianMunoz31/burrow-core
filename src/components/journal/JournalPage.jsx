import { lazy, Suspense, useRef } from 'react';
import { BookOpen } from 'lucide-react';
import SectionCard from '../shared/SectionCard';
import LoadError from '../shared/LoadError';
import { Skeleton } from '../shared/Skeleton';
import Modal from '../shared/Modal';
import ConfirmDialog from '../shared/ConfirmDialog';
import AddButton from '../shared/AddButton';
import EntryForm from './EntryForm';
import EntryList from './EntryList';
import { entryName } from './entryName';
import { useJournal } from '../../hooks/useJournal';
import { useCrudDialogs } from '../../hooks/useCrudDialogs';
import { useToast } from '../../contexts/ToastContext';
import { usePageContext } from '../../contexts/PageContextContext';
import { buildJournalContext } from '../../utils/javiBuilders/journal';

// Lazy: JournalStats pulls recharts, so the entry list renders without the charts chunk.
const JournalStats = lazy(() => import('./JournalStats'));

export default function JournalPage() {
  const { entries, loading, error, refresh, add, update, remove } = useJournal();
  usePageContext(
    'journal',
    () => buildJournalContext({ entries, loading, error, now: new Date() }),
    entries.length > 0 && entries,
  );
  const crud = useCrudDialogs();
  const toast = useToast();
  const addRef = useRef(null);
  const bodyRef = useRef(null);

  const submit = async (values, dialog) => {
    if (dialog.mode === 'edit') {
      await update(dialog.item.id, values);
      toast({ message: 'Entry updated', type: 'success' });
    } else {
      await add(values);
      toast({ message: 'Entry added', type: 'success' });
    }
  };

  const confirmRemove = async () => {
    await remove(crud.pendingRemove.id);
    crud.cancelRemove();
    toast({ message: 'Entry removed', type: 'success' });
  };

  if (error?.status === 503) {
    return (
      <SectionCard title="Journal unavailable">
        <p className="text-sm text-slate-slate300">
          Burrow can&apos;t open your data file. Try restarting Burrow.
        </p>
      </SectionCard>
    );
  }

  const loadFailed = !loading && Boolean(error) && entries.length === 0;
  const label = !loading && entries.length === 0 ? 'Add your first entry' : 'New entry';

  return (
    <div className="space-y-5">
      {loading ? (
        <SectionCard title="Entries" icon={BookOpen}>
          <div className="space-y-3" role="status" aria-label="Loading entries">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </SectionCard>
      ) : loadFailed ? (
        <SectionCard title="Entries" icon={BookOpen}>
          <LoadError thing="journal entries" onRetry={refresh} />
        </SectionCard>
      ) : (
        <EntryList
          entries={entries}
          action={<AddButton ref={addRef} label={label} onClick={() => crud.openAdd()} />}
          onEdit={crud.openEdit}
          onRemove={crud.askRemove}
        />
      )}
      {!loading && entries.length > 0 && (
        <Suspense
          fallback={
            <SectionCard title="Stats">
              <div className="space-y-3" role="status" aria-label="Loading stats">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-32 w-full" />
              </div>
            </SectionCard>
          }
        >
          <JournalStats entries={entries} />
        </Suspense>
      )}

      {crud.dialog && (
        <Modal
          title={crud.dialog.mode === 'edit' ? 'Edit entry' : 'New entry'}
          size="lg"
          onClose={crud.close}
          dismissible={!crud.submitting}
          initialFocusRef={bodyRef}
          finalFocusRef={addRef}
        >
          <EntryForm
            bodyRef={bodyRef}
            mode={crud.dialog.mode}
            initialValues={crud.dialog.mode === 'edit' ? crud.dialog.item : crud.dialog.defaults}
            onSubmit={crud.runSubmit(submit)}
          />
        </Modal>
      )}
      {crud.pendingRemove && (
        <ConfirmDialog
          title="Remove entry?"
          message={`"${entryName(crud.pendingRemove)}" will be permanently deleted.`}
          onConfirm={confirmRemove}
          onCancel={crud.cancelRemove}
          finalFocusRef={addRef}
        />
      )}
    </div>
  );
}
