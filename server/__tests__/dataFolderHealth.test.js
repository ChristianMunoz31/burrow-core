// The data folder warning: a OneDrive root or a linked folder (server/dataFolderHealth.js).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LINKED_WARNING, ONEDRIVE_WARNING, dataFolderWarning, inspectDataFolder, logDataFolderWarning, oneDriveRoots } from '../dataFolderHealth.js';

describe('OneDrive and linked data folders', () => {
  const win = { platform: 'win32' };

  it('collects the sync roots from the three variables, once each', () => {
    expect(oneDriveRoots({ OneDrive: 'C:\\Users\\example\\OneDrive', OneDriveConsumer: 'C:\\Users\\example\\OneDrive', OneDriveCommercial: ' D:\\Work ', Other: 'x' })).toEqual([
      'C:\\Users\\example\\OneDrive',
      'D:\\Work',
    ]);
    expect(oneDriveRoots({})).toEqual([]);
  });

  it('warns when the folder is a OneDrive root, inside it, or inside any of the three roots (case-insensitive)', () => {
    const env = { OneDrive: 'C:\\Users\\example\\OneDrive', OneDriveCommercial: 'D:\\Contoso' };
    for (const dir of ['C:\\Users\\example\\OneDrive', 'C:\\Users\\example\\OneDrive\\Burrow', 'c:\\users\\EXAMPLE\\onedrive\\Apps\\Burrow', 'D:\\Contoso\\Docs\\Burrow']) {
      const info = inspectDataFolder(dir, { env, ...win });
      expect(info.oneDrive, dir).toBe(true);
      expect(dataFolderWarning(info)).toEqual({ code: 'onedrive', message: ONEDRIVE_WARNING });
    }
    expect(ONEDRIVE_WARNING).toBe('Your Burrow data folder is inside OneDrive. Syncing a live database can damage it.');
  });

  it('does not warn for %USERPROFILE%\\Burrow Data, which Known Folder Move does not redirect, or a lookalike name', () => {
    const env = { OneDrive: 'C:\\Users\\example\\OneDrive' };
    for (const dir of ['C:\\Users\\example\\Burrow Data', 'C:\\Users\\example\\AppData\\Roaming\\Burrow', 'C:\\Users\\example\\OneDrive2\\Burrow', 'C:\\Users\\example']) {
      const info = inspectDataFolder(dir, { env, ...win, lstat: () => ({ isSymbolicLink: () => false }) });
      expect(info.oneDrive, dir).toBe(false);
      expect(dataFolderWarning(info), dir).toBeNull();
    }
  });

  it('warns about a linked folder (symbolic link or junction) even outside OneDrive', () => {
    const info = inspectDataFolder('C:\\Users\\example\\Burrow Data', { env: {}, ...win, lstat: () => ({ isSymbolicLink: () => true }) });
    expect(info).toMatchObject({ oneDrive: false, linked: true });
    expect(dataFolderWarning(info)).toEqual({ code: 'linked', message: LINKED_WARNING });
  });

  it.runIf(process.platform === 'win32')('sees through a real junction into a OneDrive folder', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-od-'));
    try {
      const cloud = path.join(base, 'OneDrive');
      fs.mkdirSync(path.join(cloud, 'Burrow'), { recursive: true });
      const link = path.join(base, 'Burrow');
      try {
        fs.symlinkSync(path.join(cloud, 'Burrow'), link, 'junction');
      } catch {
        return; // links are not allowed on this machine
      }
      const info = inspectDataFolder(link, { env: { OneDrive: cloud }, platform: 'win32' });
      expect(info.linked).toBe(true);
      expect(info.oneDrive).toBe(true);
      expect(dataFolderWarning(info).code).toBe('onedrive');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('a folder that does not exist yet is judged by its path', () => {
    const info = inspectDataFolder(path.join(os.tmpdir(), 'burrow-not-there', 'Burrow'), { env: {}, platform: process.platform });
    expect(info).toMatchObject({ oneDrive: false, linked: false });
  });

  it('logs the warning once, never throws, and says nothing when there is nothing to say', () => {
    const lines = [];
    const warning = logDataFolderWarning('C:\\Users\\example\\OneDrive\\Burrow', { env: { OneDrive: 'C:\\Users\\example\\OneDrive' }, platform: 'win32', warn: (m) => lines.push(m) });
    expect(warning.code).toBe('onedrive');
    expect(lines).toEqual([`data folder: onedrive: ${ONEDRIVE_WARNING}`]);
    expect(logDataFolderWarning('C:\\Users\\example\\Burrow Data', { env: {}, platform: 'win32', lstat: () => ({ isSymbolicLink: () => false }), warn: (m) => lines.push(m) })).toBeNull();
    expect(lines).toHaveLength(1);
    expect(
      logDataFolderWarning(null, {
        warn: () => {
          throw new Error('boom');
        },
      }),
    ).toBeNull();
  });
});
