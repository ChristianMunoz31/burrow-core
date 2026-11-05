// Vite wiring for the Burrow Pro UI (pro/ui; docs/adr/0001-open-core-split.md 3.10). The core imports the Pro
// extension points from src/extensions/proExtensions.js (core defaults: no Pro UI). When the private Pro repo is
// checked out at pro/, every Vite run (serve and build, every mode) swaps that one module for
// pro/ui/proExtensions.js; without pro/ the build is a working Free build and anything under pro/ is refused.
// BURROW_REQUIRE_PRO=1 (official release paths) makes a missing pro/ an error.
// Chunk rule: every chunk that contains a pro/ui module must be named assets/pro-*.js (the `pro` code-splitting
// group in vite.config.js and the pro/ui/lazy/pro-<Name>.jsx file names), so the bundle budget can tell core and
// Pro bytes apart and a Pro module never lands in a core chunk.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CORE_PRO_MODULE = path.join('src', 'extensions', 'proExtensions.js');
export const PRO_UI_MODULE = path.join('pro', 'ui', 'proExtensions.js');
const PRO_DIR = 'pro';
export const PRO_CHUNK_RE = /^assets\/pro-/;

/**
 * @param {{ env?: Record<string, string | undefined>, exists?: (file: string) => boolean, root?: string }} [opts]
 * @returns {boolean} whether the Pro UI goes into this Vite run
 * @throws {Error} when BURROW_REQUIRE_PRO=1 and pro/ui/proExtensions.js is missing
 */
export function proUiEnabled({ env = process.env, exists = fs.existsSync, root = ROOT } = {}) {
  const present = exists(path.join(root, PRO_UI_MODULE));
  if (!present && env.BURROW_REQUIRE_PRO === '1') {
    throw new Error(`An official build needs the Pro module but ${PRO_UI_MODULE.split(path.sep).join('/')} is missing (BURROW_REQUIRE_PRO=1)`);
  }
  return present;
}

const normalize = (file, platform) => {
  const forward = String(file).split('?')[0].replace(/\\/g, '/');
  return platform === 'win32' ? forward.toLowerCase() : forward;
};

/**
 * @param {boolean} include true swaps the core extension module for the Pro one; false forbids loading anything under pro/
 * @param {{ root?: string, platform?: string }} [opts] test seams
 * @returns {import('vite').Plugin}
 */
export function proUiPlugin(include, { root = ROOT, platform = process.platform } = {}) {
  const core = normalize(path.join(root, CORE_PRO_MODULE), platform);
  const proModule = path.join(root, PRO_UI_MODULE).replace(/\\/g, '/');
  const proDir = `${normalize(path.join(root, PRO_DIR), platform)}/`;
  const proUiDir = `${normalize(path.join(root, PRO_DIR, 'ui'), platform)}/`;
  return {
    name: 'burrow-pro-ui',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!include || !source.includes('proExtensions')) return null;
      // The Pro module itself imports the core defaults; never swap an import made from inside pro/.
      if (importer && normalize(importer, platform).startsWith(proDir)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved && normalize(resolved.id, platform) === core ? { id: proModule } : null;
    },
    load(id) {
      if (!include && normalize(id, platform).startsWith(proDir)) {
        throw new Error(`pro/ must not enter this build (${path.relative(root, id.split('?')[0])})`);
      }
      return null;
    },
    generateBundle(_options, bundle) {
      if (!include) return;
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        const ids = chunk.moduleIds ?? Object.keys(chunk.modules ?? {});
        const hasPro = ids.some((id) => normalize(id, platform).startsWith(proUiDir));
        if (hasPro && !PRO_CHUNK_RE.test(chunk.fileName)) {
          this.error(`A pro/ui module landed in the core chunk ${chunk.fileName}; Pro UI must stay in assets/pro-*.js chunks`);
        }
      }
    },
  };
}
