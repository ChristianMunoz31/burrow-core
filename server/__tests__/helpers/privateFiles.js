// Files that exist in the private repo but are deliberately left out of the public core export
// (.gitattributes export-ignore; docs/adr/0001-open-core-split.md). Tests that read such a file
// guard on it, so they stay fully active in the private repo and are skipped in the public tree.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/** True when the repo-relative path exists in this checkout (always true in the private repo). */
export function hasPrivateFile(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

/** True when every given repo-relative path exists. */
export function hasAllPrivateFiles(...relPaths) {
  return relPaths.every(hasPrivateFile);
}

/** Text of a repo-relative file, or '' when it is absent (for describe-scope reads of a guarded suite). */
export function readPrivateFile(relPath) {
  return hasPrivateFile(relPath) ? fs.readFileSync(path.join(ROOT, relPath), 'utf8') : '';
}
