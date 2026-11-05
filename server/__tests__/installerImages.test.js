import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { encodeBmp24, HEADER, SIDEBAR } from '../../scripts/desktop/installerImages.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

function bmpInfo(buf) {
  return {
    magic: buf.toString('ascii', 0, 2),
    fileSize: buf.readUInt32LE(2),
    width: buf.readInt32LE(18),
    height: buf.readInt32LE(22),
    bitCount: buf.readUInt16LE(28),
    compression: buf.readUInt32LE(30),
  };
}

describe('encodeBmp24', () => {
  it('writes a bottom-up 24-bit BMP with padded BGR rows', () => {
    // 2x2: top row red, green; bottom row blue, white.
    const rgba = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255];
    const buf = encodeBmp24(2, 2, rgba);
    expect(bmpInfo(buf)).toEqual({ magic: 'BM', fileSize: 54 + 16, width: 2, height: 2, bitCount: 24, compression: 0 });
    // First stored row is the bottom row: blue then white, padded to 8 bytes.
    expect([...buf.subarray(54, 62)]).toEqual([255, 0, 0, 255, 255, 255, 0, 0]);
    expect([...buf.subarray(62, 70)]).toEqual([0, 0, 255, 0, 255, 0, 0, 0]);
  });

  it('refuses pixel data of the wrong length', () => {
    expect(() => encodeBmp24(2, 2, [0, 0, 0, 255])).toThrow(/does not match/);
  });
});

describe('committed installer artwork', () => {
  const channels = [
    { conf: 'src-tauri/tauri.conf.json', dir: 'src-tauri/installer' },
    { conf: 'src-tauri/tauri.dev.conf.json', dir: 'src-tauri/installer/dev' },
  ];

  it.each(channels)('$conf points at the $dir images and its own icon', ({ conf, dir }) => {
    const nsis = readJson(conf).bundle.windows.nsis;
    expect(path.posix.join('src-tauri', nsis.headerImage)).toBe(`${dir}/header.bmp`);
    expect(path.posix.join('src-tauri', nsis.sidebarImage)).toBe(`${dir}/sidebar.bmp`);
    expect(fs.existsSync(path.join(ROOT, 'src-tauri', nsis.installerIcon))).toBe(true);
  });

  it.each(channels)('$dir holds uncompressed 24-bit BMPs at the NSIS sizes', ({ dir }) => {
    for (const [file, size] of [['header.bmp', HEADER], ['sidebar.bmp', SIDEBAR]]) {
      const info = bmpInfo(fs.readFileSync(path.join(ROOT, dir, file)));
      expect({ file, ...info }).toMatchObject({ file, magic: 'BM', bitCount: 24, compression: 0, ...size });
    }
  });
});
