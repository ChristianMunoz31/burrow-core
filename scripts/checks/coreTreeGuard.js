// The last line of defence before a public export (docs/adr/0001-open-core-split.md 3.14): checks a tree that is
// about to become the public core repository. Refuses when
//   - any path is under pro/ or devtools/;
//   - a non-Markdown file carries the private Pro header;
//   - a runtime core file (server.js, loadEnv.js, server/**, src/**, outside tests) names pro/, other than the loader;
//   - the developer tools marker or the Pro build marker appears outside its holders;
//   - any owner-chosen export-ignore path is present (open question O3, decided: the list below).
// Usage: node scripts/checks/coreTreeGuard.js <dir>   (exit 1 on any problem; exportCore.mjs calls checkCoreTree)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PRO_HEADER = ['// burrow-pro:', 'private source, never part of the public core.'].join(' ');

/** Owner decision O3: private-only paths that never enter the public core (also `export-ignore` in .gitattributes). */
export const EXPORT_IGNORED = Object.freeze([
  'pro/',
  'devtools/',
  '.claude/',
  '.github/workflows/release.yml',
  '.github/workflows/desktop-windows.yml',
  '.github/workflows/dev-build.yml',
  '.github/workflows/release-please.yml',
  'scripts/runner/',
  'docs/SELF_HOSTED_RUNNER.md',
  'config/msstore.json',
]);
/** Glob-like prefixes of release runbooks (docs/release-runbook-*.md). */
const EXPORT_IGNORED_RE = [/^docs\/release-runbook-[^/]*\.md$/];

/** The only runtime core file that may name pro/. */
export const RUNTIME_PRO_LOADER = 'server/proExtensionsLoader.js';

/** Build markers and the files allowed to contain them. */
// The marker texts are built from parts so this file itself never contains them.
const DEV_TOOLS_ON = ['BURROW_DEV_TOOLS', 'on'].join('=');
const PRO_ON = ['BURROW_PRO', 'on'].join('=');
export const MARKER_HOLDERS = Object.freeze({
  [DEV_TOOLS_ON]: ['Dockerfile', 'scripts/checks/channelMarker.js'],
  [PRO_ON]: ['scripts/desktop/workerBundle.js', 'scripts/desktop/buildSidecar.js', 'scripts/checks/channelMarker.js'],
});

const TEXT_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.json', '.yml', '.yaml', '.html', '.css', '.ps1', '.sh', '.toml', '.rs', '.txt', '']);
const isMarkdown = (rel) => /\.md$/i.test(rel);
const isTestPath = (rel) => /(^|\/)__tests__\//.test(rel) || /\.test\.(js|jsx|mjs)$/.test(rel);
const isRuntimeCore = (rel) =>
  (rel === 'server.js' || rel === 'loadEnv.js' || rel.startsWith('server/') || rel.startsWith('src/')) && /\.(js|jsx|mjs|cjs)$/.test(rel) && !isTestPath(rel);
/** Any mention of the pro/ folder as a path (quote, slash, space or bracket before it). */
const NAMES_PRO_RE = /(^|[\s'"`(/[])pro\//;

/** @param {string} root @returns {string[]} repo-relative paths with forward slashes */
function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (rel === '.git' || rel === 'node_modules') continue;
        out.push(`${rel}/`);
        walk(full);
      } else out.push(rel);
    }
  };
  walk(root);
  return out;
}

/**
 * @param {string} root the exported tree
 * @returns {string[]} problems, empty when the tree may become the public core
 */
export function checkCoreTree(root) {
  const problems = [];
  const files = listFiles(root);
  for (const rel of files) {
    if (rel.endsWith('/') && rel !== 'pro/' && rel !== 'devtools/') continue;
    if (rel.startsWith('pro/') || rel === 'pro') problems.push(`${rel}: the Pro module must never be in the public core`);
    else if (rel.startsWith('devtools/')) problems.push(`${rel}: the developer tools must never be in the public core`);
    else if (EXPORT_IGNORED.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p)) || EXPORT_IGNORED_RE.some((re) => re.test(rel))) {
      problems.push(`${rel}: private-only path (export-ignore list)`);
    }
  }
  for (const rel of files) {
    if (rel.endsWith('/') || rel.startsWith('pro/') || rel.startsWith('devtools/')) continue;
    if (!TEXT_EXT.has(path.extname(rel).toLowerCase()) && !isMarkdown(rel)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      problems.push(`${rel}: could not be read`);
      continue;
    }
    if (!isMarkdown(rel) && text.includes(PRO_HEADER)) problems.push(`${rel}: carries the private Pro header`);
    if (isRuntimeCore(rel) && rel !== RUNTIME_PRO_LOADER && NAMES_PRO_RE.test(text)) problems.push(`${rel}: a runtime core file names pro/`);
    if (isMarkdown(rel) || isTestPath(rel)) continue;
    for (const [marker, holders] of Object.entries(MARKER_HOLDERS)) {
      if (text.includes(marker) && !holders.includes(rel)) problems.push(`${rel}: contains ${marker} outside its holders`);
    }
  }
  return problems;
}

/**
 * @param {string[]} [argv]
 * @returns {number} exit code
 */
export function main(argv = process.argv.slice(2), { log = console.log, error = console.error } = {}) {
  const dir = argv[0];
  if (!dir) {
    error('Usage: node scripts/checks/coreTreeGuard.js <dir>');
    return 1;
  }
  const problems = checkCoreTree(path.resolve(dir));
  if (problems.length) {
    for (const p of problems.slice(0, 200)) error(`core tree: ${p}`);
    error(`${problems.length} problem(s): this tree must not become the public core.`);
    return 1;
  }
  log('core tree: ok');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
