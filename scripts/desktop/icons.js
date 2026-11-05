// Regenerates the app icons: the stable set in src-tauri/icons from source.svg, and the Burrow Dev set in
// src-tauri/icons/dev from the same artwork plus an amber DEV badge. Commit the generated files.
// Usage: npm run desktop:icons
//
// The badge is drawn with strokes, not <text>, because the SVG renderer behind `tauri icon` may have no fonts.
// After generating, the mobile and store extras the CLI writes (android/, ios/, Square*.png, StoreLogo.png,
// 64x64.png) are deleted: the bundle only uses 32x32.png, 128x128.png, 128x128@2x.png, icon.icns, icon.ico
// and icon.png.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, runTauri } from './lib.js';

const ICONS_DIR = path.join(ROOT, 'src-tauri', 'icons');
const DEV_DIR = path.join(ICONS_DIR, 'dev');
const BADGE_SIZE = 32;

/**
 * @param {string} svg
 * @returns {{ minX: number, minY: number, size: number }}
 * @throws {Error} when the viewBox is missing or not square
 */
export function readSquareViewBox(svg) {
  const m = /<svg\b[^>]*\sviewBox\s*=\s*["']\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/.exec(svg);
  if (!m) throw new Error('source.svg needs a viewBox attribute');
  const [minX, minY, width, height] = m.slice(1).map(Number);
  if (!(width > 0) || width !== height) throw new Error(`source.svg viewBox must be square (found ${width} x ${height})`);
  return { minX, minY, size: width };
}

/**
 * The source artwork with the DEV badge added just before the closing tag.
 * @param {string} svg
 * @returns {string}
 */
export function withDevBadge(svg) {
  const { minX, minY, size } = readSquareViewBox(svg);
  const end = svg.lastIndexOf('</svg>');
  if (end === -1) throw new Error('source.svg has no closing </svg>');
  const stroke = 'stroke="#1c1917" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"';
  const badge = [
    `  <g transform="translate(${minX} ${minY}) scale(${size / BADGE_SIZE})">`,
    '    <rect x="1" y="19" width="30" height="12" rx="3" fill="#f59e0b"/>',
    `    <path d="M5.5 21.5 V28.5 H8 C10.5 28.5 11.5 27 11.5 25 C11.5 23 10.5 21.5 8 21.5 Z" ${stroke}/>`,
    `    <path d="M19 21.5 H13.5 V28.5 H19 M13.5 25 H18" ${stroke}/>`,
    `    <path d="M21 21.5 L24 28.5 L27 21.5" ${stroke}/>`,
    '  </g>',
    '',
  ].join('\n');
  return `${svg.slice(0, end)}${badge}${svg.slice(end)}`;
}

function removeExtras(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const extra = entry.isDirectory()
      ? entry.name === 'android' || entry.name === 'ios'
      : /^Square.*\.png$/.test(entry.name) || entry.name === 'StoreLogo.png' || entry.name === '64x64.png';
    if (extra) fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

function main() {
  try {
    const sourceFile = path.join(ICONS_DIR, 'source.svg');
    const source = fs.readFileSync(sourceFile, 'utf8');
    readSquareViewBox(source);
    const devSource = withDevBadge(source);

    runTauri(['icon', path.relative(ROOT, sourceFile), '-o', path.relative(ROOT, ICONS_DIR)]);
    fs.mkdirSync(DEV_DIR, { recursive: true });
    const devFile = path.join(DEV_DIR, 'source.svg');
    fs.writeFileSync(devFile, devSource);
    runTauri(['icon', path.relative(ROOT, devFile), '-o', path.relative(ROOT, DEV_DIR)]);

    removeExtras(ICONS_DIR);
    removeExtras(DEV_DIR);
    console.log('icons regenerated: src-tauri/icons and src-tauri/icons/dev');
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
