// Registry completeness (docs/LICENSING.md 6.1): every Pro capability has an introducedAt entry, and every
// feature gated by requirePro / assertPro anywhere in the server has a real date. A future feature therefore
// cannot ship gated but undated: the test fails until its first release build date is added to
// server/license/proFeatureDates.js. Static guard in the style of proRoutesBoundary.test.js.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRO_FEATURES } from '../pro.js';
import { PRO_FEATURE_INTRODUCED_AT, proFeatureIntroducedMs } from '../license/proFeatureDates.js';
import { SHIPPED_PRO_FEATURES } from '../../src/constants/proFeatures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Open core (docs/adr/0001-open-core-split.md 3.4): the Pro module's own re-checks are scanned too when pro/ is checked out.
const PRO_SERVER = path.join(ROOT, 'pro', 'server');
const FILES = [path.join(ROOT, 'server.js'), ...sourceFiles(path.join(ROOT, 'server')), ...(fs.existsSync(PRO_SERVER) ? sourceFiles(PRO_SERVER) : [])];
const PRO_ROUTES_FILE = path.join(ROOT, 'server', 'proRoutes.js');
// server/proExtensions.js mounts requirePro(route.feature) for every PRO_ROUTES entry; those ids are read from the table.
const SEAM_FILE = path.join(ROOT, 'server', 'proExtensions.js');
const CALL_RE = /\b(requirePro|assertPro|proAccess)\(\s*([^)]*?)\s*\)/g;

/** [file, helper, argument source] for every call of requirePro / assertPro / proAccess outside their definition. */
function gateCalls() {
  const calls = [];
  for (const file of FILES) {
    if (file === path.join(ROOT, 'server', 'pro.js')) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(CALL_RE)) {
      // skip imports and comments that merely mention the helper name
      const line = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index));
      if (/^\s*(\/\/|\*|import )/.test(line)) continue;
      if (file === SEAM_FILE && m[2] === 'route.feature') continue;
      calls.push([path.relative(ROOT, file).replaceAll('\\', '/'), m[1], m[2]]);
    }
  }
  // Every route of the public Pro route table is gated by core with its feature.
  for (const m of fs.readFileSync(PRO_ROUTES_FILE, 'utf8').matchAll(/feature: ('[a-z_]+')/g)) calls.push(['server/proRoutes.js', 'requirePro', m[1]]);
  return calls;
}

const PRO_MODULE = path.join(ROOT, 'server', 'pro.js');

/**
 * Callers of the global isProEnabled() outside server/pro.js. isProEnabled() answers "is any Pro on", which is
 * wrong for a lapsed Store perpetual license (Pro only per feature, pro stays false), so a caller would lock a
 * feature the buyer still owns. Every legitimate caller must be listed here with the reason it is safe.
 * Today there are none: the gates all use requirePro / assertPro with a feature id.
 * @type {Readonly<Record<string, string>>}
 */
const IS_PRO_ENABLED_ALLOWLIST = Object.freeze({});

describe('the Pro feature date registry', () => {
  it('has exactly the ids of PRO_FEATURES', () => {
    expect(Object.keys(PRO_FEATURE_INTRODUCED_AT).sort()).toEqual(Object.keys(PRO_FEATURES).sort());
  });

  it('every entry is a strict license date or null, and shipped features (used) are never null', () => {
    for (const [id, feature] of Object.entries(PRO_FEATURES)) {
      const date = PRO_FEATURE_INTRODUCED_AT[id];
      if (date === null) {
        expect(feature.used, `${id} is in use but has no introducedAt date`).toBe(false);
      } else {
        expect(proFeatureIntroducedMs(id), `${id}: ${String(date)} is not a YYYY-MM-DDTHH:MM:SSZ date`).not.toBeNull();
        expect(feature.used, `${id} has a date but is marked unused`).toBe(true);
      }
    }
  });

  it('every feature gated by requirePro, requireProWhen or assertPro anywhere in the server has a date', () => {
    const calls = gateCalls();
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const [file, helper, arg] of calls) {
      const m = /^'([a-z_]+)'$/.exec(arg);
      expect(m, `${file}: ${helper}(${arg}) must use a string literal feature id so its date can be checked`).not.toBeNull();
      const id = m[1];
      expect(Object.hasOwn(PRO_FEATURES, id), `${file}: ${id} is not in PRO_FEATURES`).toBe(true);
      expect(PRO_FEATURE_INTRODUCED_AT[id], `${file}: ${id} is gated but has no introducedAt date in server/license/proFeatureDates.js`).not.toBeNull();
      expect(PRO_FEATURES[id].used, `${file}: ${id} is gated but PRO_FEATURES marks it unused`).toBe(true);
    }
  });

  it('no server file calls isProEnabled() unless it is allowlisted as safe for lapsed Store licenses', () => {
    const offenders = [];
    for (const file of FILES) {
      if (file === PRO_MODULE) continue;
      const rel = path.relative(ROOT, file).replaceAll('\\', '/');
      if (Object.hasOwn(IS_PRO_ENABLED_ALLOWLIST, rel)) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bisProEnabled\(/g)) {
        const line = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index));
        if (/^\s*(\/\/|\*|import )/.test(line)) continue;
        offenders.push(rel);
      }
    }
    expect(offenders, 'use requirePro / assertPro with a feature id (per-feature), not isProEnabled()').toEqual([]);
  });

  it('the gated features today are exactly javi_tools, javi_conversation, javi_characters, briefings, explain and the three folder features', () => {
    const ids = new Set(gateCalls().map(([, , arg]) => arg.replaceAll("'", '')));
    expect([...ids].sort()).toEqual(['briefings', 'explain', 'folder_auto_rescan', 'folder_qa', 'folder_report', 'javi_characters', 'javi_conversation', 'javi_tools']);
  });

  it('the client mirror lists the shipped features with the registry labels', () => {
    const shipped = Object.entries(PRO_FEATURES).filter(([, f]) => f.used);
    expect(Object.keys(SHIPPED_PRO_FEATURES).sort()).toEqual(shipped.map(([id]) => id).sort());
    for (const [id, feature] of shipped) expect(SHIPPED_PRO_FEATURES[id]).toBe(feature.label);
  });
});
