// Static boundary for "Erase all my data" (same fs + regex style as aiBoundary.test.js and
// proToolsBoundary.test.js): the erase service is importable only from its route module, the route module only
// from server.js, and nothing Javi, Jarvis, AI or page-builder related can trigger, propose or link to it.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dynamicLoads, unexpectedDynamicLoads } from './helpers/dynamicLoads.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');
const read = (relPath) => fs.readFileSync(path.join(ROOT, relPath), 'utf8');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '__tests__']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const CODE = /\.(?:js|jsx|mjs|cjs)$/;
const backendFiles = [...walk(path.join(ROOT, 'server')).filter((f) => CODE.test(f)), path.join(ROOT, 'server.js')].map(rel);
const frontendFiles = walk(path.join(ROOT, 'src')).filter((f) => CODE.test(f)).map(rel);

function specifiers(source) {
  const out = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"`])([^'"`\n]+)\1/g;
  for (const m of source.matchAll(re)) out.push(m[2]);
  return out;
}

const EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs'];
/**
 * Resolves a relative specifier to a known file: the path itself, with an extension, or a directory's index
 * file (`import './erase'` means `./erase/index.js`).
 * @param {Set<string>} knownFiles repo-relative paths
 */
function resolveIn(knownFiles, fromRel, spec) {
  if (!spec.startsWith('.')) return null;
  const base = rel(path.resolve(path.join(ROOT, path.dirname(fromRel)), spec)).replace(/\/+$/, '');
  const candidates = [base, ...EXTENSIONS.map((e) => `${base}${e}`), ...EXTENSIONS.map((e) => `${base}/index${e}`)];
  return candidates.find((c) => knownFiles.has(c)) ?? null;
}
const known = new Set(backendFiles);
const resolveSpec = (fromRel, spec) => resolveIn(known, fromRel, spec);
const graph = new Map(backendFiles.map((f) => [f, new Set(specifiers(read(f)).map((s) => resolveSpec(f, s)).filter(Boolean))]));
const importersOf = (target) => backendFiles.filter((f) => graph.get(f).has(target));

const knownFront = new Set(frontendFiles);
const frontGraph = new Map(
  frontendFiles.map((f) => [f, new Set(specifiers(read(f)).map((s) => resolveIn(knownFront, f, s)).filter(Boolean))]),
);

const ERASE_MODULES = Object.freeze(['server/erase/eraseService.js', 'server/erase/eraseTokens.js', 'server/eraseRoutes.js']);
// Anything in these places is on the AI side: model clients, Javi tools and prompts, page advice, UI builders.
const AI_BACKEND = backendFiles.filter((f) => /^server\/(agents|javi|ai)\//.test(f));
// Everything on the Javi side of the browser: builders and helpers, the panel and its parts, the hooks that
// talk to /api/jarvis, and their service clients.
const AI_FRONTEND = frontendFiles.filter((f) =>
  /^src\/(utils\/javiBuilders\/|components\/javi\/|utils\/javi[A-Za-z]*\.js$|constants\/javiPages\.js$|hooks\/(?:useJarvis[A-Za-z]*|useJavi[A-Za-z]*|useCachedJarvisAi)\.js$|services\/(?:jarvis|javi)[A-Za-z]*\.js$)/.test(f),
);
// Frontend modules that open the erase flow.
const ERASE_UI = Object.freeze([
  'src/services/eraseService.js',
  'src/components/settings/DangerZone.jsx',
  'src/components/settings/EraseDataDialog.jsx',
]);
// What names the routes, the service, or the Danger zone entry point.
const ERASE_REFERENCE =
  /\/api\/data\/erase|eraseService|eraseRoutes|eraseTokens|eraseAllData|registerEraseRoutes|danger-zone|DangerZone|Erase all my data/i;
const ERASE_WORDS = /\b(?:erase[sd]?|erasing|wipe[sd]?|wiping)\b/i;

describe('the erase modules are reachable only from the route', () => {
  it('scans a real file set and finds the erase modules', () => {
    expect(backendFiles.length).toBeGreaterThan(50);
    expect(AI_BACKEND.length).toBeGreaterThan(10);
    expect(AI_FRONTEND.length).toBeGreaterThan(3);
    // useJarvis moved to the Pro module (docs/adr/0001-open-core-split.md B4); its twin scans it there.
    for (const f of ['src/hooks/useJarvisStatus.js', 'src/hooks/useJaviSession.js', 'src/services/javiService.js', 'src/components/javi/JaviPanel.jsx']) {
      expect(AI_FRONTEND, f).toContain(f);
    }
    for (const f of ERASE_UI) expect(frontendFiles, f).toContain(f);
    for (const f of ERASE_MODULES) expect(known.has(f), f).toBe(true);
  });

  it('only server/eraseRoutes.js imports the erase service', () => {
    expect(importersOf('server/erase/eraseService.js')).toEqual(['server/eraseRoutes.js']);
  });

  it('only server/eraseRoutes.js imports the token store', () => {
    expect(importersOf('server/erase/eraseTokens.js')).toEqual(['server/eraseRoutes.js']);
  });

  it('only server.js imports the route module', () => {
    expect(importersOf('server/eraseRoutes.js')).toEqual(['server.js']);
  });

  it('no import( or require( in server/ takes a computed argument (explicit allowlist: prose inside string literals)', () => {
    const found = unexpectedDynamicLoads(backendFiles, read);
    expect(found, `A computed import/require can load an erase module past this graph: ${found.join('; ')}`).toEqual([]);
  });

  it('the detector flags computed loads and accepts plain literals', () => {
    expect(dynamicLoads('x.js', "await import('./a.js'); require(`./b.js`);")).toEqual([]);
    expect(dynamicLoads('x.js', 'await import(name)')).toHaveLength(1);
    expect(dynamicLoads('x.js', 'import(`./erase/${n}.js`)')).toHaveLength(1);
    expect(dynamicLoads('x.js', "require('./e' + 'rase')")).toHaveLength(1);
  });

  it('resolves directory imports, extensions and trailing slashes, so an index file cannot hide an importer', () => {
    const files = new Set(['server/erase/index.js', 'server/erase/eraseService.js', 'src/ui/Panel.jsx', 'src/ui/index.jsx']);
    expect(resolveIn(files, 'server/eraseRoutes.js', './erase')).toBe('server/erase/index.js');
    expect(resolveIn(files, 'server/eraseRoutes.js', './erase/')).toBe('server/erase/index.js');
    expect(resolveIn(files, 'server/eraseRoutes.js', './erase/eraseService')).toBe('server/erase/eraseService.js');
    expect(resolveIn(files, 'src/App.jsx', './ui/Panel')).toBe('src/ui/Panel.jsx');
    expect(resolveIn(files, 'src/App.jsx', './ui')).toBe('src/ui/index.jsx');
    expect(resolveIn(files, 'src/App.jsx', 'react')).toBeNull();
  });

  it('every relative import in server/ resolves to a file or a directory index (nothing is silently skipped)', () => {
    // Explicit allowlist: root-level files outside server/ (the env loader has no erase code), and the optional
    // developer extension folder, which the loader imports at run time and which is absent from the release zip.
    const OUTSIDE_SERVER = new Set(['server.js -> ./loadEnv.js', 'server/devExtensionsLoader.js -> ../devtools/server/index.js', 'server/proExtensionsLoader.js -> ../pro/server/index.js']);
    const unresolved = [];
    for (const f of backendFiles) {
      for (const spec of specifiers(read(f))) {
        if (!spec.startsWith('.') || /\.(?:json|sql|css|html|txt|md)$/i.test(spec)) continue;
        if (!resolveSpec(f, spec) && !OUTSIDE_SERVER.has(`${f} -> ${spec}`)) unresolved.push(`${f} -> ${spec}`);
      }
    }
    expect(unresolved).toEqual([]);
  });
});

describe('no AI code can reach, propose or link to erasing', () => {
  it('no file under server/javi or server/ai references the routes, the service or the Danger zone', () => {
    const offenders = AI_BACKEND.filter((f) => ERASE_REFERENCE.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('no Javi UI file (builders, panel, hooks, service clients, page list, context) references them either', () => {
    const offenders = AI_FRONTEND.filter((f) => ERASE_REFERENCE.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('nothing the AI side imports leads to an erase module, directly or through other modules', () => {
    const seen = new Set();
    const queue = [...AI_BACKEND];
    while (queue.length) {
      const next = queue.pop();
      if (seen.has(next)) continue;
      seen.add(next);
      for (const dep of graph.get(next) ?? []) queue.push(dep);
    }
    // The audit module is the one shared dependency (it writes the marker); it must not import any erase module.
    for (const f of ERASE_MODULES) expect(seen.has(f), `${f} is reachable from the AI side`).toBe(false);
  });

  it('nothing the Javi UI imports leads to the erase client or the Danger zone, directly or through other modules', () => {
    const seen = new Set();
    const queue = [...AI_FRONTEND];
    while (queue.length) {
      const next = queue.pop();
      if (seen.has(next)) continue;
      seen.add(next);
      for (const dep of frontGraph.get(next) ?? []) queue.push(dep);
    }
    for (const f of ERASE_UI) expect(seen.has(f), `${f} is reachable from the Javi UI`).toBe(false);
  });

  it('no AI file calls fetch with a path that is not a literal under /api/jarvis, and none uses another transport', () => {
    const FETCH = /\bfetch\s*\(\s*/g;
    // Provider transports: they call the configured model host (Ollama, or the user's cloud base URL), never a Burrow route.
    const PROVIDER_TRANSPORT = new Set(['server/ai/llmClient.js', 'server/ai/providers/ollama.js', 'server/ai/providers/openaiCompat.js']);
    const offenders = [];
    for (const f of [...AI_BACKEND, ...AI_FRONTEND]) {
      if (PROVIDER_TRANSPORT.has(f)) continue;
      const source = read(f);
      for (const m of source.matchAll(FETCH)) {
        const after = source.slice(m.index + m[0].length);
        // A literal, or a template whose fixed part up to the first ${ starts with /api/jarvis.
        const literal = /^(['"`])(\/api\/jarvis[^'"`$]*)(?:\$\{[^}]*\}[^'"`$]*)*\1/.exec(after);
        if (!literal) offenders.push(`${f}: ${source.slice(m.index, m.index + 50).split('\n')[0]}`);
      }
      if (/\b(?:XMLHttpRequest|sendBeacon|EventSource|WebSocket)\b/.test(source)) offenders.push(`${f}: another transport`);
    }
    expect(offenders).toEqual([]);
  });

  it('the fetch scan accepts the Jarvis routes and rejects a variable or an erase path', () => {
    const ok = (code) => /^(['"`])(\/api\/jarvis[^'"`$]*)(?:\$\{[^}]*\}[^'"`$]*)*\1/.test(code);
    expect(ok("'/api/jarvis/status')")).toBe(true);
    expect(ok('`/api/jarvis/actions/${encodeURIComponent(token)}`')).toBe(true);
    expect(ok('url, {')).toBe(false);
    expect(ok('`${base}/api/data/erase`')).toBe(false);
    expect(ok("'/api/data/erase'")).toBe(false);
  });

  it('no Javi prompt or page-advice text mentions erase or wipe (the tool definitions and agent prompts are checked in pro/server/__tests__/eraseBoundary.pro.test.js)', () => {
    for (const f of ['server/javi/advisorPrompt.js', 'server/javi/pages.js']) {
      expect(read(f), f).not.toMatch(ERASE_WORDS);
    }
    for (const f of AI_FRONTEND) expect(read(f), f).not.toMatch(ERASE_WORDS);
  });

});

describe('the browser side', () => {
  it('only the erase service client and the Danger zone files name the erase routes', () => {
    const namers = frontendFiles.filter((f) => /\/api\/data\/erase/.test(read(f))).sort();
    expect(namers).toEqual(['src/services/eraseService.js']);
  });

  it('only the Settings data section mounts the Danger zone', () => {
    const mounts = frontendFiles.filter((f) => /\bDangerZone\b/.test(read(f)) && !/DangerZone/.test(path.basename(f))).sort();
    expect(mounts).toEqual(['src/components/settings/DataStorageSection.jsx']);
  });
});
