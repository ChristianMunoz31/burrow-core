// After a release: puts the new version number and a short "What's new" line on the three Gumroad product
// pages (Burrow Pro, the hidden student and nonprofit product, and the free Burrow download). Run it LOCALLY, on
// the owner's computer, with the Gumroad CLI that is already signed in (gumroad auth login). Nothing runs in CI.
//
// Usage: npm run release:gumroad -- [--tag vX.Y.Z] [--dry-run | --publish [--yes]] [--cli <path>]
//          [--backup-dir <dir>] [--notes-from CHANGELOG.md]
//   --dry-run     the DEFAULT. Reads each product's current description through the CLI (read-only) and prints
//                 the change as a diff. Writes nothing, anywhere.
//   --publish     writes. First saves a timestamped backup of each description that will change (default
//                 %LOCALAPPDATA%\burrow-release\gumroad-backups, outside the repo), then updates the products.
//                 Asks to confirm unless --yes.
//   --cli <path>  the Gumroad CLI (default %LOCALAPPDATA%\gumroad\gumroad.exe). A .js or .mjs path is run with
//                 node, which is how the tests use a fake CLI.
//   --tag         default v<package.json version>; stable tags only.
// What it can do is set by the CLI: `gumroad products view <id> --json` reads a product and
// `gumroad products update <id> --description <html>` replaces its description. So the script keeps ONE paragraph
// that starts with "Latest version:" and rewrites only that paragraph, in place on later runs; the rest of the
// description is sent back exactly as it was read. You choose where the paragraph sits on the page.
// FIRST SYNC: the script refuses a page with no "Latest version:" paragraph (exactly one per page is required, so the
// version lives in one place). Before the first run, add one paragraph by hand to the description of each of the three
// pages in the Gumroad editor, for example "Latest version: 0.1.0", then run this. Later runs rewrite it in place.
// Copy rule (docs/PRODUCT.md, "Store copy rule"): Burrow is a desktop app with a built-in helper, never "AI
// service" or "access to AI". The text is checked before anything is written.
import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { ROOT } from '../desktop/lib.js';
import { cleanChangelog, extractChangelogSection } from './publishPublic.js';
import { checkTag, defaultConfirm } from './releaseLocal.mjs';

const execFile = promisify(execFileCb);

export const MAX_ARG_CHARS = 28000;
export const MAX_ITEM_CHARS = 100;
export const MAX_ITEMS = 3;
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const TECHNICAL_RE = /[/`]|\b(?:SSRF|API|APIs|module|sidecar|Tauri|SEA|NSIS|HMAC|SQL|SQLite|migration|migrations|refactor|worker|CI|npm|cargo)\b/i;
// A paragraph (`<p>` or `<p class=...>`, never `<pre>`) whose text starts with "Latest version:", also when the text
// sits inside inline tags such as `<p><strong>Latest version: ...`.
const PARAGRAPH_RE = /<p(?:\s[^>]*)?>\s*(?:<[^>]+>\s*)*Latest version:[\s\S]*?<\/p>/i;

/** Phrases the store copy rule forbids anywhere on a product page, with the reason shown to the owner. */
export const BANNED_COPY = Object.freeze([
  { re: /\bAI[\s-]+services?\b/i, why: '"AI service"' },
  { re: /\baccess\s+to\s+(?:an?\s+|the\s+)?(?:\w+\s+)?AI\b/i, why: '"access to AI"' },
  { re: /\bAI[\s-]+tools?\b/i, why: '"AI tools"' },
  { re: /\b(?:AI[\s-]+)?chat[\s-]?bots?\b/i, why: '"chatbot"' },
]);

/**
 * @typedef {{
 *   tag: string | null, publish: boolean, dryRun: boolean, yes: boolean, cli: string | null,
 *   backupDir: string | null, notesFrom: string | null, help: boolean,
 * }} CliOptions
 */

/**
 * Dry run is the default; `--publish` turns it off.
 * @param {string[]} argv
 * @returns {CliOptions}
 */
export function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      tag: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      publish: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      cli: { type: 'string' },
      'backup-dir': { type: 'string' },
      'notes-from': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values['dry-run'] && values.publish) throw new Error('Choose --dry-run or --publish, not both');
  if (values.tag !== undefined) checkTag(values.tag);
  return {
    tag: values.tag ?? null,
    publish: values.publish,
    dryRun: !values.publish,
    yes: values.yes,
    cli: values.cli ?? null,
    backupDir: values['backup-dir'] ?? null,
    notesFrom: values['notes-from'] ?? null,
    help: values.help,
  };
}

/**
 * Problems with a piece of store copy; empty when it follows the rule.
 * @param {string} text
 * @returns {string[]}
 */
export function checkCopy(text) {
  const problems = [];
  const value = String(text ?? '');
  for (const { re, why } of BANNED_COPY) {
    if (re.test(value)) problems.push(`contains ${why}, which the store copy rule forbids. Describe Burrow as a desktop app with a built-in helper.`);
  }
  if (value.includes(EM_DASH) || value.includes(EN_DASH)) problems.push('contains a dash character that is not allowed in copy');
  return problems;
}

const decodeEntities = (s) =>
  s.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&');
const escapeHtml = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// Like \b\d+\.\d+\.\d+\b, but also catches "v1.2.3" (no word boundary between the v and the digit).
// Also short forms such as "0.2" and "v0.3".
const VERSION_LIKE_RE = /(?<![\d.])v?\d+\.\d+(?:\.\d+)?(?![\d.]*\d)/;
// Numbers that are obviously not versions: sizes and other measures (also ranges like "1.3 to 4.7 GB") and prices.
const NON_VERSION_RE = /\d+(?:\.\d+)?(?:\s*(?:to|-|and)\s*\d+(?:\.\d+)?)?\s*(?:GB|MB|KB|TB|GHz|MHz|ms|px|%|x|hours?|minutes?|seconds?|days?|stars?)(?![A-Za-z])|[$€£]\s*\d+(?:\.\d+)?/gi;

const visibleText = (html) => decodeEntities(String(html ?? '').replace(/<[^>]+>/g, ' '));

/** Keys whose strings are text a buyer reads. Ids, urls, types, timestamps and file names are never scanned. */
export const TEXT_KEYS = Object.freeze(['text', 'content', 'html', 'body', 'description', 'name']);

/**
 * The strings a buyer can read inside a parsed JSON value (rich content comes back as structured JSON of unknown
 * shape): a string counts when it is the value of a key in TEXT_KEYS (an array under such a key counts too, but an
 * object inside it is judged by its own keys). A bare top-level string counts too. So `{ type: 'file', url: '.../v1.2.3/setup.exe' }` is not scanned, but
 * `{ type: 'paragraph', content: [{ type: 'text', text: 'Burrow 1.2.3' }] }` is.
 */
function jsonStrings(value, out = [], inText = true) {
  if (typeof value === 'string') {
    if (inText) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) jsonStrings(v, out, inText);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) jsonStrings(v, out, TEXT_KEYS.includes(k.toLowerCase()));
  }
  return out;
}

/** The text of a `gumroad products content get --json` answer: its string values, or the raw text when it is not JSON. */
export function contentText(stdout) {
  try {
    return jsonStrings(JSON.parse(stdout)).join('\n');
  } catch {
    return String(stdout ?? '');
  }
}

/**
 * The version number must live in exactly one place per page: the single "Latest version:" paragraph of the
 * description. Returns what is wrong; empty means the page is safe to sync.
 * @param {{ label: string, description: string, receipt?: string | null, content?: string | null }} page
 * @returns {string[]}
 */
export function versionGuardProblems({ label, description, receipt = null, content = null }) {
  const problems = [];
  const text = String(description ?? '');
  const count = [...text.matchAll(new RegExp(PARAGRAPH_RE.source, 'gi'))].length;
  if (count !== 1) {
    problems.push(`${label}: the description has ${count} "Latest version:" paragraphs, it must have exactly one`);
  }
  const places = [
    ['description', visibleText(text.replace(new RegExp(PARAGRAPH_RE.source, 'gi'), ' '))],
    ['custom receipt', visibleText(receipt)],
    ['rich content', visibleText(content)],
  ];
  for (const [where, visible] of places) {
    const m = VERSION_LIKE_RE.exec(visible.replace(NON_VERSION_RE, ' '));
    if (m) problems.push(`${label}: a version number (${m[0]}) is written in the ${where}, outside the "Latest version:" paragraph. Reword it (for example "the latest Burrow") so the version lives in one place`);
  }
  return problems;
}

/**
 * Banned store wording that is already on a page outside the paragraph this script manages. This only warns:
 * the rest of the page is the owner's text and is never rewritten or blocked here.
 * @param {string} description
 * @returns {string[]} the reasons, empty when the page is clean
 */
export function bannedWordingElsewhere(description) {
  const rest = String(description ?? '').replace(PARAGRAPH_RE, ' ').replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(rest);
  return BANNED_COPY.filter(({ re }) => re.test(text)).map(({ why }) => why);
}

function shorten(item) {
  if (item.length <= MAX_ITEM_CHARS) return item;
  const cut = item.slice(0, MAX_ITEM_CHARS - 3);
  const at = cut.lastIndexOf(' ');
  return `${(at > 40 ? cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, '')}...`;
}

/**
 * The user-facing items of one release, from the cleaned release-please section (publishPublic.js
 * `cleanChangelog`): the New, Fixed and Faster headings only, in that order, scope prefixes and issue
 * references removed. Items that break the copy rule are skipped.
 * @param {string} changelog
 * @param {string} version without the leading v
 * @returns {{ items: string[], skipped: number }}
 */
export function changelogItems(changelog, version) {
  const section = extractChangelogSection(changelog, version);
  if (section === null) return { items: [], skipped: 0 };
  const cleaned = cleanChangelog(section);
  const wanted = ['New', 'Fixed', 'Faster'];
  const groups = new Map(wanted.map((w) => [w, []]));
  let current = null;
  for (const line of cleaned.split('\n')) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = groups.has(heading[1]) ? heading[1] : null;
      continue;
    }
    const bullet = /^[*-]\s+(.*)$/.exec(line);
    if (!bullet || current === null) continue;
    let text = decodeEntities(bullet[1]).replace(/^\*\*[^*]+:\*\*\s*/, '').replace(/,?\s*closes\s+#\d+/gi, '').trim().replace(/[.\s]+$/, '');
    if (!text) continue;
    text = text[0].toUpperCase() + text.slice(1);
    groups.get(current).push(text);
  }
  // Developer wording does not belong on a store page; it stays in the changelog.
  const all = wanted.flatMap((w) => groups.get(w)).filter((t) => !TECHNICAL_RE.test(t));
  const ok = all.filter((t) => checkCopy(t).length === 0);
  return { items: ok.slice(0, MAX_ITEMS).map(shorten), skipped: all.length - ok.length };
}

/**
 * The What's new text: `release-notes/<tag>.md` when present (hand-written, so it must follow the copy rule or
 * the run stops), else the user-facing items of the CHANGELOG section.
 * @param {{ tag: string, root: string, notesFrom?: string | null, warn?: (m: string) => void }} input
 * @returns {{ text: string, source: string }}
 */
export function buildWhatsNew({ tag, root, notesFrom = null, warn = () => {} }) {
  const version = tag.slice(1);
  const notesFile = path.join(root, 'release-notes', `${tag}.md`);
  if (fs.existsSync(notesFile)) {
    const lines = fs
      .readFileSync(notesFile, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*(?:[-*]|#+)\s*/, '').trim())
      .filter(Boolean);
    const text = lines.join('. ').replace(/\.\.+/g, '.').replace(/[.\s]+$/, '');
    if (!text) throw new Error(`${path.relative(root, notesFile)} is empty`);
    return { text, source: `release-notes/${tag}.md` };
  }
  const changelogPath = path.resolve(root, notesFrom ?? 'CHANGELOG.md');
  const changelog = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';
  const { items, skipped } = changelogItems(changelog, version);
  if (skipped > 0) warn(`${skipped} changelog line(s) were left out because they break the store copy rule.`);
  if (items.length === 0) {
    warn(`No user-facing items found for ${version} in the changelog; using a generic line. Add release-notes/${tag}.md to write your own.`);
    return { text: 'Small fixes and improvements', source: 'generic line' };
  }
  return { text: items.join('; '), source: `CHANGELOG.md section ${version}` };
}

/**
 * The managed paragraph. Throws when the text breaks the copy rule.
 * @param {string} version without the leading v
 * @param {string} whatsNew
 * @returns {string}
 */
export function renderParagraph(version, whatsNew) {
  const text = `Latest version: ${version}. What's new: ${String(whatsNew).replace(/[.\s]+$/, '')}.`;
  const problems = checkCopy(text);
  if (problems.length > 0) throw new Error(`The new page text ${problems.join('; ')}`);
  return `<p>${escapeHtml(text)}</p>`;
}

/**
 * Puts the paragraph into a description: replaces the existing "Latest version:" paragraph, or appends one.
 * Everything else is returned byte for byte.
 * @param {string} description
 * @param {string} paragraph
 * @returns {{ next: string, before: string | null, changed: boolean }}
 */
export function applyParagraph(description, paragraph) {
  const current = String(description ?? '');
  const m = PARAGRAPH_RE.exec(current);
  if (m) {
    const next = `${current.slice(0, m.index)}${paragraph}${current.slice(m.index + m[0].length)}`;
    return { next, before: m[0], changed: next !== current };
  }
  const next = current.trim() === '' ? paragraph : `${current}${current.endsWith('\n') ? '' : '\n'}${paragraph}`;
  return { next, before: null, changed: true };
}

/**
 * A readable diff of one product: the managed paragraph before and after, and what stays untouched.
 * @param {{ label: string, id: string, before: string | null, after: string, oldLength: number, newLength: number, changed: boolean }} input
 * @returns {string[]}
 */
export function renderDiff({ label, id, before, after, oldLength, newLength, changed }) {
  const lines = [`== ${label} (${id}) ==`];
  if (!changed) {
    lines.push('  already up to date, nothing to write');
    return lines;
  }
  lines.push(before === null ? '  - (no "Latest version:" paragraph yet; one will be added at the end)' : `  - ${before}`);
  lines.push(`  + ${after}`);
  lines.push(`  description: ${oldLength} -> ${newLength} characters; everything outside that paragraph is unchanged`);
  return lines;
}

/**
 * @param {Date} date
 * @returns {string} 20261005-103000Z
 */
export function timestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
}

/**
 * @param {Date} date
 * @param {string} key product key such as pro
 * @param {string} id Gumroad product id
 * @returns {string}
 */
export function backupFileName(date, key, id) {
  return `${timestamp(date)}_${key}_${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}.json`;
}

/** Throws when `dir` is inside the repository (a backup holds page text and does not belong in git). */
export function assertOutsideRepo(dir, root) {
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error(`The backup folder ${dir} is inside the repository. Use a folder outside it.`);
}

/**
 * The three Gumroad products, from config/store.json (Pro and the hidden student/nonprofit product) and
 * config/gumroad-sync.json (the free download). A product with an empty id is left out.
 * @param {string} root
 * @returns {{ key: string, label: string, id: string }[]}
 */
export function loadProducts(root) {
  const readJson = (rel) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
    } catch {
      throw new Error(`Could not read ${rel}. It must exist and be valid JSON.`);
    }
  };
  const store = readJson('config/store.json');
  const sync = readJson('config/gumroad-sync.json');
  const all = [
    { key: 'pro', label: 'Burrow Pro', id: store?.gumroad?.proProductId },
    { key: 'free-license', label: 'Burrow student and nonprofit (hidden)', id: store?.gumroad?.freeLicenseProductId },
    { key: 'download', label: 'Burrow free download', id: sync?.downloadProductId },
  ];
  return all.filter((p) => typeof p.id === 'string' && p.id.trim() !== '').map((p) => ({ ...p, id: p.id.trim() }));
}

/** Where the Gumroad CLI lives by default. */
export function defaultCliPath(env = process.env) {
  return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'gumroad', 'gumroad.exe');
}

const SAFE_ARGS = ['--no-input', '--non-interactive', '--no-color'];

/**
 * @typedef {{
 *   env?: Record<string, string | undefined>, root?: string,
 *   runCli?: (cli: string, args: string[]) => Promise<{ stdout: string, stderr: string }>,
 *   log?: (line: string) => void, confirm?: (q: string) => Promise<boolean>, now?: () => Date,
 * }} Deps
 */

async function defaultRunCli(cli, args) {
  const script = /\.(?:m?js|cjs)$/i.test(cli);
  return execFile(script ? process.execPath : cli, script ? [cli, ...args] : args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true });
}

/**
 * Reads, diffs and (with --publish) updates the product pages.
 * @param {CliOptions} opts
 * @param {Deps} [deps]
 * @returns {Promise<{ products: { key: string, changed: boolean }[], backups: string[], updated: string[] }>}
 */
export async function runSync(opts, deps = {}) {
  const {
    env = process.env,
    root = ROOT,
    runCli = defaultRunCli,
    log = (line) => console.log(line),
    confirm = defaultConfirm,
    now = () => new Date(),
  } = deps;

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const tag = opts.tag ?? `v${pkg.version}`;
  checkTag(tag);
  const version = tag.slice(1);

  const cli = path.resolve(opts.cli ?? defaultCliPath(env));
  if (!fs.existsSync(cli)) {
    throw new Error(`The Gumroad CLI was not found at ${cli}. Install it from https://github.com/antiwork/gumroad-cli, run "gumroad auth login", or pass --cli <path>.`);
  }
  const backupDir = path.resolve(opts.backupDir ?? path.join(env.LOCALAPPDATA ?? os.tmpdir(), 'burrow-release', 'gumroad-backups'));
  assertOutsideRepo(backupDir, root);

  const { text, source } = buildWhatsNew({ tag, root, notesFrom: opts.notesFrom, warn: (m) => log(`Warning: ${m}`) });
  const paragraph = renderParagraph(version, text);
  const products = loadProducts(root);
  if (products.length === 0) throw new Error('No Gumroad product ids are set in config/store.json or config/gumroad-sync.json.');

  log(`Gumroad sync for ${tag} (${opts.publish ? 'PUBLISH' : 'DRY RUN, nothing is written'})`);
  log(`What's new from ${source}:`);
  log(`  ${paragraph}`);

  const cliCall = async (args) => {
    try {
      return await runCli(cli, [...args, ...SAFE_ARGS]);
    } catch (err) {
      // The CLI's own message (stderr), not execFile's "Command failed: <the whole command line>".
      const stderr = String(err?.stderr ?? '').trim();
      const detail = (stderr || 'it exited with an error').split('\n')[0].slice(0, 300);
      throw new Error(`gumroad ${args.slice(0, 2).join(' ')} failed: ${detail}. Check that you are signed in (gumroad auth login).`, { cause: err });
    }
  };

  const plans = [];
  const versionProblems = [];
  for (const product of products) {
    const { stdout } = await cliCall(['products', 'view', product.id, '--json']);
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`gumroad products view ${product.id} did not return JSON. Run it yourself with --json to look.`);
    }
    const description = parsed?.product?.description ?? parsed?.description;
    if (typeof description !== 'string') {
      throw new Error(`gumroad products view ${product.id} returned no description text. Run it yourself with --json to see what it returns.`);
    }
    const name = parsed?.product?.name ?? parsed?.name ?? null;
    const receipt = parsed?.product?.custom_receipt ?? parsed?.custom_receipt ?? null;
    if (!('custom_receipt' in (parsed?.product ?? {})) && !('custom_receipt' in (parsed ?? {}))) {
      log(`Warning: gumroad products view ${product.id} has no custom_receipt field, so the receipt of ${product.label} was not checked for a version number. Check it by hand in Gumroad.`);
    }
    const rich = await cliCall(['products', 'content', 'get', product.id, '--json']);
    versionProblems.push(...versionGuardProblems({ label: product.label, description, receipt: typeof receipt === 'string' ? receipt : null, content: contentText(rich.stdout) }));
    const elsewhere = bannedWordingElsewhere(description);
    if (elsewhere.length > 0) {
      log(`Warning: ${product.label} already has ${elsewhere.join(', ')} elsewhere on the page (outside the line this script writes). It is left as it is; fix it in Gumroad.`);
    }
    const applied = applyParagraph(description, paragraph);
    if (applied.changed && applied.next.length > MAX_ARG_CHARS) {
      throw new Error(`The new description of ${product.label} is ${applied.next.length} characters, too long to send through the CLI (limit ${MAX_ARG_CHARS}). Shorten the page in Gumroad first.`);
    }
    plans.push({ product, description, name, ...applied });
    for (const line of renderDiff({
      label: product.label, id: product.id, before: applied.before, after: paragraph,
      oldLength: description.length, newLength: applied.next.length, changed: applied.changed,
    })) log(line);
  }

  if (versionProblems.length > 0) {
    throw new Error(`The Gumroad pages do not keep the version in one place, so nothing was written:\n  - ${versionProblems.join('\n  - ')}`);
  }

  const result = { products: plans.map((p) => ({ key: p.product.key, changed: p.changed })), backups: [], updated: [] };
  const pending = plans.filter((p) => p.changed);
  if (opts.dryRun) {
    log(`Dry run finished: ${pending.length} of ${plans.length} page(s) would change. Nothing was written. Run again with --publish to update them.`);
    return result;
  }
  if (pending.length === 0) {
    log('Every page is already up to date. Nothing to do.');
    return result;
  }
  if (!opts.yes && !(await confirm(`Update ${pending.length} Gumroad page(s) now? A backup of each current description is saved first.`))) {
    log('Cancelled. Nothing was written.');
    return result;
  }

  // Backups first, all of them, before the first write.
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = now();
  for (const p of pending) {
    const file = path.join(backupDir, backupFileName(stamp, p.product.key, p.product.id));
    fs.writeFileSync(
      file,
      `${JSON.stringify({ productId: p.product.id, key: p.product.key, name: p.name, tag, savedAt: stamp.toISOString(), description: p.description }, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    result.backups.push(file);
  }
  log(`Saved ${result.backups.length} backup(s) to ${backupDir}`);

  for (const p of pending) {
    await cliCall(['products', 'update', p.product.id, '--description', p.next, '--yes']);
    result.updated.push(p.product.key);
    const { stdout } = await cliCall(['products', 'view', p.product.id, '--json']);
    const after = JSON.parse(stdout);
    const seen = after?.product?.description ?? after?.description;
    if (typeof seen !== 'string' || !seen.includes(`Latest version: ${version}.`)) {
      log(`Warning: ${p.product.label} was updated but the page does not show "Latest version: ${version}." when read back. Check it in Gumroad.`);
    } else {
      log(`Updated ${p.product.label}`);
    }
  }
  log(`Done. To undo, put the "description" from the backup file back with: gumroad products update <id> --description "<html>"`);
  return result;
}

const HELP = `Usage: npm run release:gumroad -- [--tag vX.Y.Z] [--dry-run | --publish [--yes]] [--cli <path>] [--backup-dir <dir>] [--notes-from CHANGELOG.md]
Dry run is the default. See docs/RELEASING.md ("After the release: update the Gumroad pages").`;

async function main(argv) {
  const opts = parseCliArgs(argv);
  if (opts.help) {
    console.log(HELP);
    return;
  }
  await runSync(opts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
