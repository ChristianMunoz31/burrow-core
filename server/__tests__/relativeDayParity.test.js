// The client and server relative-date helpers must agree (they cannot share a module).
import { describe, it, expect } from 'vitest';
import * as server from '../relativeDay.js';
import * as client from '../../src/utils/relativeDay.js';

const TODAY = '2026-10-04';
const DAYS = ['2026-09-01', '2026-10-01', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2027-01-01', null, 'x'];

describe('relativeDay server/client parity', () => {
  it.each(DAYS)('%s', (day) => {
    expect(server.dueStatus(day, TODAY)).toBe(client.dueStatus(day, TODAY));
    expect(server.relativeDay(day, TODAY)).toBe(client.relativeDay(day, TODAY));
    expect(server.daysFromToday(day, TODAY)).toBe(client.daysFromToday(day, TODAY));
  });

  it('exports the same functions', () => {
    expect(Object.keys(server).sort()).toEqual(Object.keys(client).sort());
  });

  it('describes the passport case from the smoke test correctly', () => {
    expect(server.dueStatus('2026-10-01', TODAY)).toBe('overdue by 3 days');
  });
});
