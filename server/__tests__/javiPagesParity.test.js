// Backend page allowlist and caps must stay identical to the frontend catalogue.
import { describe, it, expect } from 'vitest';
import * as server from '../javi/pages.js';
import * as client from '../../src/constants/javiPages.js';

describe('javi page parity (frontend vs backend)', () => {
  it('has identical page keys', () => {
    expect([...client.JAVI_PAGE_KEYS].sort()).toEqual(Object.keys(server.JAVI_PAGE_LABELS).sort());
  });

  it('has identical labels', () => {
    for (const key of client.JAVI_PAGE_KEYS) {
      expect(client.JAVI_PAGES[key].label).toBe(server.JAVI_PAGE_LABELS[key]);
    }
  });

  it('has equal size caps', () => {
    expect(client.JAVI_CONTEXT_MAX_CHARS).toBe(server.JAVI_CONTEXT_MAX_CHARS);
    expect(client.JAVI_MAX_MESSAGES).toBe(server.JAVI_MAX_MESSAGES);
    expect(client.JAVI_MAX_MESSAGE_CHARS).toBe(server.JAVI_MAX_MESSAGE_CHARS);
    expect(client.JAVI_MAX_TOTAL_MESSAGE_CHARS).toBe(server.JAVI_MAX_TOTAL_MESSAGE_CHARS);
    expect(server.JAVI_MAX_TOTAL_MESSAGE_CHARS).toBe(16000);
  });

  it('every page path resolves back to its key (inbox item routes)', () => {
    for (const [key, path] of Object.entries(server.JAVI_PAGE_PATHS)) expect(client.resolveJaviPageKey(path)).toBe(key);
  });
});
