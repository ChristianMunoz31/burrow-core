import { useId, useState } from 'react';
import { userMessage } from '../../utils/apiError';
import {
  btnPrimary,
  formErrorClass,
  inputClass,
  labelClass,
} from '../shared/formStyles';

const PRIORITIES = ['low', 'medium', 'high'];
const CONTEXTS = ['work', 'home', 'both'];

const selectClass = `${inputClass} capitalize`;

// Add/edit todo form, rendered inside a Modal. `initialValues` is the todo
// (edit) or partial defaults such as { status } (add). `onSubmit` receives the
// exact API payload and returns a promise; rejections are shown inline and the
// values are kept so the user can retry.
export default function TodoForm({
  mode = 'add',
  initialValues = {},
  columns = [],
  defaultContext = 'work',
  onSubmit,
}) {
  const uid = useId();
  const [title, setTitle] = useState(initialValues.title ?? '');
  const [description, setDescription] = useState(initialValues.description ?? '');
  const [due, setDue] = useState(initialValues.due ?? '');
  const [priority, setPriority] = useState(initialValues.priority || 'medium');
  const [context, setContext] = useState(initialValues.context || defaultContext);
  const [status, setStatus] = useState(initialValues.status ?? columns[0]?.name ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  // A todo whose status matches no column (orphan) keeps its current value
  // selectable so editing other fields doesn't silently move it.
  const statusNames = columns.map((c) => c.name);
  if (status && !statusNames.includes(status)) statusNames.push(status);

  const invalid = !title.trim();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (invalid || submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim(),
        due: due || null,
        priority,
        context,
        status,
      });
    } catch (err) {
      setFormError(userMessage(err, "Couldn't save the todo. Try again."));
      setSubmitting(false);
    }
  };

  const id = (name) => `${uid}-${name}`;

  return (
    <form onSubmit={handleSubmit} className="grid gap-3">
      <div>
        <label htmlFor={id('title')} className={labelClass}>
          Title
        </label>
        <input
          id={id('title')}
          name="title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing?"
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor={id('description')} className={labelClass}>
          Description
        </label>
        <textarea
          id={id('description')}
          name="description"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Details (optional)"
          className={`${inputClass} resize-none`}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={id('due')} className={labelClass}>
            Due date
          </label>
          <input
            id={id('due')}
            name="due"
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor={id('priority')} className={labelClass}>
            Priority
          </label>
          <select
            id={id('priority')}
            name="priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className={selectClass}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={id('context')} className={labelClass}>
            Context
          </label>
          <select
            id={id('context')}
            name="context"
            value={context}
            onChange={(e) => setContext(e.target.value)}
            className={selectClass}
          >
            {CONTEXTS.map((ctx) => (
              <option key={ctx} value={ctx}>
                {ctx}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={id('status')} className={labelClass}>
            Status
          </label>
          <select
            id={id('status')}
            name="status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className={selectClass}
          >
            {statusNames.map((name) => (
              <option key={name} value={name}>
                {name}
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
      <div className="flex justify-end mt-1">
        <button type="submit" disabled={invalid || submitting} className={btnPrimary}>
          {mode === 'edit' ? 'Save changes' : 'Add todo'}
        </button>
      </div>
    </form>
  );
}
