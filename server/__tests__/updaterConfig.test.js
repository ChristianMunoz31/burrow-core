// The Tauri updater config: the release overlay is committed but applied only by buildInstaller.js,
// and no other config (base, Dev) or capability may enable the updater or grant IPC.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const TAURI_DIR = join(process.cwd(), 'src-tauri');
const readJson = (...parts) => JSON.parse(readFileSync(join(TAURI_DIR, ...parts), 'utf8'));
const PLACEHOLDER = 'BURROW_UPDATER_PUBKEY_PLACEHOLDER';

function isMinisignPubkey(value) {
  if (typeof value !== 'string') return false;
  const text = Buffer.from(value, 'base64').toString('utf8');
  const line = text.split(/\r?\n/)[1];
  if (!line) return false;
  const raw = Buffer.from(line.trim(), 'base64');
  return raw.length === 42 && raw.subarray(0, 2).toString('latin1') === 'Ed';
}

describe('tauri.release.conf.json', () => {
  const overlay = readJson('tauri.release.conf.json');

  it('turns on updater artifacts and nothing else in the bundle', () => {
    expect(overlay.bundle).toEqual({ createUpdaterArtifacts: true });
  });

  it('has exactly the designed updater plugin config', () => {
    expect(Object.keys(overlay.plugins)).toEqual(['updater']);
    const updater = overlay.plugins.updater;
    expect(Object.keys(updater).sort()).toEqual(['endpoints', 'pubkey', 'requireSignedVersion', 'windows']);
    expect(updater.endpoints).toEqual([
      'https://github.com/ChristianMunoz31/burrow-releases/releases/latest/download/latest.json',
    ]);
    expect(updater.windows).toEqual({ installMode: 'passive' });
    // The app refuses an update whose manifest version differs from the version signed into the signature (downgrade guard).
    expect(updater.requireSignedVersion).toBe(true);
  });

  it('carries the placeholder or a valid minisign public key, never a private key', () => {
    const { pubkey } = overlay.plugins.updater;
    expect(pubkey === PLACEHOLDER || isMinisignPubkey(pubkey)).toBe(true);
    expect(JSON.stringify(overlay)).not.toMatch(/secret key/i);
  });

  it('recognises a synthetic public key and refuses malformed ones', () => {
    const raw = Buffer.concat([Buffer.from('Ed'), Buffer.alloc(8, 7), Buffer.alloc(32, 9)]);
    const text = `untrusted comment: minisign public key: 0707070707070707\n${raw.toString('base64')}\n`;
    expect(isMinisignPubkey(Buffer.from(text).toString('base64'))).toBe(true);
    expect(isMinisignPubkey(PLACEHOLDER)).toBe(false);
    expect(isMinisignPubkey('')).toBe(false);
    expect(isMinisignPubkey(Buffer.from('untrusted comment: x').toString('base64'))).toBe(false);
  });
});

describe.each(['tauri.conf.json', 'tauri.dev.conf.json'])('%s', (file) => {
  const config = readJson(file);

  it('has no updater plugin config', () => {
    expect(config.plugins?.updater).toBeUndefined();
  });

  it('does not create updater artifacts', () => {
    expect(config.bundle?.createUpdaterArtifacts).toBeUndefined();
  });
});

describe('capabilities/default.json', () => {
  const capability = readJson('capabilities', 'default.json');

  it('still grants no permissions and has no remote entry', () => {
    expect(capability.permissions).toEqual([]);
    expect(capability.remote).toBeUndefined();
    expect(capability.local).toBe(true);
  });
});
