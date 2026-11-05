import { useId, useState } from 'react';
import { userMessage } from '../../utils/apiError';
import { btnPrimary, formErrorClass, inputClass, labelClass } from '../shared/formStyles';

export default function CountdownForm({ mode, initialValues, onSubmit }) {
  const uid = useId();
  const [title, setTitle] = useState(initialValues?.title ?? '');
  const [date, setDate] = useState(initialValues?.targetDate ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  const invalid = !title.trim() || !date;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (invalid || submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await onSubmit({ title: title.trim(), targetDate: date });
    } catch (err) {
      setFormError(userMessage(err, "Couldn't save the countdown. Try again."));
      setSubmitting(false);
    }
  };

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
          placeholder="What are you counting down to?"
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor={`${uid}-date`} className={labelClass}>
          Target date
        </label>
        <input
          id={`${uid}-date`}
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className={inputClass}
        />
      </div>
      {formError && (
        <p role="alert" className={formErrorClass}>
          {formError}
        </p>
      )}
      <div className="flex justify-end mt-4">
        <button type="submit" disabled={invalid || submitting} className={btnPrimary}>
          {mode === 'edit' ? 'Save changes' : 'Add countdown'}
        </button>
      </div>
    </form>
  );
}
