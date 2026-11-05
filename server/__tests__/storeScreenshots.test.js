import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HEIGHT,
  SHOTS,
  WIDTH,
  assertPngSize,
  assertTempDataDir,
  captionOverlay,
  isAllowedRequest,
  pngSize,
  screenshotsDir,
  variantFiles,
} from '../../scripts/store/screenshotLib.mjs';

function png(width, height) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe('store screenshot helpers', () => {
  it('lists six shots with unique names, both themes and clean captions', () => {
    expect(SHOTS).toHaveLength(6);
    expect(new Set(SHOTS.map((s) => s.name)).size).toBe(6);
    expect(new Set(SHOTS.map((s) => s.theme))).toEqual(new Set(['light', 'dark']));
    for (const s of SHOTS) {
      expect(s.caption.length).toBeLessThanOrEqual(60);
      expect(s.caption).not.toMatch(/[\u2014\u2013]|AI service|cloud/i);
      expect(() => captionOverlay(s.caption)).not.toThrow();
    }
  });

  it('names the plain and captioned variants', () => {
    expect(variantFiles({ name: '01-home' })).toEqual({ plain: '01-home.png', caption: '01-home-caption.png' });
  });

  it('writes outside the repo under LOCALAPPDATA', () => {
    expect(screenshotsDir({ env: { LOCALAPPDATA: 'local-root' }, home: 'home-dir' })).toBe(path.join('local-root', 'burrow-release', 'store', 'screenshots'));
    expect(screenshotsDir({ env: {}, home: path.join('x', 'h') })).toBe(path.join('x', 'h', 'AppData', 'Local', 'burrow-release', 'store', 'screenshots'));
  });

  it('accepts a temp data dir and refuses anything else', () => {
    expect(() => assertTempDataDir(path.join(os.tmpdir(), 'burrow-e2e-x', 'data'))).not.toThrow();
    expect(() => assertTempDataDir(path.join(os.homedir(), 'Documents', 'data'))).toThrow(/temp/i);
    expect(() => assertTempDataDir(path.join(process.env.APPDATA ?? os.homedir(), 'Burrow'))).toThrow();
  });

  it('escapes caption text, rejects empty text and em dashes', () => {
    expect(captionOverlay('A <b> & "c"').html).toContain('A &lt;b&gt; &amp; &quot;c&quot;');
    expect(() => captionOverlay('  ')).toThrow();
    expect(() => captionOverlay('one \u2014 two')).toThrow(/dash/);
  });

  it('keeps the caption band narrower than the page and off the Javi bar corner', () => {
    const { css } = captionOverlay('x');
    expect(css).toContain('left:50%');
    expect(Number(/max-width:(\d+)px/.exec(css)[1])).toBeLessThan(WIDTH - 2 * 120);
  });

  it('allows only the sandbox origin, data and blob URLs', () => {
    const origin = 'http://127.0.0.1:5000';
    expect(isAllowedRequest('http://127.0.0.1:5000/api/x', origin)).toBe(true);
    expect(isAllowedRequest('data:image/png;base64,AA', origin)).toBe(true);
    expect(isAllowedRequest('https://fonts.example.com/a.css', origin)).toBe(false);
    expect(isAllowedRequest('http://127.0.0.1:11434/api', origin)).toBe(false);
    expect(isAllowedRequest('not a url', origin)).toBe(false);
  });

  it('reads PNG sizes and enforces 1920x1080', () => {
    expect(pngSize(png(5, 6))).toEqual({ width: 5, height: 6 });
    expect(() => assertPngSize(png(WIDTH, HEIGHT))).not.toThrow();
    expect(() => assertPngSize(png(1280, 720))).toThrow(/1280x720/);
    expect(() => pngSize(Buffer.from('nope'))).toThrow(/PNG/);
  });
});
