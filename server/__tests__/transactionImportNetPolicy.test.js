// The sheets network feature copy is user-facing: it must name the transaction import.
import { describe, expect, it } from 'vitest';
import { NETWORK_FEATURES } from '../netPolicy.js';

describe('sheets feature copy', () => {
  const sheets = NETWORK_FEATURES.find((f) => f.id === 'sheets');

  it('describes importing transactions from a Google Sheet link', () => {
    expect(sheets.description.toLowerCase()).toContain('import transactions from a published google sheet link');
  });

  it('has no em or en dash', () => {
    expect(`${sheets.label} ${sheets.description}`).not.toMatch(/[–—]/);
  });
});
