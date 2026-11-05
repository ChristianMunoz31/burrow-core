import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Mic, MicOff, X } from 'lucide-react';
import { useSpeechRecognition } from '../../hooks/useSpeechRecognition';
import { userMessage } from '../../utils/apiError';
import { labelClass, inputClass, btnPrimary, formErrorClass } from '../shared/formStyles';

const MOODS = ['great', 'good', 'okay', 'down', 'rough'];

/**
 * Add/edit form for a journal entry (mic dictation + tags). `onSubmit` receives the
 * exact API payload and returns a promise. Date is not editable.
 */
export default function EntryForm({ mode, initialValues, onSubmit, bodyRef }) {
  const { supported, listening, interim, transcript, start, stop, error } = useSpeechRecognition();
  const uid = useId();
  const [title, setTitle] = useState(initialValues?.title ?? '');
  const [body, setBody] = useState(initialValues?.body ?? '');
  const [mood, setMood] = useState(initialValues?.mood ?? '');
  const [tags, setTags] = useState(initialValues?.tags ?? []);
  const [tagInput, setTagInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  // Whenever the speech-recognition transcript changes, append it to the
  // body text. Track what we've already appended so the user can keep typing
  // in between voice sessions without losing edits.
  const lastAppendedRef = useRef('');
  useEffect(() => {
    if (transcript && transcript !== lastAppendedRef.current) {
      setBody((prev) => {
        const sep = prev && !prev.endsWith(' ') ? ' ' : '';
        return prev + sep + transcript.slice(lastAppendedRef.current.length).trim();
      });
      lastAppendedRef.current = transcript;
    }
  }, [transcript]);

  const liveBody = useMemo(() => {
    if (!listening || !interim) return body;
    const sep = body && !body.endsWith(' ') ? ' ' : '';
    return body + sep + interim;
  }, [body, interim, listening]);

  const valid = body.trim().length > 0;

  const toggleMic = () => {
    if (!supported) return;
    if (listening) stop();
    else start();
  };

  const addTagFromInput = () => {
    const cleaned = tagInput.trim();
    if (!cleaned) return;
    if (!tags.includes(cleaned)) setTags([...tags, cleaned]);
    setTagInput('');
  };

  const removeTag = (t) => setTags(tags.filter((x) => x !== t));

  const handleTagKey = (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTagFromInput();
    } else if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
      setTags(tags.slice(0, -1));
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    return save();
  };

  const save = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    setFormError(null);
    if (listening) stop();
    // A tag typed but not yet committed (no Enter/blur) still counts.
    const pending = tagInput.trim();
    const finalTags = pending && !tags.includes(pending) ? [...tags, pending] : tags;
    const payload =
      mode === 'edit'
        ? {
            title: title.trim(),
            body: body.trim(),
            mood: mood || null,
            tags: finalTags,
          }
        : {
            title: title.trim() || undefined,
            body: body.trim(),
            mood: mood || undefined,
            tags: finalTags,
          };
    try {
      await onSubmit(payload);
    } catch (err) {
      setFormError(userMessage(err, "Couldn't save the entry. Try again."));
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label htmlFor={`${uid}-title`} className={labelClass}>
          Title (optional)
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
        <label htmlFor={`${uid}-body`} className={labelClass}>
          Entry
        </label>
        <div className="relative">
          <textarea
            id={`${uid}-body`}
            ref={bodyRef}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                save();
              }
            }}
            value={liveBody}
            onChange={(e) => {
              setBody(e.target.value);
              lastAppendedRef.current = transcript;
            }}
            placeholder={
              supported
                ? 'Tap the mic and speak, or type here…'
                : 'Voice not supported in this browser. Type here…'
            }
            rows={6}
            className={`${inputClass} resize-y`}
          />
          {supported && (
            <button
              type="button"
              onClick={toggleMic}
              aria-label={listening ? 'Stop recording' : 'Start recording'}
              className={[
                'absolute bottom-3 right-3 p-2 rounded-full border transition-colors',
                listening
                  ? 'bg-red-redDark1/30 border-red-red text-accent-red animate-pulse'
                  : 'bg-slate-slate800 border-slate-slate700 text-slate-slate300 hover:text-slate-slate100',
              ].join(' ')}
            >
              {listening ? <MicOff size={16} /> : <Mic size={16} />}
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className={formErrorClass}>Mic error: {error}. Check browser permissions and try again.</p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor={`${uid}-mood`} className={labelClass}>
            Mood
          </label>
          <select
            id={`${uid}-mood`}
            value={mood}
            onChange={(e) => setMood(e.target.value)}
            className={inputClass}
          >
            <option value="">None</option>
            {MOODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor={`${uid}-tags`} className={labelClass}>
          Tags
        </label>
        <div className="flex flex-wrap items-center gap-1.5">
          {tags.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-slate-slate700/60 border border-slate-slate700 text-slate-slate200"
            >
              {t}
              <button
                type="button"
                onClick={() => removeTag(t)}
                aria-label={`Remove tag ${t}`}
                className="text-slate-slate400 hover:text-accent-red"
              >
                <X size={11} />
              </button>
            </span>
          ))}
          <input
            id={`${uid}-tags`}
            type="text"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={handleTagKey}
            onBlur={addTagFromInput}
            placeholder="Add tag…"
            className="px-2 py-1 text-xs rounded-md glass-input text-slate-slate100 placeholder-slate-slate500 focus:border-slate-slateBlueLight focus:outline-none w-32"
          />
        </div>
      </div>

      {formError && (
        <p role="alert" className={formErrorClass}>
          {formError}
        </p>
      )}

      <div className="flex justify-end mt-4">
        <button type="submit" disabled={!valid || submitting} className={btnPrimary}>
          {mode === 'edit' ? 'Save changes' : 'Add entry'}
        </button>
      </div>
    </form>
  );
}
