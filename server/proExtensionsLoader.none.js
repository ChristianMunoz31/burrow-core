// Stand-in for server/proExtensionsLoader.js in every bundle built without the Pro module (scripts/desktop/workerBundle.js
// proPlugin): the Pro module does not exist in a Free build.
export async function importProExtension() {
  return null;
}
