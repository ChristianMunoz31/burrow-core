// Pure helpers for the Folders preview pane (no React, no network). The text is always rendered as React text.
import { detectDelimiter, parseWith } from './csvSplit';
import { PREVIEW_CSV_COLUMNS, PREVIEW_CSV_ROWS } from '../constants/folders';

const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

/** Display text without bidirectional override controls, so a file name or cell cannot reorder the page. */
export const stripBidi = (value) => String(value ?? '').replace(BIDI_CONTROLS, '');

const isLowSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Cuts `text` at the page start offsets. Offsets that are not whole numbers inside the text, or not increasing,
 * are skipped; an offset inside a surrogate pair moves back to its start. `page` is the page number of the
 * segment (page 1 has no divider).
 * @param {string} text
 * @param {number[]|null|undefined} pageBreaks
 * @returns {{ page: number, text: string }[]}
 */
export function splitPages(text, pageBreaks) {
  const segments = [];
  let start = 0;
  let page = 1;
  (Array.isArray(pageBreaks) ? pageBreaks : []).forEach((raw, i) => {
    if (!Number.isInteger(raw)) return;
    const at = raw > 0 && raw < text.length && isLowSurrogate(text.charCodeAt(raw)) ? raw - 1 : raw;
    if (at <= start || at >= text.length) return;
    segments.push({ page, text: text.slice(start, at) });
    start = at;
    page = i + 2;
  });
  segments.push({ page, text: text.slice(start) });
  return segments;
}

/**
 * The first rows of a CSV or TSV text, split with the shared importer splitter. The first non-blank line is
 * the header. `moreRows` is true when the file has more than `PREVIEW_CSV_ROWS` data rows, `moreCols` when a
 * shown row had more than `PREVIEW_CSV_COLUMNS` cells. When the server cut the text (`truncated`), the last,
 * probably partial, line is dropped.
 * @param {string} raw
 * @param {boolean} [truncated]
 * @returns {{ headers: string[], rows: string[][], moreRows: boolean, moreCols: boolean } | null} null when there is no row
 */
export function parseCsvPreview(raw, truncated = false) {
  let text = String(raw ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (truncated && text.includes('\n')) text = text.slice(0, text.lastIndexOf('\n'));
  const delimiter = detectDelimiter(text);
  const all = parseWith(text, delimiter, PREVIEW_CSV_ROWS + 2).filter((cells) => cells.some((c) => c.trim() !== ''));
  if (all.length === 0) return null;
  const cut = (cells) => cells.slice(0, PREVIEW_CSV_COLUMNS).map(stripBidi);
  const shown = all.slice(0, PREVIEW_CSV_ROWS + 1);
  return {
    headers: cut(all[0]),
    rows: all.slice(1, PREVIEW_CSV_ROWS + 1).map(cut),
    moreRows: all.length > PREVIEW_CSV_ROWS + 1,
    moreCols: shown.some((cells) => cells.length > PREVIEW_CSV_COLUMNS),
  };
}

/** Whole kilobytes for the "Showing the first N KB" note, at least 1. */
export const previewKb = (shownChars) => Math.max(1, Math.round((Number(shownChars) || 0) / 1024));
