// Stages the folder that `makeappx pack` turns into one .msix. The layout is exactly what the Tauri shell resolves at
// run time (src-tauri/src/sidecar.rs resolve_launch): the sidecar next to the app exe, the UI and the SQL migrations
// under <exe dir>/resources/. It is the same tree the NSIS installer puts in the install folder.
//
//   AppxManifest.xml
//   Burrow.exe
//   burrow-server.exe              the Node SEA sidecar (Tauri strips the target triple from externalBin)
//   resources/dist/...             the built UI (BURROW_DIST_DIR)
//   resources/migrations/*.sql     (BURROW_MIGRATIONS_DIR)
//   Assets/StoreLogo.png, Square44x44Logo.png, Square150x150Logo.png
import fs from 'node:fs';
import path from 'node:path';
import { stripPeSignature } from './pe.mjs';
import { APP_EXECUTABLE, SIDECAR_EXECUTABLE } from './storeManifest.mjs';
import { skipDevStamp } from '../desktop/devDist.js';

export const REQUIRED_ASSETS = Object.freeze(['StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png']);
export const MANIFEST_FILE = 'AppxManifest.xml';

/**
 * Every file that must exist in a staged package, relative to the stage folder, with `/` separators.
 * @returns {string[]}
 */
export function requiredStagedFiles() {
  return [MANIFEST_FILE, APP_EXECUTABLE, SIDECAR_EXECUTABLE, 'resources/dist/index.html', ...REQUIRED_ASSETS.map((a) => `Assets/${a}`)];
}

/**
 * @param {string} dir
 * @returns {string[]} files below `dir`, relative, `/` separators, sorted
 */
export function listFiles(dir) {
  const out = [];
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(dir, '');
  return out.sort();
}

/**
 * Problems with a staged package folder; empty when it matches what the shell resolves.
 * @param {string} stageDir
 * @returns {string[]}
 */
export function checkStagedLayout(stageDir) {
  const problems = [];
  for (const rel of requiredStagedFiles()) {
    if (!fs.existsSync(path.join(stageDir, ...rel.split('/')))) problems.push(`missing ${rel}`);
  }
  const migrations = path.join(stageDir, 'resources', 'migrations');
  const sqlFiles = fs.existsSync(migrations) ? fs.readdirSync(migrations).filter((n) => n.endsWith('.sql')) : [];
  if (sqlFiles.length === 0) problems.push('resources/migrations has no .sql files');
  return problems;
}

/**
 * Copies the compiled app into `stageDir` and writes the manifest. The folder is emptied first.
 * @param {{ stageDir: string, exe: string, sidecar: string, distDir: string, migrationsDir: string, assetsDir: string,
 *   manifestXml: string }} opts absolute paths; `exe` must be the compiled Burrow.exe, `sidecar` the matching-arch sidecar
 * @returns {string[]} the staged files, relative
 * @throws {Error} when an input is missing or the result does not match the layout the shell resolves
 */
export function stageLayout({ stageDir, exe, sidecar, distDir, migrationsDir, assetsDir, manifestXml }) {
  for (const [label, file] of [['app exe', exe], ['sidecar', sidecar]]) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`The ${label} is missing: ${file}`);
  }
  for (const [label, dir] of [['built UI', distDir], ['migrations', migrationsDir], ['Store assets', assetsDir]]) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`The ${label} folder is missing: ${dir}`);
  }
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(stageDir, 'resources'), { recursive: true });
  fs.copyFileSync(exe, path.join(stageDir, APP_EXECUTABLE));
  // The injected node.exe carries a dead Authenticode signature that makes signing the package fail (see pe.mjs).
  fs.writeFileSync(path.join(stageDir, SIDECAR_EXECUTABLE), stripPeSignature(fs.readFileSync(sidecar)).bytes);
  fs.cpSync(distDir, path.join(stageDir, 'resources', 'dist'), { recursive: true, filter: skipDevStamp });
  fs.cpSync(migrationsDir, path.join(stageDir, 'resources', 'migrations'), { recursive: true });
  fs.mkdirSync(path.join(stageDir, 'Assets'), { recursive: true });
  for (const name of REQUIRED_ASSETS) {
    const from = path.join(assetsDir, name);
    if (!fs.existsSync(from)) throw new Error(`The Store asset ${name} is missing in ${assetsDir}`);
    fs.copyFileSync(from, path.join(stageDir, 'Assets', name));
  }
  fs.writeFileSync(path.join(stageDir, MANIFEST_FILE), manifestXml, 'utf8');
  const problems = checkStagedLayout(stageDir);
  if (problems.length > 0) throw new Error(`The staged package layout is wrong: ${problems.join('; ')}`);
  return listFiles(stageDir);
}
