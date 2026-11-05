import { describe, expect, it } from 'vitest';
import { STORAGE_GROUPS, STORAGE_KINDS, STORAGE_MAP, describeLocation, groupStorageMap } from '../storageMap';

describe('describeLocation', () => {
  const cases = [
    [{ kind: 'database' }, 'On this computer'],
    [{ kind: 'synced' }, 'On this computer'],
    [{ kind: 'device' }, 'This browser only'],
    [{ kind: 'external' }, 'Online, if turned on'],
  ];

  it.each(cases)('%j -> %s', (entry, text) => {
    expect(describeLocation(entry)).toEqual({ text, tone: 'muted' });
  });
});

describe('STORAGE_MAP', () => {
  it('is frozen, uses known kinds and has unique ids', () => {
    expect(Object.isFrozen(STORAGE_MAP)).toBe(true);
    expect(STORAGE_MAP.every((e) => STORAGE_KINDS.includes(e.kind))).toBe(true);
    expect(new Set(STORAGE_MAP.map((e) => e.id)).size).toBe(STORAGE_MAP.length);
    expect(STORAGE_MAP.every((e) => STORAGE_GROUPS.some((g) => g.id === e.group))).toBe(true);
  });

  it('maps kind to group for every entry', () => {
    const groupOfKind = { database: 'database', synced: 'database', device: 'device', external: 'external' };
    for (const entry of STORAGE_MAP) {
      expect(entry.group, entry.id).toBe(groupOfKind[entry.kind]);
    }
  });

  it('groups every entry exactly once', () => {
    const grouped = groupStorageMap();
    expect(grouped.flatMap((g) => g.items)).toHaveLength(STORAGE_MAP.length);
  });
});

describe('groupStorageMap', () => {
  const grouped = groupStorageMap();
  const idsOf = (groupId) => grouped.find((g) => g.id === groupId).items.map((i) => i.id);

  it('places every STORAGE_MAP id in exactly one group and the total matches', () => {
    const allIds = grouped.flatMap((g) => g.items.map((i) => i.id));
    expect(allIds).toHaveLength(STORAGE_MAP.length);
    expect(new Set(allIds).size).toBe(STORAGE_MAP.length);
    for (const entry of STORAGE_MAP) {
      expect(grouped.filter((g) => g.items.some((i) => i.id === entry.id))).toHaveLength(1);
    }
  });

  it('returns groups in STORAGE_GROUPS order with their metadata', () => {
    expect(grouped.map((g) => g.id)).toEqual(STORAGE_GROUPS.map((g) => g.id));
    grouped.forEach((g, i) => {
      expect(g.title).toBe(STORAGE_GROUPS[i].title);
      expect(g.description).toBe(STORAGE_GROUPS[i].description);
    });
  });

  it('sorts items alphabetically by label within each group', () => {
    for (const g of grouped) {
      const labels = g.items.map((i) => i.label);
      expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    }
  });

  it('has the expected membership per group', () => {
    expect(idsOf('database')).toEqual(
      expect.arrayContaining([
        'transactions', 'budget', 'todos', 'habits', 'notes', 'journal',
        'bookmarks', 'countdowns', 'calendar', 'focus', 'jarvis', 'settings',
      ]),
    );
    expect(idsOf('device')).toEqual([]);
    expect([...idsOf('external')].sort()).toEqual(['health', 'weather']);
  });

  it('throws on an entry with an unknown group', () => {
    expect(() => groupStorageMap([{ id: 'x', label: 'X', kind: 'device', group: 'nope' }])).toThrow(/nope/);
  });

  it('does not mutate the input entries order', () => {
    const input = [
      { id: 'b', label: 'B', group: 'device' },
      { id: 'a', label: 'A', group: 'device' },
    ];
    const out = groupStorageMap(input);
    expect(out.find((g) => g.id === 'device').items.map((i) => i.id)).toEqual(['a', 'b']);
  });
});
