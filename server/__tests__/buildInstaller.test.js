import { afterEach, describe, expect, it, vi } from 'vitest';
// Release paths refuse a checkout without the Pro module (assertProPresent); these fixture roots have none, and
// server/__tests__/proReleaseGuard.test.js covers the refusal itself.
vi.mock('../../scripts/checks/proPresent.js', async (importOriginal) => ({ ...(await importOriginal()), assertProPresent: () => {} }));
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildInstaller, nsisDirFor } from '../../scripts/release/buildInstaller.js';
import { MISSING_SIGNING_MESSAGE, PUBKEY_PLACEHOLDER } from '../../scripts/release/updaterConfig.js';
import { STABLE_ONLY_MESSAGE } from '../../scripts/desktop/build.js';
import { OVERLAY_ROOT_VERSION, makeOverlayRoot, makeTestKey, signTestData, writeDirectShell } from './helpers/updaterSigning.js';

const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.from('fixture installer')]);
const NAME = 'Burrow_0.2.0_x64-setup.exe';
const KEY = 'TAURI_SIGNING_PRIVATE_KEY';
const PASSWORD = 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD';

describe('buildInstaller (injected tauri step, fixture folders)', () => {
  const cleanups = [];
  afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

  const setup = (pubkey) => {
    const made = makeOverlayRoot(pubkey);
    cleanups.push(made.cleanup);
    return made.root;
  };
  /** A step that plays tauri: writes the installer, and the sig when `sig` is given. */
  const tauri = (root, { sig = null, target, extra = [] } = {}) =>
    vi.fn((_file, args) => {
      // The two-phase (updater on) build only bundles in the `tauri bundle` call.
      if (args[1] === 'build' && args.includes('--no-bundle')) return;
      const dir = nsisDirFor(root, target);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, NAME), EXE);
      if (sig !== null) fs.writeFileSync(path.join(dir, `${NAME}.sig`), sig);
      for (const name of extra) fs.writeFileSync(path.join(dir, name), 'x');
    });

  describe('updater off (placeholder key)', () => {
    it('builds as before: no overlay flag, and no signing variable reaches the child even when set', () => {
      const root = setup(PUBKEY_PLACEHOLDER);
      const step = tauri(root);
      const env = { PATH: 'p', [KEY]: 'secret-key', [PASSWORD]: 'secret-pw', TAURI_SIGNING_PRIVATE_KEY_PATH: 'x', TAURI_CONFIG: '{}' };
      const out = buildInstaller({ root, env, step });
      expect(out).toEqual({ installer: path.join(nsisDirFor(root), NAME), sig: null });
      expect(step).toHaveBeenCalledTimes(1);
      const [file, args, opts] = step.mock.calls[0];
      expect(file).toBe(process.execPath);
      expect(args.slice(1)).toEqual(['build', '--bundles', 'nsis']);
      expect(args).not.toContain('--config');
      expect(opts.cwd).toBe(root);
      expect(opts.env.BURROW_CHANNEL).toBe('stable');
      expect(opts.env.PATH).toBe('p');
      expect(opts.env.TAURI_CONFIG).toBeUndefined();
      expect(Object.keys(opts.env).filter((k) => /^TAURI_/i.test(k))).toEqual([]);
    });

    it('works without any overlay file at all', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-bi-none-'));
      cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
      writeDirectShell(root);
      expect(buildInstaller({ root, env: {}, step: tauri(root) }).sig).toBeNull();
    });

    it('refuses a compiled shell that is a Store build or carries no distribution marker, before it returns an installer', () => {
      const exe = (root) => path.join(root, 'src-tauri', 'target', 'release', 'Burrow.exe');
      const root = setup(PUBKEY_PLACEHOLDER);
      fs.writeFileSync(exe(root), Buffer.from('MZ burrow-distribution=store'));
      expect(() => buildInstaller({ root, env: {}, step: tauri(root) })).toThrow(/Microsoft Store build.*Unset BURROW_DISTRIBUTION/);
      fs.writeFileSync(exe(root), Buffer.from('MZ burrow-distribution=direct burrow-distribution=store'));
      expect(() => buildInstaller({ root, env: {}, step: tauri(root) })).toThrow(/Microsoft Store build/);
      fs.writeFileSync(exe(root), Buffer.from('MZ no marker at all'));
      expect(() => buildInstaller({ root, env: {}, step: tauri(root) })).toThrow(/no burrow-distribution=direct marker/);
      fs.rmSync(exe(root));
      expect(() => buildInstaller({ root, env: {}, step: tauri(root) })).toThrow(/tauri did not produce/);
      writeDirectShell(root);
      expect(buildInstaller({ root, env: {}, step: tauri(root) }).sig).toBeNull();
    });

    it('with the updater on the shell is checked after the compile phase too', () => {
      const root = setup(makeTestKey().pubkeyB64);
      fs.writeFileSync(path.join(root, 'src-tauri', 'target', 'release', 'Burrow.exe'), Buffer.from('MZ burrow-distribution=store'));
      const compile = vi.fn();
      expect(() => buildInstaller({ root, env: { PATH: 'p' }, phase: 'build', step: compile })).toThrow(/Microsoft Store build/);
      expect(compile).toHaveBeenCalledTimes(1);
    });

    it('fails when tauri left a .sig behind (a half-enabled build is never published)', () => {
      const root = setup(PUBKEY_PLACEHOLDER);
      expect(() => buildInstaller({ root, env: {}, step: tauri(root, { sig: 'AAAA' }) })).toThrow(/updater is off/);
    });

    it('needs exactly one installer', () => {
      const root = setup(PUBKEY_PLACEHOLDER);
      expect(() => buildInstaller({ root, env: {}, step: vi.fn() })).toThrow(/Expected exactly one \*-setup\.exe/);
      expect(() => buildInstaller({ root, env: {}, step: tauri(root, { extra: ['Burrow_0.2.0_other-setup.exe'] }) })).toThrow(/found: .*other-setup\.exe/);
    });
  });

  describe('updater on (real key)', () => {
    const key = makeTestKey();
    const goodSig = () => signTestData({ key, data: EXE, version: OVERLAY_ROOT_VERSION });
    const signing = () => {
      const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-bi-key-')), 'k.txt');
      cleanups.push(() => fs.rmSync(path.dirname(keyFile), { recursive: true, force: true }));
      fs.writeFileSync(keyFile, 'not a real key');
      return { TAURI_SIGNING_PRIVATE_KEY_PATH: keyFile, [PASSWORD]: 'pw' };
    };

    it('builds in two phases: no signing variable while compiling, the key only on the bundle step', () => {
      const root = setup(key.pubkeyB64);
      const signingEnv = signing();
      const step = tauri(root, { sig: goodSig() });
      const out = buildInstaller({ root, env: { PATH: 'p', ...signingEnv }, step });
      expect(out.sig).toBe(`${out.installer}.sig`);
      expect(step).toHaveBeenCalledTimes(2);
      const [, buildArgs, buildOpts] = step.mock.calls[0];
      const [, bundleArgs, bundleOpts] = step.mock.calls[1];
      expect(buildArgs.slice(1)).toEqual(['build', '--no-bundle', '--config', 'src-tauri/tauri.release.conf.json']);
      expect(bundleArgs.slice(1)).toEqual(['bundle', '--bundles', 'nsis', '--config', 'src-tauri/tauri.release.conf.json']);
      expect(Object.keys(buildOpts.env).filter((k) => /^TAURI_/i.test(k))).toEqual([]);
      expect(JSON.stringify(buildOpts.env)).not.toContain(signingEnv.TAURI_SIGNING_PRIVATE_KEY_PATH);
      expect(bundleOpts.env[KEY]).toBe(signingEnv.TAURI_SIGNING_PRIVATE_KEY_PATH);
      expect(bundleOpts.env[PASSWORD]).toBe('pw');
      expect(bundleOpts.env.TAURI_SIGNING_PRIVATE_KEY_PATH).toBeUndefined();
    });

    it('--phase build compiles with no signing variable and needs none; --phase bundle signs (CI runs them as two steps)', () => {
      const root = setup(key.pubkeyB64);
      const compile = tauri(root);
      expect(buildInstaller({ root, env: { PATH: 'p' }, phase: 'build', step: compile })).toBeNull();
      expect(compile).toHaveBeenCalledTimes(1);
      expect(compile.mock.calls[0][1].slice(1)).toEqual(['build', '--no-bundle', '--config', 'src-tauri/tauri.release.conf.json']);
      expect(Object.keys(compile.mock.calls[0][2].env).filter((k) => /^TAURI_/i.test(k))).toEqual([]);

      const signingEnv = signing();
      const bundle = tauri(root, { sig: goodSig() });
      const out = buildInstaller({ root, env: { PATH: 'p', ...signingEnv }, phase: 'bundle', step: bundle });
      expect(out.sig).toBe(`${out.installer}.sig`);
      expect(bundle).toHaveBeenCalledTimes(1);
      expect(bundle.mock.calls[0][1].slice(1)).toEqual(['bundle', '--bundles', 'nsis', '--config', 'src-tauri/tauri.release.conf.json']);
      expect(bundle.mock.calls[0][2].env[KEY]).toBe(signingEnv.TAURI_SIGNING_PRIVATE_KEY_PATH);
      expect(() => buildInstaller({ root, env: {}, phase: 'bundle', step: tauri(root, { sig: goodSig() }) })).toThrow(MISSING_SIGNING_MESSAGE);
      expect(() => buildInstaller({ root, env: {}, phase: 'nope', step: bundle })).toThrow(/--phase/);
    });

    it('with the updater off, --phase build builds the whole installer and --phase bundle is a no-op', () => {
      const root = setup(PUBKEY_PLACEHOLDER);
      const step = tauri(root);
      expect(buildInstaller({ root, env: {}, phase: 'bundle', step })).toBeNull();
      expect(step).not.toHaveBeenCalled();
      expect(buildInstaller({ root, env: {}, phase: 'build', step }).sig).toBeNull();
      expect(step.mock.calls[0][1].slice(1)).toEqual(['build', '--bundles', 'nsis']);
    });

    it('passes --target to both phases', () => {
      const target = 'aarch64-pc-windows-msvc';
      const root = setup(key.pubkeyB64);
      const step = tauri(root, { sig: goodSig(), target });
      buildInstaller({ root, env: signing(), target, step });
      for (const [, args] of step.mock.calls) expect(args.slice(args.indexOf('--target'))).toEqual(['--target', target]);
    });

    it('fails closed when the signed comment carries no version, or another version (downgrade guard)', () => {
      const root = setup(key.pubkeyB64);
      const env = signing();
      expect(() => buildInstaller({ root, env, step: tauri(root, { sig: signTestData({ key, data: EXE }) }) })).toThrow(/not bound to version 0\.2\.0.*no version/);
      expect(() => buildInstaller({ root, env, step: tauri(root, { sig: signTestData({ key, data: EXE, version: '0.1.9' }) }) })).toThrow(/not bound to version 0\.2\.0.*version 0\.1\.9/);
    });

    it('fails before tauri starts when the key or the password is missing, with the owner message', () => {
      const root = setup(key.pubkeyB64);
      for (const env of [{}, { [KEY]: 'k' }, { [PASSWORD]: 'pw' }, { [KEY]: 'k', [PASSWORD]: '' }]) {
        const step = tauri(root, { sig: goodSig() });
        expect(() => buildInstaller({ root, env, step }), JSON.stringify(Object.keys(env))).toThrow(MISSING_SIGNING_MESSAGE);
        expect(step).not.toHaveBeenCalled();
      }
    });

    it('refuses a key file path inside the repo before tauri starts', () => {
      const root = setup(key.pubkeyB64);
      const inside = path.join(root, 'leaked.txt');
      fs.writeFileSync(inside, 'x');
      const step = tauri(root, { sig: goodSig() });
      expect(() => buildInstaller({ root, env: { TAURI_SIGNING_PRIVATE_KEY_PATH: inside, [PASSWORD]: 'pw' }, step })).toThrow(/inside the repository/);
      expect(step).not.toHaveBeenCalled();
    });

    it('fails closed when the .sig is missing, empty, or does not verify', () => {
      const root = setup(key.pubkeyB64);
      const env = signing();
      expect(() => buildInstaller({ root, env, step: tauri(root) })).toThrow(/exactly .*\.sig/);
      expect(() => buildInstaller({ root, env, step: tauri(root, { sig: '\n' }) })).toThrow(/is empty/);
      expect(() => buildInstaller({ root, env, step: tauri(root, { sig: signTestData({ key: makeTestKey(), data: EXE }) }) })).toThrow(/does not verify against the public key/);
      expect(() => buildInstaller({ root, env, step: tauri(root, { sig: signTestData({ key, data: Buffer.from('other bytes') }) }) })).toThrow(/does not verify/);
    });
  });

  describe('channel and target guards', () => {
    it('refuses a dev channel or a display version before anything runs', () => {
      const root = setup(PUBKEY_PLACEHOLDER);
      for (const env of [{ BURROW_CHANNEL: 'dev' }, { BURROW_DISPLAY_VERSION: '0.2.0-dev.20261007.abc1234' }]) {
        const step = tauri(root);
        expect(() => buildInstaller({ root, env, step })).toThrow(STABLE_ONLY_MESSAGE);
        expect(step).not.toHaveBeenCalled();
      }
    });

    it('allows only the two Windows triples, and looks for the installer under the target folder', () => {
      const root = setup(PUBKEY_PLACEHOLDER);
      for (const target of ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc']) {
        const step = tauri(root, { target });
        const out = buildInstaller({ root, env: {}, target, step });
        expect(out.installer).toBe(path.join(root, 'src-tauri', 'target', target, 'release', 'bundle', 'nsis', NAME));
        const args = step.mock.calls[0][1];
        expect(args.slice(args.indexOf('--target'))).toEqual(['--target', target]);
      }
      for (const target of ['aarch64-apple-darwin', 'x86_64-unknown-linux-gnu', 'x86_64-pc-windows-gnu', 'x86_64-pc-windows-msvc --x', '']) {
        const step = vi.fn();
        expect(() => buildInstaller({ root, env: {}, target, step }), target).toThrow(/is not allowed/);
        expect(step).not.toHaveBeenCalled();
      }
    });
  });
});
