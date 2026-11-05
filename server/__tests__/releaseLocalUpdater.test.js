// release:local with the in-app updater ON (a real public key in the overlay). Keys and signatures are synthetic and
// made in memory. The updater-off behavior is covered, unchanged, by releaseLocal.test.js.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Release paths refuse a checkout without the Pro module (assertProPresent); these fixture roots have none, and
// server/__tests__/proReleaseGuard.test.js covers the refusal itself.
vi.mock('../../scripts/checks/proPresent.js', async (importOriginal) => ({ ...(await importOriginal()), assertProPresent: () => {} }));
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildManifest,
  checkInstallerNames,
  formatSums,
  manifestProblems,
  runRelease,
} from '../../scripts/release/releaseLocal.mjs';
import { MISSING_SIGNING_MESSAGE } from '../../scripts/release/updaterConfig.js';
import { makeOverlayRoot, makeTestKey, signTestData } from './helpers/updaterSigning.js';

const HEAD = 'c0ffee0'.padEnd(40, '1');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const H = (c) => c.repeat(64);
const X64 = Buffer.concat([Buffer.from('MZ'), Buffer.from('x64 fixture')]);
const ARM = Buffer.concat([Buffer.from('MZ'), Buffer.from('arm64 fixture')]);
const NAMES = {
  x64: 'Burrow-Setup-x64.exe', arm64: 'Burrow-Setup-arm64.exe', sigX64: 'Burrow-Setup-x64.exe.sig', sigArm: 'Burrow-Setup-arm64.exe.sig',
};

describe('SHA256SUMS and names with the updater on', () => {
  it('formatSums writes five lines in the documented order', () => {
    const entries = [
      { name: 'latest.json', sha256: H('e') }, { name: NAMES.sigArm, sha256: H('d') }, { name: NAMES.sigX64, sha256: H('c') },
      { name: NAMES.arm64, sha256: H('b') }, { name: NAMES.x64, sha256: H('a') },
    ];
    expect(formatSums(entries, { updater: true })).toBe(
      `${H('a')}  ${NAMES.x64}\n${H('b')}  ${NAMES.arm64}\n${H('c')}  ${NAMES.sigX64}\n${H('d')}  ${NAMES.sigArm}\n${H('e')}  latest.json\n`,
    );
  });

  it('formatSums with the updater off still writes two lines and refuses the extras', () => {
    expect(formatSums([{ name: NAMES.x64, sha256: H('a') }, { name: NAMES.arm64, sha256: H('b') }])).toBe(`${H('a')}  ${NAMES.x64}\n${H('b')}  ${NAMES.arm64}\n`);
    expect(() => formatSums([{ name: NAMES.x64, sha256: H('a') }, { name: NAMES.arm64, sha256: H('b') }, { name: NAMES.sigX64, sha256: H('c') }])).toThrow(/Only the two installers/);
  });

  it('formatSums with the updater on needs every line', () => {
    expect(() => formatSums([{ name: NAMES.x64, sha256: H('a') }, { name: NAMES.arm64, sha256: H('b') }], { updater: true })).toThrow(/No valid sha256 for Burrow-Setup-x64\.exe\.sig/);
  });

  it('checkInstallerNames accepts the sig files only when the updater is on', () => {
    const all = [NAMES.x64, NAMES.arm64, NAMES.sigX64, NAMES.sigArm];
    expect(() => checkInstallerNames(all, { updater: true })).not.toThrow();
    expect(() => checkInstallerNames(all)).toThrow(/Unexpected file\(s\).*\.sig/);
    expect(() => checkInstallerNames([NAMES.x64, NAMES.arm64], { updater: true })).toThrow(/Missing installer\(s\): .*\.sig/);
  });

  it('the build manifest covers the signatures', () => {
    const installers = [
      { name: NAMES.x64, arch: 'x64', originalName: 'o64', sha256: H('a'), source: 's', sig: { name: NAMES.sigX64, sha256: H('c') } },
      { name: NAMES.arm64, arch: 'arm64', originalName: 'oarm', sha256: H('b'), source: 's', sig: { name: NAMES.sigArm, sha256: H('d') } },
    ];
    const m = buildManifest({ commit: HEAD, version: '0.2.0', tag: 'v0.2.0', installers });
    expect(m.installers.x64.sig).toEqual({ name: NAMES.sigX64, sha256: H('c') });
    const hashes = [
      { name: NAMES.x64, sha256: H('a') }, { name: NAMES.arm64, sha256: H('b') },
      { name: NAMES.sigX64, sha256: H('c') }, { name: NAMES.sigArm, sha256: H('d') },
    ];
    expect(manifestProblems(m, { commit: HEAD, version: '0.2.0', hashes })).toEqual([]);
    const swapped = hashes.map((h) => (h.name === NAMES.sigArm ? { ...h, sha256: H('f') } : h));
    expect(manifestProblems(m, { commit: HEAD, version: '0.2.0', hashes: swapped })).toEqual([`${NAMES.sigArm} is not the file that was built (sha256 differs from build-manifest.json)`]);
    expect(manifestProblems(m, { commit: HEAD, version: '0.2.0', hashes: swapped, skip: [NAMES.sigArm] })).toEqual([]);
    const noSig = buildManifest({ commit: HEAD, version: '0.2.0', tag: 'v0.2.0', installers: installers.map((i) => ({ name: i.name, arch: i.arch, originalName: i.originalName, sha256: i.sha256, source: i.source })) });
    expect(manifestProblems(noSig, { commit: HEAD, version: '0.2.0', hashes })[0]).toMatch(/no entry for Burrow-Setup-x64\.exe\.sig/);
  });
});

describe('runRelease with the updater on (fixtures, stubbed git, gh and build)', () => {
  const key = makeTestKey();
  const SIG_X64 = signTestData({ key, data: X64, version: '0.2.0' });
  const SIG_ARM = signTestData({ key, data: ARM, version: '0.2.0' });
  let root;
  let overlayCleanup;
  let outDir;
  let publicDir;
  let calls;

  function makeExec(over = {}) {
    return vi.fn(async (file, args, opts) => {
      calls.push([file, ...args]);
      const k = `${file} ${args.slice(0, 2).join(' ')}`;
      if (over[k]) return over[k](args, opts);
      if (k === 'git status --porcelain') return { stdout: '', stderr: '' };
      if (k === 'git rev-parse HEAD') return { stdout: `${HEAD}\n`, stderr: '' };
      if (k === 'git log -1') return { stdout: '1700000000\n', stderr: '' };
      if (k.startsWith('gh api repos/ChristianMunoz31/burrow/git/ref/tags/')) return { stdout: JSON.stringify({ object: { type: 'commit', sha: HEAD } }), stderr: '' };
      if (k === 'gh auth token') return { stdout: 'fake-token\n', stderr: '' };
      throw new Error(`unexpected call: ${file} ${args.join(' ')}`);
    });
  }
  const stageArm = () => {
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(path.join(publicDir, NAMES.arm64), ARM);
    fs.writeFileSync(path.join(publicDir, NAMES.sigArm), SIG_ARM);
  };
  const stageAll = () => {
    stageArm();
    fs.writeFileSync(path.join(publicDir, NAMES.x64), X64);
    fs.writeFileSync(path.join(publicDir, NAMES.sigX64), SIG_X64);
  };
  const opts = (extra = {}) => ({ tag: null, publish: false, dryRun: true, yes: false, skipBuild: true, x64FromCi: null, x64File: null, outDir, help: false, ...extra });
  const run = (o, deps = {}) => {
    const publishFn = vi.fn(async () => ({}));
    const lines = [];
    const p = runRelease(o, { root, env: {}, exec: makeExec(), log: (l) => lines.push(l), publishFn, channelRun: () => 0, peVersion: async () => null, ...deps });
    return { p, publishFn, lines };
  };

  beforeEach(() => {
    const made = makeOverlayRoot(key.pubkeyB64);
    root = made.root;
    overlayCleanup = made.cleanup;
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-rlu-out-'));
    publicDir = path.join(outDir, 'public');
    calls = [];
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.2.0' }));
    fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\n## [0.2.0](x) (2026-10-05)\n\n### Features\n\n* add dark mode\n');
  });
  afterEach(() => {
    overlayCleanup();
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it('a --skip-build dry run writes latest.json, five-line sums, and hands publish the updater state', async () => {
    stageAll();
    const { p, publishFn } = run(opts());
    await p;
    const sums = fs.readFileSync(path.join(publicDir, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
    expect(sums.map((l) => l.split('  ')[1])).toEqual([NAMES.x64, NAMES.arm64, NAMES.sigX64, NAMES.sigArm, 'latest.json']);
    const latest = JSON.parse(fs.readFileSync(path.join(publicDir, 'latest.json'), 'utf8'));
    expect(latest).toMatchObject({ version: '0.2.0', notes: 'New:\n- Add dark mode' });
    expect(latest.platforms['windows-x86_64'].signature).toBe(SIG_X64);
    expect(latest.platforms['windows-aarch64'].signature).toBe(SIG_ARM);
    expect(sums[4].split('  ')[0]).toBe(sha(fs.readFileSync(path.join(publicDir, 'latest.json'))));
    expect(publishFn.mock.calls[0][0]).toMatchObject({ dryRun: true, root, updater: { enabled: true, pubkey: key.pubkeyB64 } });
  });

  it('the plan lists all six files', async () => {
    stageAll();
    const { p, lines } = run(opts());
    await p;
    const text = lines.join('\n');
    for (const name of [NAMES.x64, NAMES.arm64, NAMES.sigX64, NAMES.sigArm, 'latest.json', 'SHA256SUMS.txt']) expect(text).toContain(`  ${name}  `);
  });

  it('refuses a staged signature that does not verify (another key, or other bytes)', async () => {
    stageAll();
    fs.writeFileSync(path.join(publicDir, NAMES.sigArm), signTestData({ key: makeTestKey(), data: ARM }));
    await expect(run(opts()).p).rejects.toThrow(/Burrow-Setup-arm64\.exe\.sig does not verify/);
    fs.writeFileSync(path.join(publicDir, NAMES.sigArm), signTestData({ key, data: Buffer.from('MZ other') }));
    await expect(run(opts()).p).rejects.toThrow(/does not verify against Burrow-Setup-arm64\.exe/);
  });

  it('refuses a missing sig file', async () => {
    stageAll();
    fs.rmSync(path.join(publicDir, NAMES.sigX64));
    await expect(run(opts()).p).rejects.toThrow(/Missing installer\(s\): Burrow-Setup-x64\.exe\.sig/);
  });

  describe('--x64-file', () => {
    const name = 'Burrow_0.2.0_x64-setup.exe';
    let src;
    beforeEach(() => {
      src = path.join(outDir, 'hand', name);
      fs.mkdirSync(path.dirname(src), { recursive: true });
      fs.writeFileSync(src, X64);
      stageArm();
    });

    it('needs <file>.sig beside it', async () => {
      await expect(run(opts({ x64File: src })).p).rejects.toThrow(/needs its signature beside it/);
    });

    it('stages the sig, verifies it against the staged installer, and covers it in the sums', async () => {
      fs.writeFileSync(`${src}.sig`, `${SIG_X64}\n`);
      const { p } = run(opts({ x64File: src }));
      await p;
      expect(fs.readFileSync(path.join(publicDir, NAMES.sigX64), 'utf8').trim()).toBe(SIG_X64);
      expect(fs.readFileSync(path.join(publicDir, 'SHA256SUMS.txt'), 'utf8')).toContain(`  ${NAMES.sigX64}\n`);
    });

    it('refuses a sig made for other bytes', async () => {
      fs.writeFileSync(`${src}.sig`, signTestData({ key, data: Buffer.from('MZ not this file') }));
      await expect(run(opts({ x64File: src })).p).rejects.toThrow(/Burrow-Setup-x64\.exe\.sig does not verify/);
    });
  });

  describe('--x64-from-ci', () => {
    const ciRun = {
      status: 'completed', headSha: HEAD, createdAt: '2026-10-05T10:00:00Z', updatedAt: '2026-10-05T10:30:00Z',
      jobs: [{ name: 'build-release / assets', conclusion: 'success', databaseId: 11 }, { name: 'build-release / desktop-windows / Windows x64', conclusion: 'success', databaseId: 22 }],
    };
    const asset = (id, name, updated = '2026-10-05T10:20:00Z') => ({ id, name, updated_at: updated });
    const over = ({ sigBytes = SIG_X64, sumsSig = sha(Buffer.from(SIG_X64)), logSig = sumsSig, sigUpdatedLater = false } = {}) => {
      let reads = 0;
      const sumsText = `${sha(X64)}  ${NAMES.x64}\n${sumsSig}  ${NAMES.sigX64}\n`;
      return {
        'gh run view': async (args) => {
          if (args.includes('--log')) return { stdout: `win\tBuild\t2026 ${sha(X64)}  ${NAMES.x64}\nwin\tBuild\t2026 ${logSig}  ${NAMES.sigX64}\n`, stderr: '' };
          return { stdout: JSON.stringify(ciRun), stderr: '' };
        },
        'gh api repos/ChristianMunoz31/burrow/actions/runs/777': async () => ({ stdout: JSON.stringify({ path: '.github/workflows/release.yml' }), stderr: '' }),
        'gh api repos/ChristianMunoz31/burrow/releases/tags/v0.2.0': async () => {
          reads += 1;
          return {
            stdout: JSON.stringify({
              assets: [
                asset(901, NAMES.x64), asset(902, 'SHA256SUMS-desktop-windows-x64.txt'),
                asset(903, NAMES.sigX64, sigUpdatedLater && reads > 1 ? '2026-10-05T10:25:00Z' : undefined),
              ],
            }),
            stderr: '',
          };
        },
        'gh api -H': async (args) => {
          const url = args[3];
          if (url.endsWith('/assets/901')) return { stdout: X64, stderr: '' };
          if (url.endsWith('/assets/902')) return { stdout: Buffer.from(sumsText), stderr: '' };
          if (url.endsWith('/assets/903')) return { stdout: Buffer.from(sigBytes), stderr: '' };
          throw new Error(`unexpected asset ${url}`);
        },
      };
    };
    const go = (cfg) => run(opts({ x64FromCi: '777' }), { exec: makeExec(over(cfg)) });
    beforeEach(stageArm);

    it('downloads the sig by asset id in the same check, verifies it, and stages it', async () => {
      const { p } = go();
      await p;
      expect(calls.filter((c) => c[1] === 'api' && c[2] === '-H').map((c) => c[4].split('/').pop())).toEqual(['901', '902', '903']);
      expect(fs.readFileSync(path.join(publicDir, NAMES.sigX64), 'utf8')).toBe(SIG_X64);
      expect(calls.some((c) => c[1] === 'release')).toBe(false);
    });

    it('stops when the sig does not match the per-arch sums asset, the job log, or changed while downloading', async () => {
      await expect(go({ sumsSig: H('f') }).p).rejects.toThrow(/does not match/);
      await expect(go({ logSig: H('f') }).p).rejects.toThrow(/Burrow-Setup-x64\.exe\.sig does not match the sha256 the x64 job printed/);
      await expect(go({ sigUpdatedLater: true }).p).rejects.toThrow(/Burrow-Setup-x64\.exe\.sig on the private release changed/);
    });

    it('stops when the downloaded sig is not a signature of the installer', async () => {
      const wrong = signTestData({ key, data: Buffer.from('MZ different') });
      await expect(go({ sigBytes: wrong, sumsSig: sha(Buffer.from(wrong)) }).p).rejects.toThrow(/does not verify/);
    });
  });

  describe('building ARM64 with signing', () => {
    const arm = { hostTripleFn: () => 'aarch64-pc-windows-msvc', arch: 'arm64' };
    const nsis = () => path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
    const makeStep = (sig) => {
      const seen = [];
      const step = vi.fn((_file, args, o) => {
        seen.push({ args: args.map((a) => path.basename(a)), env: o.env });
        if (args.includes('--bundles')) {
          fs.mkdirSync(nsis(), { recursive: true });
          fs.writeFileSync(path.join(nsis(), 'Burrow_0.2.0_arm64-setup.exe'), ARM);
          fs.writeFileSync(path.join(nsis(), 'Burrow_0.2.0_arm64-setup.exe.sig'), sig);
        }
      });
      return { step, seen };
    };
    const x64Src = () => {
      const f = path.join(outDir, 'Burrow_0.2.0_x64-setup.exe');
      fs.writeFileSync(f, X64);
      fs.writeFileSync(`${f}.sig`, SIG_X64);
      return f;
    };
    const keyFile = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-rlu-key-'));
      const file = path.join(dir, 'k.txt');
      fs.writeFileSync(file, 'synthetic, not a key');
      return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
    };

    it('fails before any step or git call when the signing variables are missing', async () => {
      const { step } = makeStep(SIG_ARM);
      const exec = makeExec();
      await expect(run(opts({ skipBuild: false, x64File: x64Src() }), { step, exec, ...arm, env: {} }).p).rejects.toThrow(MISSING_SIGNING_MESSAGE);
      expect(step).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
    });

    it('only the tauri step sees the signing variables; npm ci and the other steps and git/gh run without them', async () => {
      const k = keyFile();
      const { step, seen } = makeStep(SIG_ARM);
      const env = { TAURI_SIGNING_PRIVATE_KEY_PATH: k.file, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'pw', PATH: 'p' };
      await run(opts({ skipBuild: false, x64File: x64Src() }), { step, exec: makeExec(), ...arm, env }).p;
      k.cleanup();
      const withSigning = seen.filter((s) => Object.keys(s.env).some((n) => /^TAURI_/i.test(n)));
      expect(withSigning).toHaveLength(1);
      expect(withSigning[0].args).toContain('--bundles');
      expect(withSigning[0].env.TAURI_SIGNING_PRIVATE_KEY).toBe(path.resolve(k.file));
      const ci = seen.find((s) => s.args.at(-1) === 'ci');
      expect(ci).toBeTruthy();
      expect(Object.keys(ci.env).filter((n) => /^TAURI_/i.test(n))).toEqual([]);
      expect(fs.readFileSync(path.join(publicDir, NAMES.sigArm), 'utf8')).toBe(SIG_ARM);
      const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'build-manifest.json'), 'utf8'));
      expect(manifest.installers.arm64.sig).toEqual({ name: NAMES.sigArm, sha256: sha(Buffer.from(SIG_ARM)) });
      expect(manifest.installers.x64.sig).toEqual({ name: NAMES.sigX64, sha256: sha(Buffer.from(SIG_X64)) });
    });

    it('refuses an ARM64 signature made with another key', async () => {
      const k = keyFile();
      const { step } = makeStep(signTestData({ key: makeTestKey(), data: ARM }));
      const env = { TAURI_SIGNING_PRIVATE_KEY_PATH: k.file, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'pw' };
      await expect(run(opts({ skipBuild: false, x64File: x64Src() }), { step, exec: makeExec(), ...arm, env }).p).rejects.toThrow(/does not verify against the public key/);
      k.cleanup();
    });
  });
});
