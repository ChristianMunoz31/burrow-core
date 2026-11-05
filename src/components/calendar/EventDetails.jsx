import { useId } from 'react';
import { AlignLeft, Calendar, ChevronLeft, Clock, MapPin, Pencil, Trash2 } from 'lucide-react';
import { btnDanger, btnPrimary, btnSecondary } from '../shared/formStyles';
import { formatEventWhen } from './eventLabels';

/**
 * Read-only event card rendered inside the shared Modal (the modal heading is the
 * event title). Only fields that exist are shown. `editRef` lets the page focus the
 * Edit button (initial focus, and when coming back from the form). `id` goes on the
 * summary card so the page can use it as the dialog's accessible description.
 * `onBack` (only when opened from the day modal) adds a Back button that returns to that
 * day's list; `backLabel` is the day's name, used in its accessible name.
 */
export default function EventDetails({ event, onEdit, onRemove, onBack, backLabel, editRef, id }) {
  const { date, time } = formatEventWhen(event);
  const imported = event.source === 'ics';
  const notesId = useId();

  return (
    <div>
      <div id={id} className="glass-subtle relative space-y-2 rounded-md py-3 pl-5 pr-3 text-sm text-slate-slate200">
        <span
          aria-hidden="true"
          className={`absolute inset-y-2 left-2 w-1 rounded-full bg-slate-slateBlueLight`}
        />
        <p className="flex items-start gap-2">
          <Calendar size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-slate-slate400" />
          <span className="sr-only">Date: </span>
          <span className="min-w-0 break-words">{date}</span>
        </p>
        {time && (
          <p className="flex items-start gap-2">
            <Clock size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-slate-slate400" />
            <span className="sr-only">Time: </span>
            <span className="min-w-0 break-words">{time}</span>
          </p>
        )}
        {event.location && (
          <p className="flex items-start gap-2">
            <MapPin size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-slate-slate400" />
            <span className="sr-only">Location: </span>
            <span className="min-w-0 break-words">{event.location}</span>
          </p>
        )}
      </div>

      {imported && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full bg-slate-slate700/60 px-2 py-0.5 font-medium text-slate-slate300">
            Imported
          </span>
        </div>
      )}

      {event.description && (
        <div className="mt-3">
          <p id={notesId} className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-slate400">
            <AlignLeft size={13} aria-hidden="true" />
            Notes
          </p>
          <p
            tabIndex={0}
            role="region"
            aria-labelledby={notesId}
            className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-sm text-slate-slate200"
          >
            {event.description}
          </p>
        </div>
      )}

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <div className="mr-auto flex flex-wrap gap-2">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label={backLabel ? `Back to ${backLabel}` : 'Back'}
              className={btnSecondary}
            >
              <ChevronLeft size={14} aria-hidden="true" />
              Back
            </button>
          )}
          <button type="button" onClick={onRemove} className={btnDanger}>
            <Trash2 size={14} aria-hidden="true" />
            Remove
          </button>
        </div>
        <button ref={editRef} type="button" onClick={onEdit} className={btnPrimary}>
          <Pencil size={14} aria-hidden="true" />
          Edit
        </button>
      </div>
    </div>
  );
}
