import { useRef } from 'react';
import { Target } from 'lucide-react';
import SectionCard from '../shared/SectionCard';
import { Skeleton } from '../shared/Skeleton';
import Modal from '../shared/Modal';
import ConfirmDialog from '../shared/ConfirmDialog';
import AddButton from '../shared/AddButton';
import LoadError from '../shared/LoadError';
import { useHabits } from '../../hooks/useHabits';
import { useCrudDialogs } from '../../hooks/useCrudDialogs';
import { useNewIntent } from '../../hooks/useNewIntent';
import { useToast } from '../../contexts/ToastContext';
import HabitForm from './HabitForm';
import HabitRow from './HabitRow';
import { usePageContext } from '../../contexts/PageContextContext';
import { buildHabitsContext } from '../../utils/javiBuilders/habits';

export default function HabitsPage() {
  const { habits, loading, error, refresh, add, update, remove, toggle } = useHabits();
  usePageContext(
    'habits',
    () => buildHabitsContext({ habits, loading, error, now: new Date() }),
    habits.length > 0 && habits,
  );
  const crud = useCrudDialogs();
  const toast = useToast();
  const addRef = useRef(null);
  useNewIntent(crud.openAdd);

  const submit = async (values, dialog) => {
    if (dialog.mode === 'edit') {
      await update(dialog.item.id, values);
      toast({ message: 'Habit updated', type: 'success' });
    } else {
      await add(values);
      toast({ message: 'Habit added', type: 'success' });
    }
  };

  const confirmRemove = async () => {
    await remove(crud.pendingRemove.id);
    crud.cancelRemove();
    toast({ message: 'Habit removed', type: 'success' });
  };

  const handleToggle = async (habitId, date, currentlyDone) => {
    try {
      await toggle(habitId, date, currentlyDone);
    } catch {
      // useHabits has already put the habit back the way it was.
      toast({ message: "Couldn't save that. Your habit was put back as it was.", type: 'error' });
    }
  };

  const loadFailed = !loading && Boolean(error) && habits.length === 0;

  if (error?.status === 503) {
    return (
      <SectionCard title="Habits unavailable">
        <p className="text-sm text-slate-slate300">
          Burrow can&apos;t open your data file. Try restarting Burrow.
        </p>
      </SectionCard>
    );
  }

  return (
    <div className="space-y-5">
      <SectionCard
        title={`Tracking · ${habits.length}`}
        icon={Target}
        action={
          loadFailed ? null : (
            <AddButton ref={addRef} label="Add habit" onClick={() => crud.openAdd()} />
          )
        }
      >
        {loading && (
          <div className="space-y-3" role="status" aria-label="Loading habits">
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center gap-4 py-1">
                <div className="flex-1">
                  <Skeleton className="h-4 w-32 mb-1.5" />
                  <Skeleton className="h-3 w-16" />
                </div>
                <Skeleton className="h-3 w-40" />
              </div>
            ))}
          </div>
        )}
        {loadFailed && <LoadError thing="habits" onRetry={refresh} />}
        {!loading && !loadFailed && habits.length === 0 && (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-slate-slate400">No habits yet. Add one to start a streak.</p>
            <AddButton label="Add your first habit" onClick={() => crud.openAdd()} />
          </div>
        )}
        {!loading && habits.length > 0 && (
          <ul className="divide-y divide-slate-slate700/50">
            {habits.map((habit) => (
              <HabitRow
                key={habit.id}
                habit={habit}
                onToggle={handleToggle}
                onEdit={crud.openEdit}
                onRemove={crud.askRemove}
              />
            ))}
          </ul>
        )}
      </SectionCard>

      {crud.dialog && (
        <Modal
          title={crud.dialog.mode === 'edit' ? 'Edit habit' : 'Add habit'}
          onClose={crud.close}
          dismissible={!crud.submitting}
          finalFocusRef={addRef}
        >
          <HabitForm
            mode={crud.dialog.mode}
            initialValues={crud.dialog.mode === 'edit' ? crud.dialog.item : crud.dialog.defaults}
            onSubmit={crud.runSubmit(submit)}
          />
        </Modal>
      )}
      {crud.pendingRemove && (
        <ConfirmDialog
          title="Remove habit?"
          message={`"${crud.pendingRemove.title}" will be permanently deleted.`}
          onConfirm={confirmRemove}
          onCancel={crud.cancelRemove}
          finalFocusRef={addRef}
        />
      )}
    </div>
  );
}
