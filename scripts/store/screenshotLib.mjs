// Pure helpers for scripts/store/screenshots.mjs: the shot list, the output folder, the caption
// overlay and the PNG size check. No browser, no server, no file writes, so they are unit tested.
import os from 'node:os';
import path from 'node:path';
import { SandboxSafetyError, assertSafeDataDir } from '../lib/sandboxSafety.js';

export const WIDTH = 1920;
export const HEIGHT = 1080;

/**
 * The six Store screenshots in order. `theme` is the prefers-color-scheme the app follows.
 * Captions are benefit-led, honest and free of em dashes (docs/PRODUCT.md copy rules).
 */
export const SHOTS = Object.freeze([
  { name: '01-home', theme: 'dark', url: '/', heading: 'Overview', caption: 'Budget, journal and more, on your PC. No account.' },
  { name: '02-javi', theme: 'light', url: '/budget', heading: 'Budget', caption: 'Get a quick insight on each page. Burrow does the math.', javi: true },
  { name: '03-planner', theme: 'dark', url: '/budget/planner', heading: 'Budget', caption: 'Plan your month with budgets for every category.' },
  { name: '04-journal', theme: 'light', url: '/journal', heading: 'Journal', caption: 'A private journal that stays on your PC.' },
  { name: '05-calendar', theme: 'dark', url: '/calendar', heading: 'Calendar', caption: 'Your calendar and events, saved on your PC.' },
  { name: '06-network', theme: 'light', url: '/settings#network', heading: 'Settings', caption: 'Online features stay off until you turn them on.', section: '#network' },
]);

/** File names (without folder) of the plain and captioned variant of a shot. */
export const variantFiles = (shot) => ({ plain: `${shot.name}.png`, caption: `${shot.name}-caption.png` });

/**
 * The folder the PNGs go to: outside the repo, next to the other Store release output.
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [opts]
 * @returns {string}
 */
export function screenshotsDir({ env = process.env, home = os.homedir() } = {}) {
  const base = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return path.join(base, 'burrow-release', 'store', 'screenshots');
}

/**
 * Throws unless the temp data dir passes the sandbox guard (inside the OS temp dir, never the real
 * Burrow data dir). Returns the resolved directory.
 * @param {string} dir
 * @param {Parameters<typeof assertSafeDataDir>[1]} [opts]
 * @returns {string}
 */
export function assertTempDataDir(dir, opts) {
  return assertSafeDataDir(dir, opts);
}

/**
 * Whether a request URL may leave the browser: only the sandbox server origin, data: and blob:.
 * @param {string} url
 * @param {string} origin e.g. `http://127.0.0.1:5000`
 * @returns {boolean}
 */
export function isAllowedRequest(url, origin) {
  if (url.startsWith('data:') || url.startsWith('blob:')) return true;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * The width and height of a PNG buffer, read from its IHDR chunk.
 * @param {Buffer} buf
 * @returns {{ width: number, height: number }}
 */
export function pngSize(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!buf || buf.length < 24 || sig.some((b, i) => buf[i] !== b)) throw new Error('Not a PNG file.');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Throws unless the PNG is exactly 1920x1080. */
export function assertPngSize(buf, label = 'screenshot') {
  const { width, height } = pngSize(buf);
  if (width !== WIDTH || height !== HEIGHT) throw new Error(`${label} is ${width}x${height}, expected ${WIDTH}x${HEIGHT}.`);
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * Caption band layout: a rounded band centered near the bottom, narrower than the page so it keeps
 * clear of the Javi bar at the bottom right, in the brand purple (matches the ad creatives).
 * @param {string} text
 * @returns {{ html: string, css: string }}
 */
export function captionOverlay(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('A caption needs text.');
  if (/[—–]/.test(text)) throw new Error('Captions must not contain dashes like an em dash.');
  const css = `
#store-caption{position:fixed;left:50%;bottom:36px;transform:translateX(-50%);z-index:2147483647;
 display:flex;align-items:center;justify-content:center;max-width:1240px;padding:18px 44px;border-radius:22px;
 background:linear-gradient(160deg,rgba(52,26,116,.96),rgba(34,10,82,.96));border:1px solid rgba(255,255,255,.22);
 box-shadow:0 18px 48px rgba(10,2,40,.5);color:#f5f3ff;font:600 40px/1.15 Inter,'Segoe UI',sans-serif;letter-spacing:-.01em;
 white-space:nowrap;pointer-events:none}`;
  return { css, html: `<div id="store-caption" role="presentation">${escapeHtml(text)}</div>` };
}

export { SandboxSafetyError };
