// Vite wiring for the developer tools UI (devtools/ui). The core Settings page imports the extension list from
// src/extensions/settingsExtensions.js (empty). A build that wants the developer tools swaps that one module for
// devtools/ui/settingsExtensions.js; every other build excludes the whole devtools/ tree and fails if anything
// tries to load it. Which build includes it:
//   npm run dev (serve)            included when devtools/ exists
//   npm run build:devtools         included (mode 'devtools'); fails without devtools/
//   npm run build, BURROW_CHANNEL=dev   included (Burrow Dev); fails without devtools/
//   any other build (stable, Store, zip, Docker, CI)   excluded
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBuildChannel } from '../../server/channel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORE_MODULE = path.join('src', 'extensions', 'settingsExtensions.js');
const DEV_MODULE = path.join('devtools', 'ui', 'settingsExtensions.js');
const DEV_DIR = 'devtools';

/**
 * @param {{ command: 'serve' | 'build', mode: string, env?: Record<string, string | undefined>, exists?: (file: string) => boolean, root?: string }} opts
 * @returns {boolean} whether the developer tools UI goes into this Vite run
 * @throws {Error} when the mode or the dev channel asks for it and devtools/ is missing
 */
export function devToolsUiEnabled({ command, mode, env = process.env, exists = fs.existsSync, root = ROOT }) {
  let channelDev;
  try {
    channelDev = resolveBuildChannel(env) === 'dev';
  } catch (err) {
    if (command !== 'serve') throw err;
    channelDev = false;
  }
  const present = exists(path.join(root, DEV_MODULE));
  if (mode === 'devtools' || channelDev) {
    if (!present) {
      throw new Error(`The developer tools UI was requested (${mode === 'devtools' ? '--mode devtools' : 'BURROW_CHANNEL=dev'}) but ${DEV_MODULE} is missing`);
    }
    return true;
  }
  return command === 'serve' && present;
}

const normalize = (file, platform) => {
  const forward = String(file).split('?')[0].replace(/\\/g, '/');
  return platform === 'win32' ? forward.toLowerCase() : forward;
};

/**
 * @param {boolean} include true swaps the core extension list for the developer tools one; false forbids loading anything under devtools/
 * @param {{ root?: string, platform?: string }} [opts] test seams
 * @returns {import('vite').Plugin}
 */
export function devToolsUiPlugin(include, { root = ROOT, platform = process.platform } = {}) {
  const core = normalize(path.join(root, CORE_MODULE), platform);
  const devModule = path.join(root, DEV_MODULE).replace(/\\/g, '/');
  const devDir = `${normalize(path.join(root, DEV_DIR), platform)}/`;
  return {
    name: 'burrow-dev-tools-ui',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!include || !source.includes('settingsExtensions')) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved && normalize(resolved.id, platform) === core ? { id: devModule } : null;
    },
    load(id) {
      if (!include && normalize(id, platform).startsWith(devDir)) {
        throw new Error(`devtools/ must not enter this build (${path.relative(root, id.split('?')[0])})`);
      }
      return null;
    },
  };
}
