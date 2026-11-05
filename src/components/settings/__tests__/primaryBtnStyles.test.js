import { describe, expect, it } from 'vitest';
import { PRIMARY_BTN as AI_PRIMARY } from '../aiFormStyles';
import { PRIMARY_BTN as UPDATE_PRIMARY } from '../updateCopy';

const SHARED_DISABLED = [
  'aria-disabled:cursor-not-allowed',
  'aria-disabled:bg-slate-slate700/60',
  'aria-disabled:text-slate-slate300',
  'forced-colors:aria-disabled:opacity-60',
];

describe('disabled primary buttons', () => {
  it.each([
    ['aiFormStyles', AI_PRIMARY],
    ['updateCopy', UPDATE_PRIMARY],
  ])('%s PRIMARY_BTN has the shared muted disabled look and a forced-colors cue', (_name, classes) => {
    const tokens = classes.split(/\s+/);
    for (const token of SHARED_DISABLED) expect(tokens).toContain(token);
  });

  it('the update button no longer relies on plain opacity alone', () => {
    expect(UPDATE_PRIMARY.split(/\s+/)).not.toContain('aria-disabled:opacity-60');
  });
});
