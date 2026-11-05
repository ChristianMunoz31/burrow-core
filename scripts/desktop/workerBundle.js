// esbuild settings shared by the sidecar bundle and the worker bundles, and the extra esbuild passes that turn
// server/backup/worker/backupWorker.js and server/folders/parserWorker.js into one CJS source string each. The
// sidecar embeds those strings (defines __BURROW_BACKUP_WORKER_SRC__ and __BURROW_PARSER_WORKER_SRC__) and
// server/backup/worker/client.js and server/folders/parseDocs.js start them with new Worker(src, { eval: true }),
// because inside a Node SEA there is no worker file on disk.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { CHANNELS, DEV_VERSION_RE, resolveBuildChannel } from '../../server/channel.js';
import { DATA_LOCATIONS, assertBuildDataLocation } from '../../server/dataLocation.js';
import { DISTRIBUTIONS } from '../../server/distribution.js';
import { BUILD_INFO_FILE } from '../../server/license/constants.js';
import { loadBuildInfo } from '../../server/license/buildInfo.js';
import { PRO_HEADER, checkProServerImport } from '../build/proBoundary.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WORKER_ENTRY = path.join(ROOT, 'server', 'backup', 'worker', 'backupWorker.js');
export const PARSER_WORKER_ENTRY = path.join(ROOT, 'server', 'folders', 'parserWorker.js');

/** App version from package.json (the bundle bakes it in). */
export function readAppVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
}

/**
 * The build date the build-info writer produced (dist/burrow-build-info.json), baked into the bundle so a
 * user-editable dist file cannot move the desktop build date.
 * @param {string} [distDir]
 * @returns {string} ISO build date
 * @throws {Error} when the file is missing or invalid
 */
export function readBundledBuildDate(distDir = path.join(ROOT, 'dist')) {
  const info = loadBuildInfo({ distDir, bundled: undefined });
  if (info.buildDateIso === null) {
    throw new Error(`${BUILD_INFO_FILE} is missing or invalid in ${distDir}: run npm run build first`);
  }
  return info.buildDateIso;
}

/** First characters of the channel marker comment at the top of every sidecar bundle. */
export const CHANNEL_MARKER_PREFIX = '/*! BURROW_CHANNEL=';

/**
 * The marker line scripts/checks/channelMarker.js reads back from a bundle.
 * @param {'stable' | 'dev'} channel
 * @returns {string}
 */
export function channelBanner(channel) {
  assertChannel(channel);
  return `${CHANNEL_MARKER_PREFIX}${channel} */\n`;
}

/** First characters of the distribution marker comment that follows the channel marker in a Store sidecar bundle. */
export const DISTRIBUTION_MARKER_PREFIX = '/*! BURROW_DISTRIBUTION=';

/**
 * The marker for the bundle's distribution. Empty for `direct`, so only the banner of a direct bundle is unchanged
 * from before the Store build existed (the rest of the bundle differs, for example by the baked-in distribution define);
 * `store` gets its own comment line right after the channel marker.
 * @param {'direct' | 'store'} distribution
 * @returns {string}
 */
export function distributionBanner(distribution) {
  assertDistribution(distribution);
  return distribution === 'store' ? `${DISTRIBUTION_MARKER_PREFIX}store */
` : '';
}

/** First characters of the data location marker comment that follows the distribution marker in a userprofile bundle. */
export const DATA_LOCATION_MARKER_PREFIX = '/*! BURROW_DATA_LOCATION=';

/**
 * The marker for the bundle's data location. Empty for `appdata`, so a direct bundle's banner is unchanged;
 * `userprofile` (Store build only) gets its own comment line after the distribution marker.
 * @param {'appdata' | 'userprofile'} dataLocation
 * @returns {string}
 */
export function dataLocationBanner(dataLocation) {
  assertDataLocation(dataLocation);
  return dataLocation === 'userprofile' ? `${DATA_LOCATION_MARKER_PREFIX}userprofile */
` : '';
}

function assertDataLocation(dataLocation) {
  if (!DATA_LOCATIONS.includes(dataLocation)) {
    throw new Error(`Unknown data location "${String(dataLocation)}": expected one of ${DATA_LOCATIONS.join(', ')}`);
  }
}

function assertDistribution(distribution) {
  if (!DISTRIBUTIONS.includes(distribution)) {
    throw new Error(`Unknown distribution "${String(distribution)}": expected one of ${DISTRIBUTIONS.join(', ')}`);
  }
}

function assertChannel(channel) {
  if (!CHANNELS.includes(channel)) throw new Error(`Unknown channel "${String(channel)}": expected one of ${CHANNELS.join(', ')}`);
}

/**
 * esbuild defines. import.meta does not exist in CJS: it is pointed at the bundle (or exe) location so
 * the few fileURLToPath(new URL(..., import.meta.url)) call sites still resolve (env overrides win).
 * The channel is always baked in, so the shell environment cannot switch a stable sidecar to dev.
 * @param {string} version display version baked into the bundle
 * @param {{ channel?: 'stable' | 'dev', buildDate?: string, commit?: string | null, distribution?: 'direct' | 'store', dataLocation?: 'appdata' | 'userprofile', pro?: boolean }} [opts] `pro` (default false) is baked in as `__BURROW_PRO__` (whether the Pro module is bundled); `distribution` (default `direct`) is baked in as `__BURROW_DISTRIBUTION__`; `dataLocation` (default `appdata`, `userprofile` only with the store distribution) as `__BURROW_DATA_LOCATION__`; `buildDate` (ISO) is baked in as `__BURROW_BUILD_DATE__`; `commit` (short SHA, resolved once by the caller, default none) as `__BURROW_COMMIT__`
 * @returns {Record<string, string>}
 * @throws {Error} on an unknown channel
 */
export const bundleDefine = (version, { channel = 'stable', buildDate, commit = null, distribution = 'direct', dataLocation = 'appdata', pro = false } = {}) => {
  assertChannel(channel);
  assertDistribution(distribution);
  assertDataLocation(dataLocation);
  assertBuildDataLocation({ dataLocation, distribution, channel });
  return {
    ...(buildDate === undefined ? {} : { __BURROW_BUILD_DATE__: JSON.stringify(buildDate) }),
    // Short git SHA at bundle time (null when git is unavailable), so a packaged build needs no git at runtime.
    __BURROW_COMMIT__: JSON.stringify(commit ?? null),
    'import.meta.url': '__importMetaUrl',
    __BURROW_APP_VERSION__: JSON.stringify(version),
    // Consumed by server/license/channelSeam.js (docs/LICENSING.md 4.7).
    __BURROW_RELEASE_BUILD__: 'true',
    __BURROW_CHANNEL__: JSON.stringify(channel),
    __BURROW_DISTRIBUTION__: JSON.stringify(distribution),
    __BURROW_DATA_LOCATION__: JSON.stringify(dataLocation),
    // Consumed by server/license/channelSeam.js devToolsCompiledIn: only a dev bundle can load a developer extension.
    __BURROW_DEV_TOOLS__: channel === 'dev' ? 'true' : 'false',
    // Consumed by server/folders/docGate.js: PDF and DOCX parsing is off in every bundled build (issue #67), so BURROW_DOC_PARSING cannot turn it on.
    __BURROW_DOC_PARSING__: 'false',
    // Consumed by server/license/channelSeam.js proCompiledIn: false when the bundle was built without pro/.
    __BURROW_PRO__: pro ? 'true' : 'false',
  };
};

const samePath = (a, b) => path.relative(a, b) === '';

/**
 * esbuild plugin that decides where the developer tools stand in a bundle by rewriting one import. Core imports
 * server/devExtensionsLoader.js (the only file that names devtools/); stable and Store bundles get
 * devExtensionsLoader.none.js instead (a stub that finds nothing), so no devtools/ code or marker can enter them,
 * and a stable bundle fails when anything under devtools/ is still loaded. A dev bundle gets devtools/server/static.js,
 * which bundles the extension statically; it fails loud when devtools/ is missing.
 * @param {'stable' | 'dev'} channel
 * @param {{ root?: string, exists?: (file: string) => boolean }} [opts] test seams
 * @returns {import('esbuild').Plugin}
 * @throws {Error} on an unknown channel
 */
export function devToolsPlugin(channel, { root = ROOT, exists = fs.existsSync } = {}) {
  assertChannel(channel);
  const loaderFile = path.join(root, 'server', 'devExtensionsLoader.js');
  const loaderNone = path.join(root, 'server', 'devExtensionsLoader.none.js');
  const devStatic = path.join(root, 'devtools', 'server', 'static.js');
  const devtoolsDir = path.join(root, 'devtools');
  return {
    name: 'burrow-dev-tools',
    setup(buildApi) {
      if (channel === 'dev' && !exists(devStatic)) {
        throw new Error(`A dev bundle needs the developer tools but ${path.relative(root, devStatic)} is missing`);
      }
      buildApi.onResolve({ filter: /(^|[\\/])devExtensionsLoader\.js$/ }, (args) => {
        if (!samePath(loaderFile, path.resolve(args.resolveDir, args.path))) return undefined;
        return { path: channel === 'dev' ? devStatic : loaderNone };
      });
      if (channel === 'stable') {
        buildApi.onLoad({ filter: /[\\/]devtools[\\/]/ }, (args) => {
          const rel = path.relative(devtoolsDir, args.path);
          if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
          return { errors: [{ text: 'devtools must not enter a stable bundle', location: { file: args.path } }] };
        });
      }
    },
  };
}

/** First characters of the Pro marker comment, the second banner line of every sidecar and worker bundle. */
export const PRO_MARKER_PREFIX = '/*! BURROW_PRO=';
export const PRO_MARKER_ON = '/*! BURROW_PRO=on */';
export const PRO_MARKER_OFF = '/*! BURROW_PRO=off */';

/**
 * The Pro marker line (docs/adr/0001-open-core-split.md 3.10). It follows the channel line, which stays first.
 * @param {boolean} pro
 * @returns {string}
 */
export function proBanner(pro) {
  return `${pro ? PRO_MARKER_ON : PRO_MARKER_OFF}\n`;
}

/** The Pro module entry esbuild swaps in for the loader. */
export const proStaticPath = (root = ROOT) => path.join(root, 'pro', 'server', 'static.js');

/**
 * Whether this build includes the Pro module: present when pro/server/static.js exists.
 * @param {{ root?: string, exists?: (file: string) => boolean, requirePro?: boolean }} [opts]
 * @returns {boolean}
 * @throws {Error} when requirePro is set and pro/ is missing
 */
export function resolveProBuild({ root = ROOT, exists = fs.existsSync, requirePro = false } = {}) {
  const present = exists(proStaticPath(root));
  if (requirePro && !present) {
    throw new Error('An official build needs the Pro module but pro/server/static.js is missing');
  }
  return present;
}

/**
 * esbuild plugin that decides where the Pro module stands in a bundle by rewriting one import (the inverse of the
 * developer tools: present means included in every build kind). Core imports server/proExtensionsLoader.js (the only
 * runtime file that names pro/); with pro/ it resolves to pro/server/static.js, which bundles the module statically,
 * and every import made from pro/server is checked against the Pro allowlist (scripts/build/proBoundary.js), so a
 * violation fails the build. Without pro/ it resolves to proExtensionsLoader.none.js and anything under pro/ that is
 * still loaded fails the build.
 * @param {{ requirePro?: boolean, root?: string, exists?: (file: string) => boolean }} [opts]
 * @returns {import('esbuild').Plugin}
 */
export function proPlugin({ requirePro = false, root = ROOT, exists = fs.existsSync } = {}) {
  const loaderFile = path.join(root, 'server', 'proExtensionsLoader.js');
  const loaderNone = path.join(root, 'server', 'proExtensionsLoader.none.js');
  const proStatic = proStaticPath(root);
  const proDir = path.join(root, 'pro');
  const proServerDir = path.join(root, 'pro', 'server');
  const inside = (dir, file) => {
    const rel = path.relative(dir, file);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  const isTestPath = (file) => /[\\/]__tests__[\\/]/.test(file);
  return {
    name: 'burrow-pro',
    setup(buildApi) {
      const present = resolveProBuild({ root, exists, requirePro });
      buildApi.onResolve({ filter: /(^|[\\/])proExtensionsLoader\.js$/ }, (args) => {
        if (!samePath(loaderFile, path.resolve(args.resolveDir, args.path))) return undefined;
        return { path: present ? proStatic : loaderNone };
      });
      if (present) {
        // Every import made from Pro runtime code is checked against the allowlist (ADR 3.9).
        buildApi.onResolve({ filter: /.*/ }, (args) => {
          if (!args.importer || !inside(proServerDir, args.importer) || isTestPath(args.importer)) return undefined;
          if (args.kind !== 'import-statement' && args.kind !== 'entry-point') {
            return { errors: [{ text: `pro/server may not use ${args.kind} (${args.path})`, location: { file: args.importer } }] };
          }
          const why = checkProServerImport({ root, importer: args.importer, specifier: args.path, names: [], namespace: false });
          return why ? { errors: [{ text: why, location: { file: args.importer } }] } : undefined;
        });
        buildApi.onLoad({ filter: /[\\/]pro[\\/]server[\\/].*\.m?js$/ }, (args) => {
          if (!inside(proServerDir, args.path)) return undefined;
          const text = fs.readFileSync(args.path, 'utf8');
          if (!text.startsWith(PRO_HEADER)) {
            return { errors: [{ text: 'every Pro source file must start with the private header', location: { file: args.path } }] };
          }
          return undefined;
        });
      } else {
        buildApi.onLoad({ filter: /[\\/]pro[\\/]/ }, (args) => {
          if (!inside(proDir, args.path)) return undefined;
          return { errors: [{ text: 'pro/ must not enter a bundle built without the Pro module', location: { file: args.path } }] };
        });
      }
    },
  };
}

/**
 * Resolves the channel and the version baked into the bundle.
 * @param {{ channel: string | null, displayVersion: string | null, packageVersion: string }} opts
 * @returns {{ channel: 'stable' | 'dev', version: string }}
 */
export function resolveChannelBuild({ channel, displayVersion, packageVersion }) {
  const resolved = resolveBuildChannel({ BURROW_CHANNEL: channel ?? '' }, '--channel');
  const display = (displayVersion ?? '').trim();
  if (resolved === 'stable') {
    if (display) throw new Error('--display-version is only for a dev build; a stable build uses the package.json version');
    return { channel: 'stable', version: packageVersion };
  }
  if (!DEV_VERSION_RE.test(display)) {
    throw new Error('A dev build needs --display-version (or BURROW_DISPLAY_VERSION) like 0.2.0-dev.20261005.abc1234');
  }
  return { channel: 'dev', version: display };
}

export const BUNDLE_BANNER =
  "var __importMetaUrl = require('node:url').pathToFileURL(typeof __filename === 'string' ? __filename : process.execPath).href;\n" +
  // node:sqlite prints an ExperimentalWarning; drop only that one, keep every other warning.
  "process.removeAllListeners('warning');process.on('warning',function(w){if(w&&w.name==='ExperimentalWarning'&&/SQLite/i.test(w.message))return;console.error(w&&w.stack?w.stack:String(w));});";

/**
 * Bundles one worker entry to a single CJS source string (nothing is written to disk).
 * @param {string} entry absolute path of the worker entry
 * @param {string} outName file name used only for esbuild's messages
 * @param {{ minify?: boolean, channel?: 'stable' | 'dev', version?: string, buildDate?: string, commit?: string | null, distribution?: 'direct' | 'store', dataLocation?: 'appdata' | 'userprofile', pro?: boolean }} [opts]
 * @returns {Promise<string>}
 */
async function buildWorkerSource(entry, outName, { minify = false, channel = 'stable', version = readAppVersion(), buildDate, commit = null, distribution = 'direct', dataLocation = 'appdata', pro = false } = {}) {
  const result = await build({
    entryPoints: [entry],
    write: false,
    outfile: path.join(ROOT, '.sidecar-build', outName),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    minify,
    legalComments: 'none',
    logLevel: 'warning',
    define: bundleDefine(version, { channel, buildDate, commit, distribution, dataLocation, pro }),
    // The workers never import the Pro loader; the plugin only keeps pro/ out when the build has no Pro module.
    plugins: [devToolsPlugin(channel), proPlugin({ exists: pro ? fs.existsSync : () => false })],
    // fflate's browser build: same zipSync, without the Node entry's bare require('module') and worker setup.
    alias: { fflate: 'fflate/browser' },
    banner: { js: channelBanner(channel) + proBanner(pro) + distributionBanner(distribution) + dataLocationBanner(dataLocation) + BUNDLE_BANNER },
  });
  const out = result.outputFiles?.[0];
  if (!out) throw new Error(`${outName} worker bundle produced no output`);
  return out.text;
}

/**
 * Bundles the backup worker entry to a single CJS source string (nothing is written to disk).
 * @param {Parameters<typeof buildWorkerSource>[2]} [opts]
 * @returns {Promise<string>}
 */
export const buildBackupWorkerSource = (opts) => buildWorkerSource(WORKER_ENTRY, 'backupWorker.cjs', opts);

/**
 * Bundles the Folders PDF/DOCX parser worker (server/folders/parserWorker.js, with unpdf's pdf.js build and fflate)
 * to a single CJS source string. The sidecar embeds it as __BURROW_PARSER_WORKER_SRC__.
 * @param {Parameters<typeof buildWorkerSource>[2]} [opts]
 * @returns {Promise<string>}
 */
export const buildParserWorkerSource = (opts) => buildWorkerSource(PARSER_WORKER_ENTRY, 'parserWorker.cjs', opts);
