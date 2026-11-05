// Extra Settings sections contributed by a build, none in the core. Each entry:
//   { id, label, icon, Component, enabled(info): boolean }
// `enabled` reads GET /api/app/info; `Component` renders the section card. Vite swaps this module for the
// developer-tools list in dev-tool builds (scripts/build/devToolsUi.js), so no extension code reaches a stable build.
/** @type {ReadonlyArray<{ id: string, label: string, icon: import('react').ElementType, Component: import('react').ComponentType, enabled: (info: object | null | undefined) => boolean }>} */
export const SETTINGS_EXTENSIONS = Object.freeze([]);
