import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import NotesPage from '../NotesPage';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';

const h = vi.hoisted(() => ({
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  refresh: vi.fn(),
  notes: [],
  loading: false,
  error: null,
}));

vi.mock('../../../hooks/useNotes', () => ({
  useNotes: () => ({
    notes: h.notes,
    loading: h.loading,
    error: h.error,
    add: h.add,
    update: h.update,
    remove: h.remove,
    refresh: h.refresh,
  }),
}));

const NOTES = [
  { id: 'n1', body: 'Buy milk', color: 'blue', context: 'home', pinned: false },
  { id: 'n2', body: 'Call the plumber', color: 'green', context: 'work', pinned: true },
];

describe('NotesPage CRUD', () => {
  beforeEach(() => {
    h.add.mockReset().mockResolvedValue({});
    h.update.mockReset().mockResolvedValue({});
    h.remove.mockReset().mockResolvedValue({});
    h.notes = NOTES;
    h.loading = false;
    h.error = null;
  });
  afterEach(cleanup);

  it('shows no form or dialog on load', () => {
    renderWithProviders(<NotesPage />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Note' })).not.toBeInTheDocument();
    expect(screen.getByText('2 notes')).toBeInTheDocument();
  });

  it('Add opens a dialog with focus in the first field, creates, closes, toasts and restores focus', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotesPage />);
    const addBtn = screen.getByRole('button', { name: 'Add note' });
    await user.click(addBtn);
    const dialog = screen.getByRole('dialog', { name: 'Add note' });
    const body = within(dialog).getByRole('textbox', { name: 'Note' });
    expect(body).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Add note' })).toBeDisabled();
    await user.type(body, '  Water plants  ');
    await user.selectOptions(within(dialog).getByLabelText('Color'), 'pink');
    await user.click(within(dialog).getByRole('button', { name: 'Add note' }));
    await waitFor(() =>
      expect(h.add).toHaveBeenCalledWith({ body: 'Water plants', color: 'pink' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Note added')).toBeInTheDocument();
    expect(addBtn).toHaveFocus();
  });

  it('Edit opens prefilled and sends update(id, payload)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotesPage />);
    await user.click(screen.getByRole('button', { name: 'Edit Buy milk' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit note' });
    const body = within(dialog).getByRole('textbox', { name: 'Note' });
    expect(body).toHaveValue('Buy milk');
    expect(within(dialog).getByLabelText('Color')).toHaveValue('blue');
    expect(within(dialog).queryByLabelText('Context')).not.toBeInTheDocument();
    await user.clear(body);
    await user.type(body, 'Buy oat milk');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(h.update).toHaveBeenCalledWith('n1', {
        body: 'Buy oat milk',
        color: 'blue',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Note updated')).toBeInTheDocument();
  });

  it('pin toggle still calls update with pinned', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotesPage />);
    await user.click(screen.getByRole('button', { name: 'Pin note' }));
    expect(h.update).toHaveBeenCalledWith('n1', { pinned: true });
    expect(screen.getByRole('button', { name: 'Unpin note' })).toBeInTheDocument();
  });

  it('Remove confirms with Cancel focused; Cancel makes no call; Confirm deletes', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm');
    renderWithProviders(<NotesPage />);
    await user.click(screen.getByRole('button', { name: 'Remove Buy milk' }));
    let alert = screen.getByRole('alertdialog');
    expect(within(alert).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(alert).getByRole('button', { name: 'Cancel' }));
    expect(h.remove).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove Buy milk' }));
    alert = screen.getByRole('alertdialog');
    await user.click(within(alert).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(h.remove).toHaveBeenCalledWith('n1'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Note removed')).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('the X in the form closes without calling add', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotesPage />);
    await user.click(screen.getByRole('button', { name: 'Add note' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(h.add).not.toHaveBeenCalled();
  });

  it('rejected submit shows the error and keeps the dialog and values', async () => {
    h.add.mockRejectedValue(new Error('Save failed'));
    const user = userEvent.setup();
    renderWithProviders(<NotesPage />);
    await user.click(screen.getByRole('button', { name: 'Add note' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Note' }), 'Hello');
    await user.click(within(dialog).getByRole('button', { name: 'Add note' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("Couldn't save the note. Try again.");
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: 'Note' })).toHaveValue('Hello');
  });

  it('rejected remove shows the error and keeps the confirm open', async () => {
    h.remove.mockRejectedValue(new Error('Delete failed'));
    const user = userEvent.setup();
    renderWithProviders(<NotesPage />);
    await user.click(screen.getByRole('button', { name: 'Remove Buy milk' }));
    const alert = screen.getByRole('alertdialog');
    await user.click(within(alert).getByRole('button', { name: 'Remove' }));
    expect(await within(alert).findByRole('alert')).toHaveTextContent("Burrow couldn't finish that. Try again.");
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('Escape closes the dialog', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NotesPage />);
    await user.click(screen.getByRole('button', { name: 'Add note' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('temp-id notes have no actions', () => {
    h.notes = [{ id: 'temp-1', body: 'Optimistic', color: 'yellow', context: 'work', pinned: false }];
    renderWithProviders(<NotesPage />);
    expect(screen.getByText('Optimistic')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(Edit|Remove|Pin)/ })).not.toBeInTheDocument();
  });

  it('empty state offers an add CTA that opens the dialog', async () => {
    h.notes = [];
    const user = userEvent.setup();
    renderWithProviders(<NotesPage />);
    await user.click(screen.getByRole('button', { name: 'Add your first note' }));
    expect(screen.getByRole('dialog', { name: 'Add note' })).toBeInTheDocument();
  });

  it('renders the 503 unavailable state', () => {
    h.error = { status: 503 };
    renderWithProviders(<NotesPage />);
    expect(screen.getByText('Notes unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add/ })).not.toBeInTheDocument();
  });

  it('shows LoadError (not the empty state) on a non-503 error, and hides count and Add', async () => {
    h.notes = [];
    h.error = { status: 500 };
    renderWithProviders(<NotesPage />);
    expect(screen.getByRole('alert')).toHaveTextContent("Burrow couldn't load your notes. Your data is safe.");
    expect(screen.queryByText('No notes yet.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Add/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('saves with Ctrl+Enter from the note field', async () => {
    renderWithProviders(<NotesPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Pay rent');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(h.add).toHaveBeenCalledWith({ body: 'Pay rent', color: 'yellow' }));
  });
});
