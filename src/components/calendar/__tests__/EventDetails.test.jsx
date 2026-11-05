import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import '@testing-library/jest-dom/vitest';
import CalendarPage from '../CalendarPage';
import EventDetails from '../EventDetails';
import { ToastProvider } from '../../../contexts/ToastContext';
import { allowSlowSuite } from '../../../test-utils/slowSuite';

const h = vi.hoisted(() => ({
  state: { events: [], loading: false, error: null },
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  importIcs: vi.fn(),
}));

vi.mock('../../../hooks/useCalendar', () => ({
  useCalendar: () => ({
    ...h.state,
    add: h.add,
    update: h.update,
    remove: h.remove,
    importIcs: h.importIcs,
  }),
}));

const now = new Date();
const at = (hour, minute = 0) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0).toISOString();
const dateLabel = (d) =>
  d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const TODAY_LABEL = dateLabel(now);
// The day selector's accessible name is the date plus the event count ("…, 2 events").
const dayName = (d) => new RegExp(`^${dateLabel(d)}, `);
const norm = (s) => s.replace(/\s/g, ' ');
const nameIs = (expected) => (name) => norm(name) === expected;

const FULL = {
  id: 'e1',
  summary: 'Standup',
  description: 'Daily sync',
  location: 'Room 1',
  start: at(10),
  end: at(10, 30),
  allDay: false,
  context: 'work',
  source: 'manual',
};
const BARE = {
  id: 'e3',
  summary: 'Bare',
  description: '',
  location: '',
  start: at(15),
  end: null,
  allDay: false,
  context: '',
  source: 'manual',
};
const ICS = { ...BARE, id: 'e2', summary: 'Feed', allDay: true, start: at(0), context: 'home', source: 'ics' };

const FULL_NAME = nameIs(`Open event: Standup, 10:00 AM, ${TODAY_LABEL}`);

const client = new QueryClient();
const tree = () => (
  <QueryClientProvider client={client}>
    <ToastProvider>
      <MemoryRouter>
        <CalendarPage />
      </MemoryRouter>
    </ToastProvider>
  </QueryClientProvider>
);
const renderPage = () => render(tree());

const detailsDialog = (name) => screen.getByRole('dialog', { name });
const footer = (dialog, name) => within(dialog).getByRole('button', { name });
const footerClose = (dialog) => within(dialog).getAllByRole('button', { name: 'Close' }).at(-1);
const TODAY_TITLE = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
// Buttons for the Standup event currently rendered (grid chip, plus a search row when searching).
const surfaces = () => screen.getAllByRole('button', { name: FULL_NAME });
const bySurface = (surface) => surfaces().find((b) => b.dataset.eventSurface === surface);
// The day list only exists inside the day modal: open it (via the day button) and return the row.
const openDayDialog = async (user) => {
  await user.click(screen.getByRole('button', { name: dayName(now) }));
  return screen.getByRole('dialog', { name: TODAY_TITLE });
};
const openListRow = async (user) =>
  within(await openDayDialog(user)).getByRole('button', { name: FULL_NAME });
// Resolves the opener button for a surface, opening the day modal first for 'list'.
const surfaceButton = async (user, surface) =>
  surface === 'list' ? openListRow(user) : bySurface(surface);

beforeEach(() => {
  h.state = { events: [FULL], loading: false, error: null };
  h.add.mockReset().mockResolvedValue({});
  h.update.mockReset().mockResolvedValue({});
  h.remove.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

// Heavy render-and-wait suite: raise the time limits so a busy machine does not trip them.
allowSlowSuite();

describe('EventDetails via CalendarPage', () => {
  it.each(['grid', 'list'])('%s button opens details with every field', async (surface) => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await surfaceButton(user, surface));
    const dialog = detailsDialog('Standup');
    expect(norm(dialog.textContent)).toContain('10:00 AM to 10:30 AM');
    expect(dialog).toHaveTextContent('Room 1');
    expect(dialog).toHaveTextContent('Daily sync');
    expect(dialog).toHaveTextContent('Notes');
    expect(within(dialog).queryByText('work')).not.toBeInTheDocument();
    expect(dialog.querySelector('.capitalize')).toBeNull();
    expect(within(dialog).queryByText('Imported')).not.toBeInTheDocument();
  });

  it('search result opens details with every field', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText('Search events'), 'standup');
    await user.click(bySurface('search'));
    const dialog = detailsDialog('Standup');
    expect(dialog).toHaveTextContent('Room 1');
    expect(dialog).toHaveTextContent('Daily sync');
    expect(dialog).not.toHaveTextContent('work');
  });

  it('hides location and notes when missing', async () => {
    h.state = { events: [BARE], loading: false, error: null };
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getAllByRole('button', { name: /^Open event: Bare, / })[0]);
    const dialog = detailsDialog('Bare');
    expect(norm(dialog.textContent)).toContain('3:00 PM');
    expect(within(dialog).queryByText('Notes')).not.toBeInTheDocument();
    expect(dialog.querySelector('svg.lucide-map-pin')).toBeNull();
    expect(dialog.querySelector('.capitalize')).toBeNull();
    expect(within(dialog).queryByText('Imported')).not.toBeInTheDocument();
  });

  it('draws the accent bar and chip dot in the default colour for every tag', async () => {
    h.state = { events: [FULL, ICS], loading: false, error: null };
    renderPage();
    const chips = document.querySelectorAll('[data-event-surface="grid"]');
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      const dot = chip.querySelector('span[aria-hidden="true"]');
      expect(dot).toHaveClass('bg-slate-slateBlueLight');
      expect(dot).not.toHaveClass('bg-accent-blue');
      expect(dot).not.toHaveClass('bg-accent-green');
    }
  });

  it('shows All day for all-day events', async () => {
    h.state = { events: [ICS], loading: false, error: null };
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getAllByRole('button', { name: /^Open event: Feed, All day/ })[0]);
    expect(detailsDialog('Feed')).toHaveTextContent('All day');
  });

  it('shows the Imported badge for ICS events only', async () => {
    h.state = { events: [ICS, FULL], loading: false, error: null };
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getAllByRole('button', { name: /^Open event: Feed, / })[0]);
    expect(within(detailsDialog('Feed')).getByText('Imported')).toBeInTheDocument();
    expect(within(detailsDialog('Feed')).queryByText('home')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(surfaces()[0]);
    expect(within(detailsDialog('Standup')).queryByText('Imported')).not.toBeInTheDocument();
  });

  it('has Remove, Close and Edit footer actions with initial focus on Edit', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(surfaces()[0]);
    const dialog = detailsDialog('Standup');
    expect(footer(dialog, 'Edit')).toHaveFocus();
    expect(footer(dialog, 'Remove')).toBeInTheDocument();
    expect(within(dialog).getAllByRole('button', { name: 'Close' })).toHaveLength(1);
  });

  it('preserves description whitespace and line breaks', async () => {
    const description = 'Line one\n\n  indented line\nLine three';
    h.state = { events: [{ ...FULL, description }], loading: false, error: null };
    const user = userEvent.setup();
    renderPage();
    await user.click(surfaces()[0]);
    const notes = within(detailsDialog('Standup')).getByText(
      (_c, el) => el.tagName === 'P' && el.textContent === description,
    );
    expect(notes.textContent).toBe(description);
    expect(notes).toHaveClass('whitespace-pre-wrap');
  });

  it('does not render the description as HTML', async () => {
    h.state = { events: [{ ...FULL, description: '<b>bold</b>' }], loading: false, error: null };
    const user = userEvent.setup();
    renderPage();
    await user.click(surfaces()[0]);
    const dialog = detailsDialog('Standup');
    expect(dialog).toHaveTextContent('<b>bold</b>');
    expect(dialog.querySelector('b')).toBeNull();
  });
});

describe('details -> edit flows', () => {
  it('Edit shows the prefilled form, Save returns to details with updated data', async () => {
    h.update.mockImplementation(async (id, patch) => {
      h.state = { ...h.state, events: h.state.events.map((e) => (e.id === id ? { ...e, ...patch } : e)) };
      return { id };
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(surfaces()[0]);
    await user.click(footer(detailsDialog('Standup'), 'Edit'));
    const form = screen.getByRole('dialog', { name: 'Edit event' });
    expect(within(form).getByLabelText('Title')).toHaveValue('Standup');
    expect(within(form).getByLabelText('Location')).toHaveValue('Room 1');
    expect(within(form).getByLabelText('Notes')).toHaveValue('Daily sync');
    expect(within(form).queryByRole('button', { name: 'Delete event' })).not.toBeInTheDocument();
    const title = within(form).getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Retro');
    const loc = within(form).getByLabelText('Location');
    await user.clear(loc);
    await user.type(loc, 'Room 9');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Retro' });
    expect(dialog).toHaveTextContent('Room 9');
    expect(dialog).not.toHaveTextContent('Room 1');
    expect(screen.queryByRole('dialog', { name: 'Edit event' })).not.toBeInTheDocument();
    expect(footer(dialog, 'Edit')).toHaveFocus();
  });

  it('Cancel returns to the same details with focus on Edit', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(surfaces()[0]);
    await user.click(footer(detailsDialog('Standup'), 'Edit'));
    const form = screen.getByRole('dialog', { name: 'Edit event' });
    await user.type(within(form).getByLabelText('Title'), ' changed');
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    const dialog = detailsDialog('Standup');
    expect(footer(dialog, 'Edit')).toHaveFocus();
    expect(dialog).toHaveTextContent('Daily sync');
    expect(h.update).not.toHaveBeenCalled();
  });

  it('a failed save stays in the form with the error', async () => {
    h.update.mockRejectedValue(new Error('save failed'));
    const user = userEvent.setup();
    renderPage();
    await user.click(surfaces()[0]);
    await user.click(footer(detailsDialog('Standup'), 'Edit'));
    const form = screen.getByRole('dialog', { name: 'Edit event' });
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent("Couldn't save the event. Try again.");
    expect(screen.getByRole('dialog', { name: 'Edit event' })).toBeInTheDocument();
  });

  it('Add event still opens the create form directly', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Add event' }));
    const dialog = screen.getByRole('dialog', { name: 'Add event' });
    expect(within(dialog).getByLabelText('Title')).toHaveValue('');
    expect(within(dialog).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });
});

describe('remove from details', () => {
  it('confirm dialog is titled "Remove event?"; confirm deletes and focuses Add event', async () => {
    h.remove.mockImplementation(async (id) => {
      h.state = { ...h.state, events: h.state.events.filter((e) => e.id !== id) };
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(bySurface('grid'));
    await user.click(footer(detailsDialog('Standup'), 'Remove'));
    const alert = screen.getByRole('alertdialog', { name: 'Remove event?' });
    await user.click(within(alert).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(h.remove).toHaveBeenCalledWith('e1'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add event' })).toHaveFocus());
  });

  it('cancelling the confirm keeps the details open and nothing is removed', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(surfaces()[0]);
    await user.click(footer(detailsDialog('Standup'), 'Remove'));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(h.remove).not.toHaveBeenCalled();
    expect(detailsDialog('Standup')).toBeInTheDocument();
  });
});

describe('focus return to the originating button', () => {
  it('Escape returns focus to the grid button', async () => {
    const user = userEvent.setup();
    renderPage();
    const btn = bySurface('grid');
    await user.click(btn);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(btn).toHaveFocus();
  });

  it('footer Close returns focus to the grid button', async () => {
    const user = userEvent.setup();
    renderPage();
    const btn = bySurface('grid');
    await user.click(btn);
    await user.click(footerClose(detailsDialog('Standup')));
    expect(btn).toHaveFocus();
  });

  // The day-list row disappears with the modal, so focus lands on the button that opened the day.
  it('Escape and footer Close from a day-list row return focus to the day button', async () => {
    const user = userEvent.setup();
    renderPage();
    const dayBtn = screen.getByRole('button', { name: dayName(now) });
    await user.click(await openListRow(user));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(dayBtn).toHaveFocus();
    await user.click(await openListRow(user));
    await user.click(footerClose(detailsDialog('Standup')));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(dayBtn).toHaveFocus();
  });

  it('Back returns focus to the day-list row', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await openListRow(user));
    await user.click(footer(detailsDialog('Standup'), `Back to ${TODAY_TITLE}`));
    const list = screen.getByRole('dialog', { name: TODAY_TITLE });
    expect(within(list).getByRole('button', { name: FULL_NAME })).toHaveFocus();
  });

  it('Escape and footer Close return focus to the search row', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText('Search events'), 'standup');
    const btn = bySurface('search');
    await user.click(btn);
    await user.keyboard('{Escape}');
    expect(btn).toHaveFocus();
    await user.click(btn);
    await user.click(footerClose(detailsDialog('Standup')));
    expect(btn).toHaveFocus();
  });

  it('after Edit, Save, Close focus returns to the originating chip', async () => {
    const user = userEvent.setup();
    renderPage();
    const btn = bySurface('grid');
    await user.click(btn);
    await user.click(footer(detailsDialog('Standup'), 'Edit'));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save changes' }));
    await screen.findByRole('dialog', { name: 'Standup' });
    await user.click(footerClose(detailsDialog('Standup')));
    expect(btn).toHaveFocus();
  });

  it('after Edit, Save, Close from a day-list row focus returns to the day button', async () => {
    const user = userEvent.setup();
    renderPage();
    const dayBtn = screen.getByRole('button', { name: dayName(now) });
    await user.click(await openListRow(user));
    await user.click(footer(detailsDialog('Standup'), 'Edit'));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save changes' }));
    await screen.findByRole('dialog', { name: 'Standup' });
    await user.click(footerClose(detailsDialog('Standup')));
    expect(dayBtn).toHaveFocus();
  });
});

describe('saving (optimistic) events', () => {
  it('stay aria-disabled with a hint and clicking does nothing', async () => {
    h.state = { events: [{ ...FULL, id: 'temp-7' }], loading: false, error: null };
    const user = userEvent.setup();
    renderPage();
    const chips = screen.getAllByRole('button', { name: /^Saving event: Standup, / });
    expect(chips).toHaveLength(1);
    const day = await openDayDialog(user);
    const row = within(day).getByRole('button', { name: /^Saving event: Standup, / });
    for (const b of [...chips, row]) {
      expect(b).toHaveAttribute('aria-disabled', 'true');
      expect(b).toHaveAccessibleDescription(/Saving, available once synced/);
      await user.click(b);
    }
    // Only the day list is open; no details view appeared.
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog')).toHaveAccessibleName(TODAY_TITLE);
    expect(screen.queryByRole('button', { name: /^Back to/ })).not.toBeInTheDocument();
  });
});

describe('live data changes while details are open', () => {
  const rerenderNow = (utils) => act(() => utils.rerender(tree()));

  it('refetch updates the heading and fields', async () => {
    const user = userEvent.setup();
    const utils = renderPage();
    await user.click(surfaces()[0]);
    expect(detailsDialog('Standup')).toBeInTheDocument();
    h.state = { ...h.state, events: [{ ...FULL, summary: 'Standup v2', location: 'Zoom' }] };
    rerenderNow(utils);
    const dialog = detailsDialog('Standup v2');
    expect(dialog).toHaveTextContent('Zoom');
    expect(dialog).not.toHaveTextContent('Room 1');
  });

  it('the event vanishing closes the modal and focus goes to Add event', async () => {
    const user = userEvent.setup();
    const utils = renderPage();
    await user.click(bySurface('grid'));
    h.state = { ...h.state, events: [] };
    rerenderNow(utils);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add event' })).toHaveFocus());
  });

  it('the event vanishing while opened from the day modal falls back to the day list', async () => {
    h.state = { events: [FULL, ICS], loading: false, error: null };
    const user = userEvent.setup();
    const utils = renderPage();
    await user.click(await openListRow(user));
    expect(detailsDialog('Standup')).toBeInTheDocument();
    h.state = { ...h.state, events: [ICS] };
    rerenderNow(utils);
    const list = await screen.findByRole('dialog', { name: TODAY_TITLE });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(within(list).queryByRole('button', { name: /Standup/ })).not.toBeInTheDocument();
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    await waitFor(() => expect(within(list).getByRole('button', { name: /^Open event: Feed/ })).toHaveFocus());
  });

  it('the event vanishing while editing closes everything', async () => {
    const user = userEvent.setup();
    const utils = renderPage();
    await user.click(surfaces()[0]);
    await user.click(footer(detailsDialog('Standup'), 'Edit'));
    h.state = { ...h.state, events: [] };
    rerenderNow(utils);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('the event leaving the list mid-save keeps the form open until the save settles', async () => {
    let resolveSave;
    h.update.mockImplementation(() => new Promise((res) => { resolveSave = res; }));
    const user = userEvent.setup();
    const utils = renderPage();
    await user.click(surfaces()[0]);
    await user.click(footer(detailsDialog('Standup'), 'Edit'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    h.state = { ...h.state, events: [] };
    act(() => utils.rerender(tree()));
    const form = screen.getByRole('dialog', { name: 'Edit event' });
    expect(within(form).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await act(async () => resolveSave({}));
  });
});

describe('accessibility', () => {
  it('moves focus to the Title input when switching to the edit form', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(surfaces()[0]);
    await user.click(footer(detailsDialog('Standup'), 'Edit'));
    expect(within(screen.getByRole('dialog', { name: 'Edit event' })).getByLabelText('Title')).toHaveFocus();
  });

  it('Cancel is disabled while a save is pending', async () => {
    let resolveSave;
    h.update.mockImplementation(() => new Promise((res) => { resolveSave = res; }));
    const user = userEvent.setup();
    renderPage();
    await user.click(surfaces()[0]);
    await user.click(footer(detailsDialog('Standup'), 'Edit'));
    const form = screen.getByRole('dialog', { name: 'Edit event' });
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(within(form).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await act(async () => resolveSave({}));
  });

  it('the details dialog is described by its date, time and location', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(surfaces()[0]);
    const dialog = detailsDialog('Standup');
    expect(dialog).toHaveAccessibleDescription(new RegExp(now.getDate().toString()));
    expect(dialog).toHaveAccessibleDescription(/Date:.*Time:.*Location: ?Room 1/);
  });

  it('the scrollable Notes are a named region', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(surfaces()[0]);
    const region = within(detailsDialog('Standup')).getByRole('region', { name: 'Notes' });
    expect(region).toHaveTextContent('Daily sync');
    expect(region).toHaveAttribute('tabindex', '0');
  });
});

describe('EventDetails Back button', () => {
  const baseProps = { onEdit: vi.fn(), onRemove: vi.fn(), onClose: vi.fn() };

  it('is absent without onBack', () => {
    render(<EventDetails event={FULL} {...baseProps} />);
    expect(screen.queryByRole('button', { name: /^Back/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('renders "Back" text with a "Back to <date>" accessible name and calls onBack', async () => {
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(<EventDetails event={FULL} {...baseProps} onBack={onBack} backLabel="Friday, October 2" />);
    const back = screen.getByRole('button', { name: 'Back to Friday, October 2' });
    expect(back).toHaveTextContent('Back');
    await user.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(baseProps.onClose).not.toHaveBeenCalled();
  });

  it('falls back to the plain name "Back" without a backLabel', () => {
    render(<EventDetails event={FULL} {...baseProps} onBack={() => {}} />);
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
  });

  it('does not nest buttons', () => {
    const { container } = render(
      <EventDetails event={FULL} {...baseProps} onBack={() => {}} backLabel="Friday, October 2" />,
    );
    expect(container.querySelectorAll('button button')).toHaveLength(0);
  });
});

describe('Back appears only when details are opened from the day list', () => {
  it('grid and search have no Back; the day list does', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(bySurface('grid'));
    expect(within(detailsDialog('Standup')).queryByRole('button', { name: /^Back/ })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.type(screen.getByLabelText('Search events'), 'standup');
    await user.click(bySurface('search'));
    expect(within(detailsDialog('Standup')).queryByRole('button', { name: /^Back/ })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.clear(screen.getByLabelText('Search events'));
    await user.click(await openListRow(user));
    expect(
      within(detailsDialog('Standup')).getByRole('button', { name: `Back to ${TODAY_TITLE}` }),
    ).toBeInTheDocument();
  });
});
