import { useRef } from 'react';
import { Pin, PinOff, StickyNote } from 'lucide-react';
import SectionCard from '../shared/SectionCard';
import { ListSkeleton } from '../shared/Skeleton';
import Modal from '../shared/Modal';
import ConfirmDialog from '../shared/ConfirmDialog';
import AddButton from '../shared/AddButton';
import LoadError from '../shared/LoadError';
import ItemActions, { IconButton } from '../shared/ItemActions';
import NoteForm from './NoteForm';
import { useNotes } from '../../hooks/useNotes';
import { useCrudDialogs, isTempId } from '../../hooks/useCrudDialogs';
import { useToast } from '../../contexts/ToastContext';
import { usePageContext } from '../../contexts/PageContextContext';
import { buildNotesContext } from '../../utils/javiBuilders/notes';

// Subtle tint per note color. Uses *Light1 tokens (defined for every palette in
// tailwind.config.cjs) at low opacity so notes read on the dark surface.
const COLOR_CLASS = {
  yellow: 'bg-yellow-yellowLight1/10 border-yellow-yellowLight1/30',
  blue: 'bg-blue-blueLight1/10 border-blue-blueLight1/30',
  green: 'bg-green-greenLight1/10 border-green-greenLight1/30',
  pink: 'bg-slate-slateBlueLight/10 border-slate-slateBlueLight/30',
  purple: 'bg-purple-purpleLight1/10 border-purple-purpleLight1/30',
};

const DOT_CLASS = {
  yellow: 'bg-yellow-yellowLight1',
  blue: 'bg-blue-blueLight1',
  green: 'bg-green-greenLight1',
  pink: 'bg-slate-slateBlueLight',
  purple: 'bg-purple-purpleLight1',
};

const noteName = (note) => (note.body || '').slice(0, 30);

export default function NotesPage() {
  const { notes, loading, error, refresh, add, update, remove } = useNotes();
  usePageContext('notes', () => buildNotesContext({ notes, loading, error }), notes.length > 0 && notes);
  const crud = useCrudDialogs();
  const toast = useToast();
  const addRef = useRef(null);

  const submit = async (values, dialog) => {
    if (dialog.mode === 'edit') {
      await update(dialog.item.id, values);
      toast({ message: 'Note updated', type: 'success' });
    } else {
      await add(values);
      toast({ message: 'Note added', type: 'success' });
    }
  };

  const confirmRemove = async () => {
    await remove(crud.pendingRemove.id);
    crud.cancelRemove();
    toast({ message: 'Note removed', type: 'success' });
  };

  if (error?.status === 503) {
    return (
      <SectionCard title="Notes unavailable" icon={StickyNote}>
        <p className="text-sm text-slate-slate300">
          Burrow can&apos;t open your data file. Try restarting Burrow.
        </p>
      </SectionCard>
    );
  }

  const loadFailed = !loading && Boolean(error) && notes.length === 0;
  const isEmpty = !loading && !loadFailed && notes.length === 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-slate400">
          {loading || loadFailed ? '' : `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`}
        </p>
        {!isEmpty && !loadFailed && <AddButton ref={addRef} label="Add note" onClick={() => crud.openAdd()} />}
      </div>

      {loading ? (
        <ListSkeleton rows={4} />
      ) : loadFailed ? (
        <LoadError thing="notes" onRetry={refresh} />
      ) : isEmpty ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-slate-slate400">No notes yet.</p>
          <AddButton ref={addRef} label="Add your first note" onClick={() => crud.openAdd()} />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {notes.map((n) => (
            <div
              key={n.id}
              className={`group relative rounded-xl border p-4 ${COLOR_CLASS[n.color] || COLOR_CLASS.yellow}`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className={`w-2.5 h-2.5 rounded-full ${DOT_CLASS[n.color] || DOT_CLASS.yellow}`} />
                {!isTempId(n.id) && (
                  <ItemActions
                    name={noteName(n)}
                    onEdit={() => crud.openEdit(n)}
                    onRemove={() => crud.askRemove(n)}
                  >
                    <IconButton
                      label={n.pinned ? 'Unpin note' : 'Pin note'}
                      icon={n.pinned ? PinOff : Pin}
                      className={n.pinned ? 'text-accent-indigo' : ''}
                      onClick={() =>
                        update(n.id, { pinned: !n.pinned }).catch(() =>
                          toast({ message: "Couldn't update the note. Try again.", type: 'error' }),
                        )
                      }
                    />
                  </ItemActions>
                )}
              </div>
              {n.pinned && (
                <span className="absolute top-3 left-8 text-[10px] uppercase tracking-wide text-accent-indigo">
                  Pinned
                </span>
              )}
              <p className="text-sm text-slate-slate100 whitespace-pre-wrap break-words">{n.body}</p>
            </div>
          ))}
        </div>
      )}

      {crud.dialog && (
        <Modal
          title={crud.dialog.mode === 'edit' ? 'Edit note' : 'Add note'}
          onClose={crud.close}
          dismissible={!crud.submitting}
          finalFocusRef={addRef}
        >
          <NoteForm
            mode={crud.dialog.mode}
            initialValues={crud.dialog.mode === 'edit' ? crud.dialog.item : crud.dialog.defaults}
            onSubmit={crud.runSubmit(submit)}
          />
        </Modal>
      )}
      {crud.pendingRemove && (
        <ConfirmDialog
          title="Remove note?"
          message={`"${noteName(crud.pendingRemove)}" will be permanently deleted.`}
          onConfirm={confirmRemove}
          onCancel={crud.cancelRemove}
          finalFocusRef={addRef}
        />
      )}
    </div>
  );
}
