import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import { MemoryRouter, useLocation } from 'react-router-dom';
import CountdownsPage from '../CountdownsPage';

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{`${loc.pathname}${loc.search}`}</output>;
}

// The page reads the `new` intent from the URL, so it renders inside a router.
const renderPage = (ui, entry = '/') =>
  renderWithProviders(
    <MemoryRouter initialEntries={[entry]}>
      {ui}
      <Where />
    </MemoryRouter>,
  );

const h = vi.hoisted(() => ({
  state: {},
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('../../../hooks/useCountdowns', () => ({
  useCountdowns: () => ({
    countdowns: [],
    loading: false,
    error: null,
    add: h.add,
    update: h.update,
    remove: h.remove,
    refresh: h.refresh,
    ...h.state,
  }),
}));

const trip = { id: 'c1', title: 'Trip', targetDate: '2099-01-01', context: 'home' };

beforeEach(() => {
  h.state = { countdowns: [trip] };
  h.add.mockReset().mockResolvedValue(undefined);
  h.update.mockReset().mockResolvedValue(undefined);
  h.remove.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('CountdownsPage', () => {
  it('renders no form or dialog on load', () => {
    renderPage(<CountdownsPage />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Trip')).toBeInTheDocument();
  });

  it('shows the 503 state', () => {
    h.state = { error: { status: 503 } };
    renderPage(<CountdownsPage />);
    expect(screen.getByText('Countdowns unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add countdown' })).not.toBeInTheDocument();
  });

  it('Add opens a dialog with focus in the first field, creates, closes, toasts and returns focus', async () => {
    renderPage(<CountdownsPage />);
    const addBtn = screen.getByRole('button', { name: 'Add countdown' });
    await userEvent.click(addBtn);
    const dlg = screen.getByRole('dialog', { name: 'Add countdown' });
    expect(within(dlg).getByLabelText('Title')).toHaveFocus();
    expect(within(dlg).queryByLabelText('Context')).not.toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: 'Add countdown' })).toBeDisabled();

    await userEvent.type(within(dlg).getByLabelText('Title'), ' Launch ');
    fireEvent.change(within(dlg).getByLabelText('Target date'), { target: { value: '2099-05-06' } });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Add countdown' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(h.add).toHaveBeenCalledWith({ title: 'Launch', targetDate: '2099-05-06' });
    expect(h.add.mock.calls[0][0]).not.toHaveProperty('context');
    expect(screen.getByText('Countdown added')).toBeInTheDocument();
    expect(addBtn).toHaveFocus();
  });

  it('shows the error and keeps the dialog open when add rejects', async () => {
    h.add.mockRejectedValue(new Error('boom'));
    renderPage(<CountdownsPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Add countdown' }));
    const dlg = screen.getByRole('dialog');
    await userEvent.type(within(dlg).getByLabelText('Title'), 'Launch');
    fireEvent.change(within(dlg).getByLabelText('Target date'), { target: { value: '2099-05-06' } });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Add countdown' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent("Couldn't save the countdown. Try again.");
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dlg).getByLabelText('Title')).toHaveValue('Launch');
  });

  it('Edit prefills and calls update(id, patch)', async () => {
    renderPage(<CountdownsPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit Trip' }));
    const dlg = screen.getByRole('dialog', { name: 'Edit countdown' });
    expect(within(dlg).getByLabelText('Title')).toHaveValue('Trip');
    expect(within(dlg).getByLabelText('Target date')).toHaveValue('2099-01-01');
    expect(within(dlg).queryByLabelText('Context')).not.toBeInTheDocument();

    await userEvent.clear(within(dlg).getByLabelText('Title'));
    await userEvent.type(within(dlg).getByLabelText('Title'), 'Holiday');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(h.update).toHaveBeenCalledWith('c1', { title: 'Holiday', targetDate: '2099-01-01' });
    expect(h.update.mock.calls[0][1]).not.toHaveProperty('context');
    expect(h.add).not.toHaveBeenCalled();
    expect(screen.getByText('Countdown updated')).toBeInTheDocument();
  });

  it('Remove opens an alertdialog with Cancel focused; Cancel makes no call', async () => {
    const win = vi.spyOn(window, 'confirm');
    renderPage(<CountdownsPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Trip' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(h.remove).not.toHaveBeenCalled();
    expect(win).not.toHaveBeenCalled();
  });

  it('Confirm calls remove(id), closes and toasts', async () => {
    renderPage(<CountdownsPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Trip' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(h.remove).toHaveBeenCalledWith('c1');
    expect(screen.getByText('Countdown removed')).toBeInTheDocument();
  });

  it('shows an error and stays open when remove rejects', async () => {
    h.remove.mockRejectedValue(new Error('nope'));
    renderPage(<CountdownsPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Trip' }));
    const dlg = screen.getByRole('alertdialog');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Remove' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent("Burrow couldn't finish that. Try again.");
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('Escape closes the dialog without saving', async () => {
    renderPage(<CountdownsPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Add countdown' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(h.add).not.toHaveBeenCalled();
  });

  it('the X in the form closes without saving', async () => {
    renderPage(<CountdownsPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit Trip' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('hides actions for temp ids', () => {
    h.state = { countdowns: [{ ...trip, id: 'temp-1' }] };
    renderPage(<CountdownsPage />);
    expect(screen.getByText('Trip')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Trip' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Trip' })).not.toBeInTheDocument();
  });

  it('empty state offers an Add CTA that opens the dialog', async () => {
    h.state = { countdowns: [] };
    renderPage(<CountdownsPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Add your first countdown' }));
    expect(screen.getByRole('dialog', { name: 'Add countdown' })).toBeInTheDocument();
  });

  it('empty state shows exactly one Add button', () => {
    h.state = { countdowns: [] };
    renderPage(<CountdownsPage />);
    expect(screen.getAllByRole('button', { name: /^Add/ })).toHaveLength(1);
  });

  it('hides the count while loading', () => {
    h.state = { countdowns: [], loading: true };
    renderPage(<CountdownsPage />);
    expect(screen.queryByText(/0 countdowns/)).not.toBeInTheDocument();
  });

  it('shows LoadError (not the empty state) on a non-503 error', async () => {
    h.state = { countdowns: [], error: { status: 500 } };
    renderPage(<CountdownsPage />);
    expect(screen.getByRole('alert')).toHaveTextContent("Burrow couldn't load your countdowns. Your data is safe.");
    expect(screen.queryByText('No countdowns yet.')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('CountdownsPage new-item intent', () => {
  it('opens the add dialog once for ?new=1 and removes the param', async () => {
    renderPage(<CountdownsPage />, '/page?new=1');
    expect(await screen.findByRole('dialog', { name: 'Add countdown' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/page$/));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('opens no dialog without the param', () => {
    renderPage(<CountdownsPage />, '/page');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
