// Loads the optional Burrow Pro module from the top-level pro/ folder. This is the only runtime core file that may
// name that folder (docs/adr/0001-open-core-split.md 3.6). Unbundled runs (npm start, desktop:dev, Vitest) import it
// at run time and get null when the folder is absent (a Free checkout). The sidecar bundler swaps this module for
// proExtensionsLoader.none.js (no pro/) or pro/server/static.js (pro/ present).

/** True for the "module not found" error of the Pro entry itself (Windows paths use backslashes). */
export function isProExtensionNotFound(err) {
  if (err?.code !== 'ERR_MODULE_NOT_FOUND') return false;
  return String(err?.url ?? err?.message).replaceAll('\\', '/').includes('pro/server/index.js');
}

/** @returns {Promise<object | null>} the module's default export, or null when pro/ is absent */
export async function importProExtension() {
  try {
    return (await import('../pro/server/index.js')).default ?? null;
  } catch (err) {
    if (isProExtensionNotFound(err)) return null;
    throw err;
  }
}
