// The one place an inventory `rel_path` becomes a path on disk. A stored row (or an imported one) is never trusted: the path
// must be plain forward-slash segments, and on Windows no segment may be a reserved device name (CON, PRN, AUX, NUL, COM1-9,
// LPT0-9, CONIN$, CONOUT$, with or without an extension) or end in a dot or a space (Windows drops those, so "a." would open "a").
import path from 'node:path';

const RESERVED_DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/** True for a path segment Windows would treat as a device or would normalize to another name. @param {string} seg */
export function isWindowsUnsafeSegment(seg) {
  if (/[. ]$/.test(seg)) return true;
  return RESERVED_DEVICE.test(seg.split('.')[0].replace(/ +$/, ''));
}

/**
 * The path of an inventory row inside the real root, or null for anything that is not a plain relative path.
 * @param {string} rootReal real path of the folder root
 * @param {unknown} relPath the `rel_path` of a folder_files row
 * @param {{ platform?: NodeJS.Platform }} [opts] the Windows-only rules (colon, reserved names, trailing dot or space) apply when `platform` is win32
 * @returns {string | null}
 */
export function absInRoot(rootReal, relPath, { platform = process.platform } = {}) {
  if (typeof relPath !== 'string' || relPath === '') return null;
  const parts = relPath.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\0'))) return null;
  // A backslash is a separator and a colon an alternate data stream or a drive on Windows; elsewhere both are ordinary
  // name characters that the walk lists, so refusing them there would leave those files unreadable for good.
  if (platform === 'win32' && parts.some((p) => p.includes('\\') || p.includes(':') || isWindowsUnsafeSegment(p))) return null;
  return path.join(rootReal, ...parts);
}
