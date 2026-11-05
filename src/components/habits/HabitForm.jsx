import { useId, useState } from 'react';
import { userMessage } from '../../utils/apiError';
import { btnPrimary, formErrorClass, inputClass, labelClass } from '../shared/formStyles';

const FREQUENCIES = ['daily', 'weekday', 'weekly'];
const COLORS = ['blue', 'green', 'teal', 'purple', 'orange', 'red', 'yellow', 'cyan'];

export default function HabitForm({ mode, initialValues, onSubmit }) {
  const uid = useId();
  const [title, setTitle] = useState(initialValues?.title ?? '');
  const [frequency, setFrequency] = useState(initialValues?.frequency ?? 'daily');
  const [color, setColor] = useState(initialValues?.color ?? 'teal');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  const invalid = !title.trim();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (invalid || submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await onSubmit({ title: title.trim(), frequency, color });
    } catch (err) {
      setFormError(userMessage(err, "Couldn't save the habit. Try again."));
      setSubmitting(false);
    }
  };

  const selects = [
    { key: 'frequency', label: 'Frequency', value: frequency, set: setFrequency, options: FREQUENCIES },
    { key: 'color', label: 'Color', value: color, set: setColor, options: COLORS },
  ];

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label htmlFor={`${uid}-title`} className={labelClass}>
          Title
        </label>
        <input
          id={`${uid}-title`}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. read 20 min"
          className={inputClass}
        />
      </div>
      {selects.map((s) => (
        <div key={s.key}>
          <label htmlFor={`${uid}-${s.key}`} className={labelClass}>
            {s.label}
          </label>
          <select
            id={`${uid}-${s.key}`}
            value={s.value}
            onChange={(e) => s.set(e.target.value)}
            className={`${inputClass} capitalize`}
          >
            {s.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
      ))}
      {formError && (
        <p role="alert" className={formErrorClass}>
          {formError}
        </p>
      )}
      <div className="flex justify-end mt-4">
        <button type="submit" disabled={invalid || submitting} className={btnPrimary}>
          {mode === 'edit' ? 'Save changes' : 'Add habit'}
        </button>
      </div>
    </form>
  );
}
