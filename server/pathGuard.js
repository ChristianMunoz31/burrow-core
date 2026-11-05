// Path identity helpers shared by the startup guards, the stable-copy overlap check and the sandbox
// scripts. A folder is compared by its real location (symlinks and junctions resolved on the deepest
// existing ancestor), case-folded where the file system usually ignores case (Windows and macOS).
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {NodeJS.Platform} platform
 * @returns {typeof path.posix}
 */
export const pathModuleFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

/**
 * Real location of `p`: symlinks and junctions are resolved on the deepest existing ancestor and the
 * missing tail is appended. Only meaningful for the host OS (another platform gets the plain resolve).
 * Never creates or writes anything.
 * @param {string} p
 * @param {typeof path.posix} [mod]
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function canonical(p, mod = path, platform = process.platform) {
  const resolved = mod.resolve(p);
  if (platform !== process.platform) return resolved;
  const tail = [];
  let cur = resolved;
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? mod.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = mod.dirname(cur);
      if (parent === cur) return resolved;
      tail.push(mod.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Lower-cases on Windows and macOS (case-insensitive file systems by default), exact elsewhere.
 * @param {string} p
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export const foldPath = (p, platform = process.platform) => (platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p);

/**
 * True when `child` is the same folder as `parent` or lies inside it (inputs already canonical and folded).
 * @param {string} parent
 * @param {string} child
 * @param {typeof path.posix} mod
 * @returns {boolean}
 */
export function isSameOrInside(parent, child, mod) {
  const rel = mod.relative(parent, child);
  const outside = rel === '..' || rel.startsWith(`..${mod.sep}`) || mod.isAbsolute(rel);
  return rel === '' || !outside;
}

/**
 * True when two folders are the same, or one contains the other, by real location.
 * @param {string} a
 * @param {string} b
 * @param {{ platform?: NodeJS.Platform }} [opts]
 * @returns {boolean}
 */
export function pathsOverlap(a, b, { platform = process.platform } = {}) {
  const mod = pathModuleFor(platform);
  const ca = foldPath(canonical(a, mod, platform), platform);
  const cb = foldPath(canonical(b, mod, platform), platform);
  return isSameOrInside(ca, cb, mod) || isSameOrInside(cb, ca, mod);
}
