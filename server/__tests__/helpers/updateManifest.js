// Synthetic latest.json documents and fake responses for the update check tests (no network, no real hosts).
const BASE = 'https://github.com/ChristianMunoz31/burrow-releases/releases';

export const installerUrl = (version, arch) => `${BASE}/download/v${version}/Burrow-Setup-${arch}.exe`;

/** A schema-valid manifest for `version`; `over` replaces top-level keys. */
export const manifest = (version = '1.2.0', over = {}) => ({
  version,
  notes: 'New:\n- A plain line',
  pub_date: '2030-01-01T00:00:00Z',
  platforms: {
    'windows-x86_64': { signature: 'c2lnLXg2NA==', url: installerUrl(version, 'x64') },
    'windows-aarch64': { signature: 'c2lnLWFybTY0', url: installerUrl(version, 'arm64') },
  },
  ...over,
});

/** A fake fetch response (node-fetch shape: status, ok, headers.get, text). */
export const respond = (status, body, { raw, headers } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Map(Object.entries(headers ?? {})),
  text: async () => raw ?? JSON.stringify(body),
});

export const redirectTo = (location, status = 302) => respond(status, {}, { headers: { location } });
