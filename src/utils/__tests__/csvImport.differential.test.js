import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';
import { detectDelimiter, parseWith, readCsvText } from '../csvImport';

// parseWith replaced papaparse. papaparse is still installed (server tests use it), so this test keeps the two
// in lock step on seeded random input. Both are called with the options csvImport used: one fixed delimiter,
// skipEmptyLines false, and `preview` of 0 (whole file) or DELIMITER_SCAN_ROWS * 2 = 60 (delimiter probe).
// csvImport always feeds text that readCsvText normalized (no BOM, LF line ends), so inputs are normalized the
// same way before comparing.
const BOM = String.fromCharCode(0xfeff);
const reference = (text, delimiter, preview = 0) =>
  Papa.parse(text, { delimiter, skipEmptyLines: false, preview }).data;

// mulberry32: small seeded PRNG so a failure is reproducible from the seed in the message.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['a', 'b', 'Coffee', 'x y', '12.50', '-3', '', ' ', '  pad  ', 'é', '日本', '😀', 'ü,ö', "it's", '#', 'z'];

function makeInput(rand, delimiter) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const tokens = [
    () => pick(WORDS),
    () => pick(WORDS),
    () => delimiter,
    () => delimiter,
    () => '\n',
    () => '\r\n',
    () => '\r',
    () => '"',
    () => '""',
    () => `"${pick(WORDS)}"`,
    () => `"${pick(WORDS)}${delimiter}${pick(WORDS)}"`,
    () => `"line\nbreak"`,
    () => `"say ""hi"""`,
    () => `"unterminated`,
    () => `mid"quote`,
    () => `"x"y`,
    () => `"x"  `,
    () => ' ',
    () => '\t',
    () => pick([',', ';', '\t', '|']),
  ];
  const n = Math.floor(rand() * 24);
  let s = '';
  for (let i = 0; i < n; i++) s += pick(tokens)();
  if (rand() < 0.25) s += '\n';
  // One leading BOM at most: readCsvText strips exactly one, and papaparse would strip a second that never occurs.
  return rand() < 0.1 ? BOM + s : s;
}

describe('parseWith vs papaparse (differential)', () => {
  it('matches on 4000 seeded random inputs, whole file and preview 60', () => {
    const rand = rng(20261008);
    const mismatches = [];
    let compared = 0;
    for (let i = 0; i < 4000; i++) {
      const delimiter = [',', ';', '\t', '|'][i % 4];
      const raw = makeInput(rand, delimiter);
      let text;
      try {
        text = readCsvText(raw);
      } catch {
        // empty / NUL-free text that is only whitespace is refused before parsing, so it never reaches parseWith
        continue;
      }
      for (const preview of [0, 1, 2, 3, 60]) {
        compared++;
        const got = parseWith(text, delimiter, preview);
        const want = reference(text, delimiter, preview);
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          mismatches.push({ i, delimiter, preview, text, got, want });
          if (mismatches.length >= 3) break;
        }
      }
      if (mismatches.length >= 3) break;
    }
    expect(mismatches).toEqual([]);
    expect(compared).toBeGreaterThan(10000);
  });

  it('matches on raw, un-normalized input too (BOM and CR inside the text) when no normalization is applied', () => {
    // Not a csvImport path, but pins that parseWith stays a drop-in for the library on the same bytes.
    const rand = rng(77);
    const bad = [];
    for (let i = 0; i < 1000; i++) {
      const delimiter = [',', ';', '\t', '|'][i % 4];
      const text = makeInput(rand, delimiter).replaceAll(BOM, '').replace(/\r/g, '');
      if (!text) continue;
      const got = parseWith(text, delimiter);
      const want = reference(text, delimiter);
      if (JSON.stringify(got) !== JSON.stringify(want)) bad.push({ delimiter, text, got, want });
    }
    expect(bad.slice(0, 3)).toEqual([]);
  });

  it('matches on structured bank-like files with quotes, CRLF, BOM, blank lines and a trailing newline', () => {
    const rand = rng(5);
    const bad = [];
    for (let i = 0; i < 600; i++) {
      const delimiter = [',', ';', '\t', '|'][i % 4];
      const rows = [];
      const cols = 2 + Math.floor(rand() * 5);
      const count = 1 + Math.floor(rand() * 80);
      for (let r = 0; r < count; r++) {
        if (rand() < 0.05) {
          rows.push('');
          continue;
        }
        const cells = [];
        for (let c = 0; c < cols; c++) {
          const v = WORDS[Math.floor(rand() * WORDS.length)];
          const quoted = rand() < 0.3 || v.includes(delimiter);
          cells.push(quoted ? `"${v.replaceAll('"', '""')}"` : v);
        }
        rows.push(cells.join(delimiter));
      }
      const eol = ['\n', '\r\n', '\r'][i % 3];
      const raw = (i % 5 === 0 ? BOM : '') + rows.join(eol) + (i % 2 ? eol : '');
      let text;
      try {
        text = readCsvText(raw);
      } catch {
        continue;
      }
      for (const preview of [0, 60]) {
        const got = parseWith(text, delimiter, preview);
        const want = reference(text, delimiter, preview);
        if (JSON.stringify(got) !== JSON.stringify(want)) bad.push({ delimiter, preview, text, got, want });
      }
    }
    expect(bad.slice(0, 3)).toEqual([]);
  });

  it('picks the same delimiter as a papaparse-based probe would on random text', () => {
    const rand = rng(99);
    const refDetect = (raw) => {
      const clean = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
      let best = ',';
      let bestScore = -1;
      let bestWidth = 0;
      for (const d of [',', ';', '\t', '|']) {
        const rows = reference(clean, d, 60).filter((r) => !r.every((c) => String(c ?? '').trim() === ''));
        const sample = rows.slice(0, 30);
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
          best = d;
          bestScore = score;
          bestWidth = width;
        }
      }
      return best;
    };
    let compared = 0;
    for (let i = 0; i < 1500; i++) {
      const raw = makeInput(rand, [',', ';', '\t', '|'][i % 4]);
      if (raw.length > 60000) continue;
      compared++;
      expect(detectDelimiter(raw), JSON.stringify(raw)).toBe(refDetect(raw));
    }
    expect(compared).toBeGreaterThan(1000);
  });
});
