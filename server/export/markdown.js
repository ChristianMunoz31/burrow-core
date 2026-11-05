// Markdown rendering for journal entries and notes in the export ZIP. Front matter values are
// JSON-encoded (valid YAML 1.2 flow syntax), so titles with ':', '---', quotes or newlines are
// safe. Files are named <date>-<slug>-<id8>.md; the id suffix keeps names unique and stable.

/**
 * @param {unknown} text
 * @param {string} fallback
 * @returns {string}
 */
export function slugify(text, fallback) {
  const slug = String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return slug || fallback;
}

const firstLine = (body) =>
  String(body ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '') ?? '';

const id8 = (id) => String(id ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'unknown';
const day = (ts) => (typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}/.test(ts) ? ts.slice(0, 10) : '0000-00-00');
const scalar = (v) => JSON.stringify(v ?? null);

function render(pairs, body) {
  const front = pairs.map(([k, v]) => `${k}: ${v}`).join('\n');
  return `---\n${front}\n---\n\n${String(body ?? '').replace(/\r\n?/g, '\n')}`;
}

/**
 * @param {{ id: string, title?: string|null, date?: string|null, body?: string|null, mood?: string|null,
 *   tags?: string[]|null, context?: string|null, created_at?: string|null }} row
 * @returns {{ path: string, content: string }}
 */
export function journalMarkdown(row) {
  const slug = slugify(row.title || firstLine(row.body), 'entry');
  return {
    path: `markdown/journal/${day(row.date ?? row.created_at)}-${slug}-${id8(row.id)}.md`,
    content: render(
      [
        ['id', scalar(row.id)],
        ['title', scalar(row.title ?? '')],
        ['date', scalar(row.date)],
        ['mood', scalar(row.mood)],
        ['tags', JSON.stringify(Array.isArray(row.tags) ? row.tags : [])],
        ['context', scalar(row.context)],
        ['created_at', scalar(row.created_at)],
      ],
      row.body,
    ),
  };
}

/**
 * @param {{ id: string, body?: string|null, color?: string|null, pinned?: boolean|null,
 *   context?: string|null, created_at?: string|null }} row
 * @returns {{ path: string, content: string }}
 */
export function noteMarkdown(row) {
  const slug = slugify(firstLine(row.body), 'note');
  return {
    path: `markdown/notes/${day(row.created_at)}-${slug}-${id8(row.id)}.md`,
    content: render(
      [
        ['id', scalar(row.id)],
        ['color', scalar(row.color)],
        ['pinned', JSON.stringify(Boolean(row.pinned))],
        ['context', scalar(row.context)],
        ['created_at', scalar(row.created_at)],
      ],
      row.body,
    ),
  };
}
