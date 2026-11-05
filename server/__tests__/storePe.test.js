// pe.mjs: the sidecar's dead Authenticode signature is removed from the packaged copy, anything else is left alone.
import { describe, expect, it } from 'vitest';
import { peMachine, peSignature, stripPeSignature } from '../../scripts/release/pe.mjs';

/**
 * A minimal PE32+ image: DOS header, PE header, optional header with `directories` data directories (NumberOfRvaAndSizes)
 * and a section table. The default section's raw data ends at 0x200.
 */
function fakePe({
  machine = 0xaa64,
  sigOffset = 0,
  sigSize = 0,
  total = 0x400,
  checksum = 0x1234,
  directories = 16,
  sections = [{ pointer: 0x100, size: 0x100 }],
  declaredSections = sections.length,
} = {}) {
  const buf = Buffer.alloc(total);
  buf.writeUInt16LE(0x5a4d, 0);
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write('PE\0\0', 0x80, 'latin1');
  buf.writeUInt16LE(machine, 0x84);
  buf.writeUInt16LE(declaredSections, 0x86);
  buf.writeUInt16LE(240, 0x80 + 20);
  const optional = 0x80 + 24;
  buf.writeUInt16LE(0x20b, optional);
  buf.writeUInt32LE(checksum, optional + 64);
  buf.writeUInt32LE(directories, optional + 108);
  sections.forEach((section, i) => {
    const header = optional + 240 + i * 40;
    buf.writeUInt32LE(section.size, header + 16);
    buf.writeUInt32LE(section.pointer, header + 20);
  });
  const security = optional + 112 + 4 * 8;
  buf.writeUInt32LE(sigOffset, security);
  buf.writeUInt32LE(sigSize, security + 4);
  return buf;
}

describe('peMachine', () => {
  it('reads x64, arm64 and other machines, and rejects non-PE data', () => {
    expect(peMachine(fakePe({ machine: 0x8664 }))).toBe('x64');
    expect(peMachine(fakePe({ machine: 0xaa64 }))).toBe('arm64');
    expect(peMachine(fakePe({ machine: 0x14c }))).toBe('other');
    expect(peMachine(Buffer.from('plain text file'))).toBeNull();
  });
});

describe('stripPeSignature', () => {
  it('clears the security directory and the checksum, keeping the file length when data follows the signature', () => {
    const input = fakePe({ sigOffset: 0x200, sigSize: 0x40, total: 0x400 });
    const out = stripPeSignature(input);
    expect(out.stripped).toBe(true);
    expect(peSignature(out.bytes)).toEqual({ offset: 0, size: 0 });
    expect(out.bytes.length).toBe(0x400);
    expect(out.bytes.readUInt32LE(0x80 + 24 + 64)).toBe(0);
    expect(peSignature(input)).toEqual({ offset: 0x200, size: 0x40 });
  });

  it('cuts the certificate table off when it is the end of the file', () => {
    const out = stripPeSignature(fakePe({ sigOffset: 0x300, sigSize: 0x100, total: 0x400 }));
    expect(out.stripped).toBe(true);
    expect(out.bytes.length).toBe(0x300);
  });

  it('keeps the file length when the certificate table overlaps section data, and only clears the directory entry', () => {
    const input = fakePe({ sigOffset: 0x180, sigSize: 0x80, total: 0x200 });
    const out = stripPeSignature(input);
    expect(out.stripped).toBe(true);
    expect(out.bytes.length).toBe(0x200);
    expect(peSignature(out.bytes)).toEqual({ offset: 0, size: 0 });
    expect(out.bytes.readUInt32LE(0x80 + 24 + 64)).toBe(0);
  });

  it('keeps the file length when the certificate table runs past the end of the file', () => {
    const out = stripPeSignature(fakePe({ sigOffset: 0x300, sigSize: 0x200, total: 0x400 }));
    expect(out.stripped).toBe(true);
    expect(out.bytes.length).toBe(0x400);
    expect(peSignature(out.bytes)).toEqual({ offset: 0, size: 0 });
  });

  it('keeps the file length when data follows the certificate table, and when the section table does not fit', () => {
    expect(stripPeSignature(fakePe({ sigOffset: 0x300, sigSize: 0x40, total: 0x400 })).bytes.length).toBe(0x400);
    const lying = stripPeSignature(fakePe({ sigOffset: 0x300, sigSize: 0x100, total: 0x400, declaredSections: 60000 }));
    expect(lying.stripped).toBe(true);
    expect(lying.bytes.length).toBe(0x400);
  });

  it('uses the last section by raw data end, wherever it sits in the table', () => {
    const sections = [{ pointer: 0x300, size: 0x80 }, { pointer: 0x100, size: 0x100 }];
    expect(stripPeSignature(fakePe({ sections, sigOffset: 0x300, sigSize: 0x100, total: 0x400 })).bytes.length).toBe(0x400);
    expect(stripPeSignature(fakePe({ sections, sigOffset: 0x380, sigSize: 0x80, total: 0x400 })).bytes.length).toBe(0x380);
  });

  it('leaves the file unchanged when it has no Security data directory (NumberOfRvaAndSizes of 4 or less)', () => {
    for (const directories of [0, 1, 4]) {
      const input = fakePe({ directories, sigOffset: 0x300, sigSize: 0x100, total: 0x400 });
      const out = stripPeSignature(input);
      expect(out.stripped, `directories=${directories}`).toBe(false);
      expect(out.bytes.equals(input)).toBe(true);
    }
    expect(stripPeSignature(fakePe({ directories: 5, sigOffset: 0x300, sigSize: 0x100, total: 0x400 })).stripped).toBe(true);
  });

  it('leaves unsigned executables and other files untouched', () => {
    const unsigned = fakePe();
    expect(stripPeSignature(unsigned)).toEqual({ bytes: unsigned, stripped: false });
    const text = Buffer.from('sidecar');
    expect(stripPeSignature(text)).toEqual({ bytes: text, stripped: false });
    expect(peSignature(text)).toBeNull();
  });

  it('survives a truncated header', () => {
    const short = fakePe().subarray(0, 0x90);
    expect(stripPeSignature(short).stripped).toBe(false);
  });
});

describe('stageLayout and the sidecar signature', () => {
  it('writes the sidecar into the package without its dead signature', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { REQUIRED_ASSETS, stageLayout } = await import('../../scripts/release/storeLayout.mjs');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-store-pe-'));
    try {
      const dist = path.join(tmp, 'dist');
      const migrations = path.join(tmp, 'migrations');
      const assets = path.join(tmp, 'assets');
      for (const dir of [dist, migrations, assets]) fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dist, 'index.html'), '<html></html>');
      fs.writeFileSync(path.join(migrations, '001.sql'), 'select 1;');
      for (const name of REQUIRED_ASSETS) fs.writeFileSync(path.join(assets, name), 'png');
      fs.writeFileSync(path.join(tmp, 'Burrow.exe'), 'exe');
      fs.writeFileSync(path.join(tmp, 'sidecar.exe'), fakePe({ sigOffset: 0x200, sigSize: 0x40 }));
      stageLayout({
        stageDir: path.join(tmp, 'stage'),
        exe: path.join(tmp, 'Burrow.exe'),
        sidecar: path.join(tmp, 'sidecar.exe'),
        distDir: dist,
        migrationsDir: migrations,
        assetsDir: assets,
        manifestXml: '<Package/>',
      });
      const staged = fs.readFileSync(path.join(tmp, 'stage', 'burrow-server.exe'));
      expect(peSignature(staged)).toEqual({ offset: 0, size: 0 });
      expect(peSignature(fs.readFileSync(path.join(tmp, 'sidecar.exe'))).size).toBe(0x40);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
