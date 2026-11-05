import { describe, it, expect } from 'vitest';
import { groupByColumn, nextOrder, reorderColumns, computeTodoReorder } from '../kanban';

const cols = [
  { id: 'c1', name: 'Backlog', order: 0, color: 'gray' },
  { id: 'c2', name: 'In Progress', order: 1, color: 'blue' },
  { id: 'c3', name: 'Done', order: 2, color: 'green' },
];

describe('groupByColumn', () => {
  it('buckets todos by status into the matching column', () => {
    const todos = [
      { id: 't1', title: 'a', status: 'Backlog' },
      { id: 't2', title: 'b', status: 'In Progress' },
      { id: 't3', title: 'c', status: 'Backlog' },
    ];
    const map = groupByColumn(todos, cols);
    expect(map.get('Backlog').map((t) => t.id)).toEqual(['t1', 't3']);
    expect(map.get('In Progress').map((t) => t.id)).toEqual(['t2']);
    expect(map.get('Done')).toEqual([]);
    expect(map.has('__orphan__')).toBe(false);
  });

  it('creates empty entries for columns with no todos', () => {
    const map = groupByColumn([], cols);
    expect(map.size).toBe(3);
    expect(map.get('Backlog')).toEqual([]);
    expect(map.get('In Progress')).toEqual([]);
    expect(map.get('Done')).toEqual([]);
  });

  it('routes todos with unknown status into the orphan bucket', () => {
    const todos = [
      { id: 't1', title: 'a', status: 'Backlog' },
      { id: 't2', title: 'mystery', status: 'Archived' },
    ];
    const map = groupByColumn(todos, cols);
    expect(map.get('Backlog').map((t) => t.id)).toEqual(['t1']);
    expect(map.get('__orphan__').map((t) => t.id)).toEqual(['t2']);
  });

  it('puts an open todo with no status in the first column, whatever it is named', () => {
    const renamed = [{ id: 'c1', name: 'Inbox', order: 0 }, ...cols.slice(1)];
    const todos = [
      { id: 't1', title: 'none' },
      { id: 't2', title: 'null', status: null },
      { id: 't3', title: 'blank', status: '' },
      { id: 't4', title: 'finished', done: true },
    ];
    const map = groupByColumn(todos, renamed);
    expect(map.get('Inbox').map((t) => t.id)).toEqual(['t1', 't2', 't3']);
    // A done todo with no status is not guessed into a column.
    expect(map.get('__orphan__').map((t) => t.id)).toEqual(['t4']);
  });

  it('never defaults an open todo into a column named Done', () => {
    const doneFirst = [{ id: 'c3', name: 'Done', order: -1 }, ...cols.slice(0, 2)];
    const map = groupByColumn([{ id: 't1', title: 'none' }], doneFirst);
    expect(map.get('Done')).toEqual([]);
    expect(map.get('Backlog').map((t) => t.id)).toEqual(['t1']);
  });

  it('handles empty inputs', () => {
    const map = groupByColumn([], []);
    expect(map.size).toBe(0);
  });

  it('sorts cards within a column by order, nulls last', () => {
    const todos = [
      { id: 't1', status: 'Backlog', order: 2, createdTime: '2026-01-01' },
      { id: 't2', status: 'Backlog', order: 0, createdTime: '2026-01-02' },
      { id: 't3', status: 'Backlog', createdTime: '2026-01-03' }, // no order -> last
      { id: 't4', status: 'Backlog', order: 1, createdTime: '2026-01-04' },
    ];
    const map = groupByColumn(todos, cols);
    expect(map.get('Backlog').map((t) => t.id)).toEqual(['t2', 't4', 't1', 't3']);
  });
});

describe('computeTodoReorder', () => {
  const todos = [
    { id: 't1', status: 'Backlog', order: 0 },
    { id: 't2', status: 'Backlog', order: 1 },
    { id: 't3', status: 'Backlog', order: 2 },
    { id: 'd1', status: 'Done', order: 0 },
  ];

  it('reorders within a column, dropping onto a target card', () => {
    // Drag t3 onto t1's slot -> t3 should land at index 0.
    const items = computeTodoReorder(todos, cols, 't3', {
      type: 'todo',
      id: 't1',
      status: 'Backlog',
    });
    expect(items).toEqual([
      { id: 't3', status: 'Backlog', order: 0 },
      { id: 't1', status: 'Backlog', order: 1 },
      { id: 't2', status: 'Backlog', order: 2 },
    ]);
  });

  it('moves a card across columns and re-stamps both columns', () => {
    // Drag t1 into the Done column container -> appended at end of Done.
    const items = computeTodoReorder(todos, cols, 't1', {
      type: 'column',
      columnName: 'Done',
    });
    expect(items).toContainEqual({ id: 'd1', status: 'Done', order: 0 });
    expect(items).toContainEqual({ id: 't1', status: 'Done', order: 1 });
    // Source column (Backlog) re-stamped without t1.
    expect(items).toContainEqual({ id: 't2', status: 'Backlog', order: 0 });
    expect(items).toContainEqual({ id: 't3', status: 'Backlog', order: 1 });
  });

  it('stamps a status-less card into a real column when it is dragged', () => {
    const legacy = [{ id: 'n1', title: 'no status' }, { id: 'n2', title: 'blank', status: '' }];
    const items = computeTodoReorder(legacy, cols, 'n1', { type: 'column', columnName: 'In Progress' });
    expect(items).toContainEqual({ id: 'n1', status: 'In Progress', order: 0 });
    // The source column (the implicit first column) is re-stamped with its real name.
    expect(items).toContainEqual({ id: 'n2', status: 'Backlog', order: 0 });
  });

  it('is a no-op when dropping a card on itself', () => {
    expect(
      computeTodoReorder(todos, cols, 't2', { type: 'todo', id: 't2', status: 'Backlog' }),
    ).toEqual([]);
  });

  it('is a no-op when order and column are unchanged', () => {
    // Drop t1 onto t1's own position via t2 below it produces no net change only
    // when nothing moves; dropping t2 onto t2 covered above. Here: empty over.
    expect(computeTodoReorder(todos, cols, 't1', null)).toEqual([]);
  });
});

describe('nextOrder', () => {
  it('returns 0 when there are no columns', () => {
    expect(nextOrder([])).toBe(0);
    expect(nextOrder()).toBe(0);
  });

  it('returns max + 1 of existing orders', () => {
    expect(nextOrder(cols)).toBe(3);
    expect(nextOrder([{ order: 5 }, { order: 2 }, { order: 9 }])).toBe(10);
  });

  it('handles columns without an order field', () => {
    expect(nextOrder([{ name: 'a' }, { name: 'b' }])).toBe(0);
  });
});

describe('reorderColumns', () => {
  it('moves a column down and re-stamps order', () => {
    const result = reorderColumns(cols, 0, 2);
    expect(result.map((c) => c.name)).toEqual(['In Progress', 'Done', 'Backlog']);
    expect(result.map((c) => c.order)).toEqual([0, 1, 2]);
  });

  it('moves a column up and re-stamps order', () => {
    const result = reorderColumns(cols, 2, 0);
    expect(result.map((c) => c.name)).toEqual(['Done', 'Backlog', 'In Progress']);
    expect(result.map((c) => c.order)).toEqual([0, 1, 2]);
  });

  it('does not mutate the input array', () => {
    const before = cols.map((c) => ({ ...c }));
    reorderColumns(cols, 0, 1);
    expect(cols).toEqual(before);
  });

  it('clamps out-of-range indexes', () => {
    const result = reorderColumns(cols, -5, 99);
    expect(result.map((c) => c.name)).toEqual(['In Progress', 'Done', 'Backlog']);
  });

  it('returns an empty array for empty input', () => {
    expect(reorderColumns([], 0, 1)).toEqual([]);
  });
});
