// writeBuildInfo (docs/LICENSING.md section 6).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main as buildInfoMain, resolveBuildDate, resolveChannelInfo } from '../../../scripts/license/writeBuildInfo.js';
import { BUILD_INFO_FILE } from '../../license/constants.js';

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-scripts-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const collect = () => {
  const out = { logs: [], errors: [] };
  out.opts = { log: (m) => out.logs.push(m), error: (m) => out.errors.push(m) };
  return out;
};

describe('writeBuildInfo', () => {
  const NOW = Date.parse('2026-10-05T12:00:00.999Z');
  const git = () => '2026-09-01T08:00:00Z';

  it('precedence: env, then git, then the clock (floored to the second)', () => {
    const env = { BURROW_BUILD_DATE: '2026-08-01T00:00:00Z' };
    expect(resolveBuildDate({ env, git, now: () => NOW })).toEqual({ buildDate: '2026-08-01T00:00:00Z', source: 'env' });
    expect(resolveBuildDate({ env: {}, git, now: () => NOW })).toEqual({ buildDate: '2026-09-01T08:00:00Z', source: 'git' });
    expect(resolveBuildDate({ env: {}, git: () => null, now: () => NOW })).toEqual({ buildDate: '2026-10-05T12:00:00Z', source: 'clock' });
  });

  it('rejects an invalid BURROW_BUILD_DATE', () => {
    for (const bad of ['2026-10-05', '2026-02-30T00:00:00Z', '2026-10-05T12:00:00.000Z', '2023-01-01T00:00:00Z', 'nope']) {
      expect(() => resolveBuildDate({ env: { BURROW_BUILD_DATE: bad }, git, now: () => NOW })).toThrow(/BURROW_BUILD_DATE/);
    }
  });

  it('uses a file name without a leading dot, so bundlers that skip dotfiles still ship it', () => {
    expect(BUILD_INFO_FILE).toBe('burrow-build-info.json');
    const dist = path.join(tmp, 'dist0');
    buildInfoMain(['--dist-dir', dist], { ...collect().opts, env: {}, git: () => '2026-09-01T08:00:00Z' });
    expect(fs.readdirSync(dist)).toEqual(['burrow-build-info.json']);
  });

  it('writes the documented file and --check accepts env and git sources only', () => {
    const dist = path.join(tmp, 'dist');
    const io = collect();
    expect(buildInfoMain(['--dist-dir', dist], { ...io.opts, env: {}, git, now: () => NOW })).toBe(0);
    const body = JSON.parse(fs.readFileSync(path.join(dist, BUILD_INFO_FILE), 'utf8'));
    expect(body).toEqual({ formatVersion: 1, buildDate: '2026-09-01T08:00:00Z', source: 'git', version: expect.any(String), channel: 'stable' });
    expect(buildInfoMain(['--check', '--dist-dir', dist], collect().opts)).toBe(0);

    buildInfoMain(['--dist-dir', dist], { ...collect().opts, env: { BURROW_BUILD_DATE: '2026-08-01T00:00:00Z' }, git, now: () => NOW });
    expect(buildInfoMain(['--check', '--dist-dir', dist], collect().opts)).toBe(0);

    buildInfoMain(['--dist-dir', dist], { ...collect().opts, env: {}, git: () => null, now: () => NOW });
    const clockIo = collect();
    expect(buildInfoMain(['--check', '--dist-dir', dist], clockIo.opts)).toBe(1);
    expect(clockIo.errors.join(' ')).toMatch(/clock/);
  });

  it('--check fails for a missing or garbage file', () => {
    const dist = path.join(tmp, 'dist2');
    expect(buildInfoMain(['--check', '--dist-dir', dist], collect().opts)).toBe(1);
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(dist, BUILD_INFO_FILE), '{"formatVersion":1}');
    expect(buildInfoMain(['--check', '--dist-dir', dist], collect().opts)).toBe(1);
    fs.writeFileSync(path.join(dist, BUILD_INFO_FILE), 'garbage');
    expect(buildInfoMain(['--check', '--dist-dir', dist], collect().opts)).toBe(1);
  });

  it('exits 1 on an invalid BURROW_BUILD_DATE without writing anything', () => {
    const dist = path.join(tmp, 'dist3');
    const io = collect();
    expect(buildInfoMain(['--dist-dir', dist], { ...io.opts, env: { BURROW_BUILD_DATE: 'bad' } })).toBe(1);
    expect(fs.existsSync(dist)).toBe(false);
  });

  describe('channel', () => {
    const DISPLAY = '0.2.0-dev.20261005.abc1234';
    const read = (dist) => JSON.parse(fs.readFileSync(path.join(dist, BUILD_INFO_FILE), 'utf8'));

    it('defaults to stable with the package version, also for an empty or explicit stable value', () => {
      for (const env of [{}, { BURROW_CHANNEL: '' }, { BURROW_CHANNEL: 'stable' }]) {
        const dist = path.join(tmp, `stable-${Object.keys(env).length}-${env.BURROW_CHANNEL ?? 'unset'}`);
        expect(buildInfoMain(['--dist-dir', dist], { ...collect().opts, env, git })).toBe(0);
        const body = read(dist);
        expect(body.channel).toBe('stable');
        expect(body.version).not.toMatch(/dev/);
      }
    });

    it('a dev build takes its version from BURROW_DISPLAY_VERSION', () => {
      const dist = path.join(tmp, 'dev');
      const io = collect();
      const env = { BURROW_CHANNEL: 'dev', BURROW_DISPLAY_VERSION: DISPLAY };
      expect(buildInfoMain(['--dist-dir', dist], { ...io.opts, env, git })).toBe(0);
      expect(read(dist)).toEqual({ formatVersion: 1, buildDate: '2026-09-01T08:00:00Z', source: 'git', version: DISPLAY, channel: 'dev' });
      expect(io.logs.join(' ')).toContain('dev');
      expect(buildInfoMain(['--check', '--dist-dir', dist], collect().opts)).toBe(0);
    });

    it('a dev build without a valid display version exits 1 and writes nothing', () => {
      for (const display of [undefined, '', '0.2.0', '0.2.0-dev.20261005', '0.2.0-dev.20261005.ABC1234', '0.2.0-dev.20261005.abc12345']) {
        const dist = path.join(tmp, `bad-${String(display)}`);
        const io = collect();
        const env = { BURROW_CHANNEL: 'dev', ...(display === undefined ? {} : { BURROW_DISPLAY_VERSION: display }) };
        expect(buildInfoMain(['--dist-dir', dist], { ...io.opts, env, git })).toBe(1);
        expect(io.errors.join(' ')).toMatch(/BURROW_DISPLAY_VERSION/);
        expect(fs.existsSync(dist)).toBe(false);
      }
    });

    it('an invalid BURROW_CHANNEL exits 1 and writes nothing', () => {
      for (const channel of ['beta', 'DEV', 'Stable', 'dev ops']) {
        const dist = path.join(tmp, `chan-${channel.replace(/W/g, '_')}`);
        const io = collect();
        expect(buildInfoMain(['--dist-dir', dist], { ...io.opts, env: { BURROW_CHANNEL: channel }, git })).toBe(1);
        expect(io.errors.join(' ')).toMatch(/BURROW_CHANNEL/);
        expect(fs.existsSync(dist)).toBe(false);
      }
    });

    it('resolveChannelInfo trims the values and ignores a display version for stable', () => {
      expect(resolveChannelInfo({ BURROW_CHANNEL: ' dev ', BURROW_DISPLAY_VERSION: ` ${DISPLAY} ` }, '0.1.0')).toEqual({ channel: 'dev', version: DISPLAY });
      expect(resolveChannelInfo({ BURROW_DISPLAY_VERSION: DISPLAY }, '0.1.0')).toEqual({ channel: 'stable', version: '0.1.0' });
    });
  });

  it('the real git lookup returns a valid commit date inside this checkout', () => {
    const res = resolveBuildDate({ env: {} });
    expect(['git', 'clock']).toContain(res.source);
    expect(res.buildDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});
