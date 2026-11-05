import { describe, it, expect } from 'vitest';
import { journalMarkdown, noteMarkdown, slugify } from '../export/markdown.js';

// Front matter is JSON-valued YAML: every line is `key: <json>`.
function parseFrontMatter(content) {
  const m = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(content);
  if (!m) throw new Error('no front matter');
  const front = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(': ');
    front[line.slice(0, i)] = JSON.parse(line.slice(i + 2));
  }
  return { front, body: m[2] };
}

const ID = 'ABCDEF12-3456-4789-8abc-def012345678';

describe('slugify', () => {
  it('strips diacritics, lowercases, and collapses separators', () => {
    expect(slugify('Café del Mar — Ñandú!', 'x')).toBe('cafe-del-mar-nandu');
    expect(slugify('  --Hello,   World--  ', 'x')).toBe('hello-world');
  });

  it('caps at 50 chars without a trailing dash', () => {
    const slug = slugify(`${'a'.repeat(49)} bbbbbb`, 'x');
    expect(slug.length).toBeLessThanOrEqual(50);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('uses the fallback when nothing survives', () => {
    expect(slugify('日本語 🎉', 'entry')).toBe('entry');
    expect(slugify('', 'note')).toBe('note');
    expect(slugify(null, 'note')).toBe('note');
  });
});

describe('journalMarkdown', () => {
  const row = {
    id: ID,
    title: 'A day: "out" --- there\nsecond line',
    date: '2026-02-03T04:05:06.789Z',
    body: 'Body line 1\nBody line 2\n',
    mood: 'good',
    tags: ['a', 'b "c"'],
    context: 'both',
    created_at: '2026-02-03T04:05:07.000Z',
  };

  it('names the file <date>-<slug>-<id8>.md under markdown/journal/', () => {
    expect(journalMarkdown(row).path).toBe('markdown/journal/2026-02-03-a-day-out-there-second-line-abcdef12.md');
  });

  it('falls back to the first body line, then to "entry", and to created_at for the date', () => {
    expect(journalMarkdown({ ...row, title: '', date: null }).path).toBe('markdown/journal/2026-02-03-body-line-1-abcdef12.md');
    expect(journalMarkdown({ ...row, title: null, body: '\n\n' }).path).toBe('markdown/journal/2026-02-03-entry-abcdef12.md');
  });

  it('writes JSON-escaped front matter that parses back, then the body verbatim', () => {
    const { content } = journalMarkdown(row);
    const { front, body } = parseFrontMatter(content);
    expect(front).toEqual({
      id: ID,
      title: row.title,
      date: row.date,
      mood: 'good',
      tags: row.tags,
      context: 'both',
      created_at: row.created_at,
    });
    expect(body).toBe(row.body);
    expect(content.startsWith('---\n')).toBe(true);
  });

  it('uses LF endings only and keeps a null mood as null', () => {
    const { content } = journalMarkdown({ ...row, mood: null, body: 'a\r\nb' });
    expect(content).not.toContain('\r');
    expect(content).toContain('\nmood: null\n');
    expect(content.endsWith('\n\na\nb')).toBe(true);
  });

  it('keeps front matter closed even when the title contains ---', () => {
    const { content } = journalMarkdown({ ...row, title: '---' });
    expect(parseFrontMatter(content).front.title).toBe('---');
    expect(content.split('\n').filter((l) => l === '---')).toHaveLength(2);
  });
});

describe('noteMarkdown', () => {
  const row = {
    id: '12345678-0000-4000-8000-000000000000',
    body: '\nBuy milk & eggs\nsecond',
    color: 'yellow',
    pinned: true,
    context: 'both',
    created_at: '2026-04-05T10:00:00.000Z',
  };

  it('names the file after the creation date and the first non-empty body line', () => {
    expect(noteMarkdown(row).path).toBe('markdown/notes/2026-04-05-buy-milk-eggs-12345678.md');
    expect(noteMarkdown({ ...row, body: '🎉' }).path).toBe('markdown/notes/2026-04-05-note-12345678.md');
  });

  it('writes the documented front matter keys and the body verbatim', () => {
    const { front, body } = parseFrontMatter(noteMarkdown(row).content);
    expect(Object.keys(front)).toEqual(['id', 'color', 'pinned', 'context', 'created_at']);
    expect(front).toMatchObject({ id: row.id, color: 'yellow', pinned: true, context: 'both' });
    expect(body).toBe(row.body);
  });

  it('derives id8 from the first 8 alphanumerics of the id', () => {
    expect(noteMarkdown({ ...row, id: 'ab-cd_ef!gh1234' }).path).toContain('-abcdefgh.md');
    expect(noteMarkdown({ ...row, id: 'n1' }).path).toContain('-n1.md');
  });
});
