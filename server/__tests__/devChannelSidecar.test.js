// Build-side isolation of the Dev channel: the sidecar binary of each channel has its own name (M3), the
// packaged sidecar is verified by its embedded channel marker right before `tauri build` (H2), the build
// scripts refuse a Tauri config of their own (H2), and the dev workflow keeps its write token to one step (M4).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBinaryChannel, main as channelMarkerMain } from '../../scripts/checks/channelMarker.js';
import {
  CONFIG_REFUSED_MESSAGE,
  assertNoConfigFlag,
  assertSidecarChannel,
  isConfigFlag,
  sidecarBinaryPath,
} from '../../scripts/desktop/lib.js';
import { mergeConfig } from '../../scripts/desktop/buildDev.js';
import { hasPrivateFile, readPrivateFile } from './helpers/privateFiles.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const binary = (channel, extra = '') => Buffer.from(`MZ\u0000\u0000node internals ${extra}/*! BURROW_CHANNEL=${channel} */\n"use strict";\u0000\u0000tail`, 'latin1');

describe('checkBinaryChannel', () => {
  it('accepts an executable that carries only the expected marker', () => {
    expect(checkBinaryChannel(binary('dev'), 'dev')).toEqual([]);
    expect(checkBinaryChannel(binary('stable'), 'stable')).toEqual([]);
  });

  it('rejects a stale executable of the other channel, in both directions', () => {
    expect(checkBinaryChannel(binary('stable'), 'dev').join(' ')).toMatch(/carries channel "stable", expected "dev"/);
    expect(checkBinaryChannel(binary('dev'), 'stable').join(' ')).toMatch(/carries channel "dev", expected "stable"/);
  });

  it('rejects an executable with no marker, and one that mixes channels', () => {
    expect(checkBinaryChannel(Buffer.from('just a node binary'), 'dev').join(' ')).toMatch(/no channel marker/);
    const mixed = Buffer.concat([binary('dev'), binary('stable')]);
    expect(checkBinaryChannel(mixed, 'dev').join(' ')).toMatch(/expected "dev"/);
  });

  it('a stable executable must not mention the dev channel anywhere', () => {
    const sneaky = Buffer.concat([binary('stable'), Buffer.from(' BURROW_CHANNEL=dev ')]);
    expect(checkBinaryChannel(sneaky, 'stable').join(' ')).toMatch(/must not contain/);
  });

  it('the CLI checks --binary files and fails on a mismatch', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-bin-'));
    try {
      const good = path.join(dir, 'good.exe');
      const stale = path.join(dir, 'stale.exe');
      fs.writeFileSync(good, binary('dev'));
      fs.writeFileSync(stale, binary('stable'));
      const quiet = { log: () => {}, error: () => {} };
      expect(channelMarkerMain(['--expect', 'dev', '--binary', good], quiet)).toBe(0);
      expect(channelMarkerMain(['--expect', 'dev', '--binary', stale], quiet)).toBe(1);
      expect(channelMarkerMain(['--expect', 'dev', '--binary', path.join(dir, 'missing.exe')], quiet)).toBe(1);
      expect(channelMarkerMain(['--expect', 'dev'], quiet)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sidecar binary names (M3)', () => {
  it('each channel packages its own executable', () => {
    const stable = sidecarBinaryPath('stable', 'x86_64-unknown-linux-gnu');
    const dev = sidecarBinaryPath('dev', 'x86_64-unknown-linux-gnu');
    expect(path.basename(stable)).toBe('burrow-server-x86_64-unknown-linux-gnu');
    expect(path.basename(dev)).toBe('burrow-dev-server-x86_64-unknown-linux-gnu');
    expect(path.basename(sidecarBinaryPath('dev', 'aarch64-pc-windows-msvc'))).toBe('burrow-dev-server-aarch64-pc-windows-msvc.exe');
    expect(path.basename(sidecarBinaryPath('stable', 'universal-apple-darwin'))).toBe('burrow-server-universal-apple-darwin');
  });

  it('the dev overlay replaces the stable externalBin instead of adding to it', () => {
    const stableConf = JSON.parse(read('src-tauri/tauri.conf.json'));
    const devConf = JSON.parse(read('src-tauri/tauri.dev.conf.json'));
    expect(stableConf.bundle.externalBin).toEqual(['binaries/burrow-server']);
    expect(devConf.bundle.externalBin).toEqual(['binaries/burrow-dev-server']);
    expect(mergeConfig(stableConf, devConf).bundle.externalBin).toEqual(['binaries/burrow-dev-server']);
  });

  it('the Rust shell resolves the sidecar by channel (same names as the build)', () => {
    const channelRs = read('src-tauri/src/channel.rs');
    expect(channelRs).toContain('Channel::Stable => "burrow-server"');
    expect(channelRs).toContain('Channel::Dev => "burrow-dev-server"');
    expect(read('src-tauri/src/sidecar.rs')).toMatch(/dir\.join\(sidecar_file_name\(channel\)\)/);
  });

  it.skipIf(!hasPrivateFile('.github/workflows/dev-build.yml'))('the dev workflow names every macOS universal binary burrow-dev-server and checks the executables', () => {
    const wf = read('.github/workflows/dev-build.yml');
    expect(wf).not.toMatch(/burrow-server-/);
    expect(wf).toContain('burrow-dev-server-universal-apple-darwin');
    expect(wf).toContain('channelMarker.js --expect dev --binary');
  });
});

describe('the sidecar is verified right before tauri build (H2)', () => {
  it('passes the channel, the bundle and the executable to the marker check, and throws on a failure', () => {
    const calls = [];
    assertSidecarChannel('dev', { binary: 'b.exe', bundle: 's.cjs', run: (argv) => (calls.push(argv), 0) });
    expect(calls).toEqual([['--expect', 'dev', '--bundle', 's.cjs', '--binary', 'b.exe', '--expect-distribution', 'direct', '--expect-data-location', 'appdata']]);
    expect(() => assertSidecarChannel('stable', { binary: 'b', bundle: 's', run: () => 1 })).toThrow(/not a stable build/);
  });

  it('both build scripts run the check between the sidecar build and tauri build', () => {
    const stable = read('scripts/desktop/build.js');
    const dev = read('scripts/desktop/buildDev.js');
    expect(stable.indexOf('buildSidecar.js')).toBeLessThan(stable.indexOf("assertSidecarChannel('stable')"));
    expect(stable.indexOf("assertSidecarChannel('stable')")).toBeLessThan(stable.indexOf("runTauri(['build'"));
    expect(dev.indexOf('buildSidecar.js')).toBeLessThan(dev.indexOf("assertSidecarChannel('dev')"));
    expect(dev.indexOf("assertSidecarChannel('dev')")).toBeLessThan(dev.indexOf("runTauri(['build'"));
  });
});

describe('the build scripts refuse a Tauri config of their own (H2)', () => {
  it('recognizes every spelling of --config and -c', () => {
    for (const arg of ['--config', '--config=x.json', '-c', '-cx.json', '-dc', '-vc', '-c=foo']) {
      expect(isConfigFlag(arg), arg).toBe(true);
    }
  });

  it('leaves other flags and values alone', () => {
    for (const arg of ['--target', '--target=x86_64-pc-windows-msvc', '-d', '-v', '--debug', '--bundles', 'nsis', 'x.json', '-t', '-b', '-bnsis', '-tx86_64-pc-windows-msvc', '--ci', '--verbose']) {
      expect(isConfigFlag(arg), arg).toBe(false);
    }
  });

  it('assertNoConfigFlag throws the fixed message, also for a config hidden after --', () => {
    expect(() => assertNoConfigFlag(['--debug', '--config', 'evil.json'])).toThrow(CONFIG_REFUSED_MESSAGE);
    expect(() => assertNoConfigFlag(['--', '--config=evil'])).toThrow(CONFIG_REFUSED_MESSAGE);
    expect(() => assertNoConfigFlag(['--target', 'x86_64-pc-windows-msvc', '--bundles', 'nsis'])).not.toThrow();
    expect(CONFIG_REFUSED_MESSAGE).not.toMatch(/—/);
  });

  it('both build scripts apply it to their passthrough', () => {
    expect(read('scripts/desktop/build.js')).toContain('assertNoConfigFlag(passthrough)');
    expect(read('scripts/desktop/buildDev.js')).toContain('assertNoConfigFlag(passthrough)');
  });
});

// dev-build.yml is private-only (left out of the public core export).
describe.skipIf(!hasPrivateFile('.github/workflows/dev-build.yml'))('dev-build.yml keeps the write token to the steps that need it (M4)', () => {
  const wf = readPrivateFile('.github/workflows/dev-build.yml');
  const jobBlock = (name) => {
    const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z]+:\\n|(?![\\s\\S]))`, 'm').exec(wf);
    if (!m) throw new Error(`job ${name} not found`);
    return m[1];
  };

  it('the build job has no job-level GH_TOKEN, and exactly one step uses it', () => {
    const build = jobBlock('build');
    const beforeSteps = build.slice(0, build.indexOf('    steps:'));
    expect(beforeSteps).not.toMatch(/GH_TOKEN|github\.token/);
    const uses = build.match(/GH_TOKEN/g) ?? [];
    expect(uses).toHaveLength(1);
    const step = build.slice(build.lastIndexOf('      # The only step', build.indexOf('GH_TOKEN')));
    expect(step).toContain('name: Upload to the GitHub release');
    expect(step).toContain('gh release upload');
  });

  it('the plan job gives the token only to the step that creates the release', () => {
    const plan = jobBlock('plan');
    expect(plan.slice(0, plan.indexOf('    steps:'))).not.toMatch(/GH_TOKEN|github\.token/);
    expect(plan.match(/GH_TOKEN/g) ?? []).toHaveLength(1);
    expect(plan.indexOf('GH_TOKEN')).toBeGreaterThan(plan.indexOf('- id: release'));
  });
});
