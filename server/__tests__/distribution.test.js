// Distribution marker: 'direct' (default) or 'store' (Microsoft Store MSIX build). Absent means direct.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DISTRIBUTIONS, getDistribution, isStoreDistribution, parseDistribution, resolveBuildDistribution } from '../distribution.js';
import { DISTRIBUTION_MARKER_PREFIX, bundleDefine, buildBackupWorkerSource, distributionBanner } from '../../scripts/desktop/workerBundle.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('getDistribution', () => {
  it('is direct when nothing says otherwise', () => {
    expect(getDistribution({}, undefined)).toBe('direct');
    expect(getDistribution({ BURROW_DISTRIBUTION: '' }, undefined)).toBe('direct');
    expect(getDistribution({ BURROW_DISTRIBUTION: 'STORE' }, undefined)).toBe('direct');
    expect(isStoreDistribution({}, undefined)).toBe(false);
  });

  it('reads the env only when the build did not bake a value in', () => {
    expect(getDistribution({ BURROW_DISTRIBUTION: 'store' }, undefined)).toBe('store');
    expect(getDistribution({ BURROW_DISTRIBUTION: 'store' }, 'direct')).toBe('direct');
    expect(getDistribution({ BURROW_DISTRIBUTION: 'direct' }, 'store')).toBe('store');
    expect(isStoreDistribution({}, 'store')).toBe(true);
  });

  it('treats an unknown baked value as direct', () => {
    expect(getDistribution({}, 'beta')).toBe('direct');
  });
});

describe('resolveBuildDistribution', () => {
  it('defaults to direct and accepts the two names', () => {
    expect(resolveBuildDistribution({})).toBe('direct');
    expect(resolveBuildDistribution({ BURROW_DISTRIBUTION: '  ' })).toBe('direct');
    expect(resolveBuildDistribution({ BURROW_DISTRIBUTION: 'store' })).toBe('store');
    expect(resolveBuildDistribution({ BURROW_DISTRIBUTION: ' direct ' })).toBe('direct');
  });

  it('refuses a typo instead of shipping it as direct', () => {
    expect(() => resolveBuildDistribution({ BURROW_DISTRIBUTION: 'Store' }, '--distribution')).toThrow(/--distribution must be one of direct, store/);
    expect(parseDistribution('msix')).toBeNull();
    expect(DISTRIBUTIONS).toEqual(['direct', 'store']);
  });
});

describe('bundle define and banner', () => {
  it('bakes direct by default and store on request', () => {
    expect(bundleDefine('0.1.0').__BURROW_DISTRIBUTION__).toBe('"direct"');
    expect(bundleDefine('0.1.0', { distribution: 'store' }).__BURROW_DISTRIBUTION__).toBe('"store"');
    expect(() => bundleDefine('0.1.0', { distribution: 'msix' })).toThrow(/Unknown distribution/);
  });

  it('only a store bundle carries a marker line, so direct bundles are unchanged', () => {
    expect(distributionBanner('direct')).toBe('');
    expect(distributionBanner('store')).toBe('/*! BURROW_DISTRIBUTION=store */\n');
    expect(distributionBanner('store').startsWith(DISTRIBUTION_MARKER_PREFIX)).toBe(true);
  });

  it('the real worker bundle keeps the channel marker first and adds the store marker second', async () => {
    const store = await buildBackupWorkerSource({ distribution: 'store', version: '0.1.0' });
    const lines = store.split('\n');
    expect(lines[0]).toBe('/*! BURROW_CHANNEL=stable */');
    // The Pro marker is the second line (docs/adr/0001-open-core-split.md 3.10); the store marker follows it.
    expect(lines[1]).toBe('/*! BURROW_PRO=off */');
    expect(lines[2]).toBe('/*! BURROW_DISTRIBUTION=store */');
    const direct = await buildBackupWorkerSource({ version: '0.1.0' });
    expect(direct).not.toContain('BURROW_DISTRIBUTION=');
  }, 60_000);

  it('the sidecar bundler passes the distribution to the define and the banner', () => {
    const sidecar = fs.readFileSync(path.join(ROOT, 'scripts', 'desktop', 'buildSidecar.js'), 'utf8');
    expect(sidecar).toMatch(/bundleDefine\(channelBuild\.version, \{ channel: channelBuild\.channel, buildDate, commit, distribution, dataLocation, pro \}\)/);
    expect(sidecar).toMatch(/distributionBanner\(distribution\)/);
    expect(sidecar).toMatch(/resolveBuildDistribution\(/);
  });
});
