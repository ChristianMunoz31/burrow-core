import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DataBrowser from '../DataBrowser';
import ValueViewer from '../../components/dataBrowser/ValueViewer';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { installMatchMedia, resetDom } from '../../test-utils/settingsHarness';

vi.mock('../../services/dataBrowserService', () => ({
  dataBrowserService: { listTables: vi.fn(), getRows: vi.fn(), getOverview: vi.fn() },
}));
import { dataBrowserService } from '../../services/dataBrowserService';
import { allowSlowSuite } from '../../test-utils/slowSuite';

const TABLES = {
  tables: [
    { id: 'transactions', label: 'Transactions', group: 'Money', count: 1234, status: 'ok', hasDateChart: true, hasAmountChart: true },
    { id: 'notes', label: 'Notes', group: 'Notes', count: 3, status: 'ok', hasDateChart: true, hasAmountChart: false },
    { id: 'habits', label: 'Habits', group: 'Plan', count: null, status: 'unavailable', hasDateChart: true, hasAmountChart: false },
  ],
};

const LONG = 'x'.repeat(120);

function rowsResponse(table, params = {}, over = {}) {
  return {
    table,
    label: table === 'transactions' ? 'Transactions' : 'Notes',
    primaryKey: 'id',
    columns: [
      { name: 'date', type: 'date', sortable: true },
      { name: 'merchant', type: 'text', sortable: true },
      { name: 'amount', type: 'numeric', sortable: true },
      { name: 'value', type: 'jsonb', sortable: false },
    ],
    amountColumn: 'amount',
    rows: [
      { id: 'a', date: '2026-03-01', merchant: 'Coffee', amount: '-4.5', value: '[redacted]' },
      { id: 'b', date: '2026-03-02', merchant: LONG, amount: '100', value: { k: 1 } },
    ],
    page: Number(params.page ?? 1),
    pageSize: Number(params.pageSize ?? 25),
    total: 60,
    sort: params.sort ?? 'date',
    order: params.order ?? 'desc',
    q: params.q ?? '',
    ...over,
  };
}

function LocationProbe() {
  const { search } = useLocation();
  return <output data-testid="search">{search}</output>;
}

function GoButton({ to }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      go
    </button>
  );
}

function renderPage(url = '/settings/data', goTo = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <ThemeProvider>
          <DataBrowser />
          <LocationProbe />
          {goTo && <GoButton to={goTo} />}
        </ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, client };
}

const search = () => new URLSearchParams(screen.getByTestId('search').textContent);

beforeEach(() => {
  resetDom();
  installMatchMedia(false);
  dataBrowserService.listTables.mockReset().mockResolvedValue(TABLES);
  dataBrowserService.getRows.mockReset().mockImplementation(async (table, params) => rowsResponse(table, params));
  dataBrowserService.getOverview.mockReset().mockResolvedValue({
    table: 'transactions',
    dateColumn: 'date',
    granularity: 'month',
    rowsOverTime: [
      { period: '2026-01', count: 4 },
      { period: '2026-02', count: 6 },
    ],
    amountByMonth: [
      { period: '2026-01', income: 100, expenses: 40, net: 60 },
      { period: '2026-02', income: 0, expenses: 10, net: -10 },
    ],
    sampled: 10,
    undated: 2,
    truncated: true,
  });
});

afterEach(() => {
  cleanup();
  resetDom();
});

// Heavy render-and-wait suite: raise the time limits so a busy machine does not trip them.
allowSlowSuite();

describe('DataBrowser picker and states', () => {
  it('lists tables with counts and says the view is read-only', async () => {
    renderPage();
    const nav = await screen.findByRole('navigation', { name: 'Tables' });
    expect(within(nav).getByRole('button', { name: /Transactions/ })).toHaveTextContent('1,234');
    expect(within(nav).getByRole('button', { name: /Transactions/ })).toHaveAttribute('aria-current', 'true');
    expect(within(nav).getByRole('button', { name: /Habits/ })).toHaveTextContent('n/a');
    expect(screen.getByText(/Read-only: nothing here can be edited/)).toBeInTheDocument();
    expect(screen.queryByText(/^Read-only$/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /← Settings/ })).not.toBeInTheDocument();
  });

  it('shows a loading skeleton for rows', async () => {
    dataBrowserService.getRows.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(await screen.findByRole('status', { name: 'Loading rows' })).toBeInTheDocument();
  });

  it('shows an error for the table list with Retry', async () => {
    dataBrowserService.listTables.mockRejectedValueOnce(Object.assign(new Error('x'), { status: 500 }));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the table list.");
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('navigation', { name: 'Tables' })).toBeInTheDocument();
  });

  it('shows the unavailable copy for a not_configured rows error', async () => {
    dataBrowserService.getRows.mockRejectedValue(
      Object.assign(new Error('x'), { status: 503, code: 'not_configured' }),
    );
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent("Burrow can't open your data file. Try restarting Burrow.");
  });

  it('offers Reset view on a 400', async () => {
    dataBrowserService.getRows.mockRejectedValue(Object.assign(new Error('bad'), { status: 400, code: 'invalid_sort' }));
    renderPage('/settings/data?table=transactions&sort=zzz&order=asc');
    await userEvent.click(await screen.findByRole('button', { name: 'Reset view' }));
    expect(search().get('sort')).toBeNull();
  });

  it('shows the empty state', async () => {
    dataBrowserService.getRows.mockResolvedValue(rowsResponse('transactions', {}, { rows: [], total: 0 }));
    renderPage();
    expect(await screen.findByText('No rows')).toBeInTheDocument();
  });

  it('shows the no-match state and Clear search', async () => {
    dataBrowserService.getRows.mockImplementation(async (table, params) =>
      params.q ? rowsResponse(table, params, { rows: [], total: 0 }) : rowsResponse(table, params),
    );
    renderPage('/settings/data?table=transactions&q=zzz');
    expect(await screen.findByText('No rows match “zzz”.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByText('Coffee')).toBeInTheDocument();
    expect(search().get('q')).toBeNull();
  });
});

describe('DataBrowser grid', () => {
  it('formats cells', async () => {
    renderPage();
    expect(await screen.findByText('Coffee')).toBeInTheDocument();
    expect(screen.getByText('-$4.50')).toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.getByText(new Date(2026, 2, 1).toLocaleDateString())).toBeInTheDocument();
    expect(screen.getByText('redacted')).toBeInTheDocument();
  });

  it('toggles sort with aria-sort and URL state', async () => {
    renderPage();
    const dateTh = (await screen.findByRole('columnheader', { name: /date/i }));
    expect(dateTh).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByRole('columnheader', { name: /merchant/i })).toHaveAttribute('aria-sort', 'none');
    expect(screen.getByRole('columnheader', { name: /value/i })).not.toHaveAttribute('aria-sort');

    await userEvent.click(within(dateTh).getByRole('button'));
    await waitFor(() => expect(search().get('order')).toBe('asc'));
    expect(search().get('sort')).toBe('date');
    await waitFor(() =>
      expect(screen.getByRole('columnheader', { name: /date/i })).toHaveAttribute('aria-sort', 'ascending'),
    );

    await userEvent.click(within(screen.getByRole('columnheader', { name: /merchant/i })).getByRole('button'));
    await waitFor(() => expect(search().get('sort')).toBe('merchant'));
    expect(search().get('order')).toBe('asc');
  });

  it('paginates and changes the page size', async () => {
    renderPage();
    expect(await screen.findByText('Rows 1 to 25 of 60')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Rows 26 to 50 of 60')).toBeInTheDocument();
    expect(search().get('page')).toBe('2');
    await userEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    await screen.findByText('Rows 1 to 25 of 60');
    expect(search().get('page')).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Rows per page'), '50');
    expect(await screen.findByText('Rows 1 to 50 of 60')).toBeInTheDocument();
    expect(search().get('pageSize')).toBe('50');
  });

  it('debounces search into the q param and resets the page', async () => {
    renderPage('/settings/data?table=transactions&page=2');
    await screen.findByText('Rows 26 to 50 of 60');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search rows' }), 'cof');
    expect(search().get('q')).toBeNull();
    await waitFor(() => expect(search().get('q')).toBe('cof'));
    expect(search().get('page')).toBeNull();
    await waitFor(() =>
      expect(dataBrowserService.getRows).toHaveBeenLastCalledWith(
        'transactions',
        expect.objectContaining({ q: 'cof', page: 1 }),
      ),
    );
  });

  it('keeps a sort change made inside the search debounce window', async () => {
    renderPage();
    await screen.findByText('Coffee');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search rows' }), { target: { value: 'cof' } });
    fireEvent.click(within(screen.getByRole('columnheader', { name: /merchant/i })).getByRole('button'));
    await waitFor(() => expect(search().get('sort')).toBe('merchant'));
    expect(search().get('q')).toBeNull();
    await waitFor(() => expect(search().get('q')).toBe('cof'));
    expect(search().get('sort')).toBe('merchant');
    expect(search().get('order')).toBe('asc');
  });

  it('keeps a page-size change made inside the search debounce window', async () => {
    renderPage();
    await screen.findByText('Rows 1 to 25 of 60');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search rows' }), { target: { value: 'cof' } });
    fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '50' } });
    await waitFor(() => expect(search().get('q')).toBe('cof'));
    expect(search().get('pageSize')).toBe('50');
  });

  it('locks body scroll while the viewer is open and restores it after', async () => {
    document.body.style.overflow = 'scroll';
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /^Expand merchant value/ }));
    expect(document.body.style.overflow).toBe('hidden');
    await userEvent.keyboard('{Escape}');
    expect(document.body.style.overflow).toBe('scroll');
    document.body.style.overflow = '';
  });

  it('focuses the grid region when the viewer trigger is gone on close', () => {
    const region = document.createElement('div');
    region.tabIndex = 0;
    document.body.appendChild(region);
    const trigger = document.createElement('button');
    const onClose = vi.fn();
    const { unmount } = render(
      <ValueViewer title="t" content="c" trigger={trigger} focusFallback={() => region.focus()} onClose={onClose} />,
    );
    unmount();
    expect(region).toHaveFocus();
    region.remove();
  });

  it('opens the expand viewer, closes on Escape and restores focus', async () => {
    renderPage();
    const expand = await screen.findByRole('button', { name: /^Expand merchant value/ });
    expect(expand).toHaveAccessibleName('Expand merchant value, row 2');
    await userEvent.click(expand);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();
    expect(dialog).toHaveTextContent(LONG);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(expand).toHaveFocus();
  });

  it('portals the viewer to document.body, outside the grid', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /^Expand merchant value/ }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.parentElement.parentElement).toBe(document.body);
    expect(screen.getByRole('region', { name: 'Transactions rows' })).not.toContainElement(dialog);
    expect(within(dialog).getByLabelText('Full value')).toHaveTextContent(LONG);
    expect(dialog.className).toContain('glass-flat');
  });

  it('closes the viewer on a document Escape even when focus is outside the dialog', async () => {
    renderPage();
    const expand = await screen.findByRole('button', { name: /^Expand merchant value/ });
    await userEvent.click(expand);
    act(() => document.activeElement.blur());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(expand).toHaveFocus();
  });

  it('closes the viewer on scrim mousedown but not on dialog mousedown', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /^Expand merchant value/ }));
    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(dialog);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.mouseDown(dialog.parentElement);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps focus trapped in the viewer on Tab', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /^Expand merchant value/ }));
    const dialog = screen.getByRole('dialog');
    await userEvent.tab();
    expect(dialog).toContainElement(document.activeElement);
    await userEvent.tab();
    await userEvent.tab();
    expect(dialog).toContainElement(document.activeElement);
  });

  it('announces a live summary of the visible rows and sort', async () => {
    renderPage();
    const summary = await screen.findByText('Rows 1 to 25 of 60, sorted by date descending');
    expect(summary).toHaveAttribute('aria-live', 'polite');
  });

  it('redirects an out-of-range page to the last page', async () => {
    renderPage('/settings/data?table=transactions&page=99');
    await waitFor(() => expect(search().get('page')).toBe('3'));
    expect(await screen.findByText('Rows 51 to 60 of 60')).toBeInTheDocument();
  });

  it('canonicalises page to 1 when the table is empty', async () => {
    dataBrowserService.getRows.mockImplementation(async (table, params) =>
      rowsResponse(table, params, { rows: [], total: 0 }),
    );
    renderPage('/settings/data?table=transactions&page=3');
    await waitFor(() => expect(search().get('page')).toBeNull());
    expect(await screen.findByText('No rows')).toBeInTheDocument();
  });

  it('keeps the loaded rows and shows an inline banner when a refetch fails', async () => {
    const { client } = renderPage();
    await screen.findByText('Coffee');
    dataBrowserService.getRows.mockRejectedValue(Object.assign(new Error('x'), { status: 500 }));
    await act(async () => {
      await client.refetchQueries({ queryKey: ['data-rows'] });
    });
    expect(await screen.findByText("Couldn't refresh. Showing last loaded rows.")).toBeInTheDocument();
    expect(screen.getByText('Coffee')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load rows.")).not.toBeInTheDocument();
    dataBrowserService.getRows.mockImplementation(async (table, params) => rowsResponse(table, params));
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/Couldn't refresh/)).not.toBeInTheDocument());
    expect(screen.getByText('Coffee')).toBeInTheDocument();
  });

  it('keeps the live summary region mounted across loading and loaded states', async () => {
    dataBrowserService.getRows.mockReturnValueOnce(new Promise(() => {}));
    const { container } = renderPage();
    await screen.findByRole('status', { name: 'Loading rows' });
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live).toHaveTextContent('');
  });

  it('resyncs the search box when q changes in the URL', async () => {
    renderPage('/settings/data?table=transactions&q=abc', '/settings/data?table=transactions&q=zzz');
    const box = await screen.findByRole('searchbox', { name: 'Search rows' });
    expect(box).toHaveValue('abc');
    await userEvent.click(screen.getByRole('button', { name: 'go' }));
    await waitFor(() => expect(box).toHaveValue('zzz'));
  });

  it('shows an empty state instead of a skeleton when there are no tables', async () => {
    dataBrowserService.listTables.mockResolvedValue({ tables: [] });
    renderPage();
    expect(await screen.findByText('No tables are available to browse.')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading rows' })).not.toBeInTheDocument();
  });

  it('switches tables and resets params', async () => {
    renderPage('/settings/data?table=transactions&q=abc&page=2');
    const nav = await screen.findByRole('navigation', { name: 'Tables' });
    await userEvent.click(within(nav).getByRole('button', { name: /Notes/ }));
    await waitFor(() => expect(search().get('table')).toBe('notes'));
    expect(search().get('q')).toBeNull();
    expect(search().get('page')).toBeNull();
  });
});

describe('DataBrowser placeholder data', () => {
  it('sets aria-busy while a page change is pending', async () => {
    renderPage();
    await screen.findByText('Rows 1 to 25 of 60');
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'false');
    let resolve;
    dataBrowserService.getRows.mockImplementation(
      (table, params) =>
        new Promise((r) => {
          resolve = () => r(rowsResponse(table, params));
        }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true'));
    await act(async () => resolve());
    await waitFor(() => expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'false'));
    expect(screen.getByText('Rows 26 to 50 of 60')).toBeInTheDocument();
  });

  it('never renders the previous table rows under the new table', async () => {
    renderPage();
    await screen.findByText('Coffee');
    let resolve;
    dataBrowserService.getRows.mockImplementation(
      (table, params) =>
        new Promise((r) => {
          resolve = () =>
            r(
              rowsResponse(table, params, {
                rows: [{ id: 'n1', date: '2026-04-01', merchant: 'NoteRow', amount: '1', value: null }],
              }),
            );
        }),
    );
    const nav = screen.getByRole('navigation', { name: 'Tables' });
    await userEvent.click(within(nav).getByRole('button', { name: /Notes/ }));
    await waitFor(() => expect(search().get('table')).toBe('notes'));
    expect(screen.queryByText('Coffee')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading rows' })).toBeInTheDocument();
    await act(async () => resolve());
    expect(await screen.findByText('NoteRow')).toBeInTheDocument();
    expect(screen.queryByText('Coffee')).not.toBeInTheDocument();
  });
});

describe('DataBrowser overview', () => {
  // TableOverview pulls in recharts, which Node loads synchronously as CommonJS. Load the lazy chunk
  // once up front so that blocking load never runs inside a findBy window (its late timer fails the test).
  beforeAll(() => import('../../components/dataBrowser/TableOverview'));
  it('shows generic copy for other overview errors', async () => {
    dataBrowserService.getOverview.mockRejectedValue(Object.assign(new Error('x'), { status: 500 }));
    renderPage('/settings/data?table=notes&view=overview');
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the overview.");
  });

  it('renders both charts for transactions with notes', async () => {
    renderPage();
    await screen.findByText('Coffee');
    await userEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(await screen.findByRole('img', { name: /rows per month/i })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /monthly income, expenses and net/i })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Monthly totals' })).toBeInTheDocument();
    expect(screen.getByText(/Showing the most recent 20,000 rows/)).toBeInTheDocument();
    expect(screen.getByText(/2 rows have no date/)).toBeInTheDocument();
  });

  it('omits the totals chart when there is no amount series', async () => {
    dataBrowserService.getOverview.mockResolvedValue({
      table: 'notes',
      rowsOverTime: [{ period: '2026-01', count: 1 }],
      undated: 0,
      truncated: false,
    });
    renderPage('/settings/data?table=notes&view=overview');
    expect(await screen.findByRole('img', { name: /rows per month/i })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /monthly income/i })).not.toBeInTheDocument();
  });

  it('keeps the loaded charts and shows an inline banner when an overview refetch fails', async () => {
    const { client } = renderPage('/settings/data?table=transactions&view=overview');
    await screen.findByRole('img', { name: /rows per month/i });
    dataBrowserService.getOverview.mockRejectedValue(Object.assign(new Error('x'), { status: 500 }));
    await act(async () => {
      await client.refetchQueries({ queryKey: ['data-overview'] });
    });
    expect(await screen.findByText("Couldn't refresh. Showing last loaded overview.")).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /rows per month/i })).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load the overview.")).not.toBeInTheDocument();
    dataBrowserService.getOverview.mockResolvedValue({
      table: 'transactions',
      rowsOverTime: [{ period: '2026-01', count: 1 }],
      undated: 0,
      truncated: false,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/Couldn't refresh/)).not.toBeInTheDocument());
  });

  it('supports Home and End on the tablist', async () => {
    renderPage();
    await screen.findByText('Coffee');
    screen.getByRole('tab', { name: 'Rows' }).focus();
    await userEvent.keyboard('{End}');
    await waitFor(() => expect(search().get('view')).toBe('overview'));
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveFocus();
    await userEvent.keyboard('{Home}');
    await waitFor(() => expect(search().get('view')).toBeNull());
    expect(screen.getByRole('tab', { name: 'Rows' })).toHaveFocus();
  });

  it('supports arrow-key tab navigation', async () => {
    renderPage();
    await screen.findByText('Coffee');
    screen.getByRole('tab', { name: 'Rows' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(search().get('view')).toBe('overview'));
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveFocus();
  });

  it('leaves Alt/Ctrl/Meta+Arrow alone so Alt+Left reaches Back', async () => {
    renderPage();
    await screen.findByText('Coffee');
    const tab = screen.getByRole('tab', { name: 'Rows' });
    tab.focus();
    for (const init of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      expect(fireEvent.keyDown(tab, { key: 'ArrowLeft', ...init })).toBe(true);
      expect(fireEvent.keyDown(tab, { key: 'ArrowRight', ...init })).toBe(true);
    }
    expect(search().get('view')).toBeNull();
    expect(tab).toHaveFocus();
  });
});
