// Installs the real Pro module (pro/server/index.js) for a Pro server test. Only tests under pro/ may import this
// helper (server/__tests__/proBoundary.test.js); core tests never install the module, so they behave the same with
// and without pro/.
//
//   beforeAll(async () => { await installProModuleForTests(); });
//   afterAll(() => { uninstallProModuleForTests(); });
import { loadProExtensions, resetProExtensionsForTests } from '../../proExtensions.js';
import { importProExtension } from '../../proExtensionsLoader.js';

/** Installs the real module; throws when pro/ is missing or the install was refused. */
export async function installProModuleForTests() {
  const ok = await loadProExtensions({ importer: importProExtension, log: () => {} });
  if (!ok) throw new Error('pro/ module missing');
}

/** Empties the Pro routers and every registry. */
export function uninstallProModuleForTests() {
  resetProExtensionsForTests();
}
