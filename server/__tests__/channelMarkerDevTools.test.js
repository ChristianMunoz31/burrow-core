// scripts/checks/channelMarker.js, the developer tools part: the route marker, the dist scan and --expect-dev-tools.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEV_TOOLS_MARKER,
  DEV_TOOLS_ROUTE_MARKER,
  checkBinaryChannel,
  checkBundleText,
  checkDistDevTools,
  distHasDevTools,
  main,
  scanDevToolsMarkers,
} from '../../scripts/checks/channelMarker.js';

const STABLE_BANNER = '/*! BURROW_CHANNEL=stable */\n';
const DEV_BANNER = '/*! BURROW_CHANNEL=dev */\n';
const DISPLAY = '0.2.0-dev.20261005.abc1234';

let tmp;
const put = (rel, text) => {
  const file = path.join(tmp, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const collect = () => {
  const logs = [];
  const errors = [];
  return { logs, errors, io: { log: (m) => logs.push(m), error: (m) => errors.push(m) } };
};
/** A built UI folder: build info for the channel plus whatever extra files. */
const makeDist = (name, channel, files = {}) => {
  const info = channel === 'dev' ? { formatVersion: 1, version: DISPLAY, channel: 'dev' } : { formatVersion: 1, version: '0.1.0', channel: 'stable' };
  put(`${name}/burrow-build-info.json`, JSON.stringify(info));
  put(`${name}/index.html`, '<html></html>');
  for (const [rel, text] of Object.entries(files)) put(`${name}/${rel}`, text);
  return path.join(tmp, name);
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-marker-dt-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('the developer route marker', () => {
  it('is the developer routes path', () => {
    expect(DEV_TOOLS_ROUTE_MARKER).toBe('/dev/license');
  });

  it('a stable bundle text with the route fails, a dev one passes', () => {
    const problems = checkBundleText(`${STABLE_BANNER}x("/api${DEV_TOOLS_ROUTE_MARKER}")`, 'stable');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(DEV_TOOLS_ROUTE_MARKER);
    expect(checkBundleText(`${STABLE_BANNER}x("${DEV_TOOLS_MARKER}") "${DEV_TOOLS_ROUTE_MARKER}"`, 'stable')).toHaveLength(2);
    expect(checkBundleText(`${DEV_BANNER}x("/api${DEV_TOOLS_ROUTE_MARKER}")`, 'dev')).toEqual([]);
  });

  it('a stable executable with the route fails', () => {
    const exe = (channel, extra) => Buffer.from(`MZ\u0000/*! BURROW_CHANNEL=${channel} */\u0000${extra}`, 'latin1');
    expect(checkBinaryChannel(exe('stable', `x ${DEV_TOOLS_ROUTE_MARKER} y`), 'stable').join(' ')).toMatch(/developer tools/);
    expect(checkBinaryChannel(exe('dev', `x ${DEV_TOOLS_ROUTE_MARKER} y`), 'dev')).toEqual([]);
  });
});

describe('scanDevToolsMarkers, distHasDevTools and checkDistDevTools', () => {
  it('finds nothing in a clean dist', () => {
    const dist = makeDist('clean', 'stable', { 'assets/app.js': 'console.log(1)', 'assets/app.css': 'a{}' });
    expect(scanDevToolsMarkers(dist)).toEqual([]);
    expect(distHasDevTools(dist)).toBe(false);
    expect(checkDistDevTools(dist, 'absent')).toEqual([]);
    expect(checkDistDevTools(dist, 'present')).toHaveLength(1);
  });

  it('finds either marker in .js .css .html .json and .map files, with forward-slash relative paths', () => {
    const dist = makeDist('dirty', 'stable', {
      'assets/a.js': `x="${DEV_TOOLS_MARKER}"`,
      'assets/b.css': `/* ${DEV_TOOLS_ROUTE_MARKER} */`,
      'c.html': DEV_TOOLS_MARKER,
      'd.json': `{"u":"${DEV_TOOLS_ROUTE_MARKER}"}`,
      'assets/e.js.map': DEV_TOOLS_MARKER,
      'assets/ignored.txt': DEV_TOOLS_MARKER,
    });
    expect(scanDevToolsMarkers(dist).sort()).toEqual(['assets/a.js', 'assets/b.css', 'assets/e.js.map', 'c.html', 'd.json']);
    expect(checkDistDevTools(dist, 'absent')[0]).toMatch(/carries the developer tools/);
  });

  it('distHasDevTools looks for the UI marker only; present passes with it', () => {
    const routeOnly = makeDist('route-only', 'stable', { 'assets/svc.js': `fetch("/api${DEV_TOOLS_ROUTE_MARKER}")` });
    expect(distHasDevTools(routeOnly)).toBe(false);
    const withUi = makeDist('with-ui', 'stable', { 'assets/section.js': `<div data-dev-tools="${DEV_TOOLS_MARKER}">` });
    expect(distHasDevTools(withUi)).toBe(true);
    expect(checkDistDevTools(withUi, 'present')).toEqual([]);
    expect(checkDistDevTools(withUi, 'absent')).toHaveLength(1);
  });

  it('a folder that cannot be read is a problem, not a crash', () => {
    expect(checkDistDevTools(path.join(tmp, 'missing'), 'absent')).toEqual(['the UI folder could not be scanned for the developer tools']);
    expect(checkDistDevTools(path.join(tmp, 'missing'), 'present')).toHaveLength(1);
  });
});

describe('the CLI --expect-dev-tools', () => {
  it('defaults from --expect: stable wants none, dev wants them', () => {
    const clean = makeDist('clean', 'stable');
    const stableWithTools = makeDist('stable-tools', 'stable', { 'a.js': DEV_TOOLS_MARKER });
    const devWithTools = makeDist('dev-tools', 'dev', { 'a.js': DEV_TOOLS_MARKER });
    const devWithout = makeDist('dev-none', 'dev');
    expect(main(['--expect', 'stable', '--dist-dir', clean], collect().io)).toBe(0);
    const bad = collect();
    expect(main(['--expect', 'stable', '--dist-dir', stableWithTools], bad.io)).toBe(1);
    expect(bad.errors.join(' ')).toMatch(/developer tools/);
    expect(main(['--expect', 'dev', '--dist-dir', devWithTools], collect().io)).toBe(0);
    expect(main(['--expect', 'dev', '--dist-dir', devWithout], collect().io)).toBe(1);
  });

  it('can be overridden: a build:devtools dist is stable-channel with the tools present', () => {
    const buildDevtools = makeDist('build-devtools', 'stable', { 'assets/s.js': DEV_TOOLS_MARKER });
    expect(main(['--expect', 'stable', '--dist-dir', buildDevtools], collect().io)).toBe(1);
    expect(main(['--expect', 'stable', '--expect-dev-tools', 'present', '--dist-dir', buildDevtools], collect().io)).toBe(0);
    const plain = makeDist('plain', 'stable');
    expect(main(['--expect', 'stable', '--expect-dev-tools', 'present', '--dist-dir', plain], collect().io)).toBe(1);
    expect(main(['--expect', 'stable', '--expect-dev-tools', 'absent', '--dist-dir', plain], collect().io)).toBe(0);
  });

  it('rejects an unknown value and still checks the build info', () => {
    const dist = makeDist('x', 'stable');
    expect(main(['--expect', 'stable', '--expect-dev-tools', 'maybe', '--dist-dir', dist], collect().io)).toBe(1);
    const wrongChannel = makeDist('wrong', 'dev', { 'a.js': DEV_TOOLS_MARKER });
    expect(main(['--expect', 'stable', '--expect-dev-tools', 'present', '--dist-dir', wrongChannel], collect().io)).toBe(1);
  });

  it('a missing dist folder fails', () => {
    expect(main(['--expect', 'stable', '--dist-dir', path.join(tmp, 'nothing')], collect().io)).toBe(1);
  });
});
