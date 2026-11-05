// Loads the optional developer extension from the top-level devtools/ folder. This is the only core file that
// may name that folder. Unbundled runs (npm start, desktop:dev, Vitest) import it at run time and get null when
// the folder is absent (release zip, Docker). The sidecar bundler swaps this module for devExtensionsLoader.none.js
// (stable, Store) or devtools/server/static.js (dev channel).

/** True for the "module not found" error of the extension entry itself (Windows paths use backslashes). */
export function isExtensionNotFound(err) {
  if (err?.code !== 'ERR_MODULE_NOT_FOUND') return false;
  return String(err?.url ?? err?.message).replaceAll('\\', '/').includes('devtools/server/index.js');
}

export async function importDevExtension() {
  try {
    return (await import('../devtools/server/index.js')).default ?? null;
  } catch (err) {
    if (isExtensionNotFound(err)) return null;
    throw err;
  }
}
