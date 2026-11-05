// The CSV splitter and delimiter detection (no React, no network, no budget rules). Shared by the transaction
// importer (`csvImport.js`) and the Folders preview, so the preview does not pull in the budget categories.

export const DELIMITERS = [',', ';', '\t', '|'];
const DELIMITER_PROBE_CHARS = 64 * 1024;
const DELIMITER_SCAN_ROWS = 30;

/**
 * Splits CSV text into rows of cells with one fixed single-character delimiter. Rows end at "\n" (the text is
 * normalized first); a field that starts with a quote may hold delimiters, line breaks and "" for a quote.
 * Malformed quotes are read the lenient way: a quote counts as closing only before the delimiter, a line end
 * or the end of the text. `preview` stops after that many rows (0 reads everything).
 * @param {string} text
 * @param {string} delimiter
 * @param {number} [preview]
 * @returns {string[][]}
 */
export function parseWith(text, delimiter, preview = 0) {
  if (!text) return [];
  if (!text.includes('"')) {
    const lines = text.split('\n');
    return (preview ? lines.slice(0, preview) : lines).map((line) => line.split(delimiter));
  }
  const data = [];
  let row = [];
  let cursor = 0;
  let nextDelim = text.indexOf(delimiter);
  let nextNewline = text.indexOf('\n');
  const gap = (from, to) => (to > from && text.slice(from, to).trim() === '' ? to - from : 0);
  const endRow = (next) => {
    data.push(row);
    row = [];
    cursor = next;
    nextNewline = text.indexOf('\n', cursor);
    return preview > 0 && data.length >= preview;
  };
  for (;;) {
    if (text[cursor] === '"') {
      const start = ++cursor;
      let close = start - 1;
      for (;;) {
        close = text.indexOf('"', close + 1);
        if (close === -1) break;
        if (close === text.length - 1) break;
        if (text[close + 1] === '"') {
          close++;
          continue;
        }
        if (nextDelim !== -1 && nextDelim < close + 1) nextDelim = text.indexOf(delimiter, close + 1);
        if (nextNewline !== -1 && nextNewline < close + 1) nextNewline = text.indexOf('\n', close + 1);
        const upTo = nextNewline === -1 ? nextDelim : Math.min(nextDelim, nextNewline);
        const afterDelim = close + 1 + (upTo === -1 ? 0 : gap(close + 1, upTo));
        if (text.startsWith(delimiter, afterDelim)) {
          row.push(text.slice(start, close).replaceAll('""', '"'));
          cursor = afterDelim + 1;
          nextDelim = text.indexOf(delimiter, cursor);
          nextNewline = text.indexOf('\n', cursor);
          break;
        }
        const afterNewline = close + 1 + (nextNewline === -1 ? 0 : gap(close + 1, nextNewline));
        if (text.startsWith('\n', afterNewline)) {
          row.push(text.slice(start, close).replaceAll('""', '"'));
          const stop = endRow(afterNewline + 1);
          nextDelim = text.indexOf(delimiter, cursor);
          if (stop) return data;
          break;
        }
        close++;
      }
      if (close === -1 || close === text.length - 1) {
        // An unterminated quote keeps the rest of the text; a quote that is the last character closes the field.
        row.push(close === -1 ? text.slice(cursor) : text.slice(start, close).replaceAll('""', '"'));
        data.push(row);
        return data;
      }
      continue;
    }
    if (nextDelim !== -1 && (nextDelim < nextNewline || nextNewline === -1)) {
      row.push(text.slice(cursor, nextDelim));
      cursor = nextDelim + 1;
      nextDelim = text.indexOf(delimiter, cursor);
      continue;
    }
    if (nextNewline !== -1) {
      row.push(text.slice(cursor, nextNewline));
      if (endRow(nextNewline + 1)) return data;
      continue;
    }
    break;
  }
  row.push(text.slice(cursor));
  data.push(row);
  return data;
}

export const isBlankRow = (cells) => cells.every((c) => String(c ?? '').trim() === '');

/**
 * Pick the delimiter among , ; tab | by how consistently it splits the first rows
 * (quoted fields are respected). Falls back to a comma.
 * @param {string} text
 * @returns {string}
 */
export function detectDelimiter(text) {
  let clean = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  // Probe a bounded prefix (cut at a line end) so a huge file is not parsed once per delimiter.
  if (clean.length > DELIMITER_PROBE_CHARS) {
    clean = clean.slice(0, DELIMITER_PROBE_CHARS);
    const cut = clean.lastIndexOf('\n');
    if (cut > 0) clean = clean.slice(0, cut);
  }
  let best = ',';
  let bestScore = -1;
  let bestWidth = 0;
  for (const delimiter of DELIMITERS) {
    const rows = parseWith(clean, delimiter, DELIMITER_SCAN_ROWS * 2).filter((r) => !isBlankRow(r));
    const sample = rows.slice(0, DELIMITER_SCAN_ROWS);
    if (sample.length === 0) continue;
    const counts = new Map();
    for (const r of sample) counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
    let width = 0;
    let freq = 0;
    for (const [w, f] of counts) {
      if (f > freq || (f === freq && w > width)) {
        width = w;
        freq = f;
      }
    }
    if (width < 2) continue;
    const score = freq / sample.length;
    if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) < 1e-9 && width > bestWidth)) {
      best = delimiter;
      bestScore = score;
      bestWidth = width;
    }
  }
  return best;
}

