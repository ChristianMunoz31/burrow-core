import { describe, expect, it } from 'vitest';
import { describeChildState } from '../../scripts/release/smokeSidecar.js';

const RUNNING = { exitCode: null, signalCode: null };

describe('describeChildState', () => {
  it('says a live sidecar is still running, with its stderr tail', () => {
    expect(describeChildState(RUNNING, 'warn: slow disk')).toBe('sidecar still running; stderr tail: warn: slow disk');
  });

  it('says stderr is empty when there is none', () => {
    expect(describeChildState(RUNNING, '')).toBe('sidecar still running; stderr empty');
  });

  it('reports the Windows access violation exit code as decimal and hex', () => {
    const text = describeChildState({ exitCode: 3221225477, signalCode: null }, 'fatal');
    expect(text).toContain('sidecar exited with code 3221225477 (0xC0000005)');
    expect(text).toContain('signal none');
    expect(text).toContain('stderr tail: fatal');
  });

  it('reports small and negative exit codes as unsigned hex', () => {
    expect(describeChildState({ exitCode: 3, signalCode: null }, 'x')).toContain('code 3 (0x3)');
    expect(describeChildState({ exitCode: 0, signalCode: null }, 'x')).toContain('code 0 (0x0)');
    expect(describeChildState({ exitCode: -1, signalCode: null }, 'x')).toContain('(0xFFFFFFFF)');
  });

  it('reports a signal exit without a code or hex', () => {
    const text = describeChildState({ exitCode: null, signalCode: 'SIGKILL' }, '');
    expect(text).toBe('sidecar exited with code none, signal SIGKILL; stderr empty');
    expect(text).not.toContain('0x');
  });

  it('keeps only the last 800 characters of stderr', () => {
    const text = describeChildState(RUNNING, `HEAD-${'a'.repeat(1000)}TAIL`);
    const tail = text.slice(text.indexOf('stderr tail: ') + 'stderr tail: '.length);
    expect(tail).toHaveLength(800);
    expect(tail.endsWith('TAIL')).toBe(true);
    expect(text).not.toContain('HEAD-');
    expect(describeChildState(RUNNING, 'b'.repeat(800))).toContain(`: ${'b'.repeat(800)}`);
  });

  it('reports only what it is given: a secret that was only on stdout cannot appear', () => {
    const secret = 'synthetic-launch-secret-0123456789abcdef';
    const stdout = `BURROW_READY {"port":5}\n${secret}\n`;
    const text = describeChildState({ exitCode: 1, signalCode: null }, 'listening failed');
    expect(stdout).toContain(secret);
    expect(text).not.toContain(secret);
    expect(text).toContain('listening failed');
  });
});
