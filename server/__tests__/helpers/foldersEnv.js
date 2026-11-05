// Shared fixtures for the Folders tests: synthetic temp folders under os.tmpdir(), a read-only fingerprint of a tree,
// a junction/symlink maker that reports when the OS refuses, and the path-rule override the temp dirs need
// (they live under AppData on Windows, which is a protected root).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __setPathOptionsForTests, validateFolderRoot } from '../../folders/pathSafety.js';
import { insertFolder } from '../../folders/store.js';

/** A fresh temp dir; the caller removes it with rmTree. */
export const makeTmp = (prefix = 'burrow-folders-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

export const rmTree = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

/** Neutral path rules for temp fixtures: no env roots, a fake home and exec dir inside `root`. */
export function neutralPathOptions(root, extra = {}) {
  return { env: {}, home: path.join(root, 'fake-home'), execDir: path.join(root, 'fake-exec'), ...extra };
}

export function useNeutralPaths(root, extra = {}) {
  fs.mkdirSync(path.join(root, 'fake-home'), { recursive: true });
  __setPathOptionsForTests(neutralPathOptions(root, extra));
}

/** Write files from a { 'rel/path.txt': 'text' | Buffer } map, creating folders. */
export function writeTree(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

/** { relPath: [sha256, mtimeMs, size] } of every file under a tree (read-only). */
export function fingerprint(dir) {
  const out = {};
  const visit = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        const st = fs.statSync(full);
        out[path.relative(dir, full).split(path.sep).join('/')] = [crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'), st.mtimeMs, st.size];
      }
    }
  };
  visit(dir);
  return out;
}

/** Make a directory junction (Windows) or symlink (elsewhere). Returns false when the OS refuses. */
export function tryDirLink(target, link) {
  try {
    fs.symlinkSync(target, link, 'junction');
    return true;
  } catch {
    return false;
  }
}

/** Make a file symlink. Returns false when the OS refuses (Windows without the privilege). */
export function tryFileLink(target, link) {
  try {
    fs.symlinkSync(target, link, 'file');
    return true;
  } catch {
    return false;
  }
}

/** Validate a folder with the current path options and insert its row. Returns the stored folders row. */
export async function addFolderRow(dir, name) {
  const checked = await validateFolderRoot(dir, { existing: [] });
  if (!checked.ok) throw new Error(`fixture folder refused: ${checked.code}`);
  return insertFolder({ name: name ?? checked.name, path: checked.path, pathKey: checked.pathKey });
}

/** Copy of the contract's error copy, written out so a change to the source copy fails a test. */
export const COPY = Object.freeze({
  invalid_request: [400, 'That request was not valid. Check what you entered and try again.'],
  unsupported_media_type: [415, 'That request was not valid. Try again.'],
  folder_origin_blocked: [403, 'Folders can only be added from the Burrow window.'],
  folder_not_found: [404, 'That folder is no longer in Burrow. Reload the page.'],
  folder_file_not_found: [404, 'That file is no longer in this folder list. Re-scan the folder to refresh it.'],
  folder_file_changed: [409, 'This file changed since the last scan. Re-scan the folder to see it.'],
  folder_preview_busy: [429, 'Burrow is still opening another file. Try again in a moment.'],
  folder_failed: [500, "Burrow couldn't finish that. Your files were not changed. Try again."],
  folder_path_invalid: [422, 'Enter the full path of a folder on this computer, for example C:\\Users\\Name\\Documents\\Notes.'],
  folder_missing: [422, "Burrow can't find that folder. Check the path and try again."],
  folder_not_directory: [422, 'That path is a file, not a folder. Enter the folder that holds it.'],
  folder_is_link: [422, 'That folder is a shortcut to another place. Enter the real folder instead.'],
  folder_network_path: [422, "Network folders aren't supported yet. Pick a folder on this computer."],
  folder_too_broad: [422, 'That folder is too big to read as a whole. Pick a folder inside it, like Documents or a project folder.'],
  folder_protected: [422, "Burrow doesn't read system or app folders. Pick a folder with your own files."],
  folder_burrow_data: [422, "That folder holds Burrow's own data. Pick a different folder."],
  folder_unreadable: [422, "Burrow can't open that folder. Check that you have permission to read it."],
  folder_exists: [409, 'That folder is already in Burrow.'],
  folder_overlaps: [409, 'That folder is inside, or contains, a folder you already added. Remove the other one first or pick a different folder.'],
  folder_limit: [409, 'You can add up to 20 folders. Remove one to add another.'],
  folder_job_running: [409, 'Burrow is already reading this folder. Wait for it to finish or click Cancel.'],
  folder_queue_full: [429, 'Burrow is reading other folders right now. Try again in a few minutes.'],
  folder_no_job: [409, 'Nothing is running for this folder.'],
  folder_not_scanned: [409, "Burrow hasn't read this folder yet. Click Re-scan and try again when it finishes."],
  folder_not_indexed: [409, "This folder isn't ready for questions yet. Click Re-scan and wait for it to finish, then ask again."],
  rate_limited: [429, 'Too many requests. Try again in a few minutes.'],
  folder_pick_required: [409, 'Use Add folder to choose the folder in the window that opens.'],
  folder_needs_confirm: [409, "Confirm where this folder is first. Burrow doesn't read a folder from an import until you choose it again."],
  folder_already_confirmed: [409, 'This folder is already confirmed.'],
  dialog_unavailable: [409, 'This needs the Burrow app on your computer.'],
  dialog_busy: [409, 'A Burrow window for choosing a folder or a file is already open. Finish with it first.'],
  dialog_not_found: [404, 'That request has ended. Try again.'],
  dialog_failed: [500, "Burrow couldn't open the window. Try again, or restart Burrow."],
  save_too_large: [413, 'This export is too large to save this way. Use Download instead.'],
  dialog_expired: [409, 'That window was open too long, so nothing was changed. Try again.'],
  pick_failed: [500, "Burrow couldn't open the window to choose a folder. Try again, or restart Burrow."],
  save_exists: [409, 'A file with that name is already there, so nothing was saved. Try again with another name.'],
  save_failed: [500, "Burrow couldn't save the file. If it's open in another app, close it and try again. Nothing was changed."],
  folder_moved: [409, 'This folder was moved, renamed or replaced. Remove it from Burrow and add it again.'],
  data_reset: [409, 'This was stopped because your Burrow data was erased or restored.'],
  shutdown: [409, 'This was stopped because Burrow closed. Click Re-scan to continue where it left off.'],
  folder_job_failed: [500, "Burrow couldn't finish reading this folder. Your files were not changed. Click Re-scan to try again."],
  cancelled: [409, 'Stopped. What Burrow already read is kept.'],
});

/** The expected error body of a route for a code. */
export const errorBody = (code) => ({ error: code, code, message: COPY[code][1] });
