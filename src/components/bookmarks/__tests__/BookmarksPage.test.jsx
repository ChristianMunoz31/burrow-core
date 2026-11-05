import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import BookmarksPage from '../BookmarksPage';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import { MemoryRouter, useLocation } from 'react-router-dom';

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
  state: { bookmarks: [], loading: false, error: null },
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('../../../hooks/useBookmarks', () => ({
  useBookmarks: () => ({ ...h.state, add: h.add, update: h.update, remove: h.remove, refresh: h.refresh }),
}));

const GH = { id: 'b1', title: 'GitHub', url: 'https://github.com', category: 'Dev', context: 'work' };
const NEWS = { id: 'b2', title: 'News', url: 'https://news.com', category: '', context: 'home' };

beforeEach(() => {
  h.state = { bookmarks: [GH, NEWS], loading: false, error: null };
  h.add.mockReset().mockResolvedValue({});
  h.update.mockReset().mockResolvedValue({});
  h.remove.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

describe('BookmarksPage CRUD dialogs', () => {
  it('renders no form on load, and groups in order', () => {
    renderPage(<BookmarksPage />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    const headings = screen.getAllByRole('heading', { level: 3 }).map((n) => n.textContent);
    expect(headings).toEqual(['Dev', 'Ungrouped']);
  });

  it('Add opens a dialog focused on the first field and creates the bookmark', async () => {
    const user = userEvent.setup();
    renderPage(<BookmarksPage />);
    const addBtn = screen.getByRole('button', { name: 'Add bookmark' });
    await user.click(addBtn);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Title')).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Add bookmark' })).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Title'), '  Docs ');
    await user.type(within(dialog).getByLabelText('URL'), 'docs.example.com');
    await user.type(within(dialog).getByLabelText('Group'), ' Ref ');
    await user.click(within(dialog).getByRole('button', { name: 'Add bookmark' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(h.add).toHaveBeenCalledWith({
      title: 'Docs',
      url: 'https://docs.example.com',
      category: 'Ref',
    });
    expect(h.add.mock.calls[0][0]).not.toHaveProperty('context');
    expect(screen.getByText('Bookmark added')).toBeInTheDocument();
    expect(addBtn).toHaveFocus();
  });

  it('rejected submit shows the error and keeps the dialog open with values', async () => {
    h.add.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderPage(<BookmarksPage />);
    await user.click(screen.getByRole('button', { name: 'Add bookmark' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Title'), 'Docs');
    await user.type(within(dialog).getByLabelText('URL'), 'x.com');
    await user.click(within(dialog).getByRole('button', { name: 'Add bookmark' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("Couldn't save the bookmark. Try again.");
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Docs');
  });

  it('Edit prefills the form and calls update(id, patch)', async () => {
    const user = userEvent.setup();
    renderPage(<BookmarksPage />);
    await user.click(screen.getByRole('button', { name: 'Edit GitHub' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit bookmark' });
    expect(within(dialog).getByLabelText('Title')).toHaveValue('GitHub');
    expect(within(dialog).getByLabelText('URL')).toHaveValue('https://github.com');
    expect(within(dialog).getByLabelText('Group')).toHaveValue('Dev');
    expect(within(dialog).queryByLabelText('Context')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    const title = within(dialog).getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'GH');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(h.update).toHaveBeenCalledWith('b1', {
      title: 'GH',
      url: 'https://github.com',
      category: 'Dev',
    });
    // Editing a tagged record sends a patch with no context key, so the stored tag stays.
    expect(h.update.mock.calls[0][1]).not.toHaveProperty('context');
    expect(screen.getByText('Bookmark updated')).toBeInTheDocument();
  });

  it.each(['mailto:a@b.c', 'obsidian://open?x'])(
    'editing only the title keeps a non-http url (%s) untouched',
    async (url) => {
      h.state = { bookmarks: [{ ...GH, url }], loading: false, error: null };
      const user = userEvent.setup();
      renderPage(<BookmarksPage />);
      await user.click(screen.getByRole('button', { name: 'Edit GitHub' }));
      const dialog = screen.getByRole('dialog', { name: 'Edit bookmark' });
      const title = within(dialog).getByLabelText('Title');
      await user.clear(title);
      await user.type(title, 'GH');
      await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(h.update).toHaveBeenCalled());
      expect(h.update).toHaveBeenCalledWith('b1', { title: 'GH', url, category: 'Dev' });
    },
  );

  it('editing the url applies the https protocol', async () => {
    const user = userEvent.setup();
    renderPage(<BookmarksPage />);
    await user.click(screen.getByRole('button', { name: 'Edit GitHub' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit bookmark' });
    const url = within(dialog).getByLabelText('URL');
    await user.clear(url);
    await user.type(url, 'example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(h.update).toHaveBeenCalled());
    expect(h.update.mock.calls[0][1].url).toBe('https://example.com');
  });

  it('Remove confirms in an alertdialog with Cancel focused; Cancel makes no call', async () => {
    const user = userEvent.setup();
    renderPage(<BookmarksPage />);
    await user.click(screen.getByRole('button', { name: 'Remove GitHub' }));
    const alert = screen.getByRole('alertdialog');
    expect(within(alert).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(alert).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('confirming Remove calls remove(id), closes, and toasts', async () => {
    const user = userEvent.setup();
    renderPage(<BookmarksPage />);
    await user.click(screen.getByRole('button', { name: 'Remove GitHub' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(h.remove).toHaveBeenCalledWith('b1');
    expect(screen.getByText('Bookmark removed')).toBeInTheDocument();
  });

  it('rejected remove shows the error and stays open', async () => {
    h.remove.mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();
    renderPage(<BookmarksPage />);
    await user.click(screen.getByRole('button', { name: 'Remove GitHub' }));
    const alert = screen.getByRole('alertdialog');
    await user.click(within(alert).getByRole('button', { name: 'Remove' }));
    expect(await within(alert).findByRole('alert')).toHaveTextContent("Burrow couldn't finish that. Try again.");
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('Escape closes the add dialog', async () => {
    const user = userEvent.setup();
    renderPage(<BookmarksPage />);
    await user.click(screen.getByRole('button', { name: 'Add bookmark' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(h.add).not.toHaveBeenCalled();
  });

  it('optimistic temp ids have no edit/remove actions', () => {
    h.state = { bookmarks: [{ ...GH, id: 'temp-1' }], loading: false, error: null };
    renderPage(<BookmarksPage />);
    expect(screen.queryByRole('button', { name: 'Edit GitHub' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove GitHub' })).not.toBeInTheDocument();
  });

  it('empty state offers an Add CTA that opens the dialog', async () => {
    h.state = { bookmarks: [], loading: false, error: null };
    const user = userEvent.setup();
    renderPage(<BookmarksPage />);
    await user.click(screen.getByRole('button', { name: 'Add your first bookmark' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('keeps the 503 unavailable state', () => {
    h.state = { bookmarks: [], loading: false, error: { status: 503, message: 'x' } };
    renderPage(<BookmarksPage />);
    expect(screen.getByText('Bookmarks unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add bookmark' })).not.toBeInTheDocument();
  });

  it('empty state shows exactly one Add button', () => {
    h.state = { bookmarks: [], loading: false, error: null };
    renderPage(<BookmarksPage />);
    expect(screen.getAllByRole('button', { name: /^Add/ })).toHaveLength(1);
  });

  it('hides the count while loading', () => {
    h.state = { bookmarks: [], loading: true, error: null };
    renderPage(<BookmarksPage />);
    expect(screen.queryByText(/0 bookmarks/)).not.toBeInTheDocument();
  });

  it('shows LoadError (not the empty state) on a non-503 error', async () => {
    h.state = { bookmarks: [], loading: false, error: { status: 500 } };
    renderPage(<BookmarksPage />);
    expect(screen.getByRole('alert')).toHaveTextContent("Burrow couldn't load your bookmarks. Your data is safe.");
    expect(screen.queryByText('No bookmarks yet.')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('BookmarksPage new-item intent', () => {
  it('opens the add dialog once for ?new=1 and removes the param', async () => {
    renderPage(<BookmarksPage />, '/page?new=1');
    expect(await screen.findByRole('dialog', { name: 'Add bookmark' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/page$/));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('opens no dialog without the param', () => {
    renderPage(<BookmarksPage />, '/page');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
