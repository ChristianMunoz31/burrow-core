// AppxManifest.xml for the Microsoft Store (MSIX) build of Burrow, written from a template per architecture.
//
// Why each non-default choice is here (docs/MICROSOFT_STORE.md has the long version):
// - rescap:runFullTrust: Burrow is a normal Win32 app (a Tauri exe that starts a Node SEA sidecar). Required for any
//   desktop app in the Store; it needs the owner's "restricted capability" justification in Partner Center.
// - rescap:unvirtualizedResources + desktop6:FileSystemWriteVirtualization=disabled: by default MSIX redirects NEW files
//   an app creates under %APPDATA% into the package-private LocalCache and deletes them on uninstall (files that
//   already exist are edited in place). That would split burrow.db from its -wal and -shm files and from backups,
//   and lose them when the app is removed. With virtualization off, the Store build reads and writes the same real
//   %APPDATA%\Burrow (and Burrow Dev) folder as the direct installer.
// - dataLocation "userprofile" (config/msstore.json "dataLocation" or --data-location): for when Partner Center refuses
//   rescap:unvirtualizedResources. Microsoft's schema page says desktop6:FileSystemWriteVirtualization "is currently intended to
//   be used only by certain types of desktop PC games that are published by Microsoft and our partners". The manifest then omits
//   the desktop6 namespace, the FileSystemWriteVirtualization element and the unvirtualizedResources capability and keeps
//   runFullTrust; nothing else differs. New files under AppData are then virtualized into the package's LocalCache (deleted on
//   uninstall), so the app keeps its data in %USERPROFILE%\Burrow Data instead, which MSIX does not virtualize ("Apart from AppData,
//   the app can write to any location where the user has write access, including other parts of %userprofile%",
//   https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization). The app must be compiled for it
//   (BURROW_DATA_LOCATION=userprofile, scripts/release/buildStore.mjs does both). docs/MICROSOFT_STORE.md has the runbook.
// - Registry write virtualization stays on its default: Burrow and the Tauri plugins it uses write no registry keys.
// - MinVersion 10.0.18362.0 (Windows 10 version 1903): the first release that has desktop6:FileSystemWriteVirtualization
//   ("Minimum OS Version: Windows 10 version 1903 (Build 18362)",
//   https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-desktop6-filesystemwritevirtualization)
//   and unvirtualizedResources ("introduced in Windows 10, version 1903 (10.0; Build 18362)",
//   https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization). Burrow needs both to write the real
//   %APPDATA%\Burrow, so this is the lowest version that works. Windows 11 ships the WebView2 runtime; Windows 10 may need it
//   installed (docs/MICROSOFT_STORE.md).
// - Properties/DisplayName must equal the Store name reserved in Partner Center ("Burrow: Private Life Organizer").
//   uap:VisualElements/DisplayName (Start menu, app list) uses the same value so the package has one name. The app's own
//   window and in-app branding stay "Burrow"; this name is only package metadata.
import { STABLE_VERSION_RE } from '../../server/channel.js';
import { DATA_LOCATIONS } from '../../server/dataLocation.js';

export const MIN_WINDOWS_VERSION = '10.0.18362.0';
export const MAX_WINDOWS_VERSION_TESTED = '10.0.26100.0';
export const APP_ID = 'Burrow';
export const APP_EXECUTABLE = 'Burrow.exe';
export const SIDECAR_EXECUTABLE = 'burrow-server.exe';
/** Capabilities per data location: the userprofile manifest keeps only runFullTrust. */
export const CAPABILITIES_BY_DATA_LOCATION = Object.freeze({
  appdata: Object.freeze(['runFullTrust', 'unvirtualizedResources']),
  userprofile: Object.freeze(['runFullTrust']),
});
export const CAPABILITIES = CAPABILITIES_BY_DATA_LOCATION.appdata;
export const ARCHITECTURES = Object.freeze({ arm64: 'aarch64-pc-windows-msvc', x64: 'x86_64-pc-windows-msvc' });
export const DESCRIPTION = 'Private, local-first budget and journal tracker. Your data stays on your computer.';
export const ASSET_REFS = Object.freeze({
  logo: 'Assets\\StoreLogo.png',
  square150: 'Assets\\Square150x150Logo.png',
  square44: 'Assets\\Square44x44Logo.png',
});

const MAX_PART = 65535;

/**
 * Package version for the Store: the app version x.y.z as x.y.z.0, identical to the app version. The Store reserves the
 * fourth part (it must be 0) and the first part cannot be 0 ("The other sections must be set to an integer between 0 and
 * 65535 (except for the first section, which cannot be 0)", https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements).
 * So a 0.x app version is refused for an upload build; only a local sideload test (`localTest`) may use it, because that
 * package is never uploaded. Also the bundle version.
 * @param {string} version package.json version
 * @param {{ localTest?: boolean }} [opts] `localTest` allows a 0.x version (sideload only)
 * @returns {string} x.y.z.0
 * @throws {Error} on a prerelease or dev version, a 0.x version without `localTest`, or a part above 65535
 */
export function toStoreVersion(version, { localTest = false } = {}) {
  if (typeof version !== 'string' || !STABLE_VERSION_RE.test(version)) {
    throw new Error(`The Store build needs a stable x.y.z version (found "${String(version)}"); a dev or prerelease version is not allowed`);
  }
  const parts = version.split('.').map(Number);
  if (parts[0] === 0 && !localTest) {
    throw new Error(`The Store refuses app version ${version}: the first section of a package version cannot be 0. Release Burrow 1.0.0 or later first (docs/RELEASING.md, "Release-As"). A --local-test build may use a 0.x version for sideload testing only.`);
  }
  if (parts.some((p) => p > MAX_PART)) {
    throw new Error(`Version ${version} has a part above ${MAX_PART} (MSIX allows 0 to ${MAX_PART})`);
  }
  return `${parts.join('.')}.0`;
}

/**
 * @param {string} text
 * @returns {string} text safe inside an XML attribute or element
 */
export function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * The manifest for one architecture.
 * @param {{ identity: { identityName: string, publisher: string, publisherDisplayName: string, displayName: string },
 *   version: string, arch: 'arm64' | 'x64', localTest?: boolean, dataLocation?: 'appdata' | 'userprofile' }} opts `version` is the
 *   package.json version (see toStoreVersion; `localTest` allows a 0.x version); `dataLocation` (default `appdata`) `userprofile`
 *   leaves out the desktop6 namespace, the FileSystemWriteVirtualization element and the unvirtualizedResources capability
 * @returns {string}
 * @throws {Error} on a bad version or architecture
 */
export function buildManifest({ identity, version, arch, localTest = false, dataLocation = 'appdata' }) {
  if (!Object.hasOwn(ARCHITECTURES, arch)) throw new Error(`Unknown architecture "${String(arch)}": expected ${Object.keys(ARCHITECTURES).join(' or ')}`);
  if (!DATA_LOCATIONS.includes(dataLocation)) throw new Error(`Unknown data location "${String(dataLocation)}": expected ${DATA_LOCATIONS.join(' or ')}`);
  const storeVersion = toStoreVersion(version, { localTest });
  const e = xmlEscape;
  const virtualizationOff = dataLocation === 'appdata';
  // appdata: the original manifest (virtualization off, so the app writes the real %APPDATA%). userprofile: none of the three desktop6/unvirtualizedResources parts.
  const desktop6Namespace = virtualizationOff ? '  xmlns:desktop6="http://schemas.microsoft.com/appx/manifest/desktop/windows10/6"\n' : '';
  const desktop6Virtualization = virtualizationOff ? '    <desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>\n' : '';
  return `<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
${desktop6Namespace}  IgnorableNamespaces="${virtualizationOff ? 'uap rescap desktop6' : 'uap rescap'}">
  <Identity Name="${e(identity.identityName)}" Publisher="${e(identity.publisher)}" Version="${storeVersion}" ProcessorArchitecture="${arch}" />
  <Properties>
    <DisplayName>${e(identity.displayName)}</DisplayName>
    <PublisherDisplayName>${e(identity.publisherDisplayName)}</PublisherDisplayName>
    <Logo>${ASSET_REFS.logo}</Logo>
${desktop6Virtualization}  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="${MIN_WINDOWS_VERSION}" MaxVersionTested="${MAX_WINDOWS_VERSION_TESTED}" />
  </Dependencies>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Applications>
    <Application Id="${APP_ID}" Executable="${APP_EXECUTABLE}" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
        DisplayName="${e(identity.displayName)}"
        Description="${e(DESCRIPTION)}"
        BackgroundColor="transparent"
        Square150x150Logo="${ASSET_REFS.square150}"
        Square44x44Logo="${ASSET_REFS.square44}" />
    </Application>
  </Applications>
  <Capabilities>
${CAPABILITIES_BY_DATA_LOCATION[dataLocation].map((name) => `    <rescap:Capability Name="${name}" />`).join('\n')}
  </Capabilities>
</Package>
`;
}
