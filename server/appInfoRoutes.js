// GET /api/app/info: version, channel, distribution (direct | store), data location (appdata | userprofile) and the resolved data
// folder, desktop flag, commit and build date for the UI (Dev build badge, Settings build identity), plus a data folder warning
// (OneDrive or a linked folder) when there is one.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getChannel } from './channel.js';
import { dataFolderWarning, inspectDataFolder } from './dataFolderHealth.js';
import { dataDirOf } from './backup/paths.js';
import { devToolsActive } from './devExtensions.js';
import { proModuleActive } from './proExtensions.js';
import { getDataLocation } from './dataLocation.js';
import { getDistribution } from './distribution.js';
import { loadBuildInfo } from './license/buildInfo.js';
import { envDir, getAppVersion, getCommit, isDesktopMode } from './runtime.js';

const REPO_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

let cachedBuildDate;

/**
 * ISO build date from the existing build-info source (baked define, else dist/burrow-build-info.json), or null.
 * Read once and cached, including a null result.
 * @returns {string | null}
 */
export function getBuildDate() {
  if (cachedBuildDate !== undefined) return cachedBuildDate;
  cachedBuildDate = loadBuildInfo({ distDir: envDir('BURROW_DIST_DIR') ?? REPO_DIST }).buildDateIso;
  return cachedBuildDate;
}

/** Clears the cached build date. For tests only. */
export function resetBuildDateForTests() {
  cachedBuildDate = undefined;
}

let cachedFolder;

/**
 * The resolved data folder and the warning about it, read once per process (the folder does not move while the app runs).
 * @returns {{ dataDir: string | null, warning: { code: string, message: string } | null }}
 */
function dataFolderInfo() {
  if (cachedFolder !== undefined) return cachedFolder;
  try {
    const dataDir = dataDirOf();
    cachedFolder = { dataDir, warning: dataFolderWarning(inspectDataFolder(dataDir)) };
  } catch {
    cachedFolder = { dataDir: null, warning: null };
  }
  return cachedFolder;
}

/** Clears the cached data folder. For tests only. */
export function resetDataFolderInfoForTests() {
  cachedFolder = undefined;
}

/**
 * @param {import('express').Express} app
 * @param {{ devTools?: () => boolean, proModule?: () => boolean }} [opts] `devTools` says whether a developer extension is installed
 *   (default `devToolsActive`), `proModule` whether the Pro module is installed (default `proModuleActive`); tests inject them
 */
export function registerAppInfoRoutes(app, { devTools = devToolsActive, proModule = proModuleActive } = {}) {
  app.get('/api/app/info', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const folder = dataFolderInfo();
    res.json({
      data: {
        version: getAppVersion(),
        channel: getChannel(),
        distribution: getDistribution(),
        dataLocation: getDataLocation(),
        dataDir: folder.dataDir,
        dataFolderWarning: folder.warning,
        desktop: isDesktopMode(),
        commit: getCommit(),
        buildDate: getBuildDate(),
        devTools: devTools() === true,
        proModule: proModule() === true,
      },
    });
  });
}
