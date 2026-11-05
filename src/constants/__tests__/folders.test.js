import { describe, expect, it } from 'vitest';
import * as folders from '../folders';
import { SHIPPED_PRO_FEATURES } from '../proFeatures';
import { PHASE_FALLBACK, phaseCounts, phaseLabel, phaseName } from '../folders';

const flatten = (value) => {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(flatten);
  return [];
};

describe('folders copy', () => {
  it('has no em or en dashes anywhere', () => {
    for (const text of flatten(folders)) expect(text).not.toMatch(/[‒-―]/);
  });

  it('keeps the contract copy', () => {
    expect(folders.FOLDERS_SUBTITLE).toBe(
      'Burrow reads folders you pick, on this computer. Your files are never uploaded or changed.',
    );
    expect(folders.REMOVE_TITLE).toBe('Remove this folder from Burrow?');
    expect(folders.SWITCH_LABEL).toBe('Re-scan once a day');
    expect(folders.EMBED_MODEL).toBe('nomic-embed-text');
  });

  it('builds the phase labels from the server counts', () => {
    const progress = { summariesDone: 5, summariesTotal: 20, chunksDone: 7, chunksTotal: 9 };
    expect(phaseLabel({ phase: 'summarizing_files', progress })).toBe('Summarizing files (5 of 20)');
    expect(phaseLabel({ phase: 'indexing', progress })).toBe('Preparing questions (7 of 9)');
    expect(phaseLabel({ phase: 'queued', progress })).toBe('Waiting for another folder to finish');
    expect(phaseLabel({ phase: 'inventory', progress })).toBe('Listing files');
    expect(phaseLabel({ phase: 'summarizing_folder', progress })).toBe('Writing the folder summary');
    expect(phaseLabel({ phase: 'reporting', progress })).toBe('Writing the report');
    expect(phaseName({ phase: 'summarizing_files', progress })).toBe('Summarizing files');
    expect(phaseName({ phase: 'indexing', progress })).toBe('Preparing questions');
    expect(phaseName({ phase: 'queued', progress })).toBe('Waiting for another folder to finish');
    expect(phaseCounts({ phase: 'inventory', progress })).toBeNull();
    expect(phaseCounts({ phase: 'indexing', progress })).toEqual({ done: 7, total: 9 });
  });
});

describe('phase label fallback', () => {
  it('does not name a wrong step for done or an unknown phase', () => {
    expect(phaseLabel({ phase: 'done' })).toBe(PHASE_FALLBACK);
    expect(phaseLabel({ phase: 'something_new' })).toBe(PHASE_FALLBACK);
    expect(phaseLabel({ phase: 'toString' })).toBe(PHASE_FALLBACK);
    expect(phaseName({ phase: 'done' })).toBe(PHASE_FALLBACK);
  });
});

describe('Pro feature mirror', () => {
  it('lists the folder features with the registry labels', () => {
    expect(SHIPPED_PRO_FEATURES.folder_qa).toBe('Ask your folders');
    expect(SHIPPED_PRO_FEATURES.folder_report).toBe('Folder cross-file reports');
    expect(SHIPPED_PRO_FEATURES.folder_auto_rescan).toBe('Scheduled folder re-scan');
  });
});

describe('document and shell-window copy', () => {
  it('labels documents, unreadable files and unknown statuses', () => {
    expect(folders.KIND_LABELS.document).toBe('Document');
    expect(folders.FILE_STATUS_LABELS.unreadable).toBe('Could not read this file');
    expect(folders.FILE_STATUS_FALLBACK).toBe('Not read');
    for (const text of flatten(folders.FILE_STATUS_LABELS)) expect(text).not.toMatch(/PDF|DOCX/i);
  });

  it('says the size of the search model and that it runs on this computer', () => {
    expect(folders.SEARCH_MODEL_TEXT).toContain('runs on this computer');
    expect(folders.SEARCH_MODEL_TEXT).toContain('about 270 MB');
    expect(folders.SEARCH_MODEL_TEXT).toContain('Ollama library');
  });

  it('has a fallback message for every code the new routes answer with an error status', () => {
    for (const code of [
      'folder_pick_required',
      'folder_needs_confirm',
      'folder_already_confirmed',
      'dialog_unavailable',
      'dialog_busy',
      'dialog_not_found',
      'dialog_failed',
      'save_too_large',
    ]) {
      expect(folders.ERROR_COPY[code], code).toEqual(expect.any(String));
    }
  });
});
