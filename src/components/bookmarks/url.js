/** Prefix a bare host ("example.com") with https:// so it is a valid link target. */
export function withProtocol(url) {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/** Hostname for a bookmark URL (bare hosts allowed), or null when it cannot be parsed. */
export function hostnameOf(url) {
  try {
    return new URL(withProtocol(url)).hostname.replace(/^www\./i, '') || null;
  } catch {
    return null;
  }
}

/** Deterministic hue (0-359) for a hostname, so the same site always gets the same color. */
export function hueForHost(host) {
  let hash = 0;
  for (let i = 0; i < host.length; i += 1) {
    hash = (hash * 31 + host.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}
