import { useRef } from 'react';
import { CalendarClock } from 'lucide-react';
import SectionCard from '../shared/SectionCard';
import { ListSkeleton } from '../shared/Skeleton';
import Modal from '../shared/Modal';
import ConfirmDialog from '../shared/ConfirmDialog';
import AddButton from '../shared/AddButton';
import LoadError from '../shared/LoadError';
import ItemActions from '../shared/ItemActions';
import { useCrudDialogs, isTempId } from '../../hooks/useCrudDialogs';
import { useNewIntent } from '../../hooks/useNewIntent';
import { useToast } from '../../contexts/ToastContext';
import { useCountdowns } from '../../hooks/useCountdowns';
import { daysUntil, countdownLabel } from '../../utils/countdown';
import CountdownForm from './CountdownForm';
import { usePageContext } from '../../contexts/PageContextContext';
import { buildCountdownsContext } from '../../utils/javiBuilders/countdowns';

export default function CountdownsPage() {
  const { countdowns, loading, error, refresh, add, update, remove } = useCountdowns();
  usePageContext('countdowns', () =>
    buildCountdownsContext({ countdowns, loading, error, now: new Date() }),
    countdowns.length > 0 && countdowns,
  );
  const crud = useCrudDialogs();
  const toast = useToast();
  const addRef = useRef(null);
  useNewIntent(crud.openAdd);

  const submit = async (values, dialog) => {
    if (dialog.mode === 'edit') {
      await update(dialog.item.id, values);
      toast({ message: 'Countdown updated', type: 'success' });
    } else {
      await add(values);
      toast({ message: 'Countdown added', type: 'success' });
    }
  };

  const confirmRemove = async () => {
    await remove(crud.pendingRemove.id);
    crud.cancelRemove();
    toast({ message: 'Countdown removed', type: 'success' });
  };

  if (error?.status === 503) {
    return (
      <SectionCard title="Countdowns unavailable" icon={CalendarClock}>
        <p className="text-sm text-slate-slate300">
          Burrow can&apos;t open your data file. Try restarting Burrow.
        </p>
      </SectionCard>
    );
  }

  const loadFailed = !loading && Boolean(error) && countdowns.length === 0;
  const isEmpty = !loading && !loadFailed && countdowns.length === 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-slate400">
          {loading || loadFailed ? '' : `${countdowns.length} countdown${countdowns.length === 1 ? '' : 's'}`}
        </p>
        {!isEmpty && !loadFailed && (
          <AddButton ref={addRef} label="Add countdown" onClick={() => crud.openAdd()} />
        )}
      </div>

      {loading ? (
        <ListSkeleton rows={4} />
      ) : loadFailed ? (
        <LoadError thing="countdowns" onRetry={refresh} />
      ) : isEmpty ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-slate-slate400">No countdowns yet.</p>
          <AddButton ref={addRef} label="Add your first countdown" onClick={() => crud.openAdd()} />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {countdowns.map((c) => {
            const days = daysUntil(c.targetDate);
            const past = days != null && days < 0;
            return (
              <div
                key={c.id}
                className={`group relative glass rounded-2xl p-5 ${past ? 'opacity-60' : ''}`}
              >
                {!isTempId(c.id) && (
                  <ItemActions
                    name={c.title}
                    onEdit={() => crud.openEdit(c)}
                    onRemove={() => crud.askRemove(c)}
                    className="absolute top-3 right-3"
                  />
                )}
                <div className="text-4xl font-bold text-slate-slate100 tabular-nums leading-none">
                  {days === 0 ? 'Today' : Math.abs(days)}
                  {days !== 0 && (
                    <span className="text-base font-medium text-slate-slate400">
                      {' '}
                      day{Math.abs(days) === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-slate500 mt-1">{countdownLabel(days)}</div>
                <div className="text-sm font-medium text-slate-slate100 mt-3 break-words">
                  {c.title}
                </div>
                <div className="text-xs text-slate-slate500 mt-0.5">{c.targetDate}</div>
              </div>
            );
          })}
        </div>
      )}

      {crud.dialog && (
        <Modal
          title={crud.dialog.mode === 'edit' ? 'Edit countdown' : 'Add countdown'}
          onClose={crud.close}
          dismissible={!crud.submitting}
          finalFocusRef={addRef}
        >
          <CountdownForm
            mode={crud.dialog.mode}
            initialValues={crud.dialog.mode === 'edit' ? crud.dialog.item : crud.dialog.defaults}
            onSubmit={crud.runSubmit(submit)}
          />
        </Modal>
      )}
      {crud.pendingRemove && (
        <ConfirmDialog
          title="Remove countdown?"
          message={`"${crud.pendingRemove.title}" will be permanently deleted.`}
          onConfirm={confirmRemove}
          onCancel={crud.cancelRemove}
          finalFocusRef={addRef}
        />
      )}
    </div>
  );
}
