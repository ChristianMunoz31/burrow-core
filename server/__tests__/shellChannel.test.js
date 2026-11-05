// The server -> shell update request line: exact format, the shared MAC vector (also pinned in the Rust tests),
// and refusals. No network, no real stdout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../loadEnv.js', () => ({}));

import { initDesktopAuth, resetDesktopAuth, updateRequestMac } from '../desktop/auth.js';
import {
  UPDATE_REQUEST_PREFIX,
  installerArch,
  isManualDownloadAvailable,
  isShellUpdaterAvailable,
  requestShellUpdate,
} from '../desktop/shellChannel.js';

// Shared vector, printed by the command in the design (node -e ... 1.2.3 / 00112233445566778899aabbccddeeff).
const SECRET = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const NONCE = '00112233445566778899aabbccddeeff';
const VECTOR_MAC = '131a3fcae49bf067678e9c40618722760ecf5b9b32a68568b4ef2eada010a9a2';

const fixedRandom = (size) => Buffer.from(NONCE, 'hex').subarray(0, size);
const sink = () => {
  const writes = [];
  return { writes, write: (chunk) => writes.push(chunk) };
};

beforeEach(() => initDesktopAuth(SECRET));
afterEach(() => resetDesktopAuth());

describe('updateRequestMac', () => {
  it('matches the shared test vector', () => {
    expect(updateRequestMac('1.2.3', NONCE)).toBe(VECTOR_MAC);
  });

  it('changes with the version and with the nonce', () => {
    expect(updateRequestMac('1.2.4', NONCE)).not.toBe(VECTOR_MAC);
    expect(updateRequestMac('1.2.3', 'ff'.repeat(16))).not.toBe(VECTOR_MAC);
  });

  it('changes with the launch secret', () => {
    initDesktopAuth(Buffer.alloc(32, 7));
    expect(updateRequestMac('1.2.3', NONCE)).not.toBe(VECTOR_MAC);
  });

  it('fails closed without a secret', () => {
    resetDesktopAuth();
    expect(() => updateRequestMac('1.2.3', NONCE)).toThrow('not initialised');
  });
});

describe('requestShellUpdate', () => {
  it('writes exactly one line, in one call, in the documented format', () => {
    const out = sink();
    const result = requestShellUpdate('1.2.3', { out, randomBytes: fixedRandom, desktop: true });
    expect(result).toEqual({ nonce: NONCE });
    expect(out.writes).toHaveLength(1);
    expect(out.writes[0]).toBe(
      `BURROW_UPDATE_REQUEST {"v":1,"version":"1.2.3","nonce":"${NONCE}","mac":"${VECTOR_MAC}"}\n`,
    );
    expect(out.writes[0].startsWith(UPDATE_REQUEST_PREFIX)).toBe(true);
    expect(out.writes[0].slice(0, -1)).not.toContain('\n');
  });

  it('draws a fresh 32-hex nonce per request', () => {
    const out = sink();
    requestShellUpdate('1.2.3', { out, desktop: true });
    requestShellUpdate('1.2.3', { out, desktop: true });
    const [a, b] = out.writes.map((line) => JSON.parse(line.slice(UPDATE_REQUEST_PREFIX.length)));
    expect(a.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(a.mac).toMatch(/^[0-9a-f]{64}$/);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.mac).toBe(updateRequestMac('1.2.3', a.nonce));
  });

  it.each(['1.2', '1.2.3-rc.1', '1.2.3-dev.20261001.abc1234', '01.2.3', 'v1.2.3', '1.2.3\n', '', ' 1.2.3', null, undefined, 123])(
    'refuses the version %j and writes nothing',
    (version) => {
      const out = sink();
      expect(() => requestShellUpdate(version, { out, desktop: true })).toThrow(TypeError);
      expect(out.writes).toEqual([]);
    },
  );

  it('refuses outside desktop mode and writes nothing', () => {
    const out = sink();
    expect(() => requestShellUpdate('1.2.3', { out, desktop: false })).toThrow('desktop');
    expect(out.writes).toEqual([]);
  });

  it('writes nothing when there is no secret to authenticate with', () => {
    resetDesktopAuth();
    const out = sink();
    expect(() => requestShellUpdate('1.2.3', { out, desktop: true })).toThrow();
    expect(out.writes).toEqual([]);
  });
});

describe('isShellUpdaterAvailable', () => {
  const env = (over) => ({ BURROW_DESKTOP: '1', BURROW_SHELL_UPDATER: '1', ...over });

  it('is true only for the desktop app, the exact env value and the stable channel', () => {
    expect(isShellUpdaterAvailable(env())).toBe(true);
    expect(isShellUpdaterAvailable(env({ BURROW_DESKTOP: undefined }))).toBe(false);
    expect(isShellUpdaterAvailable(env({ BURROW_DESKTOP: '0' }))).toBe(false);
    expect(isShellUpdaterAvailable(env({ BURROW_SHELL_UPDATER: undefined }))).toBe(false);
    expect(isShellUpdaterAvailable(env({ BURROW_SHELL_UPDATER: 'true' }))).toBe(false);
    expect(isShellUpdaterAvailable(env({ BURROW_SHELL_UPDATER: '0' }))).toBe(false);
  });

  it('is false on the dev channel', () => {
    expect(isShellUpdaterAvailable(env({ BURROW_CHANNEL: 'dev' }))).toBe(false);
  });

  it('is false in the Microsoft Store distribution even with the shell variable set', () => {
    expect(isShellUpdaterAvailable(env({ BURROW_DISTRIBUTION: 'store' }))).toBe(false);
    expect(isShellUpdaterAvailable(env({ BURROW_DISTRIBUTION: 'direct' }))).toBe(true);
  });
});

describe('installerArch', () => {
  it('accepts x64 and arm64 only', () => {
    expect(installerArch('x64')).toBe('x64');
    expect(installerArch('arm64')).toBe('arm64');
    for (const arch of ['ia32', 'arm', 'ppc64', '']) {
      expect(installerArch(arch)).toBeNull();
    }
  });
});

describe('isManualDownloadAvailable', () => {
  const env = (over) => ({ BURROW_DESKTOP: '1', ...over });
  const win = { platform: 'win32', arch: 'x64' };

  it('is true only for the stable direct desktop app without a shell updater on Windows x64 or arm64', () => {
    expect(isManualDownloadAvailable(env(), win)).toBe(true);
    expect(isManualDownloadAvailable(env(), { platform: 'win32', arch: 'arm64' })).toBe(true);
  });

  it.each([
    ['not desktop', { BURROW_DESKTOP: undefined }, win],
    ['the dev channel', { BURROW_CHANNEL: 'dev' }, win],
    ['the Store distribution', { BURROW_DISTRIBUTION: 'store' }, win],
    ['a working shell updater', { BURROW_SHELL_UPDATER: '1' }, win],
    ['macOS', {}, { platform: 'darwin', arch: 'arm64' }],
    ['Linux', {}, { platform: 'linux', arch: 'x64' }],
    ['an unsupported architecture', {}, { platform: 'win32', arch: 'ia32' }],
  ])('is false for %s', (_label, over, host) => {
    expect(isManualDownloadAvailable(env(over), host)).toBe(false);
  });
});
