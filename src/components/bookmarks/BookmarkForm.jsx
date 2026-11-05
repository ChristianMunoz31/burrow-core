import { useId, useState } from 'react';
import { userMessage } from '../../utils/apiError';
import { btnPrimary, formErrorClass, inputClass, labelClass } from '../shared/formStyles';
import { withProtocol } from './url';

export default function BookmarkForm({ mode = 'add', initialValues, onSubmit }) {
  const uid = useId();
  const [title, setTitle] = useState(initialValues?.title ?? '');
  const [url, setUrl] = useState(initialValues?.url ?? '');
  const [category, setCategory] = useState(initialValues?.category ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  const valid = title.trim() !== '' && url.trim() !== '';

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await onSubmit({
        title: title.trim(),
        // Edit mode: an untouched URL is sent as-is so non-http schemes
        // (mailto:, obsidian://) aren't rewritten by withProtocol.
        url:
          mode === 'edit' && url === initialValues?.url ? initialValues.url : withProtocol(url.trim()),
        category: category.trim(),
      });
    } catch (err) {
      setFormError(userMessage(err, "Couldn't save the bookmark. Try again."));
    } finally {
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
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor={`${uid}-url`} className={labelClass}>
          URL
        </label>
        <input
          id={`${uid}-url`}
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="example.com"
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor={`${uid}-category`} className={labelClass}>
          Group
        </label>
        <input
          id={`${uid}-category`}
          type="text"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="Optional"
          className={inputClass}
        />
      </div>
      {formError && (
        <p role="alert" className={formErrorClass}>
          {formError}
        </p>
      )}
      <div className="flex justify-end mt-4">
        <button type="submit" disabled={submitting || !valid} className={btnPrimary}>
          {mode === 'edit' ? 'Save changes' : 'Add bookmark'}
        </button>
      </div>
    </form>
  );
}
