// Writes latest.json, the Tauri v2 static update manifest, next to the release assets. Burrow's installed app reads it
// from https://github.com/ChristianMunoz31/burrow-releases/releases/latest/download/latest.json (an opt-in check).
//
// Usage: node scripts/release/updaterManifest.js --tag v0.5.0 --assets-dir <dir> [--notes-from CHANGELOG.md] [--now <iso>]
// The assets folder must hold Burrow-Setup-x64.exe.sig and Burrow-Setup-arm64.exe.sig. While the updater is off
// (the placeholder public key is still in src-tauri/tauri.release.conf.json) this does nothing and says so.
//
// Shape (docs/RELEASING.md): exactly `version`, `notes`, `pub_date` and `platforms` with the two keys
// `windows-x86_64` and `windows-aarch64`, each `{ signature, url }`. The URL is the pinned public download URL, the
// signature is the exact contents of the `.sig` file. Notes are plain text: no markdown, no links.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  LATEST_JSON,
  SIG_ARM64,
  SIG_X64,
  extractChangelogSection,
  loadCuratedNotes,
  pinnedInstallerUrl,
  userFacingChanges,
} from './publishPublic.js';
import { updaterState } from './updaterConfig.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TAG_RE = /^v\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$/;
const EM_DASH = String.fromCharCode(0x2014);
const MAX_NOTES_CHARS = 1500;

/**
 * The "What's new" part of a hand-written release notes file. A full document (it has a "## What's new" heading)
 * gives only that section; anything else is used as it is.
 * @param {string} curated
 * @returns {string}
 */
function whatsNewOf(curated) {
  const lines = curated.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^##\s+What['’]s new\s*$/i.test(l));
  if (start === -1) return lines.join('\n');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i]) || /^#\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

/**
 * Markdown to plain text for the update dialog: headings become `Title:`, bullets become `- `, bold, code and link
 * syntax are removed, blank lines dropped, at most 1500 characters cut at a line boundary.
 * @param {string} markdown
 * @returns {string}
 */
function toPlain(markdown) {
  const out = [];
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    let line = raw
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\*\*|__/g, '')
      .replace(/`/g, '')
      .replace(/\t/g, ' ')
      .trimEnd();
    const heading = /^#{1,6}\s+(.+?)\s*:?$/.exec(line);
    if (heading) {
      line = `${heading[1].trim()}:`;
    } else {
      const bullet = /^\s*[*+-]\s+(.*)$/.exec(line);
      if (bullet) line = `- ${bullet[1].trim()}`;
      else line = line.trim();
    }
    line = line.replace(/ {2,}/g, ' ');
    if (line !== '' && line !== '-') out.push(line);
  }
  let text = '';
  for (const line of out) {
    const next = text === '' ? line : `${text}\n${line}`;
    if (next.length > MAX_NOTES_CHARS) break;
    text = next;
  }
  return text;
}

/**
 * The plain-text notes for latest.json.
 * @param {{ section: string | null, curated?: string | null }} input
 *   section the CHANGELOG section of the version (or null); curated the hand-written notes file text, if any
 * @returns {string}
 * @throws {Error} when the result has an em dash or names the private repo
 */
export function updaterNotes({ section, curated = null }) {
  const custom = typeof curated === 'string' ? curated.trim() : '';
  let text = custom ? toPlain(whatsNewOf(custom)) : toPlain(userFacingChanges(section));
  if (text === '') text = section === null && !custom ? 'This release has no listed changes.' : 'This release has behind-the-scenes improvements.';
  if (text.includes(EM_DASH)) throw new Error('The update notes contain an em dash (check release-notes/ and the changelog)');
  if (/ChristianMunoz31\/burrow(?![-\w])/i.test(text)) throw new Error('The update notes name the private repository (check release-notes/ and the changelog)');
  return text;
}

/**
 * latest.json as text: pretty-printed with two spaces and a trailing newline.
 * @param {{ tag: string, sigX64: string, sigArm64: string, notes: string, now?: Date | string | number }} input
 *   sigX64 / sigArm64 the exact contents of the two `.sig` files (surrounding whitespace is trimmed)
 * @returns {string}
 */
export function buildLatestJson({ tag, sigX64, sigArm64, notes, now = new Date() }) {
  if (!TAG_RE.test(tag ?? '')) throw new Error('Unexpected tag format');
  if (/-dev/i.test(tag)) throw new Error('A -dev tag is a Burrow Dev build and never gets an update manifest');
  const clean = (sig, name) => {
    const value = String(sig ?? '').trim();
    if (value === '' || value.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(`${name} is empty or is not a base64 signature`);
    return value;
  };
  const when = new Date(now);
  if (Number.isNaN(when.getTime())) throw new Error('--now is not a valid date');
  const manifest = {
    version: tag.slice(1),
    notes,
    pub_date: when.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    platforms: {
      'windows-x86_64': { signature: clean(sigX64, SIG_X64), url: pinnedInstallerUrl(tag, 'x64') },
      'windows-aarch64': { signature: clean(sigArm64, SIG_ARM64), url: pinnedInstallerUrl(tag, 'arm64') },
    },
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Reads the `.sig` files from the assets folder and writes latest.json there. A no-op while the updater is off.
 * @param {{
 *   tag: string, assetsDir: string, notesFrom?: string, now?: Date | string | number, root?: string,
 *   log?: (line: string) => void,
 * }} opts
 * @returns {{ written: boolean, file: string | null }}
 */
export function generateLatestJson({ tag, assetsDir, notesFrom, now, root = ROOT, log = (l) => console.log(l) }) {
  if (!updaterState(root).enabled) {
    log('The in-app updater is off (placeholder public key), so no latest.json is written.');
    return { written: false, file: null };
  }
  const version = String(tag).replace(/^v/, '');
  let section = null;
  if (notesFrom && fs.existsSync(notesFrom)) {
    const changelog = fs.readFileSync(notesFrom, 'utf8');
    section = extractChangelogSection(changelog, version) ?? extractChangelogSection(changelog, version.replace(/[-+].*$/, ''));
  }
  const curated = loadCuratedNotes({ tag, notesFrom });
  const readSig = (name) => {
    const file = path.join(assetsDir, name);
    if (!fs.existsSync(file)) throw new Error(`${name} is missing from ${assetsDir}; the updater is on, so both installers must be signed`);
    return fs.readFileSync(file, 'utf8');
  };
  const text = buildLatestJson({ tag, sigX64: readSig(SIG_X64), sigArm64: readSig(SIG_ARM64), notes: updaterNotes({ section, curated }), now });
  const file = path.join(assetsDir, LATEST_JSON);
  fs.writeFileSync(file, text, 'utf8');
  log(`Wrote ${LATEST_JSON} for ${tag}.`);
  return { written: true, file };
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { tag: { type: 'string' }, 'assets-dir': { type: 'string' }, 'notes-from': { type: 'string' }, now: { type: 'string' } },
    strict: true,
  });
  if (!values.tag || !values['assets-dir']) throw new Error('Usage: updaterManifest.js --tag <vX.Y.Z> --assets-dir <dir> [--notes-from CHANGELOG.md] [--now <iso>]');
  generateLatestJson({
    tag: values.tag,
    assetsDir: path.resolve(values['assets-dir']),
    notesFrom: values['notes-from'] ? path.resolve(values['notes-from']) : undefined,
    now: values.now,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
