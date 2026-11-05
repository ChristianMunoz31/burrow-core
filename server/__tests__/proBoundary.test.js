// ci:always-run
// The open-core module boundary (docs/adr/0001-open-core-split.md 3.9, 3.12). Always: runtime core never imports
// pro/ and names it only in server/proExtensionsLoader.js; only PRO_PATH_HOLDERS name pro/; the Tier B helpers are
// pure; the Pro registries are called only from server/proExtensions.js; only pro/ tests install the real module; the
// ignore and Docker rules; no core file carries the private header. When pro/ exists also: the Tier A names, Tier B,
// builtins and banned source for pro/server, the pro/ui rules, and the header on every Pro source file.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasPrivateFile } from './helpers/privateFiles.js';
import {
  PRO_HEADER,
  PRO_PATH_HOLDERS,
  PRO_SERVER_BUILTINS,
  PRO_SERVER_CORE_ALLOWLIST,
  PRO_SERVER_PURE,
  bannedSourceHits,
  checkProServerImport,
  isPathHolder,
  matchesHolder,
  parseImports,
  stripComments,
} from '../../scripts/build/proBoundary.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HAS_PRO = fs.existsSync(path.join(ROOT, 'pro', 'server', 'index.js'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const posix = (p) => p.split(path.sep).join('/');
/** A mention of the pro/ folder as a path (comments included). */
const NAMES_PRO_RE = /(^|[\s'"`(/[])pro\//;
const SOURCE_RE = /\.(js|jsx|mjs|cjs)$/;
const isTest = (rel) => /(^|\/)__tests__\//.test(rel) || /\.test\.(js|jsx|mjs)$/.test(rel) || rel.startsWith('src/test-utils/');

/** Core files on disk: tracked plus untracked-but-not-ignored (pro/ is ignored, devtools/ is not public core). */
function coreFiles() {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((f) => !f.startsWith('devtools/') && !f.startsWith('pro/') && fs.existsSync(path.join(ROOT, f)));
}
const CORE = coreFiles();
const isRuntimeCore = (rel) => (rel === 'server.js' || rel === 'loadEnv.js' || rel.startsWith('server/') || rel.startsWith('src/')) && SOURCE_RE.test(rel) && !isTest(rel);
const RUNTIME = CORE.filter(isRuntimeCore);

function walk(dir, filter) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const rel = posix(path.join(dir, e.name));
    if (e.isDirectory()) out.push(...walk(rel, filter));
    else if (filter(rel)) out.push(rel);
  }
  return out;
}

describe('holder patterns', () => {
  it('match the listed holders and nothing else', () => {
    expect(matchesHolder('server/__tests__/a/b.test.js', 'server/__tests__/**')).toBe(true);
    expect(matchesHolder('.github/workflows/ci.yml', '.github/workflows/*.yml')).toBe(true);
    expect(matchesHolder('.github/workflows/x/ci.yml', '.github/workflows/*.yml')).toBe(false);
    expect(matchesHolder('docs/a/b.md', '**/*.md')).toBe(true);
    expect(isPathHolder('server/proExtensionsLoader.js')).toBe(true);
    expect(isPathHolder('server/proExtensions.js')).toBe(false);
    expect(PRO_PATH_HOLDERS.filter((p) => p.startsWith('server/') && !p.includes('__tests__'))).toEqual(['server/proExtensionsLoader.js']);
  });
});

describe('core never reaches into pro/', () => {
  it('runtime core names pro/ only in server/proExtensionsLoader.js', () => {
    const offenders = RUNTIME.filter((f) => f !== 'server/proExtensionsLoader.js' && NAMES_PRO_RE.test(read(f)));
    expect(offenders).toEqual([]);
    expect(read('server/proExtensionsLoader.js')).toContain("import('../pro/server/index.js')");
  });

  it('runtime core never imports from pro/ (static imports)', () => {
    const offenders = [];
    for (const f of RUNTIME) {
      for (const imp of parseImports(read(f))) {
        const target = posix(path.relative(ROOT, path.resolve(ROOT, path.dirname(f), imp.specifier)));
        if (imp.specifier.startsWith('.') && target.startsWith('pro/')) offenders.push(`${f} -> ${imp.specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('only PRO_PATH_HOLDERS (and the LICENSE text) name pro/', () => {
    const offenders = CORE.filter((f) => !isPathHolder(f) && f !== 'LICENSE' && !/\.(png|ico|icns|bmp|jpg|svg|woff2?|ttf|zip|db|exe)$/i.test(f)).filter((f) => {
      try {
        return NAMES_PRO_RE.test(read(f));
      } catch {
        return false;
      }
    });
    expect(offenders).toEqual([]);
  });

  it('no core file carries the private header (Markdown may quote it)', () => {
    const offenders = CORE.filter((f) => SOURCE_RE.test(f) && read(f).includes(PRO_HEADER));
    expect(offenders).toEqual([]);
  });
});

describe('Tier B helpers are pure', () => {
  it.each(PRO_SERVER_PURE)('%s imports only Tier B modules and node:crypto', (rel) => {
    for (const imp of parseImports(read(rel))) {
      if (!imp.specifier.startsWith('.')) {
        expect(PRO_SERVER_BUILTINS, `${rel}: ${imp.specifier}`).toContain(imp.specifier);
        continue;
      }
      const target = posix(path.relative(ROOT, path.resolve(ROOT, path.dirname(rel), imp.specifier)));
      expect(PRO_SERVER_PURE, `${rel} -> ${target}`).toContain(target);
    }
  });

  it('every Tier A and Tier B module exists', () => {
    for (const rel of [...Object.keys(PRO_SERVER_CORE_ALLOWLIST), ...PRO_SERVER_PURE]) expect(fs.existsSync(path.join(ROOT, rel)), rel).toBe(true);
  });
});

describe('Pro registries', () => {
  const REGISTRIES = ['registerProScheduledJob', 'resetProScheduledJobsForTests', 'setFolderProHooks', 'resetFolderProHooksForTests', 'registerCharacterTexts', 'resetCharacterTextsForTests'];
  const DEFINED_IN = { registerProScheduledJob: 'server/scheduler.js', resetProScheduledJobsForTests: 'server/scheduler.js', setFolderProHooks: 'server/folders/jobs.js', resetFolderProHooksForTests: 'server/folders/jobs.js', registerCharacterTexts: 'server/javi/characters.js', resetCharacterTextsForTests: 'server/javi/characters.js' };

  it.each(REGISTRIES)('%s is called only from server/proExtensions.js (and tests)', (name) => {
    const users = RUNTIME.filter((f) => f !== DEFINED_IN[name] && new RegExp(`\\b${name}\\b`).test(stripComments(read(f))));
    expect(users).toEqual(['server/proExtensions.js']);
  });

  it('only pro/ tests (and the devtools tier matrix) import the real-module test helper', () => {
    const users = [...CORE, ...walk('devtools', (f) => SOURCE_RE.test(f))]
      .filter((f) => SOURCE_RE.test(f) && f !== 'server/__tests__/helpers/proModule.js' && f !== 'server/__tests__/proBoundary.test.js')
      .filter((f) => /helpers\/proModule\.js/.test(read(f)));
    // devtools/ is private-only (not in the public core export), so the tier matrix exists only in the private repo.
    const TIER_MATRIX = 'devtools/server/__tests__/proTierMatrix.test.js';
    expect(users).toEqual(hasPrivateFile(TIER_MATRIX) ? [TIER_MATRIX] : []);
  });
});

describe('ignore, export and Docker rules', () => {
  it('core ignores and export-ignores pro/', () => {
    expect(read('.gitignore').split(/\r?\n/)).toContain('/pro/');
    expect(read('.gitattributes').split(/\r?\n/)).toContain('pro export-ignore');
  });

  it('.dockerignore keeps pro/ in the build context but drops its git data, e2e, evals and scripts', () => {
    const lines = read('.dockerignore').split(/\r?\n/).map((l) => l.trim());
    for (const bad of ['pro', 'pro/', '/pro', '/pro/', 'pro/*', 'pro/**', '**/pro']) expect(lines, bad).not.toContain(bad);
    for (const sub of ['pro/.git', 'pro/e2e', 'pro/evals', 'pro/scripts']) expect(lines).toContain(sub);
    expect(lines).toContain('**/__tests__');
  });

  it('the Dockerfile copies only pro/server to the runtime and refuses pro/ui there', () => {
    const docker = read('Dockerfile');
    expect(docker).toContain('RUN mkdir -p /app/.pro-runtime && if [ -d pro/server ]; then cp -r pro/server /app/.pro-runtime/server; fi');
    expect(docker).toContain('COPY --from=build /app/.pro-runtime/ ./pro/');
    expect(docker).toContain('RUN test ! -e pro/ui');
    expect(docker).toMatch(/never push an image built with pro\/ to any registry/);
  });
});

const PRO_SOURCES = HAS_PRO ? walk('pro', (f) => SOURCE_RE.test(f) && !f.startsWith('pro/node_modules/')) : [];
const PRO_SERVER_RUNTIME = PRO_SOURCES.filter((f) => f.startsWith('pro/server/') && !isTest(f));
const PRO_UI_RUNTIME = PRO_SOURCES.filter((f) => f.startsWith('pro/ui/') && !isTest(f));

/** Bare packages the core UI already imports (pro/ui may use only these). */
function srcPackages() {
  const pkgs = new Set();
  for (const f of CORE.filter((x) => x.startsWith('src/') && /\.(js|jsx)$/.test(x))) {
    for (const imp of parseImports(read(f))) {
      if (imp.specifier.startsWith('.') || imp.specifier.startsWith('/')) continue;
      const parts = imp.specifier.split('/');
      pkgs.add(imp.specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
    }
  }
  return pkgs;
}

describe.skipIf(!HAS_PRO)('pro/ rules (Pro module checked out)', () => {
  it('every Pro source file starts with the private header', () => {
    const missing = PRO_SOURCES.filter((f) => !read(f).startsWith(PRO_HEADER));
    expect(missing).toEqual([]);
  });

  it('pro/server runtime imports only Tier A names, Tier B modules, node:crypto and pro/server', () => {
    const problems = [];
    for (const f of PRO_SERVER_RUNTIME) {
      for (const imp of parseImports(read(f))) {
        const why = checkProServerImport({ root: ROOT, importer: path.join(ROOT, f), specifier: imp.specifier, names: imp.names, namespace: imp.namespace });
        if (why) problems.push(`${f}: ${why}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('pro/server runtime has no banned source', () => {
    const problems = PRO_SERVER_RUNTIME.flatMap((f) => bannedSourceHits(read(f), 'server').map((hit) => `${f}: ${hit}`));
    expect(problems).toEqual([]);
  });

  it('pro/server never imports the registries or the seam itself', () => {
    for (const f of PRO_SERVER_RUNTIME) expect(stripComments(read(f)), f).not.toMatch(/proExtensions(Loader)?\.js|scheduler\.js'/);
  });

  it('pro/ui imports only pro/ui, src/ (never the swapped module) and packages the core UI uses', () => {
    const allowedPkgs = srcPackages();
    const problems = [];
    for (const f of PRO_UI_RUNTIME) {
      for (const imp of parseImports(read(f))) {
        if (!imp.specifier.startsWith('.')) {
          const parts = imp.specifier.split('/');
          const pkg = imp.specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
          if (!allowedPkgs.has(pkg)) problems.push(`${f}: package ${pkg} is not used by the core UI`);
          continue;
        }
        const target = posix(path.relative(ROOT, path.resolve(ROOT, path.dirname(f), imp.specifier)));
        if (target === 'src/extensions/proExtensions.js') problems.push(`${f}: imports the swapped core module`);
        else if (!target.startsWith('pro/ui/') && !target.startsWith('src/')) problems.push(`${f}: imports ${target}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('pro/ui runtime has no banned source', () => {
    const problems = PRO_UI_RUNTIME.flatMap((f) => bannedSourceHits(read(f), 'ui').map((hit) => `${f}: ${hit}`));
    expect(problems).toEqual([]);
  });
});

describe('the scanners themselves', () => {
  it('parseImports reads named, default, namespace and side-effect imports', () => {
    const imps = parseImports("import a, { b, c as d } from './x.js';\nimport * as ns from '../y.js';\nimport './z.js';\nexport { e } from './w.js';\n// import { no } from './comment.js';");
    expect(imps.map((i) => i.specifier)).toEqual(['./x.js', '../y.js', './z.js', './w.js']);
    expect(imps[0].names.sort()).toEqual(['b', 'c', 'default']);
    expect(imps[1].namespace).toBe(true);
  });

  it('checkProServerImport refuses what ADR 3.9 refuses', () => {
    const importer = path.join(ROOT, 'pro', 'server', 'x', 'y.js');
    const check = (specifier, names = [], namespace = false) => checkProServerImport({ root: ROOT, importer, specifier, names, namespace });
    expect(check('node:crypto')).toBeNull();
    expect(check('node:fs')).toMatch(/bare specifier/);
    expect(check('express')).toMatch(/bare specifier/);
    expect(check('../../../server/dataAccess.js', [], true)).toBeNull();
    expect(check('../../../server/ai/index.js', ['getAiClient'])).toBeNull();
    expect(check('../../../server/ai/index.js', [], true)).toMatch(/namespace/);
    expect(check('../../../server/netPolicy.js', ['setOptIn'])).toMatch(/not allowed/);
    expect(check('../../../server/db/index.js', ['getDb'])).toMatch(/may not import/);
    expect(check('../../../server/proExtensions.js', ['PRO_GATE'])).toMatch(/may not import/);
    expect(check('../../../src/utils/x.js')).toMatch(/may not import/);
    expect(check('../../../server/folders/stats.js', ['anything'])).toBeNull();
    expect(check('../z.js')).toBeNull();
  });

  it('bannedSourceHits finds network, eval and process use, ignoring comments', () => {
    expect(bannedSourceHits("const r = await fetch('https://x');", 'server')).toContain('fetch');
    expect(bannedSourceHits('// fetch(x)\nconst a = 1;', 'server')).toEqual([]);
    expect(bannedSourceHits('process.exit(1)', 'server')).toContain('process');
    expect(bannedSourceHits('process.env.X', 'server')).toEqual([]);
    expect(bannedSourceHits("await import('./x.js')", 'server')).toContain('dynamic import');
    expect(bannedSourceHits("fetch('/api/folders')", 'ui')).toEqual([]);
    expect(bannedSourceHits("fetch(url)", 'ui')).toContain('fetch outside /api/');
    expect(bannedSourceHits("const u = 'https://example.com'", 'ui')).toContain('absolute URL');
    expect(bannedSourceHits("lazy(() => import('./lazy/pro-X.jsx'))", 'ui')).toEqual([]);
  });
});
