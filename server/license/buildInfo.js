// Build date of this artifact. Read once at init, never from the user's clock.
/* global __BURROW_BUILD_DATE__ */
import fs from 'node:fs';
import path from 'node:path';
import { BUILD_INFO_FILE, formatLicenseDate, parseLicenseDate } from './constants.js';

// The sidecar bundler bakes the date in via the esbuild `__BURROW_BUILD_DATE__` define (scripts/desktop/workerBundle.js).
const BUNDLED_BUILD_DATE = typeof __BURROW_BUILD_DATE__ === 'string' ? __BURROW_BUILD_DATE__ : undefined;

const MAX_INFO_BYTES = 1024;
const SOURCES = new Set(['env', 'git', 'clock']);

/** Reads at most MAX_INFO_BYTES + 1 bytes so an oversized file is detected without loading it. */
function readCapped(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(MAX_INFO_BYTES + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

const missing = () => ({ buildDate: null, buildDateIso: null, source: 'missing', version: null });

/**
 * @param {{ distDir: string, bundled?: string, readFile?: (file: string) => string }} opts
 * @returns {{ buildDate: number | null, buildDateIso: string | null, source: 'bundled' | 'env' | 'git' | 'clock' | 'missing', version: string | null }}
 */
export function loadBuildInfo({ distDir, bundled = BUNDLED_BUILD_DATE, readFile = readCapped }) {
  const bundledMs = parseLicenseDate(bundled);
  if (bundledMs !== null) {
    return { buildDate: bundledMs, buildDateIso: formatLicenseDate(bundledMs), source: 'bundled', version: null };
  }
  try {
    const text = readFile(path.join(distDir, BUILD_INFO_FILE));
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_INFO_BYTES) throw new Error('size');
    const info = JSON.parse(text);
    const ms = parseLicenseDate(info?.buildDate);
    if (info?.formatVersion !== 1 || ms === null || !SOURCES.has(info.source) || typeof info.version !== 'string') {
      throw new Error('shape');
    }
    return { buildDate: ms, buildDateIso: info.buildDate, source: info.source, version: info.version };
  } catch (err) {
    if (err?.code !== 'ENOENT') console.warn('license: build info ignored (unreadable)');
    return missing();
  }
}
