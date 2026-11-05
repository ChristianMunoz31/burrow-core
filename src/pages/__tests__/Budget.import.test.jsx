import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Budget from '../Budget';
import { openTransactionImport } from '../../components/budget/openTransactionImport';

// The dashboard itself is covered elsewhere; only the page shell and dialog entry points matter here.
vi.mock('../../components/budget/BudgetPage', () => ({
  default: () => <div>Budget page</div>,
}));

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{`${loc.pathname}${loc.search}`}</output>;
}

function mount(entry = '/budget') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/budget" element={<Budget />} />
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const dialog = () => screen.queryByRole('dialog', { name: 'Import transactions' });

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ features: [] }) })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Budget page import entry points', () => {
  it('has no dialog until asked, and the header button opens it', async () => {
    const user = userEvent.setup();
    mount();
    expect(dialog()).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Import transactions' }));
    expect(dialog()).toBeInTheDocument();
  });

  it('openTransactionImport() opens the dialog on a mounted page', () => {
    mount();
    act(() => openTransactionImport());
    expect(dialog()).toBeInTheDocument();
  });

  it('stops listening for the event after unmount', () => {
    const { unmount } = mount();
    unmount();
    expect(() => act(() => openTransactionImport())).not.toThrow();
    expect(dialog()).not.toBeInTheDocument();
  });

  it('/budget?import=1 opens the dialog and clears the param', async () => {
    mount('/budget?import=1');
    expect(dialog()).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/budget$/));
  });

  it('keeps other query params when clearing import', async () => {
    mount('/budget?import=1&view=planner');
    expect(dialog()).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/budget?view=planner'));
  });

  it('does not reopen after closing, and ignores import values other than 1', async () => {
    const user = userEvent.setup();
    mount('/budget?import=1');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(dialog()).not.toBeInTheDocument();
    cleanup();
    mount('/budget?import=0');
    expect(dialog()).not.toBeInTheDocument();
  });

  it('closing with Escape unmounts the dialog so the next open starts fresh', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Import transactions' }));
    await user.upload(
      screen.getByLabelText('Choose a CSV file'),
      new File(['Date,Description,Amount\n2026-05-01,Coffee Shop,-4.50\n'], 'a.csv', { type: 'text/csv' }),
    );
    await screen.findByRole('region', { name: 'Match columns' });
    await user.keyboard('{Escape}');
    expect(dialog()).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Import transactions' }));
    expect(screen.getByRole('region', { name: 'Choose a file' })).toBeInTheDocument();
  });
});
