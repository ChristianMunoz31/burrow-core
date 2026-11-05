import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import CommandPalette from '../CommandPalette';
import { QUICK_ACTIONS } from '../commands';
import { openCommandPalette } from '../../../hooks/useCommandPalette';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';

vi.mock('../../../contexts/ThemeContext', async (orig) => ({
  ...(await orig()),
  useTheme: () => ({ preference: 'system', setPreference: () => {} }),
}));

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{`${loc.pathname}${loc.search}`}</output>;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ results: [] }) })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CASES = [
  ['qa:countdown', 'New countdown', '/countdowns?new=1'],
  ['qa:bookmark', 'New bookmark', '/bookmarks?new=1'],
  ['qa:habit', 'New habit', '/habits?new=1'],
  ['qa:event', 'New calendar event', '/calendar?new=1'],
];

describe('palette "new item" quick actions', () => {
  it.each(CASES)('%s is a nav action to the ?new=1 URL', (id, label, to) => {
    expect(QUICK_ACTIONS.find((a) => a.id === id)).toMatchObject({
      label,
      kind: 'nav',
      to,
    });
  });

  it('has no duplicate Go to Focus quick action', () => {
    expect(QUICK_ACTIONS.find((a) => a.id === 'qa:focus')).toBeUndefined();
  });

  it.each(CASES)('choosing %s navigates to %s', async (_id, label, to) => {
    const user = userEvent.setup();
    renderWithProviders(
      <MemoryRouter initialEntries={['/']}>
        <CommandPalette />
        <Where />
      </MemoryRouter>,
    );
    act(() => openCommandPalette());
    await screen.findByRole('dialog', { name: 'Command palette' });
    await user.click(screen.getByRole('option', { name: new RegExp(label) }));
    expect(screen.getByTestId('where')).toHaveTextContent(to);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument());
  });
});
