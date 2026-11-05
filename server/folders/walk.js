// Read-only directory walk. Uses lstat only, never follows a link, never opens a file, and never leaves the root:
// every file is also resolved with realpath and checked against the root key. Entries are sorted per folder so the
// order (and therefore what a limit cuts off) is deterministic.
import fs from 'node:fs';
import path from 'node:path';
import { LIMITS, SKIP_DIR_NAMES } from './constants.js';
import { isInsideRoot, nativeRealpath } from './pathSafety.js';

/** @returns {{ dirsScanned: number, dirsSkipped: number, entries: number, limitsHit: Set<string> }} */
export function newWalkMeta() {
  return { dirsScanned: 0, dirsSkipped: 0, entries: 0, limitsHit: new Set() };
}

/** realpath with the native resolver (the same one validateFolderRoot used for the root key). */
export { nativeRealpath };

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const aborted = () => Object.assign(new Error('Aborted'), { name: 'AbortError', aborted: true });

/**
 * @typedef {object} WalkItem
 * @property {'file'|'link'|'skipDir'} type
 * @property {string} relPath Forward-slash path relative to the root.
 * @property {string} absPath
 * @property {import('node:fs').Stats} lstat
 * @property {number} depth
 * @property {boolean} [outside] File whose real location is not inside the root.
 */

/**
 * Walk a folder tree depth first in sorted order.
 * @param {string} rootReal Real path of the root (from validateFolderRoot).
 * @param {{ rootKey: string, signal?: AbortSignal, maxDepth?: number, maxEntries?: number, meta?: ReturnType<typeof newWalkMeta>,
 *   platform?: NodeJS.Platform }} opts `meta` is filled in as the walk goes.
 * @returns {AsyncGenerator<WalkItem, void>}
 */
export async function* walkFolder(rootReal, { rootKey, signal, maxDepth = LIMITS.maxDepth, maxEntries = LIMITS.maxEntries, meta = newWalkMeta(), platform = process.platform } = {}) {
  async function* visit(dirAbs, relDir, depth) {
    if (signal?.aborted) throw aborted();
    // Read the whole folder (bounded by what is left of the entry budget), then sort.
    const names = [];
    const budget = Math.max(0, maxEntries - meta.entries);
    try {
      const dir = await fs.promises.opendir(dirAbs);
      try {
        for await (const dirent of dir) {
          if (names.length >= budget + 1) break;
          names.push(dirent.name);
        }
      } finally {
        await dir.close().catch(() => {});
      }
    } catch (err) {
      // The root must be readable (the caller reports it); a subfolder that is locked, busy or gone is skipped.
      if (depth === 0 || signal?.aborted) throw err;
      meta.dirsSkipped += 1;
      return;
    }
    meta.dirsScanned += 1;
    names.sort(byName);
    for (const name of names) {
      if (signal?.aborted) throw aborted();
      if (meta.entries >= maxEntries) {
        meta.limitsHit.add('max_entries');
        return;
      }
      meta.entries += 1;
      const absPath = path.join(dirAbs, name);
      const relPath = relDir ? `${relDir}/${name}` : name;
      if (relPath.length > LIMITS.maxPathChars) continue;
      let st;
      try {
        st = await fs.promises.lstat(absPath);
      } catch {
        continue;
      }
      const hidden = name.startsWith('.');
      if (st.isSymbolicLink()) {
        if (hidden) continue;
        yield { type: 'link', relPath, absPath, lstat: st, depth };
      } else if (st.isDirectory()) {
        if (hidden || SKIP_DIR_NAMES.has(name.toLowerCase())) {
          meta.dirsSkipped += 1;
          yield { type: 'skipDir', relPath, absPath, lstat: st, depth };
        } else if (depth + 1 > maxDepth) {
          meta.dirsSkipped += 1;
          meta.limitsHit.add('max_depth');
          yield { type: 'skipDir', relPath, absPath, lstat: st, depth };
        } else {
          // Descend only into a folder whose real location is still inside the root (a junction swapped in since lstat).
          const inside = await nativeRealpath(absPath).then(
            (real) => isInsideRoot(rootKey, real, platform),
            () => false,
          );
          if (!inside) {
            meta.dirsSkipped += 1;
            yield { type: 'skipDir', relPath, absPath, lstat: st, depth };
            continue;
          }
          yield* visit(absPath, relPath, depth + 1);
          if (meta.limitsHit.has('max_entries')) return;
        }
      } else if (st.isFile()) {
        if (hidden) continue;
        const outside = await nativeRealpath(absPath).then(
          (real) => !isInsideRoot(rootKey, real, platform),
          () => true,
        );
        yield { type: 'file', relPath, absPath, lstat: st, depth, outside };
      }
      // Sockets, pipes and devices are ignored: they are never opened.
    }
    if (names.length > budget) meta.limitsHit.add('max_entries');
  }
  yield* visit(rootReal, '', 0);
}
