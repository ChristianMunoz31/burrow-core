/* global process */
import { vi, describe, expect, it, afterEach } from 'vitest';

// Pin a zone behind UTC before the component module builds its Intl formatters.
vi.hoisted(() => {
  process.env.TZ = 'America/Los_Angeles';
});

import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import EntryList from '../EntryList';

describe('EntryList day headers', () => {
  afterEach(cleanup);

  it('groups an entry under the local day, not the UTC day', () => {
    // 03:00 UTC on May 2 is 8 PM on Friday May 1 in Los Angeles.
    const entries = [
      { id: 'late', title: 'Late', body: 'x', tags: [], date: '2026-05-02T03:00:00.000Z' },
      { id: 'noon', title: 'Noon', body: 'y', tags: [], date: '2026-05-01T19:00:00.000Z' },
    ];
    render(<EntryList entries={entries} onEdit={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText('Friday, May 1')).toBeInTheDocument();
    expect(screen.queryByText('Saturday, May 2')).not.toBeInTheDocument();
  });
});

describe('EntryList time', () => {
  afterEach(cleanup);

  it('shows no time for a date-only entry and a time for a full timestamp', () => {
    const entries = [
      { id: 'a', title: 'Dateonly', body: 'x', tags: [], date: '2026-05-01' },
      { id: 'b', title: 'Stamped', body: 'y', tags: [], date: '2026-05-01T19:00:00.000Z' },
    ];
    const { container } = render(<EntryList entries={entries} onEdit={vi.fn()} onRemove={vi.fn()} />);
    const timeFor = (title) => screen.getByText(title).parentElement.lastElementChild.textContent;
    expect(timeFor('Dateonly')).toBe('');
    expect(timeFor('Stamped')).toBe('12:00 PM');
    expect(container.textContent).not.toMatch(/5:00 PM/);
  });
});
