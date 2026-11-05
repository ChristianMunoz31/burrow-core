// Finds makeappx.exe and signtool.exe in the newest installed Windows 10/11 SDK, for the host architecture
// (falls back to x64, which runs under emulation on Windows on ARM). Nothing is downloaded or installed.
import fs from 'node:fs';
import path from 'node:path';

const SDK_VERSION_RE = /^10\.0\.(\d+)\.(\d+)$/;

/**
 * @param {NodeJS.Architecture} [arch] defaults to this process
 * @returns {'arm64' | 'x64' | 'x86'}
 */
export function hostSdkArch(arch = process.arch) {
  if (arch === 'arm64') return 'arm64';
  if (arch === 'ia32') return 'x86';
  return 'x64';
}

/**
 * SDK version folder names, newest first.
 * @param {string[]} names
 * @returns {string[]}
 */
export function sortSdkVersions(names) {
  return names
    .map((name) => ({ name, m: SDK_VERSION_RE.exec(name) }))
    .filter((entry) => entry.m !== null)
    .sort((a, b) => Number(b.m[1]) - Number(a.m[1]) || Number(b.m[2]) - Number(a.m[2]))
    .map((entry) => entry.name);
}

/**
 * Default Windows Kits bin folder.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function defaultKitsBin(env = process.env) {
  const programFiles = env['ProgramFiles(x86)'] || env.ProgramFiles || 'C:\\Program Files (x86)';
  return path.join(programFiles, 'Windows Kits', '10', 'bin');
}

/**
 * Paths of the SDK tools.
 * @param {{ kitsBin?: string, arch?: NodeJS.Architecture, tools?: string[], readdir?: (dir: string) => string[],
 *   exists?: (file: string) => boolean }} [opts] `readdir` and `exists` are test seams
 * @returns {{ sdkVersion: string, arch: string, tools: Record<string, string> }}
 * @throws {Error} when no installed SDK has every tool
 */
export function findSdkTools({
  kitsBin = defaultKitsBin(),
  arch = process.arch,
  tools = ['makeappx', 'signtool'],
  readdir = (dir) => fs.readdirSync(dir),
  exists = (file) => fs.existsSync(file),
} = {}) {
  let versions;
  try {
    versions = sortSdkVersions(readdir(kitsBin));
  } catch {
    versions = [];
  }
  const wanted = hostSdkArch(arch);
  const archOrder = wanted === 'x64' ? ['x64'] : [wanted, 'x64'];
  for (const sdkVersion of versions) {
    for (const folder of archOrder) {
      const found = Object.fromEntries(tools.map((tool) => [tool, path.join(kitsBin, sdkVersion, folder, `${tool}.exe`)]));
      if (Object.values(found).every((file) => exists(file))) return { sdkVersion, arch: folder, tools: found };
    }
  }
  throw new Error(
    `Could not find ${tools.map((t) => `${t}.exe`).join(' and ')} in a Windows SDK under ${kitsBin}. ` +
      'Install the "Windows SDK Signing Tools for Desktop Apps" and "MSIX Packaging Tools" components (Visual Studio Installer, or the standalone Windows SDK).',
  );
}
