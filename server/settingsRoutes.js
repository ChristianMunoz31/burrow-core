// /api/profile, /api/settings/network and /api/settings/weather-location. Registered after the auth gate in server.js.
import { getProfile, setProfile } from './profile.js';
import {
  isFeatureId,
  listNetworkFeatures,
  networkRequiredBody,
  requireNetwork,
  setNetworkFeature,
} from './netPolicy.js';
import { disableCloudAi } from './aiSettingsRoutes.js';
import { getLicenseStatus } from './license/index.js';
import { isManualDownloadAvailable, isShellUpdaterAvailable } from './desktop/shellChannel.js';
import { getChannel } from './channel.js';
import { isStoreDistribution } from './distribution.js';
import { checkForUpdate, licenseImpactFor } from './updateCheck.js';
import { sendStorageError } from './storageErrors.js';
import {
  INVALID_LOCATION_MESSAGE,
  clearWeatherLocation,
  getSavedWeatherLocation,
  parseWeatherLocation,
  saveWeatherLocation,
} from './weatherLocation.js';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const badRequest = (res, error) => res.status(400).json({ error, code: 'invalid_body' });

/** What the update check says about installing: computed per request, never cached across license changes. */
function withInstallInfo(status, { licenseStatus, installSupported, manualSupported }) {
  if (status?.status !== 'available') return status;
  let impact;
  try {
    impact = licenseImpactFor(status, licenseStatus());
  } catch {
    // No readable license state: the update is not offered (a licensed user must not be let through blindly).
    impact = { licenseImpact: 'unknown', updatesUntil: null };
  }
  return { ...status, canInstall: installSupported(), canDownload: manualSupported(), ...impact };
}

/**
 * @param {import('express').Express} app
 * @param {{ licenseStatus?: () => object, installSupported?: () => boolean, storeBuild?: () => boolean,
 *   devBuild?: () => boolean, manualSupported?: () => boolean }} [deps] test seams
 */
export function registerSettingsRoutes(
  app,
  {
    licenseStatus = getLicenseStatus,
    installSupported = () => isShellUpdaterAvailable(),
    storeBuild = () => isStoreDistribution(),
    devBuild = () => getChannel() === 'dev',
    manualSupported = () => isManualDownloadAvailable(),
  } = {},
) {
  app.use(['/api/profile', '/api/settings'], (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/profile', async (req, res) => {
    try {
      res.json(await getProfile());
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  app.put('/api/profile', async (req, res) => {
    const body = req.body;
    if (!isPlainObject(body)) return badRequest(res, 'Body must be a JSON object.');
    const { displayName, onboarded } = body;
    if (displayName !== undefined && displayName !== null && typeof displayName !== 'string') {
      return badRequest(res, 'displayName must be a string or null.');
    }
    if (onboarded !== undefined && onboarded !== true) {
      return badRequest(res, 'onboarded must be true.');
    }
    try {
      res.json(await setProfile({ displayName, onboarded }));
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  app.get('/api/settings/network', async (req, res) => {
    try {
      res.json(await listNetworkFeatures());
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  app.put('/api/settings/network', async (req, res) => {
    const body = req.body;
    if (!isPlainObject(body) || !isFeatureId(body.id) || typeof body.enabled !== 'boolean') {
      return badRequest(res, 'Body must be { "id": a known feature, "enabled": boolean }.');
    }
    try {
      // Switching cloud AI off here must end the cloud setup the same way the AI disable route does.
      if (body.id === 'cloudAi' && body.enabled === false) await disableCloudAi();
      else await setNetworkFeature(body.id, body.enabled);
      res.json(await listNetworkFeatures());
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  // The weather location the user typed (Settings > Network). Local only: saving or clearing it calls no network.
  app.get('/api/settings/weather-location', async (req, res) => {
    try {
      res.json({ location: await getSavedWeatherLocation() });
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  app.put('/api/settings/weather-location', async (req, res) => {
    const location = parseWeatherLocation(req.body);
    if (!location) {
      return res.status(400).json({
        error: 'invalid_location',
        code: 'invalid_location',
        message: INVALID_LOCATION_MESSAGE,
      });
    }
    try {
      res.json({ location: await saveWeatherLocation(location) });
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  app.delete('/api/settings/weather-location', async (req, res) => {
    try {
      await clearWeatherLocation();
      res.json({ location: null });
    } catch (err) {
      sendStorageError(res, err);
    }
  });

  // Microsoft Store build: the Store delivers updates, so this answers before the network opt-in and never calls GitHub.
  app.get('/api/settings/updates/check', (req, res, next) => {
    if (!storeBuild()) return next();
    return res.json({ data: { status: 'store_managed' } });
  });

  // Burrow Dev updates from its source folder: same short-circuit, no request and no opt-in needed.
  app.get('/api/settings/updates/check', (req, res, next) => {
    if (!devBuild()) return next();
    return res.json({ data: { status: 'dev_managed' } });
  });

  // Upstream failures are a 200 with status 'unavailable' (the repo may be private), never a 5xx.
  app.get('/api/settings/updates/check', requireNetwork('updates'), async (req, res) => {
    try {
      const status = await checkForUpdate({
        refresh: req.query.refresh === '1',
        source: installSupported() ? 'manifest' : 'release',
      });
      res.json({ data: withInstallInfo(status, { licenseStatus, installSupported, manualSupported }) });
    } catch (err) {
      if (err?.status === 403) return res.status(403).json(networkRequiredBody('updates'));
      return res.status(500).json({ error: 'Update check failed' });
    }
  });
}
