import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Budget from '../Budget';
import JaviAdvisor from '../../components/javi/JaviAdvisor';
import { PageContextProvider } from '../../contexts/PageContextContext';

vi.mock('../../components/budget/BudgetPage', () => ({ default: () => null }));

beforeAll(async () => {
  await import('../../components/javi/JaviPanel');
}, 30000);

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

describe('focus when importing from the Javi panel', () => {
  it('lands inside the dialog, then on the header Import button after closing', async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <PageContextProvider>
          <MemoryRouter initialEntries={['/budget']}>
            <Routes>
              <Route path="/budget" element={<Budget />} />
            </Routes>
            <JaviAdvisor pageKey="budget" visible autoAdvise={false} />
          </MemoryRouter>
        </PageContextProvider>
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Javi, AI helper' }));
    // The panel is lazy-loaded; its Import button only exists once the real panel is in.
    const importInPanel = await waitFor(() =>
      within(screen.getByRole('dialog', { name: 'Javi' })).getByRole('button', { name: 'Import transactions' }),
    );
    await user.click(importInPanel);

    const dialog = await screen.findByRole('dialog', { name: 'Import transactions' });
    await waitFor(() => expect(dialog).toContainElement(document.activeElement));
    // Give any late focus restore a chance to (wrongly) steal focus.
    await new Promise((r) => setTimeout(r, 50));
    expect(dialog).toContainElement(document.activeElement);

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Import transactions' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import transactions' })).toHaveFocus();
  });
});
