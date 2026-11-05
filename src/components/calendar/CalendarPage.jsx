import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Upload,
  Search,
} from 'lucide-react';
import SectionCard from '../shared/SectionCard';
import { ListSkeleton } from '../shared/Skeleton';
import { useCalendar } from '../../hooks/useCalendar';
import Modal from '../shared/Modal';
import ConfirmDialog from '../shared/ConfirmDialog';
import AddButton from '../shared/AddButton';
import LoadError from '../shared/LoadError';
import ItemActions from '../shared/ItemActions';
import { useCrudDialogs, isTempId } from '../../hooks/useCrudDialogs';
import { useNewIntent } from '../../hooks/useNewIntent';
import { useToast } from '../../contexts/ToastContext';
import EventForm from './EventForm';
import EventDetails from './EventDetails';
import { EventChip, EventRowButton } from './EventButtons';
import { formatEventDate } from './eventLabels';
import { usePageContext } from '../../contexts/PageContextContext';
import { buildCalendarContext } from '../../utils/javiBuilders/calendar';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_FMT = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' });
const DAY_FMT = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
const MAX_CHIPS = 2;

// Visible from `sm` up; screen-reader-only below, so icon-only buttons keep their name.
const LABEL_FROM_SM = 'sr-only sm:not-sr-only';

// Local YYYY-MM-DD key (avoids UTC drift that would shift events across midnight).
function dayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// First enabled row of the day modal's list, or null when the day is empty.
const firstListRow = () =>
  document.querySelector('[data-event-surface="list"]:not([aria-disabled="true"])');

const eventCountText = (n) => (n === 0 ? 'no events' : `${n} ${n === 1 ? 'event' : 'events'}`);

const formatDayKey = (key) => DAY_FMT.format(new Date(`${key}T00:00:00`));

export default function CalendarPage() {
  const { events, loading, error, refresh, add, update, remove, importIcs } = useCalendar();
  usePageContext(
    'calendar',
    () => buildCalendarContext({ events, loading, error, now: new Date() }),
    events.length > 0 && events,
  );
  const crud = useCrudDialogs();
  const { pendingRemove, submitting, close: closeCrud } = crud;
  const toast = useToast();
  const addRef = useRef(null);
  const dayAddRef = useRef(null);
  const [viewDate, setViewDate] = useState(() => new Date());
  const [selectedKey, setSelectedKey] = useState(() => dayKey(new Date()));
  const [importStatus, setImportStatus] = useState(null);
  const fileRef = useRef(null);

  // {id, surface} of the event whose dialog is open (null for add / remove-only flows).
  // Used to return focus to that event's button even if it was re-rendered or moved to
  // another cell; the Modal only falls back to this when its original opener is gone.
  // Lookup order: same surface (grid/list/search), any button for the id.
  const openerRef = useRef(null);
  // {key, more} of the button that opened the day modal (the day selector, or its "+N more").
  // Kept after the day modal closes so a stacked ConfirmDialog that outlives it can still
  // return focus to that day; reset whenever any other dialog session starts.
  const dayTriggerRef = useRef(null);
  // Day view initial focus: first enabled row, else the Add button (read lazily by the Modal).
  const dayInitialFocusRef = useMemo(
    () => ({
      get current() {
        return firstListRow() ?? dayAddRef.current;
      },
    }),
    [],
  );
  const returnFocusRef = useMemo(
    () => ({
      get current() {
        const opener = openerRef.current;
        if (opener) {
          const matches = [...document.querySelectorAll('[data-event-id]')].filter(
            (el) => el.dataset.eventId === String(opener.id) && el.getAttribute('aria-disabled') !== 'true',
          );
          // A list row's same-event grid chip is not a sensible fallback (it would send focus
          // to the grid behind the day modal), so list openers only match their own surface.
          const found =
            matches.find((el) => el.dataset.eventSurface === opener.surface) ??
            (opener.surface === 'list' ? undefined : matches[0]);
          if (found) return found;
        }
        const day = dayTriggerRef.current;
        if (day) {
          // Day modal still open: its Add button. Otherwise the button that opened it.
          if (dayAddRef.current?.isConnected) return dayAddRef.current;
          const trigger =
            (day.more && document.querySelector(`[data-day-more-key="${day.key}"]`)) ||
            document.querySelector(`[data-day-key="${day.key}"]`);
          if (trigger) return trigger;
        }
        return addRef.current;
      },
    }),
    [],
  );

  // Header Add: prefilled with the selected day (today until another day is picked).
  const openAddDialog = () => {
    openerRef.current = null;
    dayTriggerRef.current = null;
    crud.openAdd({ date: selectedKey || dayKey(new Date()) });
  };
  // `?new=1` (command palette): open the same Add dialog, prefilled with today.
  useNewIntent(openAddDialog);

  // One Modal serves every view of an open session. Views (derived, see `view`):
  //   day     - dayOpen set, no detail, no form: the day's event list
  //   details - detail set, no form: read-only event card (Back only when dayOpen)
  //   edit    - crud.dialog mode 'edit' (always on top of details)
  //   add     - crud.dialog mode 'add' (header Add, or the day modal's Add)
  // `detail` is {id, item}; `item` is only a fallback while our own delete is in flight
  // (the optimistic removal drops it from `events` before the request settles).
  // Closing the form (Cancel or a successful save, via runSubmit) falls back to details or
  // the day list, whichever was underneath.
  const [dayOpen, setDayOpen] = useState(null);
  const [detail, setDetail] = useState(null);
  const removingRef = useRef(false);
  const editRef = useRef(null);
  const detailsId = useId();
  const prevViewRef = useRef(null);
  // Event id whose row should get focus when we return to the day list (null: Add button).
  const backFocusIdRef = useRef(null);

  const liveEvent = detail ? events.find((e) => e.id === detail.id) : undefined;
  const detailEvent = liveEvent ?? detail?.item;
  let view = null;
  if (crud.dialog) view = crud.dialog.mode === 'edit' ? 'edit' : 'add';
  else if (detail) view = 'details';
  else if (dayOpen) view = 'day';

  let modalTitle = '';
  if (view === 'edit') modalTitle = 'Edit event';
  else if (view === 'add') modalTitle = 'Add event';
  else if (view === 'details') modalTitle = detailEvent?.summary ?? '';
  else if (view === 'day') modalTitle = formatDayKey(dayOpen);

  const openEventDialog = (e, surface) => {
    openerRef.current = { id: e.id, surface };
    if (surface !== 'list') dayTriggerRef.current = null;
    setDetail({ id: e.id, item: e });
  };

  const openDayDialog = (key, more) => {
    openerRef.current = null;
    dayTriggerRef.current = { key, more };
    setSelectedKey(key);
    // An empty day has nothing to list: go straight to the add form for that date.
    if (!more && !events.some((e) => dayKey(new Date(e.start)) === key)) {
      crud.openAdd({ date: key });
      return;
    }
    setDayOpen(key);
  };

  // Closes the whole modal from any view.
  const closeAll = () => {
    setDetail(null);
    setDayOpen(null);
    crud.close();
  };

  const backToDay = () => {
    openerRef.current = null;
    backFocusIdRef.current = detail?.id ?? null;
    setDetail(null);
  };

  // The event vanished (refetch or another tab) while open and we're not the one
  // deleting it (or saving it: the saving lock must hold). From the day modal: back to the day
  // list. Otherwise close; with openerRef cleared and its button gone, the Modal's focus
  // restore falls back to Add event.
  useEffect(() => {
    if (detail && !liveEvent && !removingRef.current && !pendingRemove && !submitting) {
      openerRef.current = null;
      setDetail(null);
      closeCrud();
    }
  }, [detail, liveEvent, pendingRemove, submitting, closeCrud]);

  // Focus follows view changes inside the single mounted Modal (it only focuses at mount).
  useEffect(() => {
    const prev = prevViewRef.current;
    prevViewRef.current = view;
    if (prev === view) return;
    // Session over: drop the day trigger so a later, unrelated Remove can't focus a stale cell.
    // (Runs after the Modal/ConfirmDialog unmount cleanups, which already restored focus.)
    if (view === null) dayTriggerRef.current = null;
    if (view === 'details') {
      editRef.current?.focus();
    } else if (view === 'day') {
      const id = backFocusIdRef.current;
      backFocusIdRef.current = null;
      const row =
        id == null
          ? null
          : [...document.querySelectorAll('[data-event-id]')].find(
              (el) =>
                el.dataset.eventId === String(id) &&
                el.dataset.eventSurface === 'list' &&
                el.getAttribute('aria-disabled') !== 'true',
            );
      (row ?? firstListRow() ?? dayAddRef.current)?.focus();
    }
  }, [view]);

  // Announces the new dialog name when the view changes inside the open Modal (the dialog's
  // own name is only read at mount). Empty at mount; cleared when the Modal closes.
  const announcedViewRef = useRef(null);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    const prev = announcedViewRef.current;
    announcedViewRef.current = view;
    if (prev === view) return;
    setAnnouncement(prev !== null && view !== null ? modalTitle : '');
  }, [view, modalTitle]);

  const eventsByDay = useMemo(() => {
    const map = new Map();
    for (const e of events) {
      const key = dayKey(new Date(e.start));
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(e);
    }
    return map;
  }, [events]);

  const cells = useMemo(() => {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const firstOffset = new Date(year, month, 1).getDay();
    const out = [];
    for (let i = 0; i < 42; i++) {
      const date = new Date(year, month, 1 - firstOffset + i);
      out.push({ date, key: dayKey(date), inMonth: date.getMonth() === month });
    }
    return out;
  }, [viewDate]);

  const todayKey = dayKey(new Date());
  const dayEvents = dayOpen ? eventsByDay.get(dayOpen) || [] : [];

  const [query, setQuery] = useState('');
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return events
      .filter((e) =>
        [e.summary, e.location, e.description].some((f) => (f || '').toLowerCase().includes(q)),
      )
      .sort((a, b) => new Date(a.start) - new Date(b.start));
  }, [events, query]);
  const searching = query.trim().length > 0;

  // Auto-clear the import banner so a stale success/error message doesn't linger.
  useEffect(() => {
    if (!importStatus || importStatus.kind === 'pending') return undefined;
    const t = setTimeout(() => setImportStatus(null), 5000);
    return () => clearTimeout(t);
  }, [importStatus]);

  const shiftMonth = (delta) =>
    setViewDate((d) => new Date(d.getFullYear(), d.getMonth() + delta, 1));

  const goToday = () => {
    const now = new Date();
    setViewDate(new Date(now.getFullYear(), now.getMonth(), 1));
    setSelectedKey(dayKey(now));
  };

  const onImportFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImportStatus({ kind: 'pending', text: `Importing ${file.name}…` });
    try {
      const text = await file.text();
      const result = await importIcs(text);
      setImportStatus({
        kind: 'ok',
        text: `Imported ${result.imported} event${result.imported === 1 ? '' : 's'}${
          result.skipped ? ` (${result.skipped} already present)` : ''
        }.`,
      });
    } catch {
      setImportStatus({
        kind: 'error',
        text: "Burrow couldn't import that file. Check that it's a calendar (.ics) file and try again.",
      });
    }
  };

  const submit = async (values, dialog) => {
    if (dialog.mode === 'edit') {
      await update(dialog.item.id, values);
      toast({ message: 'Event updated', type: 'success' });
    } else {
      await add(values);
      toast({ message: 'Event added', type: 'success' });
    }
  };

  const confirmRemove = async () => {
    const target = crud.pendingRemove;
    removingRef.current = true;
    try {
      await remove(target.id);
    } finally {
      removingRef.current = false;
    }
    crud.cancelRemove();
    // Removal can start from a day row or from the details Remove button. Either way the
    // form/details views are done; the day list stays only if the day still has events.
    setDetail(null);
    crud.close();
    const left = dayOpen ? dayEvents.filter((e) => e.id !== target.id).length : 0;
    if (dayOpen && left === 0) {
      setDayOpen(null);
      toast({
        message: `Event removed. No events left on ${formatDayKey(dayOpen)}.`,
        type: 'success',
      });
    } else {
      toast({ message: 'Event removed', type: 'success' });
    }
  };

  // Rows/chips are the open trigger now, so only Remove stays as a sibling icon button.
  const askRemoveEvent = (e) => {
    openerRef.current = null;
    crud.askRemove(e);
  };
  const eventActions = (e) =>
    isTempId(e.id) ? null : (
      <ItemActions
        name={e.summary}
        onRemove={() => askRemoveEvent(e)}
        className="sm:[&_button]:h-8 sm:[&_button]:w-8"
      />
    );

  if (error?.status === 503) {
    return (
      <SectionCard title="Calendar unavailable" icon={Calendar}>
        <p className="text-sm text-slate-slate300">
          Burrow can&apos;t open your data file. Try restarting Burrow.
        </p>
      </SectionCard>
    );
  }

  let initialFocusRef;
  if (view === 'details') initialFocusRef = editRef;
  else if (view === 'day') initialFocusRef = dayInitialFocusRef;

  return (
    <div>
      <SectionCard title={MONTH_FMT.format(viewDate)} icon={Calendar}>
        {/* Toolbar lives in the card body (not SectionCard's `action`) so the month title keeps the
            full header width at 320-375px. Rendered once: one file input, one addRef target. */}
        <div className="mb-3 flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => shiftMonth(-1)}
            className="flex h-9 w-9 items-center justify-center rounded-md text-slate-slate400 hover:text-slate-slate100 hover:bg-slate-slate700/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-slateBlueLight sm:h-auto sm:w-auto sm:p-1.5"
            aria-label="Previous month"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            onClick={goToday}
            className="h-9 px-2.5 text-xs font-semibold rounded-md text-slate-slate300 hover:text-slate-slate100 hover:bg-slate-slate700/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-slateBlueLight sm:h-auto sm:py-1"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => shiftMonth(1)}
            className="flex h-9 w-9 items-center justify-center rounded-md text-slate-slate400 hover:text-slate-slate100 hover:bg-slate-slate700/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-slateBlueLight sm:h-auto sm:w-auto sm:p-1.5"
            aria-label="Next month"
          >
            <ChevronRight size={16} />
          </button>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex h-9 items-center gap-1.5 px-2.5 text-xs font-semibold rounded-md text-slate-slate300 hover:bg-slate-slate700/60 hover:text-slate-slate100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-slateBlueLight sm:h-auto sm:py-1"
            >
              <Upload size={13} aria-hidden="true" /> <span className={LABEL_FROM_SM}>Import .ics</span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".ics,text/calendar"
              onChange={onImportFile}
              className="hidden"
            />
            <AddButton
              ref={addRef}
              label={<span className={LABEL_FROM_SM}>Add event</span>}
              onClick={openAddDialog}
              className="inline-flex h-9 items-center gap-1.5 px-3 text-xs font-semibold rounded-md bg-slate-slateBlue text-white hover:bg-slate-slateBlueDark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-slateBlueLight sm:h-auto sm:py-1.5"
            />
          </div>
        </div>
        {importStatus && (
          <p
            className={`text-xs mb-3 ${
              importStatus.kind === 'error' ? 'text-accent-red' : 'text-slate-slate400'
            }`}
          >
            {importStatus.text}
          </p>
        )}
        {error && error.status !== 503 && (
          <div className="mb-3">
            <LoadError thing="calendar" onRetry={refresh} />
          </div>
        )}
        <div className="mb-3">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-slate500" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search all events…"
              aria-label="Search events"
              className="w-full pl-8 pr-2 py-1.5 text-sm rounded-md glass-input text-slate-slate100 placeholder-slate-slate500 focus:border-slate-slateBlueLight focus:outline-none"
            />
          </div>
          <p role="status" aria-live="polite" className="sr-only">
            {searching
              ? `${searchResults.length} ${searchResults.length === 1 ? 'event' : 'events'} found`
              : ''}
          </p>
          {searching && (
            <div className="glass-subtle mt-2 max-h-64 overflow-y-auto rounded-md">
              {searchResults.length === 0 ? (
                <p className="p-3 text-sm text-slate-slate400">No events match “{query.trim()}”.</p>
              ) : (
                <ul aria-label="Search results" className="divide-y divide-slate-slate700/40">
                  {searchResults.map((e) => (
                    <li
                      key={e.id}
                      className="group flex items-start focus-within:bg-slate-slate700/20"
                    >
                      <EventRowButton
                        event={e}
                        surface="search"
                        readOnly={isTempId(e.id)}
                        onOpen={openEventDialog}
                      />
                      <div className="py-1.5 pr-2">{eventActions(e)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        {loading ? (
          <ListSkeleton rows={6} />
        ) : (
          <>
            <div className="grid grid-cols-7 gap-1 mb-1">
              {WEEKDAYS.map((d) => (
                <div
                  key={d}
                  className="text-center text-[10px] font-semibold uppercase tracking-widest text-slate-slate500 py-1"
                >
                  {d}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {cells.map(({ date, key, inMonth }) => {
                const cellEvents = eventsByDay.get(key) || [];
                const isToday = key === todayKey;
                const isSelected = key === selectedKey;
                const hidden = cellEvents.length - MAX_CHIPS;
                const dayLabel = formatEventDate(date);
                return (
                  // Non-interactive cell: the day selector button sits underneath as a sibling of
                  // the event buttons (no nested buttons). Gaps between chips pass clicks through
                  // (pointer-events-none wrapper) so empty cell area still selects the day.
                  <div key={key} className="relative min-h-[108px]">
                    <button
                      type="button"
                      onClick={() => openDayDialog(key, false)}
                      data-day-key={key}
                      aria-label={`${dayLabel}, ${eventCountText(cellEvents.length)}`}
                      aria-haspopup="dialog"
                      aria-current={isToday ? 'date' : undefined}
                      className={`absolute inset-0 flex items-start justify-start rounded-md border p-1.5 text-left transition-colors focus-visible:outline-offset-[-2px] ${
                        isSelected
                          ? 'border-slate-slateBlue bg-slate-slateBlue/10'
                          : 'border-transparent hover:bg-slate-slate700/40 active:bg-slate-slate700/60'
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`text-xs font-semibold inline-flex h-5 w-5 items-center justify-center rounded-full ${
                          isToday ? 'bg-slate-slateBlue text-white' : 'text-slate-slate300'
                        } ${inMonth ? '' : 'opacity-50'}`}
                      >
                        {date.getDate()}
                      </span>
                    </button>
                    {cellEvents.length > 0 && (
                      <div className="pointer-events-none relative space-y-0.5 px-1 pb-1 pt-7">
                        {/* Decision: opening an event from the grid does not change the selected day;
                            the modal is the focus. */}
                        {cellEvents.slice(0, MAX_CHIPS).map((e) => (
                          <EventChip
                            key={e.id}
                            event={e}
                            readOnly={isTempId(e.id)}
                            onOpen={openEventDialog}
                          />
                        ))}
                        {hidden > 0 && (
                          <button
                            type="button"
                            onClick={() => openDayDialog(key, true)}
                            data-day-more-key={key}
                            aria-haspopup="dialog"
                            aria-label={`Show ${hidden} more event${hidden === 1 ? '' : 's'} on ${dayLabel}`}
                            className="pointer-events-auto block w-full min-h-6 rounded px-1 text-left text-[10px] text-slate-slate400 transition-colors hover:bg-slate-slate700/60 hover:text-slate-slate100 active:bg-slate-slate700 focus-visible:outline-offset-[-2px]"
                          >
                            +{hidden} more
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </SectionCard>

      {view ? (
        <Modal
          title={modalTitle}
          onClose={closeAll}
          dismissible={!submitting}
          initialFocusRef={initialFocusRef}
          describedBy={view === 'details' ? detailsId : undefined}
          finalFocusRef={returnFocusRef}
        >
          <p role="status" aria-live="polite" className="sr-only">
            {announcement}
          </p>
          {view === 'day' && (
            <div>
              {dayEvents.length === 0 ? (
                <p className="text-sm text-slate-slate400">No events</p>
              ) : (
                <ul className="space-y-2">
                  {dayEvents.map((e) => (
                    <li
                      key={e.id}
                      className="group glass-subtle glass-hover flex items-start rounded-md focus-within:border-[color:var(--glass-border-strong)]"
                    >
                      <EventRowButton
                        event={e}
                        surface="list"
                        readOnly={isTempId(e.id)}
                        onOpen={openEventDialog}
                      />
                      <div className="py-1.5 pr-2">{eventActions(e)}</div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-4 flex justify-end">
                <AddButton
                  ref={dayAddRef}
                  label="Add event"
                  aria-haspopup={undefined}
                  onClick={() => {
                    openerRef.current = null;
                    crud.openAdd({ date: dayOpen });
                  }}
                />
              </div>
            </div>
          )}
          {view === 'details' && (
            <EventDetails
              event={detailEvent}
              editRef={editRef}
              id={detailsId}
              onEdit={() => crud.openEdit(detailEvent)}
              onRemove={() => crud.askRemove(detailEvent)}
              onBack={dayOpen ? backToDay : undefined}
              backLabel={dayOpen ? formatDayKey(dayOpen) : undefined}
            />
          )}
          {(view === 'add' || view === 'edit') && (
            <EventForm
              mode={crud.dialog.mode}
              initialValues={view === 'edit' ? crud.dialog.item : crud.dialog.defaults}
              onSubmit={crud.runSubmit(submit)}
              onCancel={crud.close}
            />
          )}
        </Modal>
      ) : null}
      {crud.pendingRemove && (
        <ConfirmDialog
          title="Remove event?"
          message={`"${crud.pendingRemove.summary}" will be permanently deleted.`}
          onConfirm={confirmRemove}
          onCancel={crud.cancelRemove}
          finalFocusRef={returnFocusRef}
        />
      )}
    </div>
  );
}
