// Desktop stdin handshake: first line is exactly 64 lowercase hex chars.
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { readSecretLine } from '../desktop/handshake.js';

const HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

describe('readSecretLine', () => {
  it('returns the 32 secret bytes for a valid line', async () => {
    const s = new PassThrough();
    const p = readSecretLine(s);
    s.write(`${HEX}\n`);
    const secret = await p;
    expect(Buffer.isBuffer(secret)).toBe(true);
    expect(secret.toString('hex')).toBe(HEX);
  });

  it('accepts a line split across chunks and ignores bytes after the newline', async () => {
    const s = new PassThrough();
    const p = readSecretLine(s);
    s.write(HEX.slice(0, 10));
    s.write(`${HEX.slice(10)}\nextra`);
    expect((await p).toString('hex')).toBe(HEX);
  });

  it.each([
    ['uppercase', HEX.toUpperCase()],
    ['short', HEX.slice(0, 62)],
    ['long', `${HEX}00`],
    ['non-hex', `${HEX.slice(0, 63)}g`],
    ['CRLF', `${HEX}\r`],
    ['empty', ''],
  ])('rejects a %s line', async (_name, line) => {
    const s = new PassThrough();
    const p = readSecretLine(s);
    s.write(`${line}\n`);
    await expect(p).rejects.toMatchObject({ code: 'desktop_handshake' });
  });

  it('rejects an oversized line without a newline', async () => {
    const s = new PassThrough();
    const p = readSecretLine(s);
    s.write('a'.repeat(1000));
    await expect(p).rejects.toMatchObject({ code: 'desktop_handshake' });
  });

  it('rejects on EOF before the newline', async () => {
    const s = new PassThrough();
    const p = readSecretLine(s);
    s.write(HEX);
    s.end();
    await expect(p).rejects.toMatchObject({ code: 'desktop_handshake' });
  });

  it('rejects on timeout', async () => {
    const s = new PassThrough();
    await expect(readSecretLine(s, { timeoutMs: 30 })).rejects.toMatchObject({ code: 'desktop_handshake' });
  });

  it('never puts the secret in the error message', async () => {
    const s = new PassThrough();
    const p = readSecretLine(s);
    s.write(`${HEX.toUpperCase()}\n`);
    const err = await p.catch((e) => e);
    expect(String(err.message)).not.toContain(HEX.toUpperCase());
  });

  it('swallows a stream error after the handshake settled (no uncaught exception)', async () => {
    const s = new PassThrough();
    const p = readSecretLine(s);
    s.write(`${HEX}
`);
    await p;
    expect(() => s.emit('error', new Error('boom'))).not.toThrow();
  });
});
