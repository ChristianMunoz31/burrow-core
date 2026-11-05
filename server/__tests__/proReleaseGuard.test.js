// ci:always-run
// Every official release path refuses a build without the Pro module (docs/adr/0001-open-core-split.md 3.10, owner
// decision O6): text assertions over the release scripts and workflows (like devToolsStableGuard.test.js), plus the
// real refusal of buildInstaller and the Free-only assertions of CI and the release zip.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInstaller } from '../../scripts/release/buildInstaller.js';
import { PRO_MISSING_MESSAGE } from '../../scripts/checks/proPresent.js';
import { hasPrivateFile } from './helpers/privateFiles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The YAML block of one job (from its header to the next job at the same indent). */
function jobBlock(text, job) {
  const start = text.indexOf(`\n  ${job}:\n`);
  expect(start, job).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.slice(3).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 3);
}

describe('release scripts refuse a Free build', () => {
  it.each([
    ['scripts/release/buildInstaller.js', ['proCheck = assertProPresent', 'proCheck({ root })', "BURROW_REQUIRE_PRO: '1'"]],
    ['scripts/release/buildStore.mjs', ['assertProPresent({ root: ROOT })', "BURROW_REQUIRE_PRO: '1'", 'checkDistPro(dir, expectPro)', "expectPro = 'present'", 'checkProPresent({ root: ROOT })']],
    ['scripts/release/releaseLocal.mjs', ['proCheck = assertProPresent', 'proCheck({ root })', "BURROW_REQUIRE_PRO: '1'"]],
    ['scripts/release/releaseAuto.mjs', ['proCheck = assertProPresent', 'proCheck({ root })', "BURROW_REQUIRE_PRO: '1'", "['worktree', 'add', '--detach', proWt, proCommit]", "['tag', t, proCommit]", 'has changes. Commit them in pro/ first']],
    ['scripts/release/publishPublic.js', ["if (!values['dry-run']) assertProPresent();"]],
  ])('%s', (rel, needles) => {
    const text = read(rel);
    for (const n of needles) expect(text, n).toContain(n);
  });

  it('buildSidecar requires pro/ for --require-pro, BURROW_REQUIRE_PRO=1 and the Store distribution, and warns otherwise', () => {
    const text = read('scripts/desktop/buildSidecar.js');
    expect(text).toContain("const requirePro = args.has('--require-pro') || process.env.BURROW_REQUIRE_PRO === '1' || distribution === 'store';");
    expect(text).toContain("console.warn('Building without the Pro module: Free build (BURROW_PRO=off)')");
    expect(text).toContain("checkDistPro(distDir, pro ? 'present' : 'absent')");
  });

  it('buildInstaller really refuses a checkout without pro/ before any step', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-proguard-'));
    try {
      let steps = 0;
      expect(() => buildInstaller({ root, env: {}, step: () => (steps += 1) })).toThrow(PRO_MISSING_MESSAGE);
      expect(steps).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('workflows', () => {
  // The release workflows are private-only (left out of the public core export): only the ones present are checked.
  it.each([
    ['release.yml', 'desktop'],
    ['release.yml', 'publish-public'],
    ['desktop-windows.yml', 'windows'],
    ['dev-build.yml', 'build'],
  ].filter(([file]) => hasPrivateFile(`.github/workflows/${file}`)))('%s job %s checks out burrow-pro, requires it and sets BURROW_REQUIRE_PRO=1', (file, job) => {
    const block = jobBlock(read(`.github/workflows/${file}`), job);
    if (block.includes('ssh://github.com/ChristianMunoz31/burrow-pro.git pro')) {
      // Hand-rolled clone (desktop-windows.yml): on the hosted windows-11-arm image the key file actions/checkout
      // writes keeps an ACE for Authenticated Users and Windows OpenSSH refuses it. The key must come from the secret
      // through env into an ssh-agent (never a file), github.com's host key must be pinned and the agent stopped.
      expect(block).toContain('BURROW_PRO_DEPLOY_KEY: ${{ secrets.BURROW_PRO_DEPLOY_KEY }}');
      expect(block).toContain('-o User=git');
      expect(block).toContain('StrictHostKeyChecking=yes');
      expect(block).toContain('ssh-add -q -');
      expect(block).toContain('ssh-agent -k');
      expect(block).not.toContain('icacls');
      expect(block).not.toContain('ssh-key:');
    } else {
      expect(block).toContain('repository: ChristianMunoz31/burrow-pro');
      expect(block).toContain('ssh-key: ${{ secrets.BURROW_PRO_DEPLOY_KEY }}');
      expect(block).toContain('path: pro');
    }
    expect(block).toContain('run: node scripts/checks/proPresent.js');
    expect(block).toContain("BURROW_REQUIRE_PRO: '1'");
  });

  it('ci.yml never checks out the Pro module and asserts a Free dist', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).not.toContain('burrow-pro');
    expect(ci).toContain('node scripts/checks/channelMarker.js --expect stable --dist-dir dist --expect-pro absent');
  });

  it.skipIf(!hasPrivateFile('.github/workflows/release.yml'))('the release zip job (assets) is Free only', () => {
    const block = jobBlock(read('.github/workflows/release.yml'), 'assets');
    expect(block).not.toContain('burrow-pro');
    expect(block).toContain('--expect-pro absent');
  });

  it('cla.yml is inactive unless BURROW_PUBLIC_CORE is true and never runs pull request code', () => {
    const cla = read('.github/workflows/cla.yml');
    expect(cla).toContain("vars.BURROW_PUBLIC_CORE == 'true'");
    expect(cla).toContain('branch: cla-signatures');
    expect(cla).toContain('docs/CLA.md');
    expect(cla).not.toContain('actions/checkout');
  });
});

describe('smoke test', () => {
  it('smokeSidecar.js has --expect-pro with the explain probe', () => {
    const text = read('scripts/release/smokeSidecar.js');
    expect(text).toContain("'expect-pro': { type: 'string' }");
    expect(text).toContain("'/api/insights/explain'");
    expect(text).toContain("const wanted = expectPro === 'present' ? 400 : 501;");
  });
});
