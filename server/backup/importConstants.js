// Names shared by the import from the direct Burrow (server/backup/directImport.js) and the code that must know about its
// leftovers (Erase all my data). Plain constants: no imports, so any module can use them.

/** Private staging folder inside the data folder: <data dir>/.import-<16 hex>/. */
export const STAGED_IMPORT_DIR_PREFIX = '.import-';
export const STAGED_IMPORT_DIR_RE = /^\.import-[0-9a-f]{16}$/;
/** A finished stage is renamed to <name>.done before it is deleted, so a crash while deleting never leaves a half stage. */
export const STAGED_IMPORT_DONE_RE = /^\.import-[0-9a-f]{16}\.done$/;
/** Where the swap moves the files of a still-empty data folder instead of deleting them: <data dir>/import-aside/<stamp>/. */
export const IMPORT_ASIDE_DIR = 'import-aside';
/** Written last into a staging folder: its presence means the stage is complete and verified. */
export const IMPORT_MANIFEST_NAME = 'import-manifest.json';
/** Written into a staging folder right before the first file moves; from then on the swap only moves forward. */
export const IMPORT_SWAPPING_NAME = 'import-swapping';
