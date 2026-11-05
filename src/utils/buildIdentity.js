/**
 * One-line build identity: "Version 0.1.0 · stable · abc1234 · built 2026-10-05". Missing or invalid parts are
 * left out; null when nothing is left. The Microsoft Store build adds "Microsoft Store" after the channel so support
 * can tell it from a direct install (a direct build, or an answer without `distribution`, adds nothing). A build that keeps its
 * data in the user folder (`dataLocation` userprofile, the Store build only) adds "data in your user folder".
 * `devTools` true (the UI shows the developer tools) adds "developer tools" after the channel.
 * @param {{ version?: unknown, channel?: unknown, distribution?: unknown, dataLocation?: unknown, commit?: unknown, buildDate?: unknown } | null | undefined} info
 * @param {{ devTools?: boolean }} [opts]
 * @returns {string | null}
 */
export function formatBuildIdentity(info, { devTools = false } = {}) {
  if (!info || typeof info !== 'object') return null;
  const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const rawVersion = text(info.version);
  // getAppVersion() can answer 'unknown'; that is a missing version, never shown.
  const version = rawVersion && rawVersion.toLowerCase() !== 'unknown' ? rawVersion : null;
  const parts = [version ? `Version ${version}` : null, text(info.channel), devTools === true ? 'developer tools' : null, info.distribution === 'store' ? 'Microsoft Store' : null, info.dataLocation === 'userprofile' ? 'data in your user folder' : null, text(info.commit)];
  const rawDate = text(info.buildDate);
  const date = rawDate ? new Date(rawDate) : null;
  if (date && !Number.isNaN(date.getTime())) parts.push(`built ${date.toISOString().slice(0, 10)}`);
  const line = parts.filter(Boolean).join(' · ');
  return line || null;
}
