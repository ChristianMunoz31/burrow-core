// The frontend constants for cloud AI (src/constants/cloudAi.js) must match the server exactly:
// category ids and their order, defaults, the consent version and the two acknowledgements.
import { describe, expect, it } from 'vitest';
import * as client from '../../src/constants/cloudAi.js';
import * as consent from '../ai/consent.js';
import * as privacy from '../ai/privacy.js';

describe('cloud AI parity (frontend vs backend)', () => {
  it('has identical category ids in the same order', () => {
    expect([...client.CLOUD_CATEGORY_IDS]).toEqual([...privacy.CLOUD_CATEGORY_IDS]);
    expect(client.CLOUD_CATEGORY_IDS).toEqual(['budget', 'todos', 'calendar', 'habits', 'health', 'notes', 'journal', 'bookmarks', 'countdowns', 'focus', 'folders']);
  });

  it('has identical defaults, and off only for health, notes, journal and folders', () => {
    expect({ ...client.CLOUD_CATEGORY_DEFAULTS }).toEqual({ ...privacy.CLOUD_CATEGORY_DEFAULTS });
    expect(client.CLOUD_CATEGORY_IDS.filter((id) => !client.CLOUD_CATEGORY_DEFAULTS[id])).toEqual(['health', 'notes', 'journal', 'folders']);
  });

  it('has the same consent version and acknowledgements', () => {
    expect(client.CLOUD_CONSENT_VERSION).toBe(consent.CLOUD_CONSENT_VERSION);
    expect(client.CLOUD_CONSENT_VERSION).toBe(1);
    expect([...client.CLOUD_CONSENT_ACKS]).toEqual([...consent.CLOUD_CONSENT_ACKS]);
    expect(client.CLOUD_CONSENT_ACKS).toEqual(['sends_data', 'pay_provider']);
  });

  it('has a label for every category and none for the internal memory scope', () => {
    expect(Object.keys(client.CLOUD_CATEGORY_LABELS)).toEqual([...privacy.CLOUD_CATEGORY_IDS]);
    expect(client.CLOUD_CATEGORY_LABELS).not.toHaveProperty('memory');
    for (const id of privacy.CLOUD_CATEGORY_IDS) expect(client.CLOUD_CATEGORY_LABELS[id].label, id).toEqual(expect.any(String));
  });

  it('the frontend module has no imports (it must stay pure)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'constants', 'cloudAi.js');
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/^\s*import\s/m);
  });
});
