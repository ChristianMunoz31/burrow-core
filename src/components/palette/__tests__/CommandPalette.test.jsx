import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import CommandPalette from '../CommandPalette';
import LazyCommandPalette from '../LazyCommandPalette';
import { CALCULATOR_OPEN_EVENT, openCalculator } from '../../calculator/openCalculator';
import { openCommandPalette } from '../../../hooks/useCommandPalette';
import { JAVI_OPEN_EVENT } from '../../javi/openJavi';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import { todosService } from '../../../services/todosService';

const themeApi = vi.hoisted(() => ({ preference: 'system', setPreference: vi.fn() }));

vi.mock('../../../contexts/ThemeContext', async (orig) => ({
  ...(await orig()),
  useTheme: () => ({ preference: themeApi.preference, setPreference: themeApi.setPreference }),
}));

vi.mock('../../../services/todosService', () => ({
  todosService: { create: vi.fn(async () => ({})) },
}));

const opened = [];
const onJaviOpen = (e) => opened.push(e.detail);

beforeEach(() => {
  themeApi.preference = 'system';
  themeApi.setPreference.mockClear();
  opened.length = 0;
  window.addEventListener(JAVI_OPEN_EVENT, onJaviOpen);
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ results: [] }) })));
});
afterEach(() => {
  window.removeEventListener(JAVI_OPEN_EVENT, onJaviOpen);
  cleanup();
  vi.unstubAllGlobals();
});

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{`${loc.pathname}${loc.hash}`}</output>;
}

async function openPalette(props) {
  renderWithProviders(
    <MemoryRouter>
      <CommandPalette {...props} />
    </MemoryRouter>,
  );
  act(() => openCommandPalette());
  return screen.findByRole('dialog', { name: 'Command palette' });
}

describe('CommandPalette', () => {
  it('Enter on the Ask Javi item closes the palette and opens Javi with the query', async () => {
    const user = userEvent.setup();
    await openPalette({ javiAvailable: true });
    const input = screen.getByRole('combobox', { name: 'Search' });
    await user.type(input, 'what is due today');
    expect(screen.getByRole('option', { name: /Ask Javi: “what is due today”/ })).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(opened).toEqual([{ prompt: 'what is due today' }]);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument());
  });

  it('offers Open Javi when the query is empty', async () => {
    const user = userEvent.setup();
    await openPalette({ javiAvailable: true });
    await user.click(screen.getByRole('option', { name: /Open Javi/ }));
    expect(opened).toEqual([{ prompt: '' }]);
  });

  it('has no Ask item when Javi is not available', async () => {
    const user = userEvent.setup();
    await openPalette({ javiAvailable: false });
    await user.type(screen.getByRole('combobox', { name: 'Search' }), 'what is due today');
    expect(screen.queryByText(/Ask Javi/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Open Javi/)).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(opened).toEqual([]);
  });

  it('has no chat UI: no Ask toggle, back-to-commands button or provider badge', async () => {
    await openPalette({ javiAvailable: true });
    expect(screen.queryByRole('button', { name: 'Ask Javi' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back to commands' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Javi: /)).not.toBeInTheDocument();
    expect(screen.queryByText(/Chat/)).not.toBeInTheDocument();
  });

  it('still navigates and searches', async () => {
    const user = userEvent.setup();
    await openPalette({ javiAvailable: true });
    expect(screen.getByText('Go to Todos')).toBeInTheDocument();
    await user.type(screen.getByRole('combobox', { name: 'Search' }), 'todos');
    expect(screen.getByText('Go to Todos')).toBeInTheDocument();
  });

  it('Enter on a query that matches a command goes to it, not Ask Javi', async () => {
    const user = userEvent.setup();
    await openPalette({ javiAvailable: true });
    await user.type(screen.getByRole('combobox', { name: 'Search' }), 'settings');
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveTextContent('Go to Settings');
    expect(options.at(-1)).toHaveTextContent(/Ask Javi/);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    expect(opened).toEqual([]);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument());
  });

  it('wires combobox attributes to the listbox and the selected option', async () => {
    const user = userEvent.setup();
    await openPalette({ javiAvailable: true });
    const input = screen.getByRole('combobox', { name: 'Search' });
    const list = screen.getByRole('listbox');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-controls', list.id);
    const first = screen.getAllByRole('option')[0];
    expect(input).toHaveAttribute('aria-activedescendant', first.id);
    // The palette focuses its input in a requestAnimationFrame after mount. user.keyboard types
    // into document.activeElement, so wait for that focus or the ArrowDown can land on <body>
    // (the flaky failure under load).
    await waitFor(() => expect(input).toHaveFocus());
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[1].id));
  });

  it('ignores a stale search response for an older query', async () => {
    const user = userEvent.setup();
    const resolvers = {};
    vi.stubGlobal(
      'fetch',
      vi.fn((url) => {
        const q = decodeURIComponent(String(url).split('q=')[1]);
        return new Promise((resolve) => {
          resolvers[q] = () =>
            resolve({
              json: async () => ({
                results: [{ kind: 'note', id: q, title: `Result ${q}`, to: '/notes' }],
              }),
            });
        });
      }),
    );
    await openPalette({ javiAvailable: false });
    const input = screen.getByRole('combobox', { name: 'Search' });
    await user.type(input, 'zq');
    await waitFor(() => expect(resolvers.zq).toBeTypeOf('function'));
    await user.type(input, 'x');
    await waitFor(() => expect(resolvers.zqx).toBeTypeOf('function'));
    await act(async () => {
      resolvers.zqx();
      resolvers.zq();
    });
    expect(await screen.findByText('Result zqx')).toBeInTheDocument();
    expect(screen.queryByText('Result zq')).not.toBeInTheDocument();
  });

  it('quick-add saves once even if Enter is pressed twice', async () => {
    const user = userEvent.setup();
    let release;
    todosService.create.mockClear();
    todosService.create.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    await openPalette({ javiAvailable: false });
    await user.click(screen.getByRole('option', { name: /Add a todo/ }));
    const input = screen.getByRole('textbox', { name: 'Add a todo' });
    await user.type(input, 'buy milk');
    await user.keyboard('{Enter}{Enter}');
    expect(todosService.create).toHaveBeenCalledTimes(1);
    expect(todosService.create).toHaveBeenCalledWith({ title: 'buy milk' });
    await act(async () => release({}));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument());
  });

  it('a failed quick-add stays open with the text and an inline error, and retries', async () => {
    const user = userEvent.setup();
    todosService.create.mockReset();
    todosService.create.mockRejectedValueOnce(new Error('boom'));
    todosService.create.mockResolvedValue({});
    await openPalette({ javiAvailable: false });
    await user.click(screen.getByRole('option', { name: /Add a todo/ }));
    const input = await screen.findByRole('textbox', { name: 'Add a todo' });
    await user.type(input, 'buy milk');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save that. Try again.");
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Add a todo' })).toHaveValue('buy milk');
    await user.keyboard('{Enter}');
    expect(todosService.create).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument());
    todosService.create.mockReset();
    todosService.create.mockImplementation(async () => ({}));
  });

  it('Escape while the Back button is focused goes back instead of closing', async () => {
    const user = userEvent.setup();
    await openPalette({ javiAvailable: false });
    await user.click(screen.getByRole('option', { name: /Add a todo/ }));
    await screen.findByRole('textbox', { name: 'Add a todo' });
    const back = screen.getByRole('button', { name: 'Back' });
    back.focus();
    await user.keyboard('{Escape}');
    expect(await screen.findByRole('combobox', { name: 'Search' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
  });

  it('nav hints show the menu section, not the raw path', async () => {
    await openPalette({ javiAvailable: false });
    const option = screen.getByRole('option', { name: /Go to Todos/ });
    expect(option).toHaveTextContent('Productivity');
    expect(option).not.toHaveTextContent('/todos');
    expect(screen.getByRole('option', { name: /Go to Journal/ })).toHaveTextContent('Health');
    expect(screen.getByRole('option', { name: /Go to Subscriptions/ })).toHaveTextContent('Financials');
  });

  it('nav hints show Financials for the Budget row', async () => {
    await openPalette({ javiAvailable: false });
    expect(screen.getByRole('option', { name: /Go to Budget/ })).toHaveTextContent('Financials');
  });

  it('finds Sleep & activity by "health" and "oura" (keywords) and opens /health', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MemoryRouter>
        <CommandPalette />
        <Where />
      </MemoryRouter>,
    );
    act(() => openCommandPalette());
    await screen.findByRole('dialog', { name: 'Command palette' });
    const input = screen.getByRole('combobox', { name: 'Search' });
    await user.type(input, 'oura');
    expect(screen.getByRole('option', { name: /Go to Sleep & activity/ })).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, 'health');
    await user.click(screen.getByRole('option', { name: /Go to Sleep & activity/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/health');
  });

  it('keeps Go to Home and Go to Settings (they left the drawer, not the palette), and Calendar has no category hint', async () => {
    await openPalette({ javiAvailable: false });
    expect(screen.getByRole('option', { name: /Go to Home/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Go to Settings/ })).toBeInTheDocument();
    const calendar = screen.getByRole('option', { name: /Go to Calendar/ });
    for (const section of ['Financials', 'Productivity', 'Health']) expect(calendar).not.toHaveTextContent(section);
    expect(screen.getByRole('option', { name: /Go to Home/ })).toHaveTextContent(/^Go to Home$/);
  });

  it('Escape in a quick-add returns to the list without closing the palette', async () => {
    const user = userEvent.setup();
    await openPalette({ javiAvailable: false });
    await user.click(screen.getByRole('option', { name: /Add a todo/ }));
    const input = await screen.findByRole('textbox', { name: 'Add a todo' });
    await waitFor(() => expect(input).toHaveFocus());
    await user.keyboard('{Escape}');
    expect(await screen.findByRole('combobox', { name: 'Search' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    // A second Escape, from the list, closes it.
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Search' })).toHaveFocus());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument());
  });

  it('gives focus back to the element that opened it', async () => {
    const user = userEvent.setup();
    render(<button type="button">opener</button>);
    const opener = screen.getByRole('button', { name: 'opener' });
    opener.focus();
    await openPalette({ javiAvailable: false });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Search' })).toHaveFocus());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('keeps Tab inside the dialog', async () => {
    await openPalette({ javiAvailable: false });
    const input = screen.getByRole('combobox', { name: 'Search' });
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(input).toHaveFocus();
  });

  it('lists Import transactions and every page', async () => {
    await openPalette({ javiAvailable: false });
    expect(screen.getByRole('option', { name: /Import transactions/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Add a todo/ })).toBeInTheDocument();
    for (const page of ['Budget', 'Subscriptions', 'Journal', 'Notes', 'Habits', 'Sleep & activity', 'Todos', 'Focus', 'Calendar', 'Countdowns', 'Bookmarks', 'Folders', 'Settings']) {
      expect(screen.getAllByRole('option', { name: new RegExp(`Go to ${page}`) }).length).toBeGreaterThan(0);
    }
  });

  it('finds Home (where the Javi card shows the weather) by "weather" and lists no Weather page', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MemoryRouter initialEntries={['/todos']}>
        <CommandPalette />
        <Where />
      </MemoryRouter>,
    );
    act(() => openCommandPalette());
    await screen.findByRole('dialog', { name: 'Command palette' });
    expect(screen.queryByRole('option', { name: /Go to Weather/ })).not.toBeInTheDocument();
    await user.type(screen.getByRole('combobox', { name: 'Search' }), 'weather');
    expect(screen.queryByRole('option', { name: /Go to Calendar/ })).not.toBeInTheDocument();
    const options = screen.getAllByRole('option', { name: /Go to Home/ });
    expect(options).toHaveLength(1);
    await user.click(options[0]);
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/);
  });

  it('lists Go to Focus once, as the navigation command', async () => {
    await openPalette({ javiAvailable: false });
    expect(screen.queryByText('Start a focus session')).not.toBeInTheDocument();
    expect(screen.getAllByRole('option', { name: /Go to Focus/ })).toHaveLength(1);
  });

  it('finds Browse your data and the Settings sections by name', async () => {
    const user = userEvent.setup();
    await openPalette({ javiAvailable: false });
    const input = screen.getByRole('combobox', { name: 'Search' });
    await user.type(input, 'browse');
    expect(screen.getByRole('option', { name: /Browse your data/ })).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, 'settings: data');
    expect(screen.getByRole('option', { name: /Settings: Data & storage/ })).toBeInTheDocument();
  });

  it('finds a Settings section by keyword and navigates to /settings#id', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MemoryRouter>
        <CommandPalette />
        <Where />
      </MemoryRouter>,
    );
    act(() => openCommandPalette());
    await screen.findByRole('dialog', { name: 'Command palette' });
    await user.type(screen.getByRole('combobox', { name: 'Search' }), 'backup');
    await user.click(screen.getByRole('option', { name: /Settings: Data & storage/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/settings#data-storage');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument());
  });

  it('switches the theme through the theme context', async () => {
    const user = userEvent.setup();
    await openPalette({ javiAvailable: false });
    await user.type(screen.getByRole('combobox', { name: 'Search' }), 'theme: dark');
    await user.click(screen.getByRole('option', { name: /Theme: Dark/ }));
    expect(themeApi.setPreference).toHaveBeenCalledWith('dark');
  });

  it('offers no Switch to command and no Mode commands', async () => {
    const user = userEvent.setup();
    await openPalette({ javiAvailable: false });
    const input = screen.getByRole('combobox', { name: 'Search' });
    for (const q of ['switch to', 'workspace', 'mode']) {
      await user.clear(input);
      await user.type(input, q);
      expect(screen.queryByRole('option', { name: /Switch to|Mode:/ })).not.toBeInTheDocument();
    }
  });

  it('shows the Alt+J hint on Open Javi, not on Ask Javi with a query', async () => {
    const user = userEvent.setup();
    await openPalette({ javiAvailable: true });
    expect(screen.getByRole('option', { name: /Open Javi/ })).toHaveTextContent('Alt+J');
    await user.type(screen.getByRole('combobox', { name: 'Search' }), 'what is due');
    expect(screen.getByRole('option', { name: /Ask Javi: “what is due”/ })).not.toHaveTextContent('Alt+J');
  });

});

describe('Calculator command', () => {
  it('is listed under Actions without a shortcut hint', async () => {
    const user = userEvent.setup();
    await openPalette({ javiAvailable: false });
    await user.type(screen.getByRole('combobox', { name: 'Search' }), 'calc');
    const option = screen.getByRole('option', { name: /Calculator/ });
    expect(option).not.toHaveTextContent('Alt+C');
    expect(screen.getByText('Actions')).toBeInTheDocument();
  });

  it('selecting it dispatches calculator:open with the pre-palette element and closes the palette', async () => {
    const user = userEvent.setup();
    const events = [];
    const onOpen = (e) => events.push(e.detail);
    window.addEventListener(CALCULATOR_OPEN_EVENT, onOpen);
    try {
      render(<button type="button">before</button>);
      const before = screen.getByRole('button', { name: 'before' });
      before.focus();
      await openPalette({ javiAvailable: false });
      await user.type(screen.getByRole('combobox', { name: 'Search' }), 'calc');
      await user.click(screen.getByRole('option', { name: /Calculator/ }));
      expect(events).toHaveLength(1);
      expect(events[0].returnTo).toBe(before);
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument());
    } finally {
      window.removeEventListener(CALCULATOR_OPEN_EVENT, onOpen);
    }
  });

  it('hosts one dialog for calculator:open, even with the palette closed, and Escape returns focus to returnTo', async () => {
    renderWithProviders(
      <MemoryRouter>
        <button type="button">opener</button>
        <CommandPalette javiAvailable={false} />
      </MemoryRouter>,
    );
    const opener = screen.getByRole('button', { name: 'opener' });
    act(() => openCalculator(opener));
    act(() => openCalculator(opener));
    expect(await screen.findByRole('dialog', { name: 'Calculator' })).toBeInTheDocument();
    expect(screen.getAllByRole('dialog', { name: 'Calculator' })).toHaveLength(1);
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Calculator' })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it('with the lazy host: Ctrl+K, calc, Enter opens the dialog; Escape returns focus to the button', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MemoryRouter>
        <button type="button">before</button>
        <LazyCommandPalette javiAvailable={false} />
      </MemoryRouter>,
    );
    const before = screen.getByRole('button', { name: 'before' });
    before.focus();
    act(() => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    });
    const search = await screen.findByRole('combobox', { name: 'Search' }, { timeout: 5000 });
    await waitFor(() => expect(search).toHaveFocus());
    await user.type(search, 'calc');
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Calculator' }, { timeout: 5000 });
    await waitFor(() => expect(within(dialog).getByRole('textbox', { name: 'Calculation' })).toHaveFocus());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Calculator' })).not.toBeInTheDocument());
    await waitFor(() => expect(before).toHaveFocus());
  });
});
