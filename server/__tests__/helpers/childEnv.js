// Minimal environment for spawned test children: OS basics plus explicit overrides. VITEST and the
// developer's own BURROW_*/token variables are deliberately not inherited.
const BASICS = ['PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR'];

/**
 * @param {Record<string, string>} overrides
 * @returns {Record<string, string>}
 */
export function childEnv(overrides) {
  const env = {};
  for (const k of BASICS) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...overrides };
}
