import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import { MemoryRouter, useLocation } from 'react-router-dom';
import HabitsPage from '../HabitsPage';
import { isoToday } from '../../../utils/habits';

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
  toggle: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('../../../hooks/useHabits', () => ({
  useHabits: () => ({
    habits: [],
    loading: false,
    error: null,
    add: h.add,
    update: h.update,
    remove: h.remove,
    toggle: h.toggle,
    refresh: h.refresh,
    ...h.state,
  }),
}));

const run = { id: 'h1', title: 'Run', frequency: 'weekly', color: 'blue', context: 'work', completions: [] };

beforeEach(() => {
  h.state = { habits: [run] };
  h.add.mockReset().mockResolvedValue(undefined);
  h.update.mockReset().mockResolvedValue(undefined);
  h.remove.mockReset().mockResolvedValue(undefined);
  h.toggle.mockReset();
  h.refresh.mockReset();
});
afterEach(cleanup);

describe('HabitsPage', () => {
  it('renders no form or dialog on load', () => {
    renderPage(<HabitsPage />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Run')).toBeInTheDocument();
  });

  it('shows the 503 state without actions', () => {
    h.state = { error: { status: 503 } };
    renderPage(<HabitsPage />);
    expect(screen.getByText('Habits unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add habit' })).not.toBeInTheDocument();
  });

  it('Add opens a dialog with focus in the first field, creates, closes, toasts and returns focus', async () => {
    renderPage(<HabitsPage />);
    const addBtn = screen.getByRole('button', { name: 'Add habit' });
    await userEvent.click(addBtn);
    const dlg = screen.getByRole('dialog', { name: 'Add habit' });
    expect(within(dlg).getByLabelText('Title')).toHaveFocus();
    expect(within(dlg).getByRole('button', { name: 'Add habit' })).toBeDisabled();

    await userEvent.type(within(dlg).getByLabelText('Title'), '  Read  ');
    await userEvent.selectOptions(within(dlg).getByLabelText('Frequency'), 'weekday');
    await userEvent.selectOptions(within(dlg).getByLabelText('Color'), 'green');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Add habit' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(h.add).toHaveBeenCalledWith({ title: 'Read', frequency: 'weekday', color: 'green' });
    expect(screen.getByText('Habit added')).toBeInTheDocument();
    expect(addBtn).toHaveFocus();
  });

  it('shows the error and keeps the dialog open when add rejects', async () => {
    h.add.mockRejectedValue(new Error('boom'));
    renderPage(<HabitsPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Add habit' }));
    const dlg = screen.getByRole('dialog');
    await userEvent.type(within(dlg).getByLabelText('Title'), 'Read');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Add habit' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent("Couldn't save the habit. Try again.");
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dlg).getByLabelText('Title')).toHaveValue('Read');
  });

  it('cannot be dismissed while a submit is pending, then can after it resolves', async () => {
    let resolve;
    h.add.mockReturnValue(new Promise((r) => (resolve = r)));
    renderPage(<HabitsPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Add habit' }));
    const dlg = screen.getByRole('dialog');
    await userEvent.type(within(dlg).getByLabelText('Title'), 'Read');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Add habit' }));

    await waitFor(() => expect(within(dlg).getByRole('button', { name: 'Close' })).toBeDisabled());
    await userEvent.keyboard('{Escape}');
    fireEvent.mouseDown(dlg.parentElement);
    await userEvent.click(within(dlg).getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await act(async () => resolve());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('Edit prefills and calls update(id, patch)', async () => {
    renderPage(<HabitsPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit Run' }));
    const dlg = screen.getByRole('dialog', { name: 'Edit habit' });
    expect(within(dlg).getByLabelText('Title')).toHaveValue('Run');
    expect(within(dlg).getByLabelText('Frequency')).toHaveValue('weekly');
    expect(within(dlg).getByLabelText('Color')).toHaveValue('blue');
    expect(within(dlg).queryByLabelText('Context')).not.toBeInTheDocument();

    await userEvent.clear(within(dlg).getByLabelText('Title'));
    await userEvent.type(within(dlg).getByLabelText('Title'), 'Jog');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(h.update).toHaveBeenCalledWith('h1', { title: 'Jog', frequency: 'weekly', color: 'blue' });
    expect(h.update.mock.calls[0][1]).not.toHaveProperty('context');
    expect(h.add).not.toHaveBeenCalled();
    expect(screen.getByText('Habit updated')).toBeInTheDocument();
  });

  it('Remove opens an alertdialog with Cancel focused; Cancel makes no call', async () => {
    const win = vi.spyOn(window, 'confirm');
    renderPage(<HabitsPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Run' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(h.remove).not.toHaveBeenCalled();
    expect(win).not.toHaveBeenCalled();
  });

  it('Confirm calls remove(id), closes and toasts', async () => {
    renderPage(<HabitsPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Run' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(h.remove).toHaveBeenCalledWith('h1');
    expect(screen.getByText('Habit removed')).toBeInTheDocument();
  });

  it('shows an error and stays open when remove rejects', async () => {
    h.remove.mockRejectedValue(new Error('nope'));
    renderPage(<HabitsPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Run' }));
    const dlg = screen.getByRole('alertdialog');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Remove' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent("Burrow couldn't finish that. Try again.");
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('Escape closes the dialog without saving', async () => {
    renderPage(<HabitsPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Add habit' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(h.add).not.toHaveBeenCalled();
  });

  it('the X in the form closes without saving', async () => {
    renderPage(<HabitsPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit Run' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('hides actions for temp ids', () => {
    h.state = { habits: [{ ...run, id: 'temp-1' }] };
    renderPage(<HabitsPage />);
    expect(screen.getByText('Run')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Run' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Run' })).not.toBeInTheDocument();
  });

  it('empty state offers an Add CTA that opens the dialog', async () => {
    h.state = { habits: [] };
    renderPage(<HabitsPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Add your first habit' }));
    expect(screen.getByRole('dialog', { name: 'Add habit' })).toBeInTheDocument();
  });

  it('shows LoadError instead of the empty state on a non-503 error, and Retry refetches', async () => {
    h.state = { habits: [], error: { status: 500 } };
    renderPage(<HabitsPage />);
    expect(screen.getByRole('alert')).toHaveTextContent("Burrow couldn't load your habits. Your data is safe.");
    expect(screen.queryByText(/No habits yet/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add habit' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('has a today button with aria-pressed that toggles today', async () => {
    renderPage(<HabitsPage />);
    const btn = screen.getByRole('button', { name: 'Done today: Run' });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(btn);
    expect(h.toggle).toHaveBeenCalledWith('h1', isoToday(), false);
  });

  it('reflects a habit already done today', () => {
    h.state = { habits: [{ ...run, completions: [isoToday()] }] };
    renderPage(<HabitsPage />);
    expect(screen.getByRole('button', { name: 'Done today: Run' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('gives the 30-day grid a text summary for screen readers', () => {
    h.state = { habits: [{ ...run, completions: [isoToday()] }] };
    renderPage(<HabitsPage />);
    expect(screen.getByText('1 of 30 days done')).toBeInTheDocument();
  });

  it('toasts when saving a toggle fails', async () => {
    h.toggle.mockRejectedValue(new Error('down'));
    renderPage(<HabitsPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Done today: Run' }));
    expect(await screen.findByText(/Couldn't save that/)).toBeInTheDocument();
  });
});

describe('HabitsPage new-item intent', () => {
  it('opens the add dialog once for ?new=1 and removes the param', async () => {
    renderPage(<HabitsPage />, '/page?new=1');
    expect(await screen.findByRole('dialog', { name: 'Add habit' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/page$/));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('opens no dialog without the param', () => {
    renderPage(<HabitsPage />, '/page');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
