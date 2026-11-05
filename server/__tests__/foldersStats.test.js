// computeFolderStats, the facts the model receives, formatBytes, duplicate detection and the summary input hash.
// Every number is computed in code; these tests pin the arithmetic.
import { describe, expect, it } from 'vitest';
import { buildFileFacts, buildFolderFacts, computeFolderStats, duplicateGroups, formatBytes, summaryInputHash } from '../folders/stats.js';

const row = (rel_path, over = {}) => ({
  rel_path,
  ext: rel_path.includes('.') ? rel_path.split('.').pop() : '',
  kind: 'text',
  status: 'ok',
  size_bytes: 100,
  mtime: '2026-03-01T10:00:00.000Z',
  sha256: `sha-${rel_path}`,
  line_count: 10,
  word_count: 50,
  summary_hash: null,
  summary_status: 'none',
  chunk_count: 0,
  index_hash: null,
  ...over,
});

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [1, '1 B'],
    [812, '812 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [12698, '12.4 KB'],
    [1024 * 1024, '1.0 MB'],
    [3.04 * 1024 * 1024, '3.0 MB'],
    [1024 ** 3, '1.0 GB'],
    [1024 ** 4, '1.0 TB'],
    [1024 ** 5, '1024.0 TB'],
  ])('%d bytes is %s', (n, text) => {
    expect(formatBytes(n)).toBe(text);
  });

  it.each([[-5], [NaN], [Infinity], [undefined], [null], ['12']])('treats %j as 0 B', (n) => {
    expect(formatBytes(n)).toBe('0 B');
  });
});

describe('duplicateGroups', () => {
  it('groups readable files with the same hash, sorted by path, groups by first path', () => {
    const rows = [
      row('z.txt', { sha256: 'S1' }),
      row('b.txt', { sha256: 'S2' }),
      row('a.txt', { sha256: 'S1' }),
      row('c.txt', { sha256: 'S2' }),
      row('lone.txt', { sha256: 'S3' }),
    ];
    expect(duplicateGroups(rows)).toEqual([['a.txt', 'z.txt'], ['b.txt', 'c.txt']]);
  });

  it('ignores empty, unreadable, link and hash-less rows', () => {
    const rows = [
      row('a.txt', { sha256: 'S' }),
      row('e1.txt', { sha256: 'E', status: 'empty', size_bytes: 0 }),
      row('e2.txt', { sha256: 'E', status: 'empty', size_bytes: 0 }),
      row('z1.txt', { sha256: 'Z', size_bytes: 0 }),
      row('z2.txt', { sha256: 'Z', size_bytes: 0 }),
      row('n1.txt', { sha256: null }),
      row('n2.txt', { sha256: null }),
      row('l1', { sha256: 'S', status: 'link' }),
    ];
    expect(duplicateGroups(rows)).toEqual([]);
  });
});

describe('computeFolderStats', () => {
  const rows = [
    row('a.txt', { size_bytes: 1000, line_count: 10, word_count: 100, mtime: '2026-01-05T00:00:00.000Z', sha256: 'DUP' }),
    row('sub/b.txt', { size_bytes: 2000, line_count: 20, word_count: 200, mtime: '2026-02-05T00:00:00.000Z', sha256: 'DUP' }),
    row('c.md', { kind: 'text', size_bytes: 500, line_count: 5, word_count: 50, mtime: '2026-03-05T00:00:00.000Z' }),
    row('d.py', { kind: 'code', size_bytes: 300, line_count: 3, word_count: 30, mtime: '2025-12-31T00:00:00.000Z' }),
    row('e.csv', { kind: 'data', size_bytes: 40, line_count: 2, word_count: 2, mtime: null }),
    row('pic.png', { kind: 'other', ext: 'png', status: 'unsupported', size_bytes: 9000, sha256: null, line_count: null, word_count: null, mtime: '2026-04-01T00:00:00.000Z' }),
    row('blob.bin', { kind: 'other', ext: 'bin', status: 'binary', size_bytes: 70, sha256: null, line_count: null, word_count: null }),
    row('shortcut', { kind: 'other', ext: '', status: 'link', size_bytes: 0, sha256: null }),
    row('escape.txt', { status: 'outside_root', size_bytes: 0, sha256: null }),
    row('noext', { kind: 'other', ext: '', status: 'unsupported', size_bytes: 5, sha256: null }),
  ];
  const stats = computeFolderStats(rows, { dirsScanned: 3, dirsSkipped: 1, limitsHit: ['max_files', 'max_depth', 'max_files'] });

  it('counts files, sizes, lines and words of the readable files in code', () => {
    expect(stats).toMatchObject({
      filesTotal: 10,
      filesRead: 5,
      bytesTotal: 1000 + 2000 + 500 + 300 + 40 + 9000 + 70 + 5,
      bytesRead: 1000 + 2000 + 500 + 300 + 40,
      linesTotal: 10 + 20 + 5 + 3 + 2,
      wordsTotal: 100 + 200 + 50 + 30 + 2,
      dirsScanned: 3,
      dirsSkipped: 1,
    });
  });

  it('counts every status, including links and escapes', () => {
    expect(stats.byStatus).toEqual({ ok: 5, unsupported: 2, binary: 1, too_large: 0, unreadable: 0, empty: 0, link: 1, outside_root: 1, skipped_limit: 0 });
  });

  it('breaks files and bytes down by kind without counting links and escapes', () => {
    expect(stats.byKind).toEqual({
      text: { files: 3, bytes: 3500 },
      data: { files: 1, bytes: 40 },
      code: { files: 1, bytes: 300 },
      document: { files: 0, bytes: 0 },
      other: { files: 3, bytes: 9075 },
    });
  });

  it('lists extensions by file count then name, with (none) for no extension', () => {
    expect(stats.byExt).toEqual([
      { ext: '.txt', files: 2, bytes: 3000 },
      { ext: '(none)', files: 1, bytes: 5 },
      { ext: '.bin', files: 1, bytes: 70 },
      { ext: '.csv', files: 1, bytes: 40 },
      { ext: '.md', files: 1, bytes: 500 },
      { ext: '.png', files: 1, bytes: 9000 },
      { ext: '.py', files: 1, bytes: 300 },
    ]);
  });

  it('keeps only the top 15 extensions', () => {
    const many = Array.from({ length: 20 }, (_v, i) => row(`f${i}.e${String(i).padStart(2, '0')}`));
    expect(computeFolderStats(many).byExt).toHaveLength(15);
  });

  it('finds the oldest and newest modified time, ignoring missing ones', () => {
    expect(stats.oldestModifiedAt).toBe('2025-12-31T00:00:00.000Z');
    expect(stats.newestModifiedAt).toBe('2026-04-01T00:00:00.000Z');
    expect(computeFolderStats([row('x.txt', { mtime: null })])).toMatchObject({ oldestModifiedAt: null, newestModifiedAt: null });
  });

  it('lists the 5 largest files, biggest first, ties by path, never links or escapes', () => {
    expect(stats.largestFiles).toEqual([
      { path: 'pic.png', bytes: 9000 },
      { path: 'sub/b.txt', bytes: 2000 },
      { path: 'a.txt', bytes: 1000 },
      { path: 'c.md', bytes: 500 },
      { path: 'd.py', bytes: 300 },
    ]);
  });

  it('counts duplicate groups and sorts and de-duplicates the limits hit', () => {
    expect(stats.duplicateGroups).toBe(1);
    expect(stats.limitsHit).toEqual(['max_depth', 'max_files']);
  });

  it('is all zero for no rows', () => {
    const empty = computeFolderStats([]);
    expect(empty).toMatchObject({ filesTotal: 0, filesRead: 0, bytesTotal: 0, bytesRead: 0, linesTotal: 0, wordsTotal: 0, byExt: [], largestFiles: [], duplicateGroups: 0, limitsHit: [], oldestModifiedAt: null, newestModifiedAt: null });
    expect(empty.index).toEqual({ status: 'none', files: 0, chunks: 0, skipped: null });
  });

  describe('index status', () => {
    const indexed = (name, chunks) => row(name, { chunk_count: chunks, index_hash: `sha-${name}` });

    it('none without chunks, partial when some readable files are indexed, ready when all are', () => {
      expect(computeFolderStats([row('a.txt'), row('b.txt')]).index).toEqual({ status: 'none', files: 0, chunks: 0, skipped: null });
      expect(computeFolderStats([indexed('a.txt', 3), row('b.txt')]).index).toEqual({ status: 'partial', files: 1, chunks: 3, skipped: null });
      expect(computeFolderStats([indexed('a.txt', 3), indexed('b.txt', 2)]).index).toEqual({ status: 'ready', files: 2, chunks: 5, skipped: null });
    });

    it('a chunk set built from an older version of the file does not count', () => {
      const stale = row('a.txt', { chunk_count: 4, index_hash: 'old-hash' });
      expect(computeFolderStats([stale]).index).toMatchObject({ status: 'none', chunks: 0 });
    });

    it('carries the reason the index was skipped', () => {
      expect(computeFolderStats([row('a.txt')], { indexSkipped: 'not_pro' }).index.skipped).toBe('not_pro');
    });
  });
});

describe('buildFolderFacts', () => {
  const rows = [
    row('a.txt', { size_bytes: 1500, line_count: 1200, word_count: 3400 }),
    row('b.md', { size_bytes: 777, mtime: '2026-02-01T00:00:00.000Z' }),
    row('c.py', { kind: 'code', size_bytes: 100 }),
    row('img.png', { kind: 'other', ext: 'png', status: 'unsupported', size_bytes: 1024 * 1024, sha256: null, mtime: '2026-03-01T00:00:00.000Z' }),
    row('x.bin', { kind: 'other', ext: 'bin', status: 'binary', size_bytes: 10, sha256: null }),
  ];
  const stats = computeFolderStats(rows);
  const facts = buildFolderFacts(stats);

  it('every value is an already formatted string equal to what the stats say', () => {
    expect(facts).toMatchObject({
      Files: '5',
      'Files read': '3',
      'Total size': formatBytes(stats.bytesTotal),
      'Text size': formatBytes(stats.bytesRead),
      Lines: new Intl.NumberFormat('en-US').format(stats.linesTotal),
      Words: new Intl.NumberFormat('en-US').format(stats.wordsTotal),
      Kinds: '2 text, 1 code, 2 other',
      'Duplicate groups': '0',
    });
    expect(facts.Lines).toBe('1,220');
    for (const value of Object.values(facts)) expect(typeof value).toBe('string');
  });

  it('names the file types, what was not read, the date range and the largest files', () => {
    expect(facts['File types']).toBe('.bin 1, .md 1, .png 1, .py 1, .txt 1');
    expect(facts['Not read']).toBe('1 unsupported, 1 binary');
    expect(facts['Changed between']).toBe('2026-02-01 and 2026-03-01');
    expect(facts['Largest files']).toBe('img.png, a.txt, b.md');
  });

  it('says `none` for empty parts and omits the date range and largest files with no data', () => {
    const f = buildFolderFacts(computeFolderStats([]));
    expect(f).toMatchObject({ Files: '0', Kinds: 'none', 'File types': 'none', 'Not read': 'none' });
    expect(f).not.toHaveProperty('Changed between');
    expect(f).not.toHaveProperty('Largest files');
  });

  it('one shared date is shown once', () => {
    const f = buildFolderFacts(computeFolderStats([row('a.txt'), row('b.txt')]));
    expect(f['Changed between']).toBe('2026-03-01');
  });

  it('never carries a raw per-file size', () => {
    const json = JSON.stringify(facts);
    for (const r of rows) if (r.size_bytes >= 100) expect(json).not.toMatch(new RegExp(`\\b${r.size_bytes}\\b`));
  });
});

describe('buildFileFacts', () => {
  it('formats the size and keeps counts and the date', () => {
    expect(buildFileFacts(row('docs/readme.md', { size_bytes: 2048, line_count: 1234, word_count: 5, mtime: '2026-05-06T07:08:09.000Z' }))).toEqual({
      File: 'docs/readme.md',
      Type: '.md',
      Size: '2.0 KB',
      Lines: '1,234',
      Words: '5',
      Modified: '2026-05-06',
    });
  });

  it('leaves out what is not known', () => {
    expect(buildFileFacts({ rel_path: 'Makefile', ext: '', size_bytes: 3, line_count: null, word_count: null, mtime: null })).toEqual({ File: 'Makefile', Type: 'none', Size: '3 B' });
  });
});

describe('summaryInputHash', () => {
  const rows = [row('a.txt', { summary_hash: 'h1', summary_status: 'ok' }), row('b.txt', { summary_hash: 'h2', summary_status: 'ok' })];
  const stats = computeFolderStats(rows);

  it('is a stable sha-256 hex string', () => {
    expect(summaryInputHash(rows, stats)).toMatch(/^[0-9a-f]{64}$/);
    expect(summaryInputHash(rows, stats)).toBe(summaryInputHash(rows, stats));
  });

  it('does not depend on row order', () => {
    expect(summaryInputHash([...rows].reverse(), stats)).toBe(summaryInputHash(rows, stats));
  });

  it('changes when a file summary changes', () => {
    const changed = [rows[0], { ...rows[1], summary_hash: 'h2b' }];
    expect(summaryInputHash(changed, stats)).not.toBe(summaryInputHash(rows, stats));
    const failed = [rows[0], { ...rows[1], summary_status: 'failed' }];
    expect(summaryInputHash(failed, stats)).not.toBe(summaryInputHash(rows, stats));
  });

  it('changes when the facts change', () => {
    const more = [...rows, row('c.txt')];
    expect(summaryInputHash(more, computeFolderStats(more))).not.toBe(summaryInputHash(rows, stats));
  });

  it('ignores files that are not readable text', () => {
    const withPng = [...rows, row('p.png', { status: 'unsupported', summary_hash: 'zzz' })];
    // the facts change (one more file), but a row's own summary_hash does not matter for a non-readable file
    const a = summaryInputHash(withPng, stats);
    const b = summaryInputHash([...rows, row('p.png', { status: 'unsupported', summary_hash: 'other' })], stats);
    expect(a).toBe(b);
  });
});
