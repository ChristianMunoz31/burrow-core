import { useEffect, useId, useRef, useState } from 'react';
import { BTN } from '../settings/pillStyles';
import { userMessage } from '../../utils/apiError';
import {
  DIALOG_PROBLEMS,
  DOWNLOAD_INSTEAD,
  ERROR_COPY,
  EXPORT_ITEMS,
  GENERIC_ERROR,
  SAVE_WAITING,
  STOP_WAITING,
  SWITCH_HINT,
  SWITCH_LABEL,
} from '../../constants/folders';
import { useToast } from '../../contexts/ToastContext';
import { ICON_BTN, MENU_ITEM } from './folderStyles';

/**
 * The one More menu of a folder: the three exports (all free), the daily re-scan switch and Remove.
 * With `canSaveFile` the app's window asks where to save (`onSaveChosen`, which resolves to the final view of
 * that window); otherwise the file goes to the Downloads folder through the shared download path
 * (`onDownload`). A failure is handed to `onError` as text, so the caller can show it in the page flow, and a
 * failed save offers Download instead. `onError('')` is called at the start of each attempt.
 * The re-scan item is shown only when `autoRescan` is a boolean (an imported folder has none).
 * @param {{ onDownload: (format: 'md'|'json'|'csv') => Promise<unknown>, onError: (message: string) => void,
 *   label: string, canSaveFile?: boolean, onSaveChosen?: (format: 'md'|'json'|'csv') => Promise<object|null>,
 *   onCancelSave?: () => void, shellBusy?: boolean, autoRescan?: boolean, autoBusy?: boolean,
 *   onToggleAuto?: (next: boolean) => void, onRemove: () => void }} props
 */
export default function FolderMoreMenu({
  onDownload,
  onError,
  label,
  canSaveFile = false,
  onSaveChosen,
  onCancelSave,
  shellBusy = false,
  autoRescan,
  autoBusy = false,
  onToggleAuto,
  onRemove,
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fallback, setFallback] = useState(null);
  const menuId = useId();
  const hintId = useId();
  const labelId = useId();
  const wrapperRef = useRef(null);
  const triggerRef = useRef(null);
  const focusLastRef = useRef(false);
  const menuRef = useRef(null);
  const toast = useToast();
  const hasAuto = typeof autoRescan === 'boolean';

  const items = () => (menuRef.current ? [...menuRef.current.querySelectorAll('[role^="menuitem"]')] : []);

  useEffect(() => {
    if (!open) return undefined;
    const list = items();
    (focusLastRef.current ? list[list.length - 1] : list[0])?.focus();
    focusLastRef.current = false;
    const onPointerDown = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onMenuKeyDown = (e) => {
    if (e.key === 'Tab') {
      // Focus the trigger first, without preventDefault, so Tab moves on from there.
      triggerRef.current?.focus();
      setOpen(false);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const list = items();
    const index = list.indexOf(document.activeElement);
    if (index === -1) return;
    e.preventDefault();
    let next = index;
    if (e.key === 'ArrowDown') next = (index + 1) % list.length;
    if (e.key === 'ArrowUp') next = (index - 1 + list.length) % list.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = list.length - 1;
    list[next].focus();
  };

  const message = (err) => userMessage(err, ERROR_COPY[err?.code] ?? GENERIC_ERROR);
  const saved = (item) => toast({ message: `Saved ${item.label}.`, type: 'success' });

  // One export path: `choose` opens the native save dialog, otherwise the file downloads.
  const runExport = async (item, choose) => {
    setBusy(true);
    setSaving(choose);
    setFallback(null);
    onError('');
    try {
      if (!choose) {
        await onDownload(item.format);
        return saved(item);
      }
      const result = await onSaveChosen(item.format);
      if (result?.status === 'saved') saved(item);
      else if (DIALOG_PROBLEMS.includes(result?.status)) {
        onError(result.error?.message || ERROR_COPY[result.error?.code] || GENERIC_ERROR);
        if (result.status === 'failed') setFallback(item);
      }
    } catch (err) {
      onError(message(err));
      if (choose && (err?.code === 'save_too_large' || err?.status === 413)) setFallback(item);
    } finally {
      setSaving(false);
      setBusy(false);
    }
  };
  const download = (item) => runExport(item, false);

  // Every choice closes the menu and puts focus back on the trigger before it acts.
  const choose = (action) => {
    setOpen(false);
    triggerRef.current?.focus();
    return action();
  };
  const exportItem = (item) => choose(() => runExport(item, canSaveFile));
  const exportsDisabled = busy || shellBusy;

  const onTriggerKeyDown = (e) => {
    if (open || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    focusLastRef.current = e.key === 'ArrowUp';
    setOpen(true);
  };

  return (
    <>
      <div className="relative" ref={wrapperRef}>
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-label={`More actions for ${label}`}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={onTriggerKeyDown}
          className={ICON_BTN}
        >
          {/* A text glyph instead of an icon module keeps the bundle within budget. */}
          <span aria-hidden="true" className="text-base font-bold leading-none tracking-wider">⋯</span>
        </button>
        {open && (
          <ul
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={`Actions for ${label}`}
            onKeyDown={onMenuKeyDown}
            className="glass-menu absolute right-0 z-20 mt-2 w-60 overflow-hidden rounded-xl py-1"
          >
            <li role="none">
              <ul role="group" aria-label="Export">
                <li role="presentation" aria-hidden="true" className="px-3 pb-1 pt-2 text-xs text-slate-slate400">
                  Export
                </li>
                {EXPORT_ITEMS.map((item) => (
                  <li key={item.format} role="none">
                    <button
                      type="button"
                      role="menuitem"
                      aria-disabled={exportsDisabled || undefined}
                      tabIndex={-1}
                      onClick={() => {
                        if (exportsDisabled) return;
                        exportItem(item);
                      }}
                      className={MENU_ITEM}
                    >
                      {item.label}
                    </button>
                  </li>
                ))}
              </ul>
            </li>
            {hasAuto && (
              <li role="none" className="mt-1 border-t border-slate-slate700/40 pt-1">
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={autoRescan}
                  aria-labelledby={labelId}
                  aria-describedby={hintId}
                  aria-disabled={autoBusy || undefined}
                  tabIndex={-1}
                  onClick={() => {
                    if (autoBusy) return;
                    choose(() => onToggleAuto(!autoRescan));
                  }}
                  className={MENU_ITEM}
                >
                  <span className="flex items-center justify-between gap-3">
                    <span id={labelId}>{SWITCH_LABEL}</span>
                    <span aria-hidden="true" className="text-xs text-slate-slate400">
                      {autoRescan ? 'On' : 'Off'}
                    </span>
                  </span>
                  <span id={hintId} className="block text-xs text-slate-slate400">
                    {SWITCH_HINT}
                  </span>
                </button>
              </li>
            )}
            <li role="none" className="mt-1 border-t border-slate-slate700/40 pt-1">
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => choose(onRemove)}
                className={`${MENU_ITEM} !text-accent-red`}
              >
                Remove
              </button>
            </li>
          </ul>
        )}
      </div>
      {fallback && (
        <button type="button" onClick={() => !busy && download(fallback)} aria-disabled={busy || undefined} className={BTN}>
          {DOWNLOAD_INSTEAD}
        </button>
      )}
      {saving && (
        <div className="flex basis-full flex-wrap items-center gap-3">
          <p role="status" className="text-sm text-slate-slate300">
            {SAVE_WAITING}
          </p>
          <button type="button" onClick={onCancelSave} className={BTN}>
            {STOP_WAITING}
          </button>
        </div>
      )}
    </>
  );
}
