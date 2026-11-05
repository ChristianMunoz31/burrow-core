// Stand-in for server/devExtensionsLoader.js in every stable and Store bundle (scripts/desktop/workerBundle.js
// devToolsPlugin): the developer tools do not exist in those builds.
export async function importDevExtension() {
  return null;
}
