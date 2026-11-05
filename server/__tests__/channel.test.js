// Channel source of truth: bundled define beats env, env only applies with no bundle, stable by default.
import { describe, expect, it } from 'vitest';
import {
  BUNDLED_CHANNEL,
  CHANNELS,
  DEV_TAG_RE,
  DEV_VERSION_RE,
  STABLE_VERSION_RE,
  getChannel,
  isDevChannel,
  parseChannel,
} from '../channel.js';

describe('STABLE_VERSION_RE', () => {
  it.each(['0.0.0', '1.2.3', '10.20.30', '999999999.999999999.999999999'])('accepts %s', (v) => {
    expect(STABLE_VERSION_RE.test(v)).toBe(true);
  });

  it.each(['1.2', '01.2.3', '1.2.3-rc.1', '1.2.3+b', 'v1.2.3', '1.2.3.x', '1000000000.0.0', '0.1000000000.0', '0.0.1000000000', ' 1.2.3', '1.2.3\n'])('rejects %j (same 9 digit cap per part as the shell)', (v) => {
    expect(STABLE_VERSION_RE.test(v)).toBe(false);
  });
});

describe('channel constants', () => {
  it('lists the two channels, frozen', () => {
    expect(CHANNELS).toEqual(['stable', 'dev']);
    expect(Object.isFrozen(CHANNELS)).toBe(true);
  });

  it('has no bundled channel in tests', () => {
    expect(BUNDLED_CHANNEL).toBeUndefined();
  });

  it('DEV_VERSION_RE matches only the documented display version', () => {
    expect(DEV_VERSION_RE.exec('0.2.0-dev.20261005.abc1234')?.slice(1)).toEqual(['0', '2', '0', '20261005', 'abc1234']);
    for (const bad of [
      '0.2.0',
      '0.2.0-dev.20261005+1008',
      '0.2.0-dev.2026105.abc1234',
      '0.2.0-dev.20261005.ABC1234',
      '0.2.0-dev.20261005.abc123',
      '0.2.0-dev.20261005.abc12345',
      'v0.2.0-dev.20261005.abc1234',
      '0.2.0-dev.20261005.abc1234\n',
    ]) {
      expect(DEV_VERSION_RE.test(bad)).toBe(false);
    }
  });

  it('DEV_TAG_RE matches only dev-YYYYMMDD-sha7', () => {
    expect(DEV_TAG_RE.exec('dev-20261005-abc1234')?.slice(1)).toEqual(['20261005', 'abc1234']);
    for (const bad of ['v0.2.0', 'dev-20261005-abc123', 'dev-20261005-ABC1234', 'dev-2026-abc1234', 'xdev-20261005-abc1234']) {
      expect(DEV_TAG_RE.test(bad)).toBe(false);
    }
  });
});

describe('parseChannel', () => {
  it('accepts exact values only', () => {
    expect(parseChannel('stable')).toBe('stable');
    expect(parseChannel('dev')).toBe('dev');
    for (const bad of ['Dev', ' dev', 'dev ', '', 'beta', undefined, null, 1, {}]) expect(parseChannel(bad)).toBeNull();
  });
});

describe('getChannel precedence', () => {
  it('defaults to stable', () => {
    expect(getChannel({}, undefined)).toBe('stable');
    expect(getChannel({ BURROW_CHANNEL: 'stable' }, undefined)).toBe('stable');
    expect(getChannel({ BURROW_CHANNEL: 'DEV' }, undefined)).toBe('stable');
    expect(getChannel({ BURROW_CHANNEL: '' }, undefined)).toBe('stable');
  });

  it('uses env only when nothing is bundled', () => {
    expect(getChannel({ BURROW_CHANNEL: 'dev' }, undefined)).toBe('dev');
  });

  it('a bundled value beats the environment in both directions', () => {
    expect(getChannel({ BURROW_CHANNEL: 'dev' }, 'stable')).toBe('stable');
    expect(getChannel({ BURROW_CHANNEL: 'stable' }, 'dev')).toBe('dev');
    expect(getChannel({}, 'dev')).toBe('dev');
  });

  it('an unknown bundled value is stable', () => {
    expect(getChannel({ BURROW_CHANNEL: 'dev' }, 'weird')).toBe('stable');
  });

  it('isDevChannel follows getChannel', () => {
    expect(isDevChannel({ BURROW_CHANNEL: 'dev' }, undefined)).toBe(true);
    expect(isDevChannel({ BURROW_CHANNEL: 'dev' }, 'stable')).toBe(false);
    expect(isDevChannel({}, undefined)).toBe(false);
  });
});
