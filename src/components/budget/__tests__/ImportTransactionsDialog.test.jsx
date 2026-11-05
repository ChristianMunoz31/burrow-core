import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ImportTransactionsDialog from '../ImportTransactionsDialog';
import { transactionImportService } from '../../../services/transactionImportService';

vi.mock('../../../services/transactionImportService', () => ({
  transactionImportService: { importRows: vi.fn() },
}));
vi.mock('../../../hooks/useNetworkFeature', () => ({
  useNetworkFeature: () => ({ settingsLoading: false, enabled: false, offError: new Error('off') }),
}));

const CSV = 'Date,Description,Amount\n2026-05-01,Coffee,-4.50\n2026-05-02,Pay,100.00\n2026-13-45,Broken,1\n';

function setup(onClose = vi.fn()) {
  const client = new QueryClient();
  const spy = vi.spyOn(client, 'invalidateQueries');
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ImportTransactionsDialog onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { spy, onClose };
}

beforeEach(() => {
  transactionImportService.importRows.mockImplementation(async ({ dryRun }) => ({
    received: 2,
    inserted: 1,
    duplicates: 1,
    duplicateIndexes: [0],
    dryRun: Boolean(dryRun),
  }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ImportTransactionsDialog', () => {
  it('walks from file to done and refreshes transactions', async () => {
    const user = userEvent.setup();
    const { spy } = setup();
    expect(screen.getByRole('dialog', { name: 'Import transactions' })).toBeInTheDocument();
    expect(screen.getByText('Settings > Network')).toBeInTheDocument();

    await user.upload(
      screen.getByLabelText('Choose a CSV file'),
      new File([CSV], 'bank.csv', { type: 'text/csv' }),
    );
    expect(await screen.findByLabelText('Date')).toHaveDisplayValue('Date');
    await user.click(screen.getByRole('button', { name: 'Check my transactions' }));

    expect(await screen.findByText(/1 new/)).toBeInTheDocument();
    expect(screen.getByText('1 row could not be read')).toBeInTheDocument();
    expect(screen.getByText('Duplicate, will be skipped')).toBeInTheDocument();
    expect(transactionImportService.importRows.mock.calls[0][0].dryRun).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Import 1 transaction' }));
    await waitFor(() => expect(screen.getByText(/Imported 1 transaction\./)).toBeInTheDocument());
    expect(screen.getByText(/1 duplicate was skipped/)).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith({ queryKey: ['transactions'] });
  });

  it('shows a friendly error for a file that is not a CSV', async () => {
    const user = userEvent.setup({ applyAccept: false });
    setup();
    await user.upload(screen.getByLabelText('Choose a CSV file'), new File(['x'], 'pic.png', { type: 'image/png' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That is not a CSV file');
  });
});
