// Markdown helpers for pipeline comments. Everything that came from a PR (titles, step names,
// labels, test names) is untrusted text: it must not break a table, open a tag, form a link,
// ping a user or fake the sticky-comment marker.

const MAX_TEXT = 120

/** Escapes untrusted text for one markdown table cell or inline use, capped at 120 characters. */
export function escapeMd(text, max = MAX_TEXT) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  const capped = flat.length > max ? `${flat.slice(0, max - 3)}...` : flat
  return capped
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/`/g, '&#96;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/@/g, '&#64;')
}
