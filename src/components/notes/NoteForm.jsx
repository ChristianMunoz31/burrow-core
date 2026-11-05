import { useId, useState } from 'react';
import { userMessage } from '../../utils/apiError';
import { labelClass, inputClass, btnPrimary, formErrorClass } from '../shared/formStyles';

const COLORS = ['yellow', 'blue', 'green', 'pink', 'purple'];

/** Add/edit form for a note. `onSubmit` receives the exact API payload and returns a promise. */
export default function NoteForm({ mode, initialValues, onSubmit }) {
  const uid = useId();
  const [body, setBody] = useState(initialValues?.body ?? '');
  const [color, setColor] = useState(initialValues?.color ?? 'yellow');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  const valid = body.trim().length > 0;

  const handleSubmit = (e) => {
    e.preventDefault();
    return save();
  };

  const save = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await onSubmit({ body: body.trim(), color });
    } catch (err) {
      setFormError(userMessage(err, "Couldn't save the note. Try again."));
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label htmlFor={`${uid}-body`} className={labelClass}>
          Note
        </label>
        <textarea
          id={`${uid}-body`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              save();
            }
          }}
          placeholder="Jot something down…"
          rows={4}
          className={`${inputClass} resize-none`}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={`${uid}-color`} className={labelClass}>
            Color
          </label>
          <select
            id={`${uid}-color`}
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className={`${inputClass} capitalize`}
          >
            {COLORS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>
      {formError && (
        <p role="alert" className={formErrorClass}>
          {formError}
        </p>
      )}
      <div className="flex justify-end mt-4">
        <button type="submit" disabled={!valid || submitting} className={btnPrimary}>
          {mode === 'edit' ? 'Save changes' : 'Add note'}
        </button>
      </div>
    </form>
  );
}
