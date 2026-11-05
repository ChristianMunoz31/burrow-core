// Regenerates the NSIS installer artwork from the app icon: a 164x314 sidebar (Welcome and Finish pages) and a
// 150x57 header for Burrow (src-tauri/installer/) and Burrow Dev (src-tauri/installer/dev/, with the DEV badge).
// Commit the generated files. Usage: npm run desktop:installer-images (run npm run desktop:icons first when the
// icon changes).
//
// NSIS needs uncompressed 24-bit BMPs. The images are drawn in headless Chromium (Playwright, already a dev
// dependency) on a canvas, and the pixels are written as BMP here, so no image library is needed.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib.js';
import { withDevBadge } from './icons.js';

const ICONS_DIR = path.join(ROOT, 'src-tauri', 'icons');
const OUT_DIR = path.join(ROOT, 'src-tauri', 'installer');

export const SIDEBAR = { width: 164, height: 314 };
export const HEADER = { width: 150, height: 57 };

/**
 * Uncompressed bottom-up 24-bit BMP from RGBA pixels (alpha ignored; the canvas is opaque).
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array | number[]} rgba row-major, top row first, 4 bytes per pixel
 * @returns {Buffer}
 */
export function encodeBmp24(width, height, rgba) {
  if (rgba.length !== width * height * 4) throw new Error('pixel data does not match the image size');
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const dataSize = rowSize * height;
  const buf = Buffer.alloc(54 + dataSize);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(54 + dataSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(dataSize, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const rowStart = 54 + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const o = rowStart + x * 3;
      buf[o] = rgba[i + 2];
      buf[o + 1] = rgba[i + 1];
      buf[o + 2] = rgba[i];
    }
  }
  return buf;
}

/**
 * HTML for one installer image. The icon SVG is inlined as a data URL; the wordmark uses the system UI font.
 * @param {'sidebar' | 'header'} kind
 * @param {string} iconSvg
 * @param {{ dev: boolean }} opts
 */
export function pageFor(kind, iconSvg, { dev }) {
  const icon = `data:image/svg+xml;base64,${Buffer.from(iconSvg).toString('base64')}`;
  const name = dev ? 'Burrow Dev' : 'Burrow';
  if (kind === 'header') {
    return `<!doctype html><html><body style="margin:0">
<div id="art" style="width:${HEADER.width}px;height:${HEADER.height}px;background:#fff;display:flex;align-items:center;gap:8px;padding-left:8px;box-sizing:border-box;font-family:'Segoe UI',system-ui,sans-serif">
  <img src="${icon}" width="38" height="38" alt="">
  <span style="font-size:${dev ? 15 : 19}px;font-weight:600;color:#2e1065;letter-spacing:-0.2px">${name}</span>
</div></body></html>`;
  }
  const tagline = dev ? 'Test build. Installs next to Burrow.' : 'Private. Local. Yours.';
  return `<!doctype html><html><body style="margin:0">
<div id="art" style="position:relative;width:${SIDEBAR.width}px;height:${SIDEBAR.height}px;overflow:hidden;background:linear-gradient(160deg,#8b5cf6 0%,#6d28d9 55%,#4c1d95 100%);font-family:'Segoe UI',system-ui,sans-serif;color:#f5f3ff;text-align:center">
  <img src="${icon}" width="84" height="84" alt="" style="position:absolute;left:40px;top:48px;border-radius:18px;box-shadow:0 6px 18px rgba(46,16,101,.45)">
  <div style="position:absolute;left:0;right:0;top:146px;font-size:${dev ? 21 : 26}px;font-weight:600;letter-spacing:-0.3px">${name}</div>
  <div style="position:absolute;left:12px;right:12px;top:${dev ? 176 : 182}px;font-size:11.5px;line-height:1.35;color:#ddd6fe">${tagline}</div>
  <svg width="${SIDEBAR.width}" height="70" viewBox="0 0 164 70" style="position:absolute;left:0;bottom:0">
    <path d="M-6 70 C14 30 52 16 82 16 C112 16 150 30 170 70 Z" fill="#f5f3ff" opacity=".14"/>
    <path d="M60 70 C60 50 69 40 82 40 C95 40 104 50 104 70 Z" fill="#2e1065" opacity=".55"/>
  </svg>
</div></body></html>`;
}

async function render(page, html, size) {
  await page.setContent(html);
  await page.waitForFunction(() => [...document.images].every((img) => img.complete));
  // Rasterize through the screenshot, then read the pixels back on a canvas for an exact RGBA buffer.
  const png = await page.locator('#art').screenshot({ type: 'png' });
  const pixels = await page.evaluate(
    async ({ b64, width, height }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      return Array.from(ctx.getImageData(0, 0, width, height).data);
    },
    { b64: png.toString('base64'), ...size },
  );
  return encodeBmp24(size.width, size.height, pixels);
}

async function main() {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const source = fs.readFileSync(path.join(ICONS_DIR, 'source.svg'), 'utf8');
    for (const dev of [false, true]) {
      const svg = dev ? withDevBadge(source) : source;
      const dir = dev ? path.join(OUT_DIR, 'dev') : OUT_DIR;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'sidebar.bmp'), await render(page, pageFor('sidebar', svg, { dev }), SIDEBAR));
      fs.writeFileSync(path.join(dir, 'header.bmp'), await render(page, pageFor('header', svg, { dev }), HEADER));
    }
    console.log('installer images regenerated: src-tauri/installer and src-tauri/installer/dev');
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
