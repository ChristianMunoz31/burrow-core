import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ColumnSettings from '../ColumnSettings';
import { useTodoColumns } from '../../../hooks/useTodoColumns';
import { ToastProvider } from '../../../contexts/ToastContext';

const COLUMNS = [
  { id: 'c1', name: 'Backlog', color: 'gray', order: 0 },
  { id: 'c2', name: 'Done', color: 'green', order: 1 },
];

const TAKEN = {
  error: 'column_name_taken',
  code: 'column_name_taken',
  message: 'A column with that name already exists.',
};

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

let patchResponse;
let client;

const wrapper = ({ children }) => (
  <QueryClientProvider client={client}>
    <ToastProvider>{children}</ToastProvider>
  </QueryClientProvider>
);

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  patchResponse = json(409, TAKEN);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options = {}) => {
      if (options.method === 'PATCH') return patchResponse;
      return json(200, { columns: COLUMNS, source: 'local', writable: true });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ColumnSettings rename', () => {
  it('shows the server message for a taken name and restores the old value', async () => {
    const user = userEvent.setup();
    render(<ColumnSettings onClose={vi.fn()} />, { wrapper });
    const input = await screen.findByRole('textbox', { name: 'Name of column Backlog' });

    await user.clear(input);
    await user.type(input, 'done');
    await user.tab();

    expect(await screen.findByRole('alert')).toHaveTextContent('A column with that name already exists.');
    expect(input).toHaveValue('Backlog');
  });

  it('keeps the new name and shows no alert after a successful rename', async () => {
    patchResponse = json(200, { id: 'c1', name: 'Later', color: 'gray', order: 0 });
    const user = userEvent.setup();
    render(<ColumnSettings onClose={vi.fn()} />, { wrapper });
    const input = await screen.findByRole('textbox', { name: 'Name of column Backlog' });

    await user.clear(input);
    await user.type(input, 'Later');
    await user.tab();

    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([, o]) => o && o.method === 'PATCH')).toBe(true),
    );
    await waitFor(() => expect(input).toHaveValue('Later'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('falls back to the generic save error for a failure with no deliberate copy', async () => {
    patchResponse = json(500, {});
    const user = userEvent.setup();
    render(<ColumnSettings onClose={vi.fn()} />, { wrapper });
    const input = await screen.findByRole('textbox', { name: 'Name of column Backlog' });

    await user.clear(input);
    await user.type(input, 'Todo');
    await user.tab();

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save that change.");
    expect(input).toHaveValue('Backlog');
  });
});

describe('useTodoColumns update', () => {
  it('invalidates the todos query after a rename', async () => {
    patchResponse = json(200, { id: 'c1', name: 'Later', color: 'gray', order: 0 });
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useTodoColumns(), { wrapper });
    await waitFor(() => expect(result.current.columns).toHaveLength(2));

    await result.current.update('c1', { name: 'Later' });

    expect(spy).toHaveBeenCalledWith({ queryKey: ['todos'] });
  });

  it('leaves the todos query alone for a color change', async () => {
    patchResponse = json(200, { id: 'c1', name: 'Backlog', color: 'red', order: 0 });
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useTodoColumns(), { wrapper });
    await waitFor(() => expect(result.current.columns).toHaveLength(2));

    await result.current.update('c1', { color: 'red' });

    expect(spy).not.toHaveBeenCalledWith({ queryKey: ['todos'] });
  });
});
