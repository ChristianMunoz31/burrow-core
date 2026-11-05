import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ImportTransactionsDialog from '../ImportTransactionsDialog';
import { allowSlowSuite } from '../../../test-utils/slowSuite';

// Synthetic fixtures only. The real services and hooks run; only fetch is faked.
const CHASE = [
  'Transaction Date,Post Date,Description,Category,Type,Amount,Memo',
  '05/01/2026,05/02/2026,Corner Grocery,Groceries,Sale,-42.17,',
  '05/03/2026,05/04/2026,Coffee Shop,Food & Drink,Sale,-4.50,',
  '05/05/2026,05/05/2026,Employer Payroll,,Payment,2500.00,',
  'someday,05/05/2026,City Water,,Sale,-10.00,',
].join('\n');
const SIMPLE = 'Date,Description,Amount\n2026-05-01,Coffee Shop,-4.50\n2026-05-02,Employer Payroll,100.00\n';
const SPLIT = 'Date,Description,Money out,Money in\n2026-05-01,City Water,60.25,\n2026-05-02,Employer Payroll,,1800\n';

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

let fetchMock;
let server;

function setupServer(overrides = {}) {
  server = {
    sheetsEnabled: false,
    dryRun: () => json(200, { data: { received: 3, inserted: 2, duplicates: 1, duplicateIndexes: [1], dryRun: true } }),
    commit: () => json(200, { data: { received: 3, inserted: 2, duplicates: 1, duplicateIndexes: [1], dryRun: false } }),
    sheet: () => json(200, { csv: SIMPLE }),
    ...overrides,
  };
  fetchMock = vi.fn(async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('/api/settings/network')) {
      return json(200, { features: [{ id: 'sheets', enabled: server.sheetsEnabled, label: 'Sheets', description: '', hosts: [] }] });
    }
    if (u.startsWith('/api/transactions/import')) {
      return u.includes('dryRun=1') ? server.dryRun(init) : server.commit(init);
    }
    if (u.startsWith('/api/sheets/csv')) return server.sheet(u);
    return json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
}

const importCalls = () =>
  fetchMock.mock.calls
    .filter(([u]) => String(u).startsWith('/api/transactions/import'))
    .map(([u, init]) => ({ url: String(u), dryRun: String(u).includes('dryRun=1'), body: JSON.parse(init.body) }));

function renderDialog(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ImportTransactionsDialog onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onClose, invalidate };
}

const csvFile = (text, name = 'bank.csv') => new File([text], name, { type: 'text/csv' });
async function pick(user, text, name) {
  await user.upload(screen.getByLabelText('Choose a CSV file'), csvFile(text, name));
  return screen.findByRole('region', { name: 'Match columns' });
}

beforeEach(() => setupServer());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// Heavy render-and-wait suite: raise the time limits so a busy machine does not trip them.
allowSlowSuite();

describe('full import flow', () => {
  it('goes file -> mapping -> ambiguous dates -> preview with duplicates -> import -> done', async () => {
    const user = userEvent.setup();
    const { invalidate } = renderDialog();

    const match = await pick(user, CHASE);
    expect(match).toHaveTextContent('This looks like a Chase export');
    expect(match).toHaveTextContent('4 rows found');
    expect(screen.getByLabelText('Date')).toHaveDisplayValue('Transaction Date');
    expect(screen.getByLabelText('Description')).toHaveDisplayValue('Description');
    expect(screen.getByLabelText('Amount')).toHaveDisplayValue('Amount');
    expect(screen.getByLabelText('Category')).toHaveDisplayValue('Category');

    // Dates are all ambiguous: continue is blocked until the user answers.
    const check = screen.getByRole('button', { name: 'Check my transactions' });
    expect(check).toBeDisabled();
    expect(screen.getByText('Pick how dates are written to continue.')).toBeInTheDocument();
    const dateGroup = screen.getByRole('group', { name: 'How are dates written in this file?' });
    const us = within(dateGroup).getByRole('radio', { name: '05/01/2026 means May 1, 2026' });
    const eu = within(dateGroup).getByRole('radio', { name: '05/01/2026 means January 5, 2026' });
    expect(us).not.toBeChecked();
    expect(eu).not.toBeChecked();

    // Change a mapping select: category becomes automatic.
    await user.selectOptions(screen.getByLabelText('Category'), 'Pick automatically');
    expect(screen.getByLabelText('Category')).toHaveDisplayValue('Pick automatically');

    await user.click(eu);
    expect(check).toBeEnabled();
    await user.click(check);

    // Preview + counts from the dry run.
    const review = await screen.findByRole('region', { name: 'Check and import' });
    expect(review).toHaveTextContent('2 new, 1 duplicate skipped');
    expect(within(review).getByText('1 row could not be read')).toBeInTheDocument();
    expect(within(review).getByText('Line 5: The date could not be read')).toBeInTheDocument();

    const table = within(review).getByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('2026-01-05');
    expect(rows[0]).toHaveTextContent('Corner Grocery');
    expect(rows[0]).toHaveTextContent('Spent');
    expect(rows[0]).toHaveTextContent('Other'); // category column switched off, no rule matches
    expect(rows[0]).not.toHaveTextContent('Duplicate');
    expect(rows[1]).toHaveTextContent('Coffee Shop');
    expect(rows[1]).toHaveTextContent('Duplicate, will be skipped');
    expect(rows[2]).toHaveTextContent('Received');
    expect(rows[2]).toHaveTextContent('Income');
    expect(within(review).getAllByText('Duplicate, will be skipped')).toHaveLength(1);

    const dry = importCalls();
    expect(dry).toHaveLength(1);
    expect(dry[0].dryRun).toBe(true);
    expect(dry[0].body).toEqual({
      source: 'file',
      fileName: 'bank.csv',
      rows: [
        { date: '2026-01-05', merchant: 'Corner Grocery', amount: -42.17, category: 'Other' },
        { date: '2026-03-05', merchant: 'Coffee Shop', amount: -4.5, category: 'Other' },
        { date: '2026-05-05', merchant: 'Employer Payroll', amount: 2500, category: 'Income' },
      ],
    });

    // Commit sends the FULL row set, not dry.
    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }));
    const done = await screen.findByRole('region', { name: 'Done' });
    expect(done).toHaveTextContent('Imported 2 transactions.');
    expect(done).toHaveTextContent('1 duplicate was skipped.');
    expect(done).toHaveTextContent('1 row could not be read and was left out.');

    const calls = importCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1].dryRun).toBe(false);
    expect(calls[1].url).toBe('/api/transactions/import');
    expect(calls[1].body.rows).toEqual(dry[0].body.rows);
    expect(calls[1].body.source).toBe('file');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['transactions'] });
  });

  it('the other date answer gives different dates in the request', async () => {
    const user = userEvent.setup();
    renderDialog();
    await pick(user, CHASE);
    await user.click(screen.getByRole('radio', { name: '05/01/2026 means May 1, 2026' }));
    await user.click(screen.getByRole('button', { name: 'Check my transactions' }));
    await screen.findByRole('region', { name: 'Check and import' });
    expect(importCalls()[0].body.rows.map((r) => r.date)).toEqual(['2026-05-01', '2026-05-03', '2026-05-05']);
  });

  it('shows no date question for unambiguous dates and uses the "standard file" wording', async () => {
    const user = userEvent.setup();
    renderDialog();
    const match = await pick(user, SIMPLE);
    expect(match).toHaveTextContent('We matched your columns automatically');
    expect(screen.queryByRole('group', { name: /How are dates written/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check my transactions' })).toBeEnabled();
  });

  it('auto-selects the money in / money out layout and builds signed amounts', async () => {
    const user = userEvent.setup();
    renderDialog();
    await pick(user, SPLIT);
    expect(screen.getByRole('radio', { name: /separate columns for money in and money out/ })).toBeChecked();
    expect(screen.getByLabelText('Money out')).toHaveDisplayValue('Money out');
    expect(screen.getByLabelText('Money in')).toHaveDisplayValue('Money in');
    expect(screen.queryByLabelText('Amount')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check my transactions' }));
    await screen.findByRole('region', { name: 'Check and import' });
    expect(importCalls()[0].body.rows.map((r) => r.amount)).toEqual([-60.25, 1800]);
  });

  it('the "money spent shows as" choice flips signs in the request', async () => {
    const user = userEvent.setup();
    renderDialog();
    await pick(user, SIMPLE);
    await user.click(screen.getByRole('radio', { name: /Positive numbers/ }));
    await user.click(screen.getByRole('button', { name: 'Check my transactions' }));
    await screen.findByRole('region', { name: 'Check and import' });
    expect(importCalls()[0].body.rows.map((r) => r.amount)).toEqual([4.5, -100]);
  });

  it('disables Check until required columns are chosen', async () => {
    const user = userEvent.setup();
    renderDialog();
    await pick(user, SIMPLE);
    await user.selectOptions(screen.getByLabelText('Amount'), 'Choose a column');
    expect(screen.getByRole('button', { name: 'Check my transactions' })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Amount'), 'Amount');
    expect(screen.getByRole('button', { name: 'Check my transactions' })).toBeEnabled();
  });

  it('shows "and N more" when there are more than ten rows', async () => {
    const lines = Array.from({ length: 13 }, (_, i) => `2026-05-${String(i + 1).padStart(2, '0')},Shop ${i},-${i + 1}`);
    setupServer({
      dryRun: () => json(200, { data: { received: 13, inserted: 13, duplicates: 0, duplicateIndexes: [], dryRun: true } }),
    });
    const user = userEvent.setup();
    renderDialog();
    await pick(user, `Date,Description,Amount\n${lines.join('\n')}`);
    await user.click(screen.getByRole('button', { name: 'Check my transactions' }));
    const review = await screen.findByRole('region', { name: 'Check and import' });
    expect(within(review).getAllByRole('row')).toHaveLength(11);
    expect(review).toHaveTextContent('and 3 more');
    expect(review).toHaveTextContent('13 new, 0 duplicates skipped');
  });
});

describe('dedupe in the preview', () => {
  it('disables the import button and shows zero when every row is a duplicate', async () => {
    setupServer({
      dryRun: () => json(200, { data: { received: 2, inserted: 0, duplicates: 2, duplicateIndexes: [0, 1], dryRun: true } }),
    });
    const user = userEvent.setup();
    renderDialog();
    await pick(user, SIMPLE);
    await user.click(screen.getByRole('button', { name: 'Check my transactions' }));
    const review = await screen.findByRole('region', { name: 'Check and import' });
    expect(review).toHaveTextContent('0 new, 2 duplicates skipped');
    expect(within(review).getAllByText('Duplicate, will be skipped')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Import 0 transactions' })).toBeDisabled();
  });

  it('uses singular copy for exactly one new transaction', async () => {
    setupServer({
      dryRun: () => json(200, { data: { received: 2, inserted: 1, duplicates: 1, duplicateIndexes: [0], dryRun: true } }),
    });
    const user = userEvent.setup();
    renderDialog();
    await pick(user, SIMPLE);
    await user.click(screen.getByRole('button', { name: 'Check my transactions' }));
    await screen.findByText('1 new, 1 duplicate skipped');
    expect(screen.getByRole('button', { name: 'Import 1 transaction' })).toBeEnabled();
  });
});

describe('keyboard and navigation', () => {
  it('works with the keyboard only and Escape closes', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await pick(user, SIMPLE);

    const check = screen.getByRole('button', { name: 'Check my transactions' });
    for (let i = 0; i < 30 && document.activeElement !== check; i += 1) await user.tab();
    expect(check).toHaveFocus();
    await user.keyboard('{Enter}');
    const review = await screen.findByRole('region', { name: 'Check and import' });
    // Focus moves to the new step's heading.
    expect(within(review).getByRole('heading', { name: 'Check and import' })).toHaveFocus();

    const importBtn = screen.getByRole('button', { name: /^Import \d+ transactions?$/ });
    for (let i = 0; i < 30 && document.activeElement !== importBtn; i += 1) await user.tab();
    expect(importBtn).toHaveFocus();
    await user.keyboard('{Enter}');
    await screen.findByRole('region', { name: 'Done' });

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape and the dialog X close from the first step', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('Back keeps the chosen mapping and date answer', async () => {
    const user = userEvent.setup();
    renderDialog();
    await pick(user, CHASE);
    await user.selectOptions(screen.getByLabelText('Category'), 'Pick automatically');
    await user.click(screen.getByRole('radio', { name: '05/01/2026 means January 5, 2026' }));
    await user.click(screen.getByRole('button', { name: 'Check my transactions' }));
    await screen.findByRole('region', { name: 'Check and import' });

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('region', { name: 'Match columns' })).toBeInTheDocument();
    expect(screen.getByLabelText('Category')).toHaveDisplayValue('Pick automatically');
    expect(screen.getByRole('radio', { name: '05/01/2026 means January 5, 2026' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Check my transactions' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('region', { name: 'Choose a file' })).toBeInTheDocument();
  });

  it('step indicator marks the current step', async () => {
    const user = userEvent.setup();
    renderDialog();
    const steps = screen.getByRole('list', { name: 'Import steps' });
    expect(within(steps).getByText(/Choose a file/).closest('li')).toHaveAttribute('aria-current', 'step');
    await pick(user, SIMPLE);
    expect(within(steps).getByText(/Match columns/).closest('li')).toHaveAttribute('aria-current', 'step');
  });
});

describe('errors', () => {
  it('a server error on the preview shows a friendly alert and keeps the mapping', async () => {
    setupServer({ dryRun: () => json(500, { error: 'boom: SELECT secret FROM x', code: 'server_error' }) });
    const user = userEvent.setup();
    renderDialog();
    await pick(user, SIMPLE);
    await user.selectOptions(screen.getByLabelText('Category'), 'Pick automatically');
    await user.click(screen.getByRole('button', { name: 'Check my transactions' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong on our side and nothing was imported');
    expect(alert).not.toHaveTextContent('boom');
    expect(screen.getByRole('region', { name: 'Match columns' })).toBeInTheDocument();
    expect(screen.getByLabelText('Category')).toHaveDisplayValue('Pick automatically');
    expect(screen.getByRole('button', { name: 'Check my transactions' })).toBeEnabled();
  });

  it('an unreachable server explains nothing was imported', async () => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url).startsWith('/api/transactions/import')) throw new TypeError('Failed to fetch');
      return json(200, { features: [] });
    });
    const user = userEvent.setup();
    renderDialog();
    await pick(user, SIMPLE);
    await user.click(screen.getByRole('button', { name: 'Check my transactions' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Burrow could not be reached, so nothing was imported');
  });

  it('a failed commit keeps the preview and invalid_rows names the file lines', async () => {
    setupServer({
      commit: () =>
        json(400, {
          error: 'invalid_rows',
          code: 'invalid_rows',
          details: [
            { index: 0, field: 'date' },
            { index: 2, field: 'amount' },
            { index: 2, field: 'merchant' },
            { index: 99, field: 'amount' },
          ],
        }),
    });
    const user = userEvent.setup();
    const { invalidate } = renderDialog();
    await pick(user, CHASE);
    await user.click(screen.getByRole('radio', { name: '05/01/2026 means May 1, 2026' }));
    await user.click(screen.getByRole('button', { name: 'Check my transactions' }));
    await screen.findByRole('region', { name: 'Check and import' });
    await user.click(screen.getByRole('button', { name: 'Import 2 transactions' }));

    const alert = await screen.findByRole('alert');
    // rows[0] is file line 2 and rows[2] is file line 4; unknown indexes are ignored.
    expect(alert).toHaveTextContent('Some rows were not accepted.');
    expect(alert).toHaveTextContent('Check lines 2, 4.');
    expect(screen.getByRole('region', { name: 'Check and import' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import 2 transactions' })).toBeEnabled();
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['transactions'] });
  });

  it('invalid_rows with a single line uses the singular', async () => {
    setupServer({
      dryRun: () => json(400, { code: 'invalid_rows', details: [{ index: 1, field: 'date' }] }),
    });
    const user = userEvent.setup();
    renderDialog();
    await pick(user, SIMPLE);
    await user.click(screen.getByRole('button', { name: 'Check my transactions' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Check line 3.');
  });

  it.each([
    ['too_many_rows', /more than 5,000/],
    ['too_large', /too big to import/],
    ['rate_limited', /Wait a minute/],
    ['mystery_code', /Something went wrong and nothing was imported/],
  ])('maps server code %s to plain copy', async (code, pattern) => {
    setupServer({ dryRun: () => json(400, { error: 'x', code }) });
    const user = userEvent.setup();
    renderDialog();
    await pick(user, SIMPLE);
    await user.click(screen.getByRole('button', { name: 'Check my transactions' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(pattern);
  });

  it('stops before the server when no row can be read, naming the first bad line', async () => {
    const user = userEvent.setup();
    renderDialog();
    await pick(user, 'Date,Description,Amount\nsoon,Coffee Shop,-1\nlater,Corner Grocery,-2\n');
    await user.click(screen.getByRole('button', { name: 'Check my transactions' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'None of the rows could be read. Check the columns you picked. For example, line 2: The date could not be read.',
    );
    expect(importCalls()).toHaveLength(0);
  });

  it('rejects files that are not usable with plain messages', async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderDialog();
    const input = screen.getByLabelText('Choose a CSV file');
    await user.upload(input, new File(['x'], 'photo.png', { type: 'image/png' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That is not a CSV file');
    await user.upload(input, csvFile('Date,Description,Amount\n'));
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not find any transactions');
    await user.upload(input, new File(['a\u0000b'], 'bin.csv', { type: 'text/csv' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('does not look like a CSV file');
    expect(screen.getByRole('region', { name: 'Choose a file' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/transactions'))).toHaveLength(0);
  });
});

describe('Google Sheets source', () => {
  it('hides the link input and shows the exact note when the opt-in is off', async () => {
    renderDialog();
    const note = await screen.findByText(/Turn on Google Sheets in/);
    expect(note.textContent.replace(/\s+/g, ' ').trim()).toBe(
      'Turn on Google Sheets in Settings > Network to import from a link',
    );
    expect(within(note).getByRole('link', { name: 'Settings > Network' })).toHaveAttribute(
      'href',
      '/settings#network',
    );
    expect(screen.queryByLabelText('Published Google Sheet link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load sheet' })).not.toBeInTheDocument();
  });

  it('shows the link input and Load sheet when the opt-in is on, and feeds the same pipeline', async () => {
    setupServer({ sheetsEnabled: true });
    const user = userEvent.setup();
    renderDialog();
    const input = await screen.findByLabelText('Published Google Sheet link');
    expect(screen.queryByText(/Turn on Google Sheets in/)).not.toBeInTheDocument();
    const load = screen.getByRole('button', { name: 'Load sheet' });
    expect(load).toBeDisabled();

    const url = 'https://docs.google.com/spreadsheets/d/e/abc123/pub?output=csv';
    await user.type(input, url);
    await user.click(load);

    expect(await screen.findByRole('region', { name: 'Match columns' })).toBeInTheDocument();
    const sheetCall = fetchMock.mock.calls.find(([u]) => String(u).startsWith('/api/sheets/csv'));
    expect(String(sheetCall[0])).toBe(`/api/sheets/csv?url=${encodeURIComponent(url)}`);

    await user.click(screen.getByRole('button', { name: 'Check my transactions' }));
    await screen.findByRole('region', { name: 'Check and import' });
    await user.click(screen.getByRole('button', { name: /^Import \d+ transactions?$/ }));
    await screen.findByRole('region', { name: 'Done' });

    const calls = importCalls();
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.body.source).toBe('sheet');
      expect(c.body).not.toHaveProperty('fileName');
    }
  });

  it('handles a 403 network_opt_in_required on the sheet fetch by showing the note, not an error', async () => {
    setupServer({
      sheetsEnabled: true,
      sheet: () =>
        json(403, { error: 'network_opt_in_required', feature: 'sheets', message: 'Google Sheets is off.' }),
    });
    const user = userEvent.setup();
    renderDialog();
    await user.type(await screen.findByLabelText('Published Google Sheet link'), 'https://docs.google.com/x');
    await user.click(screen.getByRole('button', { name: 'Load sheet' }));
    expect(await screen.findByText(/Turn on Google Sheets in/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Choose a file' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load sheet' })).toBeEnabled();
  });

  it('shows a friendly alert when the sheet cannot be loaded', async () => {
    setupServer({ sheetsEnabled: true, sheet: () => json(502, { error: 'upstream' }) });
    const user = userEvent.setup();
    renderDialog();
    await user.type(await screen.findByLabelText('Published Google Sheet link'), 'https://docs.google.com/x');
    await user.click(screen.getByRole('button', { name: 'Load sheet' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not load that sheet');
    expect(screen.getByRole('region', { name: 'Choose a file' })).toBeInTheDocument();
  });

  it('a sheet with no usable CSV reports a CSV problem and stays on the first step', async () => {
    setupServer({ sheetsEnabled: true, sheet: () => json(200, { csv: '' }) });
    const user = userEvent.setup();
    renderDialog();
    await user.type(await screen.findByLabelText('Published Google Sheet link'), 'https://docs.google.com/x');
    await user.click(screen.getByRole('button', { name: 'Load sheet' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('That file is empty'));
  });
});
