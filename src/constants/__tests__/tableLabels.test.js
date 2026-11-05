import { describe, expect, it } from 'vitest';
import { tableLabel } from '../tableLabels';

describe('tableLabel', () => {
  it('names the folder tables of an export', () => {
    expect(tableLabel('folders')).toBe('Folders');
    expect(tableLabel('folder_files')).toBe('Folder files');
  });

  it('falls back to the id for an unknown table', () => {
    expect(tableLabel('something_new')).toBe('something_new');
  });
});
