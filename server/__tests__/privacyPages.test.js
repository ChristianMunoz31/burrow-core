import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { NETWORK_FEATURES } from '../netFeatures.js';
import { NETWORK_FEATURES as POLICY_FEATURES, listNetworkFeatures } from '../netPolicy.js';
import { renderPages, esc } from '../../scripts/privacy/renderPrivacy.mjs';
import { findPrivacyProblems } from '../../scripts/privacy/checkPrivacy.mjs';

const rendered = renderPages();
const fromDisk = (rel) => {
  try {
    return readFileSync(new URL(`../../pages/${rel}`, import.meta.url), 'utf8');
  } catch {
    return null;
  }
};

describe('privacy pages', () => {
  it('netPolicy and the generator read the same registry', () => {
    expect(POLICY_FEATURES).toBe(NETWORK_FEATURES);
  });

  it('the Network settings payload shows exactly id, label, description and hosts', async () => {
    const { features } = await listNetworkFeatures();
    expect(Object.keys(features[0]).sort()).toEqual(['description', 'enabled', 'hosts', 'id', 'label']);
    expect(features.map(({ id, label, description, hosts }) => ({ id, label, description, hosts }))).toEqual(
      NETWORK_FEATURES.map(({ id, label, description, hosts }) => ({ id, label, description, hosts: [...hosts] })),
    );
  });

  it('every feature has plain-language policy copy', () => {
    for (const f of NETWORK_FEATURES) {
      expect(f.policy.sent.length).toBeGreaterThan(10);
      expect(f.policy.when.length).toBeGreaterThan(10);
    }
  });

  it("the weather policy says the forecast also loads for Javi's daily briefing", () => {
    const weather = NETWORK_FEATURES.find((f) => f.id === 'weather');
    expect(weather.policy.when).toMatch(/Javi's daily briefing/);
  });

  it('render is deterministic and mentions the contact, effective date and Microsoft statement', () => {
    expect(renderPages()).toEqual(rendered);
    const html = rendered['privacy/index.html'];
    expect(html).toContain('burrowsupport@gmail.com');
    expect(html).toContain('Effective 2026-10-11');
    expect(html).toContain('https://privacy.microsoft.com/privacystatement');
    expect(html).not.toMatch(/<script|https?:\/\/fonts\.|<link /i);
    expect(html).not.toContain('\u2014');
    expect(Object.keys(rendered).sort()).toEqual(['.nojekyll', 'index.html', 'privacy/index.html']);
  });

  it('the committed pages/ output is up to date and complete', () => {
    expect(findPrivacyProblems(rendered, fromDisk)).toEqual([]);
  });

  it('fails when the committed output differs from the render', () => {
    const stale = (rel) => (rel === 'privacy/index.html' ? `${rendered[rel]}<!-- edited -->` : rendered[rel]);
    const problems = findPrivacyProblems(rendered, stale);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/privacy\/index\.html is out of date/);
  });

  it('fails when a committed file is missing', () => {
    const problems = findPrivacyProblems(rendered, (rel) => (rel === '.nojekyll' ? null : rendered[rel]));
    expect(problems).toEqual(['pages/.nojekyll is missing (run npm run privacy:render)']);
  });

  it('fails when a feature id or host is missing from the rendered page', () => {
    const extra = [
      ...NETWORK_FEATURES,
      { id: 'newThing', label: 'New thing', description: 'x', hosts: ['api.example.test'], policy: { sent: 'x', when: 'y' } },
    ];
    const problems = findPrivacyProblems(rendered, (rel) => rendered[rel], extra);
    expect(problems).toContain('feature id "newThing" is missing from the rendered privacy page');
    expect(problems).toContain('host "api.example.test" (feature newThing) is missing from the rendered privacy page');
  });

  it('every registry host appears, escaped, in the rendered page', () => {
    const html = rendered['privacy/index.html'];
    for (const f of NETWORK_FEATURES) for (const h of f.hosts) expect(html).toContain(esc(h));
  });
});
