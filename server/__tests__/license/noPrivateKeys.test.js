// Hygiene after the Ed25519 signer was retired (docs/LICENSING.md 11, 20): scripts/checks/noPrivateKeys.js
// still catches PEM private keys, the check chain works without check:devkeys, the gitleaks config has no
// Ed25519 rules, and no code or config still refers to the removed tooling. Positive fixtures are built at
// runtime from a generated key, so this file never holds key material. It is excluded from the check by exact path.
import { describe, expect, it } from 'vitest';
import crypto, { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXCLUDED_FILES, PATTERNS, isCheckedFile, isKeyFileName, scanText } from '../../../scripts/checks/noPrivateKeys.js';
import { hasPrivateFile } from '../helpers/privateFiles.js';
import { makeTestKey, signTestData } from '../helpers/updaterSigning.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(REPO_ROOT, rel));
const kinds = (text) => scanText(text).map((f) => f.kind);

const pair = generateKeyPairSync('ed25519');
const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
const der = pair.privateKey.export({ type: 'pkcs8', format: 'der' });
const jwk = pair.privateKey.export({ format: 'jwk' });

describe('noPrivateKeys still catches PEM', () => {
  it('flags a PEM private key (PKCS8, OpenSSH, EC, RSA and encrypted headers) with its line', () => {
    expect(kinds(`notes\n${pem}`)).toContain('pem-private-key');
    expect(scanText(`x\ny\n${pem}`)[0].line).toBe(3);
    const dash = '-----';
    for (const label of ['OPENSSH PRIVATE KEY', 'EC PRIVATE KEY', 'RSA PRIVATE KEY', 'ENCRYPTED PRIVATE KEY']) {
      expect(kinds(`${dash}BEGIN ${label}${dash}\nabc`)).toContain('pem-private-key');
    }
  });

  it('has the PEM and the updater key patterns only: the Ed25519 DER and JWK patterns are gone', () => {
    expect(PATTERNS.map((p) => p.kind)).toEqual(['pem-private-key', 'minisign-secret-key-header', 'tauri-secret-key-file', 'minisign-secret-key-blob']);
    expect(kinds(`key = "${der.toString('base64')}"`)).toEqual([]);
    expect(kinds(JSON.stringify(jwk))).toEqual([]);
  });

  it('never prints the matched text', () => {
    for (const finding of scanText(pem)) expect(Object.keys(finding).sort()).toEqual(['kind', 'line']);
  });

  it('does not flag public keys', () => {
    expect(scanText(pair.publicKey.export({ type: 'spki', format: 'pem' }))).toEqual([]);
    expect(scanText(pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'))).toEqual([]);
  });

  it('skips only its own file and its test, plus binary files', () => {
    expect([...EXCLUDED_FILES].sort()).toEqual(['scripts/checks/noPrivateKeys.js', 'server/__tests__/license/noPrivateKeys.test.js']);
    expect(isCheckedFile('scripts/checks/noPrivateKeys.js')).toBe(false);
    expect(isCheckedFile('server/__tests__/license/noPrivateKeys.test.js')).toBe(false);
    expect(isCheckedFile('docs/LICENSING.md')).toBe(true);
    expect(isCheckedFile('public/logo.png')).toBe(false);
  });
});

describe('the check chain without the dev key tooling', () => {
  const scripts = JSON.parse(read('package.json')).scripts;

  it('npm run check runs em dash, personal data and private keys and the privacy page check only', () => {
    expect(scripts.check).toBe('npm run check:em-dash && npm run check:personal && npm run check:keys && npm run check:privacy');
    expect(scripts['check:devkeys']).toBeUndefined();
    for (const name of ['check:em-dash', 'check:personal', 'check:keys', 'check:bundle']) expect(scripts[name]).toBeTypeOf('string');
  });

  it('keeps the build-date postbuild hook and its release checks', () => {
    expect(scripts.postbuild).toContain('writeBuildInfo.js');
    expect(exists('scripts/license/writeBuildInfo.js')).toBe(true);
    expect(read('.github/workflows/ci.yml')).not.toMatch(/devkeys|noDevKeys/i);
  });

  // release.yml is private-only (left out of the public core export).
  it.skipIf(!hasPrivateFile('.github/workflows/release.yml'))('keeps the build-date release checks in release.yml', () => {
    const release = read('.github/workflows/release.yml');
    expect(release).toContain('node scripts/license/writeBuildInfo.js --check');
    expect(release).toContain('--check --dist-dir src-tauri/resources/dist');
    expect(release).not.toMatch(/devkeys|noDevKeys/i);
  });

  it('keeps __BURROW_RELEASE_BUILD__ defined by the desktop bundler (channelSeam reads it)', () => {
    expect(read('scripts/desktop/workerBundle.js')).toContain('__BURROW_RELEASE_BUILD__');
    expect(read('server/license/channelSeam.js')).toContain('__BURROW_RELEASE_BUILD__');
  });
});

describe('removed tooling is really gone', () => {
  it('has none of the Ed25519 files', () => {
    for (const rel of [
      'server/license/verify.js',
      'server/license/keys.js',
      'server/license/canonicalize.js',
      'server/license/devKeys.json',
      'scripts/license/genKeys.js',
      'scripts/license/mintLicense.js',
      'scripts/checks/noDevKeys.js',
    ]) {
      expect(exists(rel), rel).toBe(false);
    }
  });

  it('the gitleaks config has no Ed25519 or JWK rules and still extends the default rules', () => {
    const toml = read('.gitleaks.toml');
    expect(toml).not.toMatch(/ed25519|okp|burrow-jwk|pkcs8/i);
    // The one custom rule is the updater signing key rule (minisign and Tauri secret keys).
    expect([...toml.matchAll(/^id = "([^"]+)"/gm)].map((m) => m[1])).toEqual(['burrow-minisign-secret-key']);
    expect(toml.match(/\[\[rules\]\]/g)).toHaveLength(1);
    expect(toml).toContain('useDefault = true');
  });

  it('the dev key lines are gone from .gitattributes and .dockerignore, and the activation file is ignored like the trial and clock files', () => {
    expect(read('.gitattributes')).not.toMatch(/devKeys/);
    expect(read('.dockerignore')).not.toMatch(/devKeys/);
    for (const name of ['license-clock.json', 'license-trial.json', 'license-activation.json']) {
      expect(read('.dockerignore')).toContain(name);
      expect(read('.gitignore')).toContain(name);
    }
  });

  it('no code or config refers to devKeys.json, mintLicense, verifyLicense, genKeys or noDevKeys', () => {
    const roots = ['server', 'scripts', 'src', '.github', '.githooks'];
    const files = ['package.json', '.gitattributes', '.dockerignore', '.gitleaks.toml', '.gitignore', 'server.js'];
    const skip = new Set(['node_modules', 'dist', 'target']);
    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const rel = path.posix.join(dir, entry.name);
        if (entry.isDirectory()) walk(rel);
        else files.push(rel);
      }
    };
    roots.forEach(walk);
    const me = 'server/__tests__/license/noPrivateKeys.test.js';
    const pattern = /devKeys\.json|mintLicense|verifyLicense|genKeys|noDevKeys|check:devkeys/;
    const offenders = files.filter((rel) => rel !== me && isCheckedFile(rel) && pattern.test(read(rel)));
    expect(offenders).toEqual([]);
  });

  it('holds no key material in the licensing sources, tests or config', () => {
    const files = ['.gitleaks.toml', '.gitignore', 'package.json', 'server/licenseRoutes.js'];
    for (const root of ['server/license', 'server/__tests__/license', 'scripts/license', 'scripts/checks']) {
      for (const name of fs.readdirSync(path.join(REPO_ROOT, root), { recursive: true })) {
        const rel = path.posix.join(root, String(name).replaceAll('\\', '/'));
        if (fs.statSync(path.join(REPO_ROOT, rel)).isFile()) files.push(rel);
      }
    }
    for (const rel of files.filter(isCheckedFile)) expect(scanText(read(rel)), rel).toEqual([]);
  });
});

describe('updater signing keys (minisign and Tauri)', () => {
  // Fixtures are assembled at runtime from fragments and a random body: this file never holds key material.
  const comment = 'untrusted comment' + ': ';
  const secretHeader = (tool, encrypted) => `${comment}${tool} ${encrypted ? 'encrypted ' : ''}secret` + ' key';
  const body = (prefix) => prefix + crypto.randomBytes(60).toString('base64').replace(/[^A-Za-z0-9]/g, 'A');
  const b64 = (text) => Buffer.from(text).toString('base64');
  const keyFileText = (tool, encrypted) => `${secretHeader(tool, encrypted)}
${body('RWRTY0Iy')}
`;
  const key = makeTestKey();
  const sig = signTestData({ key, data: Buffer.from('x') });

  it.each([
    ['rsign', true], ['rsign', false], ['minisign', true], ['minisign', false],
  ])('flags the raw secret key file of %s (encrypted: %s)', (tool, encrypted) => {
    expect(kinds(keyFileText(tool, encrypted))).toEqual(expect.arrayContaining(['minisign-secret-key-header', 'minisign-secret-key-blob']));
    expect(scanText(`a
b
${keyFileText(tool, encrypted)}`)[0].line).toBe(3);
  });

  it.each([
    ['rsign', true], ['rsign', false], ['minisign', true], ['minisign', false],
  ])('flags the base64 Tauri key file of %s (encrypted: %s), the form tauri signer generate writes', (tool, encrypted) => {
    const file = b64(keyFileText(tool, encrypted));
    expect(kinds(file)).toContain('tauri-secret-key-file');
    // As an environment variable or JSON value too: the prefix is not anchored.
    expect(kinds(`TAURI_SIGNING_PRIVATE_KEY=${file}`)).toContain('tauri-secret-key-file');
    expect(kinds(JSON.stringify({ k: file }))).toContain('tauri-secret-key-file');
  });

  it('flags the minisign secret key line on its own, both marker forms', () => {
    expect(kinds(`${body('RWRTY0Iy')}
`)).toContain('minisign-secret-key-blob');
    expect(kinds(`${body('RWQAAEIy')}
`)).toContain('minisign-secret-key-blob');
    expect(kinds(`  ${body('RWRTY0Iy')}`)).not.toContain('minisign-secret-key-blob');
    expect(kinds('RWRTY0Iy')).toEqual([]);
  });

  it('never flags the public key, a signature file, or the committed overlay', () => {
    const pubText = Buffer.from(key.pubkeyB64, 'base64').toString('utf8');
    for (const text of [key.pubkeyB64, pubText, `"pubkey": "${key.pubkeyB64}"`, sig, Buffer.from(sig, 'base64').toString('utf8')]) {
      expect(scanText(text), text.slice(0, 30)).toEqual([]);
    }
    const overlay = read('src-tauri/tauri.release.conf.json');
    expect(scanText(overlay)).toEqual([]);
    expect(scanText(read('docs/RELEASING.md'))).toEqual([]);
  });

  it('refuses any tracked file named *.key, whatever its text', () => {
    for (const name of ['burrow-updater.key', 'keys/x.KEY', 'a/b/secrets.key']) expect(isKeyFileName(name), name).toBe(true);
    for (const name of ['burrow-updater.key.pub', 'monkey.ts', 'key.js', 'docs/keys.md', 'a.keyboard']) expect(isKeyFileName(name), name).toBe(false);
    expect(read('.gitignore')).toMatch(/^\*\.key$/m);
    expect(read('.gitignore')).toMatch(/^\.tauri\/$/m);
  });

  it('the gitleaks rule matches the same secret forms and not the public key', () => {
    const toml = read('.gitleaks.toml');
    const regex = /regex = '''(.*)'''/.exec(toml)[1].replace('(?m)', '');
    const re = new RegExp(regex, 'm');
    for (const [tool, encrypted] of [['rsign', true], ['rsign', false], ['minisign', true], ['minisign', false]]) {
      expect(re.test(keyFileText(tool, encrypted)), `raw ${tool} ${encrypted}`).toBe(true);
      expect(re.test(b64(keyFileText(tool, encrypted))), `b64 ${tool} ${encrypted}`).toBe(true);
    }
    expect(re.test(body('RWQAAEIy'))).toBe(true);
    expect(re.test(key.pubkeyB64)).toBe(false);
    expect(re.test(sig)).toBe(false);
  });

  it('the check passes on the whole repo (no key committed)', () => {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
        if (['node_modules', 'dist', 'target', '.git', 'coverage'].includes(entry.name)) continue;
        const rel = path.posix.join(dir, entry.name);
        if (entry.isDirectory()) walk(rel);
        else files.push(rel);
      }
    };
    ['scripts', '.github', 'docs', 'src-tauri/capabilities'].forEach(walk);
    files.push('.gitleaks.toml', '.gitignore', 'package.json', 'CONTRIBUTING.md', 'src-tauri/tauri.release.conf.json');
    for (const rel of files.filter(isCheckedFile)) {
      if (/\.(md|js|mjs|json|yml|toml|ps1|rs|html)$/.test(rel) || !rel.includes('.')) expect(scanText(read(rel)), rel).toEqual([]);
    }
  });
});
