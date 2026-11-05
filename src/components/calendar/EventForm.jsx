import { useId, useState } from 'react';
import { userMessage } from '../../utils/apiError';
import { btnPrimary, btnSecondary, formErrorClass, inputClass, labelClass } from '../shared/formStyles';

const pad = (n) => String(n).padStart(2, '0');

// Local YYYY-MM-DD (avoids UTC drift that would shift events across midnight).
function localDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTime(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Build a local-midnight ISO string for an all-day event so it round-trips back
// to the same calendar day in the user's timezone.
function allDayStart(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0).toISOString();
}

function timedISO(date, time) {
  return new Date(`${date}T${time}`).toISOString();
}

// Whole calendar days between two local YYYY-MM-DD strings (DST-safe via UTC).
function dayDelta(from, to) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

// Shift an ISO instant by whole local calendar days, keeping the local clock time.
function shiftDays(iso, days) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// Derive the editable date/time fields from an event (edit) or partial defaults (add).
function initialFields(mode, initialValues) {
  if (mode === 'edit' && initialValues?.start) {
    const start = new Date(initialValues.start);
    const allDay = !!initialValues.allDay;
    return {
      summary: initialValues.summary ?? '',
      date: localDate(start),
      allDay,
      startTime: allDay ? '09:00' : localTime(start),
      endTime: !allDay && initialValues.end ? localTime(new Date(initialValues.end)) : '',
      location: initialValues.location ?? '',
      description: initialValues.description ?? '',
    };
  }
  return {
    summary: '',
    date: initialValues?.date ?? localDate(new Date()),
    allDay: true,
    startTime: '09:00',
    endTime: '',
    location: '',
    description: '',
  };
}

export default function EventForm({ mode = 'add', initialValues, onSubmit, onCancel }) {
  const uid = useId();
  const [initial] = useState(() => initialFields(mode, initialValues));
  const [summary, setSummary] = useState(initial.summary);
  const [date, setDate] = useState(initial.date);
  const [allDay, setAllDay] = useState(initial.allDay);
  const [startTime, setStartTime] = useState(initial.startTime);
  const [endTime, setEndTime] = useState(initial.endTime);
  const [location, setLocation] = useState(initial.location);
  const [description, setDescription] = useState(initial.description);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  const valid = summary.trim() !== '' && date !== '';

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!valid || submitting) return;
    const payload = {
      summary: summary.trim(),
      description: description.trim(),
      location: location.trim(),
    };
    // In edit mode only send the time fields when they changed, so editing the
    // text of an imported/multi-day event never rewrites its stored start/end.
    const isEdit = mode === 'edit';
    const timesSame =
      allDay === initial.allDay &&
      (allDay || (startTime === initial.startTime && endTime === initial.endTime));
    const timeChanged = !isEdit || date !== initial.date || !timesSame;
    if (timeChanged) {
      if (isEdit && timesSame && initialValues?.start) {
        // Date-only move: shift start and end by the same calendar-day delta so
        // multi-day duration and local times are preserved.
        const delta = dayDelta(initial.date, date);
        payload.allDay = allDay;
        payload.start = shiftDays(initialValues.start, delta);
        payload.end = initialValues.end ? shiftDays(initialValues.end, delta) : null;
        if (allDay) payload.start = allDayStart(date);
      } else {
        if (!allDay && endTime && endTime < startTime) {
          setFormError('End time must be after start time.');
          return;
        }
        payload.allDay = allDay;
        payload.start = allDay ? allDayStart(date) : timedISO(date, startTime);
        payload.end = allDay || !endTime ? null : timedISO(date, endTime);
      }
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await onSubmit(payload);
    } catch (err) {
      setFormError(userMessage(err, "Couldn't save the event. Try again."));
    } finally {
      setSubmitting(false);
    }
  };

  const id = (name) => `${uid}-${name}`;

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label htmlFor={id('summary')} className={labelClass}>
          Title
        </label>
        <input
          id={id('summary')}
          autoFocus
          type="text"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Add a task or event…"
          className={inputClass}
        />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={id('date')} className={labelClass}>
            Date
          </label>
          <input
            id={id('date')}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={inputClass}
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-slate300 pb-2">
          <input
            type="checkbox"
            checked={allDay}
            onChange={(e) => setAllDay(e.target.checked)}
            className="accent-slate-slateBlue"
          />
          All day
        </label>
      </div>
      {!allDay && (
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor={id('start')} className={labelClass}>
              Start time
            </label>
            <input
              id={id('start')}
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor={id('end')} className={labelClass}>
              End time
            </label>
            <input
              id={id('end')}
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className={inputClass}
            />
          </div>
        </div>
      )}
      <div>
        <label htmlFor={id('location')} className={labelClass}>
          Location
        </label>
        <input
          id={id('location')}
          type="text"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="Optional"
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor={id('description')} className={labelClass}>
          Notes
        </label>
        <textarea
          id={id('description')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional"
          rows={2}
          className={`${inputClass} resize-none`}
        />
      </div>
      {formError && (
        <p role="alert" className={formErrorClass}>
          {formError}
        </p>
      )}
      <div className="flex justify-end gap-2 mt-4">
        <button type="button" onClick={onCancel} disabled={submitting} className={btnSecondary}>
          Cancel
        </button>
        <button type="submit" disabled={submitting || !valid} className={btnPrimary}>
          {mode === 'edit' ? 'Save changes' : 'Add event'}
        </button>
      </div>
    </form>
  );
}
