import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import CommandPalette from '../CommandPalette';
import { QUICK_ACTIONS } from '../commands';
import { openCommandPalette } from '../../../hooks/useCommandPalette';
import { IMPORT_TRANSACTIONS_PATH } from '../../budget/openTransactionImport';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';

const themeApi = vi.hoisted(() => ({ setPreference: () => {} }));

vi.mock('../../../contexts/ThemeContext', async (orig) => ({
  ...(await orig()),
  useTheme: () => ({ preference: 'system', setPreference: themeApi.setPreference }),
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

describe('palette Import transactions action', () => {
  it('is registered as a nav quick action to /budget?import=1', () => {
    expect(IMPORT_TRANSACTIONS_PATH).toBe('/budget?import=1');
    expect(QUICK_ACTIONS.find((a) => a.id === 'qa:import')).toMatchObject({
      label: 'Import transactions',
      kind: 'nav',
      to: '/budget?import=1',
    });
  });

  it('lists the action and navigates to the import URL when chosen', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MemoryRouter initialEntries={['/']}>
        <CommandPalette />
        <Where />
      </MemoryRouter>,
    );
    act(() => openCommandPalette());
    await screen.findByRole('dialog', { name: 'Command palette' });
    await user.click(screen.getByRole('option', { name: /Import transactions/ }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/budget?import=1'));
  });
});
