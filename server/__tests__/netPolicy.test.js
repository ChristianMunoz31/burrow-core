// Outbound-network opt-in: everything is off by default, env can pre-enable, stored choices
// win, storage failures fall back to env only, and the gated routes/integrations make no request.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({ store: new Map(), down: false }));

vi.mock('../../loadEnv.js', () => ({}));
vi.mock('node-fetch', () => ({ default: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) }));
vi.mock('../dataAccess.js', () => {
  const unavailable = () => Object.assign(new Error('Local database is unavailable.'), { status: 503 });
  return {
    getState: vi.fn(async (key, fallback = null) => {
      if (h.down) throw unavailable();
      return h.store.has(key) ? h.store.get(key) : fallback;
    }),
    setState: vi.fn(async (key, value) => {
      if (h.down) throw unavailable();
      h.store.set(key, value);
      return { key, value };
    }),
  };
});

import fetch from 'node-fetch';
import {
  NETWORK_FEATURES,
  NetworkOptInError,
  __resetNetPolicyForTests,
  isEnabled,
  listNetworkFeatures,
  networkRequiredBody,
  requireNetwork,
  setNetworkFeature,
} from '../netPolicy.js';
import { fetchOura, fetchWeather } from '../integrations.js';

const ORIGINAL_OPT_IN = process.env.BURROW_NETWORK_OPTIN;

beforeEach(() => {
  delete process.env.BURROW_NETWORK_OPTIN;
  h.store.clear();
  h.down = false;
  __resetNetPolicyForTests();
  fetch.mockClear();
});
afterEach(() => {
  if (ORIGINAL_OPT_IN === undefined) delete process.env.BURROW_NETWORK_OPTIN;
  else process.env.BURROW_NETWORK_OPTIN = ORIGINAL_OPT_IN;
  __resetNetPolicyForTests();
});

describe('defaults', () => {
  it('every feature is off', async () => {
    for (const id of ['weather', 'oura', 'sheets', 'cloudAi', 'aiLan', 'updates', 'license']) expect(await isEnabled(id)).toBe(false);
  });

  it('lists the features in fixed order with label, description and hosts', async () => {
    const { features } = await listNetworkFeatures();
    expect(features.map((f) => f.id)).toEqual(['weather', 'oura', 'sheets', 'cloudAi', 'aiLan', 'updates', 'license']);
    for (const f of features) {
      expect(f.enabled).toBe(false);
      expect(typeof f.label).toBe('string');
      expect(typeof f.description).toBe('string');
      expect(f.hosts.length).toBeGreaterThan(0);
      expect(Object.keys(f).sort()).toEqual(['description', 'enabled', 'hosts', 'id', 'label']);
    }
    expect(NETWORK_FEATURES).toHaveLength(7);
    // The license feature is last and names both stores; only Activate and Move to another computer use it.
    expect(NETWORK_FEATURES.at(-1)).toMatchObject({
      id: 'license',
      label: 'License activation',
      hosts: ['api.gumroad.com', 'api.lemonsqueezy.com'],
    });
    expect(NETWORK_FEATURES.at(-1).description).toBe(
      'Contacts Gumroad or Lemon Squeezy only when you click Activate or Move to another computer in Settings > License. Your license key goes to the store you bought from. Clicking one of those buttons turns this on.',
    );
    // The oura feature also covers testing a saved token, so it reaches only the Oura host.
    expect(NETWORK_FEATURES.find((f) => f.id === 'oura').hosts).toEqual(['api.ouraring.com']);
  });

  it('updates lists GitHub and its download hosts, and says nothing is downloaded before the click', () => {
    const updates = NETWORK_FEATURES.find((f) => f.id === 'updates');
    expect(updates.hosts).toEqual([
      'github.com',
      'release-assets.githubusercontent.com',
      'objects.githubusercontent.com',
      'api.github.com',
    ]);
    expect(updates.description).toContain('Nothing is downloaded until you click Download and install.');
    expect(updates.description).toContain("A copy that can't install updates by itself shows the installer's checksum from GitHub instead");
    expect(updates.description).not.toContain('only by Burrow Dev');
    expect(updates.description).toContain('Burrow reads the checksum file (SHA256SUMS.txt) from GitHub');
    expect(updates.policy.when).toContain('api.github.com');
    expect(updates.policy.when).toContain('npm start');
    expect(updates.policy.when).not.toContain('Only in the direct download edition');
    expect(updates.description).not.toContain('—');
  });

  it('an unknown id is never enabled', async () => {
    process.env.BURROW_NETWORK_OPTIN = 'nope';
    expect(await isEnabled('nope')).toBe(false);
  });
});

describe('BURROW_NETWORK_OPTIN', () => {
  it('pre-enables the listed features and ignores unknown names', async () => {
    process.env.BURROW_NETWORK_OPTIN = ' weather , sheets,bogus,github ';
    expect(await isEnabled('weather')).toBe(true);
    expect(await isEnabled('sheets')).toBe(true);
    expect(await isEnabled('github')).toBe(false);
    expect(await isEnabled('oura')).toBe(false);
    expect((await listNetworkFeatures()).features.filter((f) => f.enabled).map((f) => f.id)).toEqual([
      'weather',
      'sheets',
    ]);
  });

  it('is the only source when storage is unavailable', async () => {
    h.down = true;
    process.env.BURROW_NETWORK_OPTIN = 'oura';
    expect(await isEnabled('oura')).toBe(true);
    expect(await isEnabled('weather')).toBe(false);
  });
});

describe('stored choice', () => {
  it('persists under network.optIn and turns a feature on', async () => {
    await setNetworkFeature('sheets', true);
    expect(h.store.get('network.optIn')).toEqual({ sheets: true });
    expect(await isEnabled('sheets')).toBe(true);
    expect(await isEnabled('weather')).toBe(false);
  });

  it('wins over the env default in both directions', async () => {
    process.env.BURROW_NETWORK_OPTIN = 'weather';
    await setNetworkFeature('weather', false);
    await setNetworkFeature('oura', true);
    expect(await isEnabled('weather')).toBe(false);
    expect(await isEnabled('oura')).toBe(true);
  });

  it('keeps other features when one changes, and ignores junk in storage', async () => {
    h.store.set('network.optIn', { weather: true, github: 'yes', extra: true });
    await setNetworkFeature('oura', true);
    expect(h.store.get('network.optIn')).toEqual({ weather: true, oura: true });
  });

  it('setNetworkFeature rejects when storage is down', async () => {
    h.down = true;
    await expect(setNetworkFeature('weather', true)).rejects.toMatchObject({ status: 503 });
  });
});

describe('requireNetwork middleware', () => {
  const app = () => {
    const a = express();
    for (const f of NETWORK_FEATURES) a.get(`/x/${f.id}`, requireNetwork(f.id), (req, res) => res.json({ ok: true }));
    return a;
  };

  it.each(NETWORK_FEATURES.map((f) => [f.id, f.label]))('403s %s with the contract body while off', async (id, label) => {
    const res = await request(app()).get(`/x/${id}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'network_opt_in_required',
      feature: id,
      message: `${label} is turned off. Enable it in Settings → Network (this calls the internet).`,
    });
    expect(res.body).toEqual(networkRequiredBody(id));
  });

  it('lets the request through once enabled', async () => {
    await setNetworkFeature('weather', true);
    const res = await request(app()).get('/x/weather');
    expect(res.status).toBe(200);
    expect((await request(app()).get('/x/oura')).status).toBe(403);
  });
});

describe('integrations make no request while gated off', () => {
  it('fetchWeather throws NetworkOptInError before calling fetch', async () => {
    await expect(fetchWeather({ lat: 1, lon: 2 })).rejects.toBeInstanceOf(NetworkOptInError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetchOura with a token throws before calling fetch; without one it reports not_configured offline', async () => {
    await expect(fetchOura('tok')).rejects.toMatchObject({ feature: 'oura', status: 403 });
    expect(fetch).not.toHaveBeenCalled();
    await expect(fetchOura('')).rejects.toMatchObject({ code: 'not_configured', status: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetchWeather calls out once weather is enabled', async () => {
    await setNetworkFeature('weather', true);
    await fetchWeather({ lat: 1, lon: 2 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain('api.open-meteo.com');
  });
});
