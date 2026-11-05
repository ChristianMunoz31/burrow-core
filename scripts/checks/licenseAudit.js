// Dependency license audit (docs/adr/0001-open-core-split.md R13, owner decision O5): walks the production dependency
// tree in node_modules (the `dependencies` of package.json, then each package's dependencies, optional dependencies
// and installed peer dependencies, resolved like Node does) and reads every package.json `license` field (or the
// legacy `licenses` array). Official builds combine the AGPL core with proprietary Pro, so any GPL, AGPL or LGPL
// package in the shipped tree fails the audit, unless the SPDX expression offers a non-copyleft alternative
// (`MIT OR GPL-3.0`) or the package is in scripts/checks/license-allowlist.json with a reason. Packages without a
// readable license are listed as warnings. No dependencies, no network.
// Usage: npm run check:licenses [-- --json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ALLOWLIST_FILE = path.join('scripts', 'checks', 'license-allowlist.json');
const COPYLEFT_RE = /^(A|L)?GPL(-|$)|^LGPL|^AGPL|^GPL/i;

/** @param {unknown} pkg parsed package.json @returns {string | null} the license expression */
export function licenseOf(pkg) {
  if (!pkg || typeof pkg !== 'object') return null;
  const { license, licenses } = /** @type {any} */ (pkg);
  if (typeof license === 'string' && license.trim()) return license.trim();
  if (license && typeof license === 'object' && typeof license.type === 'string') return license.type.trim();
  if (Array.isArray(licenses) && licenses.length) {
    const types = licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter((t) => typeof t === 'string' && t.trim());
    if (types.length) return types.length === 1 ? types[0] : `(${types.join(' OR ')})`;
  }
  return null;
}

/**
 * Whether an SPDX-like expression forces a copyleft license: every OR alternative contains a GPL family id.
 * @param {string} expr
 * @returns {boolean}
 */
export function isCopyleft(expr) {
  const clean = String(expr).replace(/[()]/g, ' ').trim();
  const alternatives = clean.split(/\s+OR\s+/i);
  return alternatives.every((alt) => alt.split(/\s+AND\s+/i).some((id) => COPYLEFT_RE.test(id.trim().replace(/\+$/, ''))));
}

/** Resolves an installed package directory the way Node does (nested node_modules, then each parent). */
function resolvePackageDir(name, fromDir, root) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.resolve(dir) === path.resolve(root)) return null;
    const up = path.dirname(dir);
    // Climb out of a node_modules/<scope>/<pkg> or node_modules/<pkg> folder.
    if (up === dir) return null;
    dir = up;
  }
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * @param {{ root?: string }} [opts]
 * @returns {{ packages: { name: string, version: string, license: string | null, dir: string }[], missing: string[] }}
 */
export function collectProductionTree({ root = ROOT } = {}) {
  const rootPkg = readJson(path.join(root, 'package.json'));
  const seen = new Map();
  const missing = [];
  const queue = Object.keys(rootPkg.dependencies ?? {}).map((name) => ({ name, from: root, optional: false }));
  while (queue.length) {
    const { name, from, optional } = queue.shift();
    const dir = resolvePackageDir(name, from, root);
    if (!dir) {
      if (!optional) missing.push(name);
      continue;
    }
    const key = fs.realpathSync(dir);
    if (seen.has(key)) continue;
    const pkg = readJson(path.join(dir, 'package.json'));
    seen.set(key, { name: pkg.name ?? name, version: pkg.version ?? '0.0.0', license: licenseOf(pkg), dir: path.relative(root, dir).split(path.sep).join('/') });
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push({ name: dep, from: dir, optional: false });
    for (const dep of Object.keys(pkg.optionalDependencies ?? {})) queue.push({ name: dep, from: dir, optional: true });
    // Peer dependencies count only when installed (the app provides them).
    for (const dep of Object.keys(pkg.peerDependencies ?? {})) queue.push({ name: dep, from: dir, optional: true });
  }
  return { packages: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)), missing };
}

/**
 * @param {{ packages: { name: string, version: string, license: string | null }[] }} tree
 * @param {{ packages?: Record<string, string> }} allowlist name or name@version to reason
 * @returns {{ blocked: object[], allowed: object[], unknown: object[] }}
 */
export function auditTree(tree, allowlist = {}) {
  const allow = allowlist.packages ?? {};
  const blocked = [];
  const allowed = [];
  const unknown = [];
  for (const p of tree.packages) {
    if (!p.license || /^(UNKNOWN|SEE LICENSE IN)/i.test(p.license)) {
      unknown.push(p);
      continue;
    }
    if (!isCopyleft(p.license)) continue;
    const reason = allow[`${p.name}@${p.version}`] ?? allow[p.name];
    if (typeof reason === 'string' && reason.trim()) allowed.push({ ...p, reason });
    else blocked.push(p);
  }
  return { blocked, allowed, unknown };
}

/**
 * @param {string[]} [argv]
 * @param {{ root?: string, log?: (m: string) => void, error?: (m: string) => void }} [io]
 * @returns {number} exit code
 */
export function main(argv = process.argv.slice(2), { root = ROOT, log = console.log, error = console.error } = {}) {
  if (!fs.existsSync(path.join(root, 'node_modules'))) {
    error('check:licenses needs node_modules: run npm ci first.');
    return 1;
  }
  const allowFile = path.join(root, ALLOWLIST_FILE);
  const allowlist = fs.existsSync(allowFile) ? readJson(allowFile) : {};
  const tree = collectProductionTree({ root });
  const result = auditTree(tree, allowlist);
  if (argv.includes('--json')) {
    log(JSON.stringify({ total: tree.packages.length, missing: tree.missing, ...result }, null, 2));
  } else {
    log(`License audit: ${tree.packages.length} production packages.`);
    for (const p of result.allowed) log(`  allowed by ${ALLOWLIST_FILE}: ${p.name}@${p.version} (${p.license}): ${p.reason}`);
    for (const p of result.unknown) log(`  warning: no readable license: ${p.name}@${p.version} (${p.dir})`);
    for (const name of tree.missing) log(`  warning: dependency not installed: ${name}`);
    for (const p of result.blocked) error(`  BLOCKED copyleft license: ${p.name}@${p.version} (${p.license}) at ${p.dir}`);
  }
  if (result.blocked.length) {
    error(`check:licenses failed: ${result.blocked.length} GPL-family package(s) in the shipped dependency tree. Replace them, or document an exception in ${ALLOWLIST_FILE}.`);
    return 1;
  }
  if (!argv.includes('--json')) log('check:licenses: no GPL, AGPL or LGPL package in the production tree.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
