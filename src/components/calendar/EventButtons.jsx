import { useId } from 'react';
import { compactTimeText, eventAriaLabel, formatTime, timeText } from './eventLabels';

const SAVING_TITLE = 'Saving… available once synced';
const SAVING_HINT = 'Saving, available once synced';
const RESULT_DATE_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

// Temp (optimistic) events stay focusable via aria-disabled; clicks are ignored.
const ARIA_DISABLED = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-60';

/**
 * Compact event chip for a month-grid cell. A real button that opens the event
 * details. `readOnly` (optimistic temp- events not yet saved) marks it
 * aria-disabled and ignores clicks, but keeps it focusable.
 */
export function EventChip({ event, readOnly = false, onOpen }) {
  const hintId = useId();
  const compactText = compactTimeText(event);
  return (
    <button
      type="button"
      data-event-id={event.id}
      data-event-surface="grid"
      aria-label={eventAriaLabel(event, readOnly)}
      aria-haspopup={readOnly ? undefined : 'dialog'}
      aria-disabled={readOnly ? 'true' : undefined}
      aria-describedby={readOnly ? hintId : undefined}
      title={readOnly ? SAVING_TITLE : event.summary}
      onClick={readOnly ? undefined : () => onOpen(event, 'grid')}
      className={`glass-subtle pointer-events-auto flex w-full min-h-6 min-w-0 items-center overflow-hidden gap-1 rounded px-1 text-left text-[10px] leading-tight text-slate-slate200 transition-colors hover:border-[color:var(--glass-border-strong)] hover:text-slate-slate100 active:border-[color:var(--glass-border-strong)] active:bg-slate-slate700/40 focus-visible:outline-offset-[-2px] ${ARIA_DISABLED}`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full bg-slate-slateBlueLight`} />
      {compactText && (
        <span aria-hidden="true" className="shrink-0 text-slate-slate300 md:hidden">
          {compactText}
        </span>
      )}
      <span aria-hidden="true" className="hidden shrink-0 text-slate-slate300 md:inline">
        {timeText(event)}
      </span>
      <span aria-hidden="true" className="min-w-0 flex-1 truncate">
        {event.summary}
      </span>
      {readOnly && (
        <span id={hintId} className="sr-only">
          {SAVING_HINT}
        </span>
      )}
    </button>
  );
}

/**
 * Full-width row button for the day modal's list (`surface="list"`) and search results
 * (`surface="search"`). The row itself opens the event; remove lives in a sibling
 * button rendered by the caller. Only inline (span) content lives inside the button.
 * End time, location and description get ids referenced by aria-describedby, since
 * the aria-label only carries title, start time and date.
 */
export function EventRowButton({ event, readOnly = false, onOpen, surface = 'list' }) {
  const uid = useId();
  const hintId = `${uid}-saving`;
  const endId = `${uid}-end`;
  const locationId = `${uid}-location`;
  const descriptionId = `${uid}-description`;

  const detailed = surface === 'list';
  const showEnd = detailed && !event.allDay && Boolean(event.end);
  const showDescription = detailed && Boolean(event.description);
  const describedBy =
    [
      readOnly ? hintId : null,
      showEnd ? endId : null,
      event.location ? locationId : null,
      showDescription ? descriptionId : null,
    ]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <button
      type="button"
      data-event-id={event.id}
      data-event-surface={surface}
      aria-label={eventAriaLabel(event, readOnly)}
      aria-haspopup={readOnly || surface === 'list' ? undefined : 'dialog'}
      aria-disabled={readOnly ? 'true' : undefined}
      aria-describedby={describedBy}
      title={readOnly ? SAVING_TITLE : undefined}
      onClick={readOnly ? undefined : () => onOpen(event, surface)}
      className={`relative flex min-h-8 min-w-0 flex-1 items-start gap-2.5 rounded-l-md bg-transparent py-2 pl-4 pr-2 text-left transition-colors hover:bg-slate-slate700/40 active:bg-slate-slate700/60 focus-visible:outline-offset-[-2px] ${ARIA_DISABLED}`}
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-1.5 left-1.5 w-1 rounded-full bg-slate-slateBlueLight"
      />
      <span className="block min-w-0 flex-1">
        <span className="block min-w-0 break-words text-sm font-medium text-slate-slate100">{event.summary}</span>
        <span className="mt-0.5 block text-xs text-slate-slate500">
          {!detailed && `${RESULT_DATE_FMT.format(new Date(event.start))} · `}
          {timeText(event)}
          {showEnd && <span id={endId}> to {formatTime(event.end)}</span>}
          {event.location && <span id={locationId} className="min-w-0 break-words"> · {event.location}</span>}
          {detailed && event.source === 'ics' && (
            <span className="ml-1 rounded bg-slate-slate700/70 px-1 py-0.5 text-[10px] uppercase tracking-wide">
              ics
            </span>
          )}
        </span>
        {showDescription && (
          <span
            id={descriptionId}
            className="mt-1 block whitespace-pre-wrap text-xs text-slate-slate400"
          >
            {event.description}
          </span>
        )}
      </span>
      {readOnly && (
        <span id={hintId} className="sr-only">
          {SAVING_HINT}
        </span>
      )}
    </button>
  );
}
