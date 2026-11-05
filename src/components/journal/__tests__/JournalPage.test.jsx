import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import JournalPage from '../JournalPage';
import { userError } from '../../../utils/apiError';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';

const h = vi.hoisted(() => ({
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  refresh: vi.fn(),
  entries: [],
  loading: false,
  error: null,
}));

vi.mock('../../../hooks/useJournal', () => ({
  useJournal: () => ({
    entries: h.entries,
    loading: h.loading,
    error: h.error,
    add: h.add,
    update: h.update,
    remove: h.remove,
    refresh: h.refresh,
  }),
}));

vi.mock('../../../hooks/useSpeechRecognition', () => ({
  useSpeechRecognition: () => ({
    supported: false,
    listening: false,
    interim: '',
    transcript: '',
    start: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
    error: null,
  }),
}));

vi.mock('../JournalStats', () => ({ default: () => <div data-testid="stats" /> }));

const ENTRIES = [
  {
    id: 'e1',
    title: 'Good day',
    body: 'Shipped the feature',
    mood: 'great',
    tags: ['work'],
    context: 'work',
    date: '2026-05-01T15:00:00.000Z',
  },
  {
    id: 'e2',
    title: '',
    body: 'Quiet evening',
    mood: null,
    tags: [],
    context: 'home',
    date: '2026-05-02T15:00:00.000Z',
  },
];

describe('JournalPage CRUD', () => {
  beforeEach(() => {
    h.add.mockReset().mockResolvedValue({});
    h.update.mockReset().mockResolvedValue({});
    h.remove.mockReset().mockResolvedValue({});
    h.entries = ENTRIES;
    h.loading = false;
    h.error = null;
  });
  afterEach(cleanup);

  it('shows no composer or dialog on load', async () => {
    renderWithProviders(<JournalPage />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Entry' })).not.toBeInTheDocument();
    expect(await screen.findByTestId('stats')).toBeInTheDocument();
  });

  it('New entry opens a large dialog, creates with the exact payload, closes, toasts, restores focus', async () => {
    const user = userEvent.setup();
    renderWithProviders(<JournalPage />);
    const newBtn = screen.getByRole('button', { name: 'New entry' });
    await user.click(newBtn);
    const dialog = screen.getByRole('dialog', { name: 'New entry' });
    expect(dialog.className).toContain('sm:max-w-2xl');
    const title = within(dialog).getByRole('textbox', { name: 'Title (optional)' });
    expect(within(dialog).getByRole('textbox', { name: 'Entry' })).toHaveFocus();
    expect(within(dialog).queryByLabelText('Context')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Add entry' })).toBeDisabled();
    await user.type(title, ' Hi ');
    await user.type(within(dialog).getByRole('textbox', { name: 'Entry' }), ' Today was fine ');
    await user.selectOptions(within(dialog).getByLabelText('Mood'), 'good');
    await user.type(within(dialog).getByPlaceholderText('Add tag…'), 'life{Enter}');
    await user.click(within(dialog).getByRole('button', { name: 'Add entry' }));
    await waitFor(() =>
      expect(h.add).toHaveBeenCalledWith({
        title: 'Hi',
        body: 'Today was fine',
        mood: 'good',
        tags: ['life'],
      }),
    );
    expect(h.add.mock.calls[0][0]).not.toHaveProperty('context');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Entry added')).toBeInTheDocument();
    expect(newBtn).toHaveFocus();
  });

  it('Edit opens prefilled and sends the patch', async () => {
    const user = userEvent.setup();
    renderWithProviders(<JournalPage />);
    await user.click(screen.getByRole('button', { name: 'Edit Good day' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit entry' });
    expect(within(dialog).getByRole('textbox', { name: 'Title (optional)' })).toHaveValue('Good day');
    const body = within(dialog).getByRole('textbox', { name: 'Entry' });
    expect(body).toHaveValue('Shipped the feature');
    expect(within(dialog).getByLabelText('Mood')).toHaveValue('great');
    expect(within(dialog).getByRole('button', { name: 'Remove tag work' })).toBeInTheDocument();
    await user.clear(body);
    await user.type(body, 'Shipped it');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(h.update).toHaveBeenCalledWith('e1', {
        title: 'Good day',
        body: 'Shipped it',
        mood: 'great',
        tags: ['work'],
      }),
    );
    // The patch has no context key, so the stored tag stays.
    expect(h.update.mock.calls[0][1]).not.toHaveProperty('context');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Entry updated')).toBeInTheDocument();
  });

  it('edit sends mood:null when the mood is cleared', async () => {
    const user = userEvent.setup();
    renderWithProviders(<JournalPage />);
    await user.click(screen.getByRole('button', { name: 'Edit Good day' }));
    const dialog = screen.getByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Mood'), '');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(h.update).toHaveBeenCalled());
    expect(h.update.mock.calls[0][1].mood).toBeNull();
    expect(h.update.mock.calls[0][1]).not.toHaveProperty('date');
  });

  it('Remove confirms with Cancel focused; Cancel makes no call; Confirm deletes', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm');
    renderWithProviders(<JournalPage />);
    await user.click(screen.getByRole('button', { name: 'Remove Good day' }));
    let alert = screen.getByRole('alertdialog');
    expect(within(alert).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(alert).getByRole('button', { name: 'Cancel' }));
    expect(h.remove).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Remove Good day' }));
    alert = screen.getByRole('alertdialog');
    await user.click(within(alert).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(h.remove).toHaveBeenCalledWith('e1'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Entry removed')).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('the X in the form closes without calling add', async () => {
    const user = userEvent.setup();
    renderWithProviders(<JournalPage />);
    await user.click(screen.getByRole('button', { name: 'New entry' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(h.add).not.toHaveBeenCalled();
  });

  it('rejected submit shows the error and keeps the dialog and values', async () => {
    h.add.mockRejectedValue(new Error('Save failed'));
    const user = userEvent.setup();
    renderWithProviders(<JournalPage />);
    await user.click(screen.getByRole('button', { name: 'New entry' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Entry' }), 'Hello');
    await user.click(within(dialog).getByRole('button', { name: 'Add entry' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't save the entry. Try again.");
    expect(alert).not.toHaveTextContent('Save failed');
    expect(within(dialog).getByRole('textbox', { name: 'Entry' })).toHaveValue('Hello');
  });

  it('shows deliberate server copy for a rejected submit', async () => {
    h.add.mockRejectedValue(userError('That entry is too long.'));
    const user = userEvent.setup();
    renderWithProviders(<JournalPage />);
    await user.click(screen.getByRole('button', { name: 'New entry' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Entry' }), 'Hello');
    await user.click(within(dialog).getByRole('button', { name: 'Add entry' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('That entry is too long.');
  });

  it('rejected remove shows the error and keeps the confirm open', async () => {
    h.remove.mockRejectedValue(new Error('Delete failed'));
    const user = userEvent.setup();
    renderWithProviders(<JournalPage />);
    await user.click(screen.getByRole('button', { name: 'Remove Good day' }));
    const alert = screen.getByRole('alertdialog');
    await user.click(within(alert).getByRole('button', { name: 'Remove' }));
    expect(await within(alert).findByRole('alert')).toHaveTextContent("Burrow couldn't finish that. Try again.");
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('Escape closes the dialog', async () => {
    const user = userEvent.setup();
    renderWithProviders(<JournalPage />);
    await user.click(screen.getByRole('button', { name: 'New entry' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('untitled entries are named by time and temp-id entries have no actions', () => {
    h.entries = [
      ENTRIES[1],
      { id: 'temp-1', title: 'Pending', body: 'x', tags: [], context: 'work', date: '2026-05-03T15:00:00.000Z' },
    ];
    renderWithProviders(<JournalPage />);
    expect(screen.getByRole('button', { name: /^Edit entry from / })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Pending' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Pending' })).not.toBeInTheDocument();
  });

  it('empty state offers an add CTA that opens the dialog', async () => {
    h.entries = [];
    const user = userEvent.setup();
    renderWithProviders(<JournalPage />);
    await user.click(screen.getByRole('button', { name: 'Add your first entry' }));
    expect(screen.getByRole('dialog', { name: 'New entry' })).toBeInTheDocument();
  });

  it('renders the 503 unavailable state', () => {
    h.error = { status: 503 };
    renderWithProviders(<JournalPage />);
    expect(screen.getByText('Journal unavailable')).toBeInTheDocument();
  });

  it('shows LoadError (not the empty state) on a non-503 error', async () => {
    h.entries = [];
    h.error = { status: 500 };
    renderWithProviders(<JournalPage />);
    expect(screen.getByRole('alert')).toHaveTextContent("Burrow couldn't load your journal entries. Your data is safe.");
    expect(screen.queryByText('No entries yet.')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('saves with Ctrl+Enter from the entry field', async () => {
    const user = userEvent.setup();
    renderWithProviders(<JournalPage />);
    await user.click(screen.getByRole('button', { name: 'New entry' }));
    await user.type(screen.getByRole('textbox', { name: 'Entry' }), 'Quick thought');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(h.add).toHaveBeenCalled());
    expect(h.add.mock.calls[0][0]).toMatchObject({ body: 'Quick thought' });
  });

  it('puts the stats card after the entry list', async () => {
    h.entries = ENTRIES;
    renderWithProviders(<JournalPage />);
    const list = screen.getByRole('heading', { name: /^Entries/ });
    const stats = await screen.findByTestId('stats');
    expect(list.compareDocumentPosition(stats) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
