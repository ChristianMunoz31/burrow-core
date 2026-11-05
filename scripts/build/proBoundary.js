// The Pro import allowlist (docs/adr/0001-open-core-split.md 3.9): the single source for
// server/__tests__/proBoundary.test.js and the `burrow-pro` esbuild plugin (scripts/desktop/workerBundle.js).
// Rules apply to non-test files under pro/server/** and pro/ui/**; pro/**/__tests__/**, pro/scripts/** and
// pro/e2e/** may import any core file. Changes only on a request of the team that owns pro/ui, with an ADR note.
import path from 'node:path';

/**
 * Tier A, capability APIs: Pro reaches data, network and AI only through these core modules. Value: the allowed
 * named imports, or '*' for any export. A namespace import is allowed only where `namespace` is true.
 * @type {Readonly<Record<string, { names: '*' | readonly string[], namespace?: boolean }>>}
 */
export const PRO_SERVER_CORE_ALLOWLIST = Object.freeze({
  'server/dataAccess.js': Object.freeze({ names: '*', namespace: true }),
  'server/ai/index.js': Object.freeze({ names: '*' }),
  'server/netPolicy.js': Object.freeze({ names: Object.freeze(['NetworkOptInError', 'assertNetworkEnabled']) }),
  'server/networkCall.js': Object.freeze({ names: Object.freeze(['recordNetworkCall', 'statusFromHttp']) }),
  'server/auditHook.js': Object.freeze({ names: Object.freeze(['recordAudit']) }),
  'server/integrations.js': Object.freeze({ names: Object.freeze(['fetchWeather', 'fetchOura']) }),
  'server/secrets/index.js': Object.freeze({ names: Object.freeze(['peekSecret']) }),
  'server/profile.js': Object.freeze({ names: Object.freeze(['getDisplayName']) }),
  'server/weatherLocation.js': Object.freeze({ names: Object.freeze(['resolveWeatherLocation']) }),
  'server/todoStatus.js': Object.freeze({ names: Object.freeze(['defaultTodoStatus']) }),
  'server/dataGeneration.js': Object.freeze({ names: Object.freeze(['captureDataGeneration', 'currentDataGeneration']) }),
  'server/scheduledJobGate.js': Object.freeze({ names: Object.freeze(['isPaused', 'dataBusy']) }),
  'server/javi/inbox.js': Object.freeze({ names: Object.freeze(['markRead']) }),
  'server/javi/advisorService.js': Object.freeze({ names: '*' }),
  'server/javi/characters.js': Object.freeze({
    names: Object.freeze(['getCharacter', 'characterText', 'normalizeCharacter', 'DEFAULT_CHARACTER', 'CHARACTER_IDS', 'BUTLER_CHARACTER']),
  }),
  'server/folders/store.js': Object.freeze({ names: '*' }),
  'server/folders/jobs.js': Object.freeze({ names: Object.freeze(['enqueueFolderJob', 'waitForFolderJob', 'cancelFolderJob', 'getFolderJob']) }),
  'server/folders/summarize.js': Object.freeze({
    names: Object.freeze(['askFolderModel', 'reduceNotes', 'retryWhenBusy', 'clipText', 'EmptyOutputError']),
  }),
});

/** Tier B, pure helpers (no I/O): any export; each may import only Tier B modules and node:crypto. */
export const PRO_SERVER_PURE = Object.freeze([
  'server/relativeDay.js',
  'server/db/errors.js',
  'server/javi/pages.js',
  'server/javi/groundedNumbers.js',
  'server/javi/userName.js',
  'server/folders/constants.js',
  'server/folders/stats.js',
  'server/folders/prompts.js',
]);

/** The only bare specifiers pro/server may import. */
export const PRO_SERVER_BUILTINS = Object.freeze(['node:crypto']);

/** Source text refused in pro/server (checked after stripping comments). */
export const PRO_SERVER_BANNED_SOURCE = Object.freeze([
  { id: 'fetch', re: /(^|[^\w$.])fetch\s*\(/ },
  { id: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/ },
  { id: 'WebSocket', re: /\bWebSocket\b/ },
  { id: 'EventSource', re: /\bEventSource\b/ },
  { id: 'dynamic import', re: /(^|[^\w$.])import\s*\(/ },
  { id: 'require', re: /(^|[^\w$.])require\s*\(/ },
  { id: 'globalThis', re: /\bglobalThis\b/ },
  { id: 'eval', re: /(^|[^\w$.])eval\s*\(/ },
  { id: 'new Function', re: /\bnew\s+Function\b/ },
  { id: 'process', re: /\bprocess\s*\.(?!env\.)/ },
]);

/** Source text refused in pro/ui (checked after stripping comments). */
export const PRO_UI_BANNED_SOURCE = Object.freeze([
  { id: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/ },
  { id: 'WebSocket', re: /\bWebSocket\b/ },
  { id: 'EventSource', re: /\bEventSource\b/ },
  { id: 'sendBeacon', re: /\bsendBeacon\b/ },
  { id: 'absolute URL', re: /['"`]https?:\/\//i },
  { id: 'fetch outside /api/', re: /(^|[^\w$.])fetch\s*\(\s*(?!['"`]\/api\/)/ },
  { id: 'non-relative dynamic import', re: /(^|[^\w$.])import\s*\(\s*(?!['"`]\.)/ },
]);

/**
 * Core files allowed to name pro/ (repo-relative, forward slashes; a trailing `/**` covers a whole folder, `*` one
 * path segment). server/proExtensionsLoader.js is the only runtime file.
 */
export const PRO_PATH_HOLDERS = Object.freeze([
  'server/proExtensionsLoader.js',
  'scripts/build/proBoundary.js',
  'scripts/build/proUi.js',
  'scripts/desktop/workerBundle.js',
  'scripts/desktop/buildSidecar.js',
  'scripts/desktop/devDist.js',
  'scripts/checks/proPresent.js',
  'scripts/checks/coreTreeGuard.js',
  'scripts/checks/gitFiles.js',
  'scripts/checks/precommit.js',
  'scripts/checks/personal-data.allow.json',
  'scripts/ci/runUnitTests.js',
  'scripts/release/exportCore.mjs',
  'scripts/release/releaseAuto.mjs',
  'scripts/release/releaseLocal.mjs',
  'vite.config.js',
  'vitest.config.js',
  'vitest.parser.config.js',
  'eslint.config.js',
  'tailwind.config.cjs',
  'playwright.config.js',
  'Dockerfile',
  '.dockerignore',
  '.gitignore',
  '.gitattributes',
  '.github/workflows/*.yml',
  'server/__tests__/**',
  'src/**/__tests__/**',
  'e2e/**',
  '**/*.md',
]);

/** The private header line of every Pro source file. */
export const PRO_HEADER = ['// burrow-pro:', 'private source, never part of the public core.'].join(' ');

const toPosix = (p) => p.split(path.sep).join('/');

/** Glob match for PRO_PATH_HOLDERS entries (`**` any depth, `*` one segment). */
export function matchesHolder(rel, pattern) {
  const re = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '(?:.*/)?')
      .replace(/\*\*/g, '.*')
      .replace(/(?<!\.)\*/g, '[^/]*')}$`,
  );
  return re.test(rel);
}

/** @param {string} rel repo-relative path @returns {boolean} */
export const isPathHolder = (rel) => PRO_PATH_HOLDERS.some((p) => matchesHolder(toPosix(rel), p));

/** Removes block and line comments (string-aware enough for the boundary scan). */
export function stripComments(text) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
    } else if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (c === '/' && n === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
    } else {
      if (c === '"' || c === "'" || c === '`') quote = c;
      out += c;
      i += 1;
    }
  }
  return out;
}

/**
 * Static import and re-export statements of a module: specifier, named imports and whether it is a namespace import.
 * @param {string} text source
 * @returns {{ specifier: string, names: string[], namespace: boolean, sideEffect: boolean }[]}
 */
export function parseImports(text) {
  const src = stripComments(text);
  const out = [];
  const re = /(?:^|[;\n])\s*(import|export)\s+([^;'"`]*?)\s*from\s*['"]([^'"]+)['"]|(?:^|[;\n])\s*import\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[4]) {
      out.push({ specifier: m[4], names: [], namespace: false, sideEffect: true });
      continue;
    }
    const clause = m[2];
    const namespace = /\*\s+as\s+\w+/.test(clause) || (m[1] === 'export' && /^\*/.test(clause.trim()));
    const names = [];
    const braces = clause.match(/\{([\s\S]*)\}/);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name) names.push(name);
      }
    }
    const def = clause.replace(/\{[\s\S]*\}/, '').replace(/\*\s+as\s+\w+/, '').replace(/,/g, ' ').trim();
    if (m[1] === 'import' && def && !def.startsWith('type ')) names.push('default');
    out.push({ specifier: m[3], names, namespace, sideEffect: false });
  }
  return out;
}

/**
 * Checks one import of a non-test pro/server file. Returns null when allowed, else a short reason.
 * @param {{ root: string, importer: string, specifier: string, names?: string[], namespace?: boolean, resolved?: string }} input
 *   importer and resolved are absolute paths; resolved defaults to path.resolve(dirname(importer), specifier)
 * @returns {string | null}
 */
export function checkProServerImport({ root, importer, specifier, names = [], namespace = false, resolved }) {
  if (!specifier.startsWith('.') && !path.isAbsolute(specifier)) {
    return PRO_SERVER_BUILTINS.includes(specifier) ? null : `bare specifier ${specifier} is not allowed in pro/server`;
  }
  const target = resolved ?? path.resolve(path.dirname(importer), specifier);
  const rel = toPosix(path.relative(root, target));
  if (rel.startsWith('pro/server/')) return null;
  if (rel.startsWith('pro/')) return `pro/server may not import ${rel}`;
  if (PRO_SERVER_PURE.includes(rel)) return null;
  const tier = PRO_SERVER_CORE_ALLOWLIST[rel];
  if (!tier) return `pro/server may not import ${rel}`;
  if (namespace && !tier.namespace) return `namespace import of ${rel} is not allowed`;
  if (tier.names !== '*') {
    const bad = names.filter((n) => !tier.names.includes(n));
    if (bad.length) return `${rel} exports ${bad.join(', ')} are not allowed for pro/server`;
  }
  return null;
}

/**
 * Banned source findings for a file. `kind` is 'server' or 'ui'.
 * @returns {string[]} ids of the rules hit
 */
export function bannedSourceHits(text, kind) {
  const src = stripComments(text);
  const rules = kind === 'ui' ? PRO_UI_BANNED_SOURCE : PRO_SERVER_BANNED_SOURCE;
  return rules.filter((r) => r.re.test(src)).map((r) => r.id);
}
