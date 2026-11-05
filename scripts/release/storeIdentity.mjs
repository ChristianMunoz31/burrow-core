// Package identity for the Microsoft Store (MSIX) build. The owner's values from Partner Center (Product
// management > Product identity) live in config/msstore.json. While any of the three is still a placeholder a Store
// upload cannot be built: the build refuses, unless --local-test is passed. A local test package uses the REAL
// identity when the config has one (so the self-signed test certificate subject equals the real Publisher), and the
// made-up LOCAL_TEST_IDENTITY only as a fallback while placeholders remain.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_LOCATIONS, parseDataLocation } from '../../server/dataLocation.js';

export const STORE_CONFIG = 'config/msstore.json';
export const PLACEHOLDER_PREFIX = 'PLACEHOLDER';
/** The three values Partner Center decides; displayName is ours. */
export const OWNER_FIELDS = Object.freeze(['identityName', 'publisher', 'publisherDisplayName']);

/** Fallback identity of a local test package while config/msstore.json has placeholders. It matches no Partner Center product. */
export const LOCAL_TEST_IDENTITY = Object.freeze({
  identityName: 'Burrow.LocalTest',
  publisher: 'CN=Burrow Local Test',
  publisherDisplayName: 'Burrow Local Test',
  displayName: 'Burrow',
});

// Package/Identity/Name: 3 to 50 characters, letters, digits, period and dash, starting and ending with a letter or digit.
const IDENTITY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{1,48}[A-Za-z0-9]$/;
const MAX_TEXT = 256;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * @param {unknown} value
 * @returns {boolean} true when the value is empty or still a placeholder
 */
export function isPlaceholder(value) {
  return typeof value !== 'string' || value.trim() === '' || value.trim().toUpperCase().startsWith(PLACEHOLDER_PREFIX);
}

/**
 * Reads config/msstore.json.
 * @param {string} root repository root
 * @returns {Record<string, unknown>}
 * @throws {Error} when the file is missing or not a JSON object
 */
export function readStoreConfig(root) {
  const file = path.join(root, ...STORE_CONFIG.split('/'));
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${STORE_CONFIG} is missing or is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${STORE_CONFIG} must be a JSON object`);
  return parsed;
}

/**
 * The data location to build: `cli` (--data-location) wins over config/msstore.json "dataLocation"; both default to
 * `appdata`. `appdata` keeps the manifest with rescap:unvirtualizedResources and the app writes %APPDATA%\Burrow;
 * `userprofile` is the fallback when Partner Center refuses that capability (the app writes %USERPROFILE%\Burrow Data).
 * @param {{ config: Record<string, unknown>, cli?: string | null }} opts
 * @returns {{ dataLocation: 'appdata' | 'userprofile', from: 'cli' | 'config' | 'default' }}
 * @throws {Error} on a value that is not one of appdata, userprofile
 */
export function resolveDataLocationSetting({ config, cli = null }) {
  const pick = (value, label) => {
    const parsed = parseDataLocation(typeof value === 'string' ? value.trim() : value);
    if (parsed === null) throw new Error(`${label} must be one of ${DATA_LOCATIONS.join(', ')} (got ${JSON.stringify(value)})`);
    return parsed;
  };
  if (cli !== null && cli !== undefined) return { dataLocation: pick(cli, '--data-location'), from: 'cli' };
  if (config.dataLocation !== undefined) return { dataLocation: pick(config.dataLocation, `${STORE_CONFIG}: dataLocation`), from: 'config' };
  return { dataLocation: 'appdata', from: 'default' };
}

/**
 * @param {Record<string, unknown>} config
 * @returns {string[]} the owner fields that are still empty or placeholders
 */
export function placeholderFields(config) {
  return OWNER_FIELDS.filter((name) => isPlaceholder(config[name]));
}

function checkText(name, value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${STORE_CONFIG}: ${name} is empty`);
  if (value !== value.trim()) throw new Error(`${STORE_CONFIG}: ${name} has spaces around it; paste the value exactly`);
  if (value.length > MAX_TEXT) throw new Error(`${STORE_CONFIG}: ${name} is longer than ${MAX_TEXT} characters`);
  if (CONTROL_RE.test(value)) throw new Error(`${STORE_CONFIG}: ${name} contains a control character`);
}

/**
 * Checks the shape Partner Center gives out, so a paste mistake fails here and not at upload.
 * @param {{ identityName: string, publisher: string, publisherDisplayName: string, displayName: string }} identity
 * @throws {Error} naming the field
 */
export function assertIdentityShape(identity) {
  for (const name of [...OWNER_FIELDS, 'displayName']) checkText(name, identity[name]);
  if (!IDENTITY_NAME_RE.test(identity.identityName)) {
    throw new Error(`${STORE_CONFIG}: identityName "${identity.identityName}" is not a valid package name (3 to 50 letters, digits, "." or "-")`);
  }
  if (!/^CN=\S.*$/.test(identity.publisher)) {
    throw new Error(`${STORE_CONFIG}: publisher must start with CN= (copy "Package/Identity/Publisher" from Partner Center)`);
  }
}

/**
 * The identity to build with. `source` is 'partner-center' (a Store build), 'local-test' (a test build with the real
 * identity from the config) or 'local-test-fallback' (a test build with the made-up identity, only while the config
 * still has placeholders).
 * @param {{ config: Record<string, unknown>, localTest?: boolean }} opts
 * @returns {{ identity: { identityName: string, publisher: string, publisherDisplayName: string, displayName: string }, source: 'partner-center' | 'local-test' | 'local-test-fallback' }}
 * @throws {Error} while owner values are placeholders (unless `localTest`), or when a value has the wrong shape
 */
export function resolveIdentity({ config, localTest = false }) {
  const missing = placeholderFields(config);
  if (localTest && missing.length > 0) return { identity: { ...LOCAL_TEST_IDENTITY }, source: 'local-test-fallback' };
  if (missing.length > 0) {
    throw new Error(
      `${STORE_CONFIG} still has placeholders for: ${missing.join(', ')}. ` +
        'Copy them from Partner Center (Product management > Product identity), or pass --local-test for a test package that cannot be uploaded.',
    );
  }
  const hasDisplayName = typeof config.displayName === 'string' && config.displayName.trim() !== '';
  // An upload must carry the reserved Store name exactly (Properties/DisplayName has to equal it), so there is no
  // silent default for it; only a sideload test package may fall back to "Burrow".
  if (!hasDisplayName && !localTest) {
    throw new Error(`${STORE_CONFIG}: displayName is empty. Copy the reserved Store name from Partner Center (Product management > Product identity); a Store upload cannot use a default.`);
  }
  const identity = {
    identityName: config.identityName,
    publisher: config.publisher,
    publisherDisplayName: config.publisherDisplayName,
    displayName: hasDisplayName ? config.displayName : 'Burrow',
  };
  assertIdentityShape(identity);
  return { identity, source: localTest ? 'local-test' : 'partner-center' };
}
