import { Suspense, lazy, useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Search,
  Sparkles,
  CornerDownLeft,
  CheckSquare,
  Upload,
  StickyNote,
  Notebook,
  Bookmark,
  Calendar,
  CalendarClock,
  Target,
  ArrowLeft,
} from 'lucide-react';
import { CALCULATOR_OPEN_EVENT } from '../calculator/openCalculator';
import { useCommandPalette } from '../../hooks/useCommandPalette';
import { useTheme } from '../../contexts/ThemeContext';
import { useToast } from '../../contexts/ToastContext';
import {
  buildNavCommands,
  buildPreferenceCommands,
  buildSettingsCommands,
  buildToolCommands,
  commandSearchText,
  QUICK_ACTIONS,
} from './commands';
import { openJavi } from '../javi/openJavi';
import { fuzzyFilter } from '../../utils/fuzzy';
import { todosService } from '../../services/todosService';
import { notesService } from '../../services/notesService';
import { journalService } from '../../services/journalService';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href]';
const QA_ICONS = {
  CheckSquare,
  StickyNote,
  Notebook,
  CalendarClock,
  Upload,
  Bookmark,
  Target,
  Calendar,
};

// Manages the visible + closing state machine for the palette animation.
// useReducer avoids direct setState calls in useEffect (lint rule: set-state-in-effect).
function animReducer(s, action) {
  if (action === 'OPEN') return { visible: true, closing: false };
  if (action === 'START_CLOSE') return { visible: true, closing: true };
  if (action === 'HIDE') return { visible: false, closing: false };
  return s;
}

const CalculatorDialog = lazy(() => import('../calculator/CalculatorDialog'));

// Mount controller: keeps only the open state, and remounts PaletteInner fresh
// on each open so transient state (query, selection, pending quick action) resets cleanly
// without reset-on-close effects. Closing state delays unmount by 220ms to let
// the fade-out animation finish before the DOM node is removed.
/**
 * Search and navigation. Conversation lives in the Javi panel: the Ask item hands the query
 * to it (see openJavi). `javiAvailable` is false on pages with no Javi (the launcher setting does not matter).
 * `initialOpen` mounts it already open (the lazy host passes the trigger that loaded it).
 * It also hosts the Calculator dialog (opened by its palette command through the calculator:open
 * event), so the dialog outlives the palette closing.
 * @param {{ javiAvailable?: boolean, initialOpen?: boolean }} props
 */
export default function CommandPalette({ javiAvailable = false, initialOpen = false }) {
  const { open, setOpen } = useCommandPalette(initialOpen);
  const [{ visible, closing }, dispatch] = useReducer(animReducer, { visible: false, closing: false });

  useEffect(() => {
    if (open) {
      dispatch('OPEN');
    } else if (visible) {
      dispatch('START_CLOSE');
      const t = setTimeout(() => dispatch('HIDE'), 220);
      return () => clearTimeout(t);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const [calcOpen, setCalcOpen] = useState(false);
  const calcReturn = useRef(null);
  useEffect(() => {
    const onCalc = (e) => {
      calcReturn.current = e.detail?.returnTo ?? null;
      setCalcOpen(true);
    };
    window.addEventListener(CALCULATOR_OPEN_EVENT, onCalc);
    return () => window.removeEventListener(CALCULATOR_OPEN_EVENT, onCalc);
  }, []);

  return (
    <>
      {visible && <PaletteInner onClose={() => setOpen(false)} closing={closing} javiAvailable={javiAvailable} />}
      {calcOpen && (
        <Suspense fallback={null}>
          <CalculatorDialog onClose={() => setCalcOpen(false)} finalFocusRef={calcReturn} />
        </Suspense>
      )}
    </>
  );
}

function PaletteInner({ onClose, closing, javiAvailable }) {
  const navigate = useNavigate();
  const { preference, setPreference } = useTheme();
  const qc = useQueryClient();
  const toast = useToast();

  const [query, setQuery] = useState('');
  const [selectedRaw, setSelected] = useState(0);
  const [pendingAction, setPendingAction] = useState(null); // quick action awaiting input
  const [actionValue, setActionValue] = useState('');
  const [actionError, setActionError] = useState(null); // inline failure of the quick add, text kept
  const [search, setSearch] = useState({ q: '', results: [] });
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const dialogRef = useRef(null);
  // The element that had focus when the palette opened (PaletteInner mounts fresh on each open).
  const [opener] = useState(() => document.activeElement);
  const inFlight = useRef(false);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (idx) => `${baseId}-opt-${idx}`;
  const errorId = `${baseId}-error`;

  // Give focus back on close, unless the action moved it on purpose (e.g. to the Javi panel).
  useEffect(
    () => () => {
      const now = document.activeElement;
      const free = !now || now === document.body || now.closest?.('[role="dialog"][aria-label="Command palette"]');
      if (free && opener?.isConnected && typeof opener.focus === 'function') opener.focus();
    },
    [opener],
  );

  // Focus the input on mount / view change.
  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [pendingAction]);

  // Debounced global search over the user's data while typing.
  // setState happens inside the timeout callback (not synchronously in the effect
  // body), so it doesn't trigger cascading renders.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      const t = setTimeout(() => setSearch({ q: '', results: [] }), 0);
      return () => clearTimeout(t);
    }
    const controller = new AbortController();
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (controller.signal.aborted) return;
        setSearch({ q, results: Array.isArray(data.results) ? data.results : [] });
      } catch {
        if (controller.signal.aborted) return;
        setSearch({ q, results: [] });
      }
    }, 180);
    return () => {
      clearTimeout(id);
      controller.abort();
    };
  }, [query]);

  const runQuickAdd = useCallback(
    async (kind, value) => {
      const v = value.trim();
      if (!v || inFlight.current) return;
      inFlight.current = true;
      setActionError(null);
      try {
        if (kind === 'todo') {
          await todosService.create({ title: v });
          qc.invalidateQueries({ queryKey: ['todos'] });
        } else if (kind === 'note') {
          await notesService.create({ body: v });
          qc.invalidateQueries({ queryKey: ['notes'] });
        } else if (kind === 'journal') {
          await journalService.create({ body: v });
          qc.invalidateQueries({ queryKey: ['journal'] });
        }
        toast({ message: `${kind.charAt(0).toUpperCase() + kind.slice(1)} saved`, type: 'success' });
        onClose();
      } catch {
        // Stay in the quick add with the typed text so nothing is lost.
        setActionError("Couldn't save that. Try again.");
      } finally {
        inFlight.current = false;
      }
    },
    [qc, onClose, toast],
  );

  const askJavi = useCallback(
    (q) => {
      onClose();
      openJavi({ prompt: q });
    },
    [onClose],
  );

  // Assemble the ordered, selectable command list for the current query.
  const items = useMemo(() => {
    const q = query.trim();
    const list = [];
    const askItem = javiAvailable
      ? {
          id: 'ask',
          label: q ? `Ask Javi: “${q}”` : 'Open Javi',
          hint: q ? null : 'Alt+J',
          icon: Sparkles,
          group: 'Javi',
          onSelect: () => askJavi(q),
        }
      : null;

    // With no query, Open Javi leads. With a query it goes last so Enter picks the
    // best command or search match, not an accidental question.
    if (askItem && !q) list.push(askItem);

    const quick = QUICK_ACTIONS.map((a) => ({
      id: a.id,
      label: a.label,
      icon: QA_ICONS[a.icon] || CheckSquare,
      group: 'Actions',
      onSelect: () => {
        if (a.kind === 'nav') {
          navigate(a.to);
          onClose();
        } else {
          setPendingAction(a);
          setActionValue('');
          setActionError(null);
        }
      },
    }));
    list.push(...fuzzyFilter(q, quick, (i) => i.label));

    const tools = buildToolCommands({ returnTo: opener }).map((c) => ({
      ...c,
      onSelect: () => {
        c.run();
        onClose();
      },
    }));
    list.push(...fuzzyFilter(q, tools, commandSearchText));

    const nav = buildNavCommands({ navigate }).map((c) => ({
      ...c,
      onSelect: () => {
        c.run();
        onClose();
      },
    }));
    list.push(...fuzzyFilter(q, nav, commandSearchText));

    const more = [
      ...buildSettingsCommands({ navigate }),
      ...buildPreferenceCommands({ preference, setPreference }),
    ].map((c) => ({
      ...c,
      onSelect: () => {
        c.run();
        onClose();
      },
    }));
    list.push(...fuzzyFilter(q, more, commandSearchText));

    const freshResults = search.q === q ? search.results : [];
    for (const r of freshResults) {
      list.push({
        id: `search:${r.kind}:${r.id}`,
        label: r.title || '(untitled)',
        hint: `${r.kind}${r.meta ? ` · ${r.meta}` : ''}`,
        icon: Search,
        group: 'In your data',
        onSelect: () => {
          navigate(r.to);
          onClose();
        },
      });
    }
    if (askItem && q) list.push(askItem);
    return list;
  }, [query, preference, setPreference, search, navigate, onClose, askJavi, javiAvailable, opener]);

  // Clamp selection at render (no setState-in-effect) so the list staying in sync
  // with a changing result set is derived, not stored.
  const selected = items.length ? Math.min(selectedRaw, items.length - 1) : 0;

  // aria-modal: keep Tab inside the dialog.
  const onDialogKeyDown = (e) => {
    // Escape in a quick add goes back to the list from anywhere in the dialog (input or Back button).
    if (e.key === 'Escape' && pendingAction) {
      e.preventDefault();
      setPendingAction(null);
      setActionError(null);
      return;
    }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const stops = [...dialogRef.current.querySelectorAll(FOCUSABLE)];
    if (stops.length === 0) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !dialogRef.current.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  const onKeyDown = (e) => {
    if (pendingAction) {
      if (e.key === 'Enter') {
        e.preventDefault();
        runQuickAdd(pendingAction.kind, actionValue);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected(Math.min(selected + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected(Math.max(selected - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      items[selected]?.onSelect?.();
    }
  };

  // Scroll the selected row into view.
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${selected}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  const placeholder = pendingAction
    ? pendingAction.placeholder
    : javiAvailable
      ? 'Search commands, your data, or ask Javi…'
      : 'Search commands and your data…';

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]">
      <div className={`glass-overlay absolute inset-0 ${closing ? 'animate-overlay-out' : 'animate-overlay-in'}`} onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onDialogKeyDown}
        className={`glass-strong relative w-full max-w-xl rounded-2xl overflow-hidden ${closing ? 'animate-overlay-out' : 'animate-overlay-in'}`}
      >
        {/* Input row */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-slate700/50">
          {pendingAction ? (
            <button
              type="button"
              onClick={() => {
                setPendingAction(null);
                setActionError(null);
              }}
              className="inline-flex h-9 w-9 sm:h-7 sm:w-7 shrink-0 items-center justify-center rounded-md text-slate-slate400 hover:text-slate-slate100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-slateBlueLight"
              aria-label="Back"
            >
              <ArrowLeft size={16} aria-hidden="true" />
            </button>
          ) : (
            <Search size={16} className="text-slate-slate400 shrink-0" aria-hidden="true" />
          )}
          <input
            ref={inputRef}
            value={pendingAction ? actionValue : query}
            onChange={(e) => {
              if (pendingAction) {
                setActionValue(e.target.value);
                setActionError(null);
              } else {
                setQuery(e.target.value);
                setSelected(0);
              }
            }}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            aria-label={pendingAction ? pendingAction.label : 'Search'}
            {...(pendingAction
              ? { 'aria-describedby': actionError ? errorId : undefined, 'aria-invalid': actionError ? true : undefined }
              : {
                  role: 'combobox',
                  'aria-expanded': items.length > 0,
                  'aria-controls': items.length > 0 ? listId : undefined,
                  'aria-activedescendant': items.length > 0 ? optionId(selected) : undefined,
                  'aria-autocomplete': 'list',
                })}
            className="flex-1 min-w-0 bg-transparent outline-none text-sm text-slate-slate100 placeholder:text-slate-slate400"
          />
          <span className="sr-only" aria-live="polite" aria-atomic="true">
            {items.length > 0 ? `${items.length} result${items.length === 1 ? '' : 's'}` : ''}
          </span>
        </div>

        {/* Body */}
        {pendingAction ? (
          <div className="px-4 py-3 text-xs text-slate-slate400 space-y-1.5">
            {actionError && (
              <p id={errorId} role="alert" className="text-accent-red">
                {actionError}
              </p>
            )}
            <p>
              Press <Kbd>Enter</Kbd> to save · <Kbd>Esc</Kbd> to cancel
            </p>
          </div>
        ) : (
          <CommandResults
            items={items}
            selected={selected}
            setSelected={setSelected}
            listRef={listRef}
            listId={listId}
            optionId={optionId}
          />
        )}
      </div>
    </div>
  );
}

function CommandResults({ items, selected, setSelected, listRef, listId, optionId }) {
  if (items.length === 0) {
    return <div className="px-4 py-8 text-center text-sm text-slate-slate400">No matches. Try something else.</div>;
  }
  return (
    <div ref={listRef} id={listId} role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto py-2">
      {items.map((item, idx) => {
        const Icon = item.icon;
        const showGroup = idx === 0 || items[idx - 1].group !== item.group;
        return (
          <div key={item.id} role="presentation">
            {showGroup && (
              <div aria-hidden="true" className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wide text-slate-slate400">
                {item.group}
              </div>
            )}
            <div
              id={optionId(idx)}
              role="option"
              aria-selected={idx === selected}
              tabIndex={-1}
              data-idx={idx}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setSelected(idx)}
              onClick={() => item.onSelect?.()}
              className={`w-full flex items-center gap-3 px-4 py-2 text-left text-sm transition-colors cursor-pointer ${
                idx === selected ? 'bg-slate-slate700/60 text-slate-slate100' : 'text-slate-slate300 hover:bg-slate-slate700/40'
              }`}
            >
              {Icon && <Icon size={15} className="text-slate-slate400 shrink-0" aria-hidden="true" />}
              <span className="flex-1 truncate">{item.label}</span>
              {item.hint && <span className="text-xs text-slate-slate400 truncate max-w-[40%]">{item.hint}</span>}
              {idx === selected && <CornerDownLeft size={13} className="text-slate-slate400 shrink-0" aria-hidden="true" />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Kbd({ children }) {
  return (
    <kbd className="px-1.5 py-0.5 rounded border border-slate-slate700 bg-slate-slate700/40 text-[10px] text-slate-slate300">
      {children}
    </kbd>
  );
}
