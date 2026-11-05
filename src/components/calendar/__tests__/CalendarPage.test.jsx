import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import CalendarPage from '../CalendarPage';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { allowSlowSuite } from '../../../test-utils/slowSuite';

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
  state: { events: [], loading: false, error: null },
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  importIcs: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('../../../hooks/useCalendar', () => ({
  useCalendar: () => ({
    ...h.state,
    add: h.add,
    update: h.update,
    remove: h.remove,
    importIcs: h.importIcs,
    refresh: h.refresh,
  }),
}));

const now = new Date();
const at = (hour, minute = 0) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0).toISOString();
const pad = (n) => String(n).padStart(2, '0');
const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateLabel = (d) =>
  d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
// The day modal's title (no year), e.g. "Friday, October 2".
const dayTitle = (d) => d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
const TODAY_LABEL = dateLabel(now);
// The day selector's accessible name is the date plus the event count ("…, 2 events").
const dayName = (d) => new RegExp(`^${dateLabel(d)}, `);
const TODAY_TITLE = dayTitle(now);
// Normalise ICU narrow no-break spaces so the time text compares reliably.
const nameIs = (expected) => (name) => name.replace(/\s/g, ' ') === expected;
const TIMED_NAME = nameIs(`Open event: Standup, 10:00 AM, ${TODAY_LABEL}`);
const ALLDAY_NAME = nameIs(`Open event: Imported, All day, ${TODAY_LABEL}`);
// A day with events elsewhere in the month, and one that is always empty.
const otherDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() === 15 ? 16 : 15);
const emptyDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() === 20 ? 21 : 20);

const TIMED = {
  id: 'e1',
  summary: 'Standup',
  description: 'Daily',
  location: 'Room 1',
  start: at(10),
  end: at(10, 30),
  allDay: false,
  context: 'work',
  source: 'manual',
};
const ICS = {
  id: 'e2',
  summary: 'Imported',
  description: '',
  location: '',
  start: at(0),
  end: null,
  allDay: true,
  context: 'both',
  source: 'ics',
};

beforeEach(() => {
  h.state = { events: [TIMED, ICS], loading: false, error: null };
  h.add.mockReset().mockResolvedValue({});
  h.update.mockReset().mockResolvedValue({});
  h.remove.mockReset().mockResolvedValue({});
  h.importIcs.mockReset();
  h.refresh.mockReset();
});
afterEach(cleanup);


const clickEdit = (user) =>
  user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Edit' }));
const clickRemove = (user) =>
  user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
// The modal header X is also named "Close"; the footer button is the last one.
const clickClose = (user) =>
  user.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' }).at(-1));

// Opens the shared modal's "day" view by clicking the day-selector button.
const openDay = async (user, date = now) => {
  await user.click(screen.getByRole('button', { name: dayName(date) }));
  return screen.getByRole('dialog', { name: dayTitle(date) });
};
// Selection is a purely visual highlight now (the button opens a dialog; it is not a toggle).
const selectedDayButtons = () =>
  [...document.querySelectorAll('[data-day-key]')].filter((b) => b.classList.contains('bg-slate-slateBlue/10'));
const inDialog = (dialog, name) => within(dialog).getByRole('button', { name });
const surfaceOf = (name, surface) =>
  screen.getAllByRole('button', { name }).find((b) => b.dataset.eventSurface === surface);
const confirmRemove = (user) =>
  user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
// Make the mocked data layer behave like the real one: removals/updates change what renders.
const applyRemove = () =>
  h.remove.mockImplementation(async (id) => {
    h.state = { ...h.state, events: h.state.events.filter((e) => e.id !== id) };
  });
const applyUpdate = () =>
  h.update.mockImplementation(async (id, patch) => {
    h.state = { ...h.state, events: h.state.events.map((e) => (e.id === id ? { ...e, ...patch } : e)) };
    return { id };
  });
const listsOutsideDialogs = () =>
  screen.queryAllByRole('list').filter((l) => !l.closest('[role="dialog"]'));

// Heavy render-and-wait suite: raise the time limits so a busy machine does not trip them.
allowSlowSuite();

describe('CalendarPage CRUD dialogs', () => {
  it('renders no form on load', () => {
    renderPage(<CalendarPage />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Date')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Search events')).toBeInTheDocument();
  });

  it('Add opens a dialog on today and creates an all-day event', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const addBtn = screen.getByRole('button', { name: 'Add event' });
    await user.click(addBtn);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Title')).toHaveFocus();
    expect(within(dialog).getByLabelText('Date')).toHaveValue(todayKey);
    await user.type(within(dialog).getByLabelText('Title'), '  Lunch ');
    await user.click(within(dialog).getByRole('button', { name: 'Add event' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(h.add).toHaveBeenCalledWith({
      summary: 'Lunch',
      description: '',
      location: '',
      allDay: true,
      start: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).toISOString(),
      end: null,
    });
    expect(screen.getByText('Event added')).toBeInTheDocument();
    expect(addBtn).toHaveFocus();
  });

  it('Add with a timed range builds local start/end ISO strings', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.click(screen.getByRole('button', { name: 'Add event' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Title'), 'Call');
    await user.click(within(dialog).getByLabelText('All day'));
    fireEvent.change(within(dialog).getByLabelText('Start time'), { target: { value: '14:00' } });
    fireEvent.change(within(dialog).getByLabelText('End time'), { target: { value: '15:15' } });
    await user.click(within(dialog).getByRole('button', { name: 'Add event' }));
    await waitFor(() => expect(h.add).toHaveBeenCalled());
    expect(h.add.mock.calls[0][0]).toMatchObject({
      allDay: false,
      start: new Date(`${todayKey}T14:00`).toISOString(),
      end: new Date(`${todayKey}T15:15`).toISOString(),
    });
  });

  it('rejects an end time before the start time without submitting', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.click(screen.getByRole('button', { name: 'Add event' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Title'), 'Call');
    await user.click(within(dialog).getByLabelText('All day'));
    fireEvent.change(within(dialog).getByLabelText('End time'), { target: { value: '08:00' } });
    await user.click(within(dialog).getByRole('button', { name: 'Add event' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('End time must be after');
    expect(h.add).not.toHaveBeenCalled();
  });

  it('rejected submit shows the error and keeps the dialog open', async () => {
    h.add.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.click(screen.getByRole('button', { name: 'Add event' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Title'), 'Lunch');
    await user.click(within(dialog).getByRole('button', { name: 'Add event' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("Couldn't save the event. Try again.");
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Lunch');
  });

  it('Edit prefills and an unchanged-time edit omits start/end/allDay', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.click(surfaceOf(TIMED_NAME, 'grid'));
    await clickEdit(user);
    const dialog = screen.getByRole('dialog', { name: 'Edit event' });
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Standup');
    expect(within(dialog).getByLabelText('Date')).toHaveValue(todayKey);
    expect(within(dialog).getByLabelText('Start time')).toHaveValue('10:00');
    expect(within(dialog).getByLabelText('End time')).toHaveValue('10:30');
    expect(within(dialog).getByLabelText('Location')).toHaveValue('Room 1');
    const title = within(dialog).getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Sync');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    // Save returns to the details view (not closed).
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit event' })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(h.update).toHaveBeenCalledTimes(1);
    const [id, patch] = h.update.mock.calls[0];
    expect(id).toBe('e1');
    expect(patch).toEqual({
      summary: 'Sync',
      description: 'Daily',
      location: 'Room 1',
    });
    expect(patch).not.toHaveProperty('context');
    expect(screen.getByText('Event updated')).toBeInTheDocument();
  });

  it('a changed-time edit includes start/end/allDay', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.click(surfaceOf(TIMED_NAME, 'grid'));
    await clickEdit(user);
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Start time'), { target: { value: '09:00' } });
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(h.update).toHaveBeenCalled());
    expect(h.update.mock.calls[0][1]).toMatchObject({
      allDay: false,
      start: new Date(`${todayKey}T09:00`).toISOString(),
      end: new Date(`${todayKey}T10:30`).toISOString(),
    });
  });

  it('toggling all-day on an edit includes start/end/allDay', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.click(surfaceOf(TIMED_NAME, 'grid'));
    await clickEdit(user);
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByLabelText('All day'));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(h.update).toHaveBeenCalled());
    expect(h.update.mock.calls[0][1]).toMatchObject({ allDay: true, end: null });
    expect(h.update.mock.calls[0][1].start).toBeTruthy();
  });

  it('ICS events are editable and removable', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    expect(screen.getAllByRole('button', { name: /^Open event: Imported, All day/ }).length).toBeGreaterThan(0);
    await openDay(user);
    await user.click(screen.getByRole('button', { name: 'Remove Imported' }));
    await confirmRemove(user);
    await waitFor(() => expect(h.remove).toHaveBeenCalledWith('e2'));
  });

  it('search results open the details dialog', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.type(screen.getByLabelText('Search events'), 'standup');
    const results = screen.getByRole('list', { name: 'Search results' });
    expect(within(results).getAllByRole('listitem')).toHaveLength(1);
    await user.click(within(results).getByRole('button', { name: /^Open event: Standup/ }));
    expect(screen.getByRole('dialog', { name: 'Standup' })).toBeInTheDocument();
  });

  it('Remove confirms in an alertdialog with Cancel focused; Cancel makes no call', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await openDay(user);
    await user.click(screen.getByRole('button', { name: 'Remove Standup' }));
    const alert = screen.getByRole('alertdialog');
    expect(within(alert).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(alert).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('confirming Remove calls remove(id), toasts and stays on the day list', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await openDay(user);
    await user.click(screen.getByRole('button', { name: 'Remove Standup' }));
    await confirmRemove(user);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(h.remove).toHaveBeenCalledWith('e1');
    expect(screen.getByText('Event removed')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: TODAY_TITLE })).toBeInTheDocument();
  });

  it('rejected remove shows the error and stays open', async () => {
    h.remove.mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await openDay(user);
    await user.click(screen.getByRole('button', { name: 'Remove Standup' }));
    const alert = screen.getByRole('alertdialog');
    await user.click(within(alert).getByRole('button', { name: 'Remove' }));
    expect(await within(alert).findByRole('alert')).toHaveTextContent("Burrow couldn't finish that. Try again.");
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('Escape closes the dialog without saving', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.click(screen.getByRole('button', { name: 'Add event' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(h.add).not.toHaveBeenCalled();
  });

  it('temp ids render as focusable aria-disabled Saving buttons with no edit/remove actions', async () => {
    h.state = { events: [{ ...TIMED, id: 'temp-9' }], loading: false, error: null };
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    expect(screen.queryByRole('button', { name: /^Open event/ })).not.toBeInTheDocument();
    const expectSaving = async (b) => {
      expect(b).toHaveAttribute('aria-disabled', 'true');
      expect(b).not.toBeDisabled();
      b.focus();
      expect(b).toHaveFocus();
      expect(b).toHaveAccessibleDescription(/Saving/);
      await user.click(b);
    };
    // grid chip (only surface on load)
    const chips = screen.getAllByRole('button', { name: /^Saving event: Standup/ });
    expect(chips).toHaveLength(1);
    await expectSaving(chips[0]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // day list row
    const dialog = await openDay(user);
    const row = within(dialog).getByRole('button', { name: /^Saving event: Standup/ });
    expect(row).toHaveAttribute('data-event-surface', 'list');
    await expectSaving(row);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog')).toHaveAccessibleName(TODAY_TITLE);
    expect(screen.queryByRole('button', { name: 'Edit Standup' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Standup' })).not.toBeInTheDocument();
  });

  it('an empty day opens the add form directly, prefilled with that date', async () => {
    h.state = { events: [], loading: false, error: null };
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.click(document.querySelector(`[data-day-key="${todayKey}"]`));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    const form = screen.getByRole('dialog', { name: 'Add event' });
    expect(within(form).getByLabelText('Date')).toHaveValue(todayKey);
    expect(screen.queryByText('No events')).not.toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.querySelector(`[data-day-key="${todayKey}"]`)).toHaveFocus();
  });

  it('shows LoadError with Retry on a non-503 load error', async () => {
    h.state = { events: [], loading: false, error: { status: 500, message: 'raw server text' } };
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    expect(screen.getByRole('alert')).toHaveTextContent("Burrow couldn't load your calendar. Your data is safe.");
    expect(screen.queryByText(/raw server text/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('event buttons open the details modal and Escape returns focus to the chip', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const btn = surfaceOf(TIMED_NAME, 'grid');
    await user.click(btn);
    expect(screen.getByRole('dialog', { name: 'Standup' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(btn).toHaveFocus();
  });

  it('a grid chip does not change the selected day', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const chip = screen.getAllByRole('button', { name: /^Open event: Standup, / })[0];
    await user.click(chip);
    expect(screen.getByRole('dialog', { name: 'Standup' })).toBeInTheDocument();
    expect(selectedDayButtons()).toHaveLength(1);
    expect(selectedDayButtons()[0]).toHaveAttribute('data-day-key', todayKey);
  });

  it('pins the day number to the top of the cell so stacked chips cannot overlap it', () => {
    renderPage(<CalendarPage />);
    const dayButton = document.querySelector(`[data-day-key="${todayKey}"]`);
    // A bare absolute button centers its content vertically; the number must be top-aligned.
    expect(dayButton).toHaveClass('flex', 'items-start');
  });

  it('Remove in the details modal confirms, removes and closes, focusing Add', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.click(screen.getAllByRole('button', { name: /^Open event: Standup, / })[0]);
    await clickRemove(user);
    await confirmRemove(user);
    await waitFor(() => expect(h.remove).toHaveBeenCalledWith('e1'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByText('Event removed')).toBeInTheDocument();
  });

  it('keeps the 503 unavailable state', () => {
    h.state = { events: [], loading: false, error: { status: 503, message: 'x' } };
    renderPage(<CalendarPage />);
    expect(screen.getByText('Calendar unavailable')).toBeInTheDocument();
  });
});

describe('CalendarPage event buttons', () => {
  it('renders timed and all-day events as chips on load and as list rows in the day modal', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    expect(screen.getAllByRole('button', { name: TIMED_NAME })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: ALLDAY_NAME })).toHaveLength(1);
    const dialog = await openDay(user);
    expect(screen.getAllByRole('button', { name: TIMED_NAME })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: ALLDAY_NAME })).toHaveLength(2);
    expect(inDialog(dialog, TIMED_NAME)).toHaveAttribute('data-event-surface', 'list');
    for (const b of screen.getAllByRole('button', { name: /^Open event: / })) {
      expect(b).toBeEnabled();
      expect(b).toHaveAttribute('data-event-id');
    }
  });

  it('renders search results as named event buttons alongside the grid chip', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.type(screen.getByLabelText('Search events'), 'imported');
    expect(within(screen.getByRole('list', { name: 'Search results' })).getAllByRole('listitem')).toHaveLength(1);
    // grid chip + search row
    expect(screen.getAllByRole('button', { name: ALLDAY_NAME })).toHaveLength(2);
    await user.clear(screen.getByLabelText('Search events'));
    await user.type(screen.getByLabelText('Search events'), 'standup');
    expect(screen.getAllByRole('button', { name: TIMED_NAME })).toHaveLength(2);
  });

  it('search rows appear for events on a day other than the selected one', async () => {
    const other = new Date(now.getFullYear(), now.getMonth(), now.getDate() === 15 ? 16 : 15, 9, 0).toISOString();
    h.state = { events: [{ ...TIMED, id: 'e5', summary: 'Dentist', start: other, end: null }], loading: false, error: null };
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    // not on the selected day, so only the grid chip exists until searched
    expect(screen.getAllByRole('button', { name: /^Open event: Dentist/ })).toHaveLength(1);
    await user.type(screen.getByLabelText('Search events'), 'dentist');
    expect(screen.getAllByRole('button', { name: /^Open event: Dentist/ })).toHaveLength(2);
  });

  it('has no nested buttons or buttons inside role=button, including with the day modal open', async () => {
    const user = userEvent.setup();
    const { container } = renderPage(<CalendarPage />);
    const check = (root) => {
      expect(root.querySelectorAll('button button').length).toBe(0);
      expect(root.querySelectorAll('[role="button"] button').length).toBe(0);
      expect(root.querySelectorAll('button [role="button"]').length).toBe(0);
    };
    check(container);
    await user.type(screen.getByLabelText('Search events'), 'e');
    check(container);
    check(document.body);
    // chip -> details
    await user.click(surfaceOf(TIMED_NAME, 'grid'));
    check(document.body);
    await user.keyboard('{Escape}');
    // day modal (list rows with sibling Remove), details-from-day, and the stacked confirm
    const dialog = await openDay(user);
    check(document.body);
    expect(within(dialog).getAllByRole('button', { name: /^Remove / }).length).toBe(2);
    await user.click(inDialog(dialog, TIMED_NAME));
    check(document.body);
    await clickRemove(user);
    check(document.body);
  });

  it('opens the prefilled edit form (via Edit) from the grid chip, the day modal row and a search result', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const assertPrefilled = () => {
      const dialog = screen.getByRole('dialog', { name: 'Edit event' });
      expect(within(dialog).getByLabelText('Title')).toHaveValue('Standup');
      expect(within(dialog).getByLabelText('Date')).toHaveValue(todayKey);
      expect(within(dialog).getByLabelText('All day')).not.toBeChecked();
      expect(within(dialog).getByLabelText('Start time')).toHaveValue('10:00');
      expect(within(dialog).getByLabelText('End time')).toHaveValue('10:30');
      expect(within(dialog).getByLabelText('Location')).toHaveValue('Room 1');
      expect(within(dialog).getByLabelText('Notes')).toHaveValue('Daily');
      expect(within(dialog).queryByLabelText('Context')).not.toBeInTheDocument();
    };
    await user.click(surfaceOf(TIMED_NAME, 'grid'));
    await clickEdit(user);
    assertPrefilled();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await clickClose(user);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const day = await openDay(user);
    await user.click(inDialog(day, TIMED_NAME));
    await clickEdit(user);
    assertPrefilled();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Search events'), 'standup');
    await user.click(surfaceOf(TIMED_NAME, 'search'));
    await clickEdit(user);
    assertPrefilled();
  });

  it('a grid chip click on another day opens its details only, not that day\'s list', async () => {
    h.state = {
      events: [{ ...TIMED, id: 'e6', summary: 'Elsewhere', start: new Date(otherDate.getFullYear(), otherDate.getMonth(), otherDate.getDate(), 9).toISOString(), end: null }],
      loading: false,
      error: null,
    };
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    expect(selectedDayButtons().map((b) => b.dataset.dayKey)).toEqual([todayKey]);
    await user.click(screen.getByRole('button', { name: /^Open event: Elsewhere/ }));
    expect(screen.getByRole('dialog', { name: 'Elsewhere' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: dayTitle(otherDate) })).not.toBeInTheDocument();
    expect(selectedDayButtons().map((b) => b.dataset.dayKey)).toEqual([todayKey]);
  });

  it('+N more opens the day modal with every event and leaves the search query alone', async () => {
    const mk = (id, summary, hour) => ({ ...TIMED, id, summary, start: at(hour), end: at(hour, 30) });
    h.state = {
      events: [mk('a', 'Alpha', 8), mk('b', 'Bravo', 9), mk('c', 'Charlie', 10), mk('d', 'Delta', 11)],
      loading: false,
      error: null,
    };
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    // select a different day first
    await user.click(screen.getByRole('button', { name: dayName(otherDate) }));
    await user.keyboard('{Escape}');
    // only two chips fit in the grid; overflow events are hidden
    expect(screen.queryByRole('button', { name: /^Open event: Charlie/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Open event: Delta/ })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Search events'), 'a');
    const more = screen.getByRole('button', { name: `Show 2 more events on ${TODAY_LABEL}` });
    expect(more).toHaveTextContent('+2 more');
    expect(more).toHaveAttribute('aria-haspopup', 'dialog');
    await user.click(more);
    expect(screen.getByLabelText('Search events')).toHaveValue('a');
    expect(screen.getByRole('list', { name: 'Search results' })).toBeInTheDocument();
    expect(selectedDayButtons().map((b) => b.dataset.dayKey)).toEqual([todayKey]);
    const dialog = screen.getByRole('dialog', { name: TODAY_TITLE });
    for (const name of ['Alpha', 'Bravo', 'Charlie', 'Delta']) {
      expect(within(dialog).getByRole('button', { name: new RegExp(`^Open event: ${name}, `) })).toBeInTheDocument();
    }
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(4);
  });

  it('+1 more uses the singular label', () => {
    h.state = {
      events: [1, 2, 3].map((n) => ({ ...TIMED, id: `s${n}`, summary: `Ev${n}`, start: at(7 + n), end: null })),
      loading: false,
      error: null,
    };
    renderPage(<CalendarPage />);
    expect(screen.getByRole('button', { name: `Show 1 more event on ${TODAY_LABEL}` })).toHaveTextContent('+1 more');
  });

  it('day and search rows have a Remove button but no Edit icon button', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const isEditIcon = (b) => /^Edit\b/.test(b.getAttribute('aria-label') || b.textContent) && !/^Edit event:/.test(b.getAttribute('aria-label') || '');
    const dialog = await openDay(user);
    expect(screen.getAllByRole('button').filter(isEditIcon)).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Edit Standup' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Remove Standup' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.type(screen.getByLabelText('Search events'), 'standup');
    expect(screen.getAllByRole('button').filter(isEditIcon)).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Edit Standup' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Standup' })).toBeInTheDocument();
  });

  it('Remove from a search result confirms before calling remove', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.type(screen.getByLabelText('Search events'), 'standup');
    await user.click(screen.getByRole('button', { name: 'Remove Standup' }));
    expect(h.remove).not.toHaveBeenCalled();
    await confirmRemove(user);
    await waitFor(() => expect(h.remove).toHaveBeenCalledWith('e1'));
  });

  it('Remove from the day list: cancel keeps the event and no details dialog opens', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const dialog = await openDay(user);
    await user.click(within(dialog).getByRole('button', { name: 'Remove Standup' }));
    expect(screen.queryByRole('dialog', { name: 'Standup' })).not.toBeInTheDocument();
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(h.remove).not.toHaveBeenCalled();
    expect(inDialog(screen.getByRole('dialog', { name: TODAY_TITLE }), TIMED_NAME)).toBeInTheDocument();
  });

  it('Remove in the modal: cancel returns to the details without removing', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const day = await openDay(user);
    await user.click(inDialog(day, TIMED_NAME));
    await clickRemove(user);
    const alert = screen.getByRole('alertdialog');
    expect(alert).toHaveTextContent('Standup');
    await user.click(within(alert).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(h.remove).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Standup' });
    expect(within(dialog).getByRole('button', { name: 'Remove' })).toHaveFocus();
  });

  it('Remove in the modal from a chip: confirm removes, closes both dialogs and focuses Add event', async () => {
    applyRemove();
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.click(surfaceOf(TIMED_NAME, 'grid'));
    await clickRemove(user);
    await confirmRemove(user);
    await waitFor(() => expect(h.remove).toHaveBeenCalledWith('e1'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByText('Event removed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Open event: Standup/ })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add event' })).toHaveFocus());
  });

  it('a rejected delete from the modal keeps the confirm open with the error', async () => {
    h.remove.mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.click(surfaceOf(TIMED_NAME, 'grid'));
    await clickRemove(user);
    const alert = screen.getByRole('alertdialog');
    await user.click(within(alert).getByRole('button', { name: 'Remove' }));
    expect(await within(alert).findByRole('alert')).toHaveTextContent("Burrow couldn't finish that. Try again.");
    expect(screen.getByRole('dialog', { name: 'Standup' })).toBeInTheDocument();
  });

  it('focus returns to the originating chip on Escape and on Cancel', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const chip = surfaceOf(TIMED_NAME, 'grid');
    await user.click(chip);
    await clickClose(user);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(chip).toHaveFocus();
    await user.click(chip);
    await user.keyboard('{Escape}');
    expect(chip).toHaveFocus();
    await user.click(chip);
    await clickEdit(user);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await clickClose(user);
    expect(chip).toHaveFocus();
  });

  it('focus returns to the originating search result row on close', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.type(screen.getByLabelText('Search events'), 'standup');
    const row = surfaceOf(TIMED_NAME, 'search');
    await user.click(row);
    await user.keyboard('{Escape}');
    expect(row).toHaveFocus();
  });

  it('an imported (ICS) event button opens details with an Imported badge, then the edit form with its all-day values', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.click(screen.getAllByRole('button', { name: ALLDAY_NAME })[0]);
    expect(within(screen.getByRole('dialog', { name: 'Imported' })).getByText('Imported', { selector: 'span' })).toBeInTheDocument();
    await clickEdit(user);
    const dialog = screen.getByRole('dialog', { name: 'Edit event' });
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Imported');
    expect(within(dialog).getByLabelText('Date')).toHaveValue(todayKey);
    expect(within(dialog).getByLabelText('All day')).toBeChecked();
    expect(within(dialog).queryByLabelText('Start time')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Context')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Delete event' })).not.toBeInTheDocument();
  });

  it('an optimistic temp- imported event renders as an aria-disabled Saving event button on the grid and in the day list', async () => {
    h.state = { events: [{ ...ICS, id: 'temp-ics-1' }], loading: false, error: null };
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const dialog = await openDay(user);
    const views = screen.getAllByRole('button', { name: /^Saving event: / });
    expect(views).toHaveLength(2);
    expect(within(dialog).getAllByRole('button', { name: /^Saving event: / })).toHaveLength(1);
    for (const b of views) {
      expect(b).toHaveAttribute('aria-disabled', 'true');
      expect(b).not.toBeDisabled();
      b.focus();
      expect(b).toHaveFocus();
      expect(b).toHaveAccessibleDescription(/Saving/);
      await user.click(b);
    }
    // still only the day list: nothing opened details
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog')).toHaveAccessibleName(TODAY_TITLE);
    expect(screen.queryByRole('button', { name: /^Open event/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Imported' })).not.toBeInTheDocument();
  });

  it('shows the temp- event as an aria-disabled Saving event button in search results too', async () => {
    h.state = { events: [{ ...TIMED, id: 'temp-2' }], loading: false, error: null };
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.type(screen.getByLabelText('Search events'), 'standup');
    const views = screen.getAllByRole('button', { name: /^Saving event: Standup, / });
    expect(views).toHaveLength(2);
    for (const b of views) {
      expect(b).toHaveAttribute('aria-disabled', 'true');
      expect(b).not.toBeDisabled();
      b.focus();
      expect(b).toHaveFocus();
      expect(b).toHaveAccessibleDescription(/Saving/);
      await user.click(b);
    }
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Back from details returns focus to the day-list row (not the grid chip)', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const chip = surfaceOf(TIMED_NAME, 'grid');
    const day = await openDay(user);
    const row = inDialog(day, TIMED_NAME);
    expect(chip).toHaveAttribute('data-event-surface', 'grid');
    expect(row).toHaveAttribute('data-event-surface', 'list');
    expect(row.getAttribute('data-event-id')).toBe(chip.getAttribute('data-event-id'));
    await user.click(row);
    await user.click(screen.getByRole('button', { name: `Back to ${TODAY_TITLE}` }));
    const backRow = inDialog(screen.getByRole('dialog', { name: TODAY_TITLE }), TIMED_NAME);
    expect(document.activeElement).toBe(backRow);
    expect(document.activeElement).toHaveAttribute('data-event-surface', 'list');
    expect(chip).not.toHaveFocus();
  });

  it('returns focus to the search row (not the grid chip) when opened from search results', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.type(screen.getByLabelText('Search events'), 'standup');
    const searchRow = surfaceOf(TIMED_NAME, 'search');
    expect(searchRow).toBeDefined();
    await user.click(searchRow);
    await clickClose(user);
    expect(document.activeElement).toBe(searchRow);
    expect(document.activeElement).toHaveAttribute('data-event-surface', 'search');
  });

  it('marks the details modal inert only while the remove confirm is stacked on top', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const day = await openDay(user);
    await user.click(inDialog(day, TIMED_NAME));
    const editPanel = screen.getByRole('dialog', { name: 'Standup' });
    expect(editPanel).not.toHaveAttribute('inert');
    await user.click(within(editPanel).getByRole('button', { name: 'Remove' }));
    const confirm = screen.getByRole('alertdialog');
    expect(editPanel).toHaveAttribute('inert');
    expect(confirm).not.toHaveAttribute('inert');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Standup' })).not.toHaveAttribute('inert');
  });

  it('marks the day modal inert while a row-level remove confirm is stacked on top', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const day = await openDay(user);
    expect(day).not.toHaveAttribute('inert');
    await user.click(within(day).getByRole('button', { name: 'Remove Standup' }));
    expect(day).toHaveAttribute('inert');
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('dialog', { name: TODAY_TITLE })).not.toHaveAttribute('inert');
  });

  it('day-list rows describe their location via aria-describedby', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const chip = surfaceOf(TIMED_NAME, 'grid');
    const day = await openDay(user);
    const row = inDialog(day, TIMED_NAME);
    expect(row).toHaveAttribute('aria-describedby');
    expect(row).toHaveAccessibleDescription(/Room 1/);
    expect(row).toHaveAccessibleDescription(/Daily/);
    expect(chip).not.toHaveAttribute('aria-describedby');
  });

  it('Add mode has no Delete event button', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.click(screen.getByRole('button', { name: 'Add event' }));
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'Delete event' })).not.toBeInTheDocument();
  });
});

describe('no always-visible panel or list', () => {
  it('shows no day panel, event list or search results on load', () => {
    renderPage(<CalendarPage />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('list')).toHaveLength(0);
    expect(screen.queryByRole('list', { name: 'Search results' })).not.toBeInTheDocument();
    expect(screen.queryByText('No events')).not.toBeInTheDocument();
    expect(screen.queryByText('Nothing scheduled.')).not.toBeInTheDocument();
    expect(screen.queryByText(/events? found/)).not.toBeInTheDocument();
    // rows only exist as grid chips
    for (const b of screen.getAllByRole('button', { name: /^Open event: / })) {
      expect(b).toHaveAttribute('data-event-surface', 'grid');
    }
  });

  it('after clicking a day, a list exists only inside the dialog and not once it closes', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const dialog = await openDay(user);
    expect(within(dialog).getByRole('list')).toBeInTheDocument();
    expect(listsOutsideDialogs()).toHaveLength(0);
    expect(screen.queryByRole('list', { name: 'Search results' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('list')).toHaveLength(0);
    for (const b of screen.getAllByRole('button', { name: /^Open event: / })) {
      expect(b).toHaveAttribute('data-event-surface', 'grid');
    }
  });

  it('even on an empty calendar nothing but the grid renders until a day is clicked', () => {
    h.state = { events: [], loading: false, error: null };
    renderPage(<CalendarPage />);
    expect(screen.queryByText('No events')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add your first event' })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('list')).toHaveLength(0);
  });
});

describe('day modal', () => {
  beforeEach(() => {
    h.state = {
      events: [
        TIMED,
        ICS,
        {
          ...TIMED,
          id: 'e9',
          summary: 'Elsewhere',
          start: new Date(otherDate.getFullYear(), otherDate.getMonth(), otherDate.getDate(), 9).toISOString(),
          end: null,
        },
      ],
      loading: false,
      error: null,
    };
  });

  it('the day selector is a dialog-opening button named by the date', () => {
    renderPage(<CalendarPage />);
    const btn = screen.getByRole('button', { name: dayName(now) });
    expect(btn).toHaveAttribute('aria-haspopup', 'dialog');
    expect(btn).toHaveAttribute('aria-current', 'date');
  });

  it('the day selector is not a toggle and its name carries the event count', () => {
    renderPage(<CalendarPage />);
    const today = screen.getByRole('button', { name: dayName(now) });
    expect(today).not.toHaveAttribute('aria-pressed');
    expect(today).toHaveAttribute('aria-label', `${TODAY_LABEL}, 2 events`);
    expect(screen.getByRole('button', { name: `${dateLabel(otherDate)}, 1 event` })).not.toHaveAttribute('aria-pressed');
    expect(screen.getByRole('button', { name: `${dateLabel(emptyDate)}, no events` })).toBeInTheDocument();
  });

  it('the day view focuses the first event row', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const day = await openDay(user);
    const first = within(day).getAllByRole('listitem')[0].querySelector('[data-event-surface="list"]');
    expect(first).toHaveFocus();
    expect(inDialog(day, 'Add event')).not.toHaveFocus();
    expect(first).not.toHaveAttribute('aria-haspopup');
    expect(inDialog(day, 'Add event')).not.toHaveAttribute('aria-haspopup');
  });

  it('announces the new dialog name after switching views, and stays empty at mount', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const day = await openDay(user);
    expect(within(day).getByRole('status')).toBeEmptyDOMElement();
    await user.click(inDialog(day, ALLDAY_NAME));
    const details = screen.getByRole('dialog', { name: 'Imported' });
    expect(within(details).getByRole('status')).toHaveTextContent('Imported');
    await user.click(within(details).getByRole('button', { name: 'Edit' }));
    expect(within(screen.getByRole('dialog', { name: 'Edit event' })).getByRole('status')).toHaveTextContent('Edit event');
  });

  it('a search-result Remove after a closed day session does not focus a day cell', async () => {
    applyRemove();
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const day = await openDay(user);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Search events'), 'Elsewhere');
    const results = screen.getByRole('list', { name: 'Search results' });
    await user.click(within(results).getByRole('button', { name: 'Remove Elsewhere' }));
    await confirmRemove(user);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(day).not.toBeInTheDocument();
    expect(document.activeElement?.hasAttribute('data-day-key')).toBe(false);
    expect(document.activeElement?.hasAttribute('data-day-more-key')).toBe(false);
  });

  it('clicking a day opens one modal titled with the day and lists only that day\'s events', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const dialog = await openDay(user);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(selectedDayButtons().map((b) => b.dataset.dayKey)).toEqual([todayKey]);
    const items = within(dialog).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(dialog).getByRole('button', { name: TIMED_NAME })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: ALLDAY_NAME })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Elsewhere/ })).not.toBeInTheDocument();
    for (const item of items) {
      const [rowBtn, removeBtn] = within(item).getAllByRole('button');
      expect(rowBtn).toHaveAttribute('data-event-surface', 'list');
      expect(removeBtn).toHaveAccessibleName(/^Remove /);
      expect(rowBtn.contains(removeBtn)).toBe(false);
    }
    expect(within(dialog).queryByText('No events')).not.toBeInTheDocument();
  });

  it('another day opens its own list', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const dialog = await openDay(user, otherDate);
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(1);
    expect(within(dialog).getByRole('button', { name: /^Open event: Elsewhere/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Standup/ })).not.toBeInTheDocument();
  });

  it('an empty day goes straight to the add form and closes after saving', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.click(document.querySelector(`[data-day-key="${keyOf(emptyDate)}"]`));
    const form = screen.getByRole('dialog', { name: 'Add event' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(within(form).getByLabelText('Date')).toHaveValue(keyOf(emptyDate));
    await user.type(within(form).getByLabelText('Title'), 'Lunch');
    await user.click(within(form).getByRole('button', { name: 'Add event' }));
    await waitFor(() => expect(h.add).toHaveBeenCalledTimes(1));
    expect(h.add.mock.calls[0][0]).toMatchObject({
      summary: 'Lunch',
      allDay: true,
      start: new Date(emptyDate.getFullYear(), emptyDate.getMonth(), emptyDate.getDate(), 0, 0, 0).toISOString(),
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('Event added')).toBeInTheDocument();
  });

  it('Add in a day with events prefills that day; Cancel returns to the list with focus on its first row', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const dialog = await openDay(user, otherDate);
    await user.click(inDialog(dialog, 'Add event'));
    const form = screen.getByRole('dialog', { name: 'Add event' });
    expect(within(form).getByLabelText('Date')).toHaveValue(keyOf(otherDate));
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    const list = screen.getByRole('dialog', { name: dayTitle(otherDate) });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getAllByRole('listitem')[0].querySelector('[data-event-surface="list"]')).toHaveFocus();
    expect(h.add).not.toHaveBeenCalled();
  });

  it('row -> details -> Back returns to the list with focus on that row', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const day = await openDay(user);
    await user.click(inDialog(day, ALLDAY_NAME));
    // same Modal switches view: exactly one dialog, now the event details
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    const details = screen.getByRole('dialog', { name: 'Imported' });
    const back = within(details).getByRole('button', { name: `Back to ${TODAY_TITLE}` });
    expect(back).toHaveTextContent('Back');
    await user.click(back);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    const list = screen.getByRole('dialog', { name: TODAY_TITLE });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(inDialog(list, ALLDAY_NAME)).toHaveFocus();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('details Close from the day modal closes everything', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const day = await openDay(user);
    await user.click(inDialog(day, TIMED_NAME));
    await clickClose(user);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Edit and Save inside the day modal return to details, then Back shows the updated row', async () => {
    applyUpdate();
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const day = await openDay(user);
    await user.click(inDialog(day, TIMED_NAME));
    await clickEdit(user);
    const form = screen.getByRole('dialog', { name: 'Edit event' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    const title = within(form).getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Retro');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    const details = await screen.findByRole('dialog', { name: 'Retro' });
    expect(within(details).getByRole('button', { name: 'Edit' })).toHaveFocus();
    expect(screen.getByText('Event updated')).toBeInTheDocument();
    await user.click(within(details).getByRole('button', { name: `Back to ${TODAY_TITLE}` }));
    const list = screen.getByRole('dialog', { name: TODAY_TITLE });
    const row = within(list).getByRole('button', { name: /^Open event: Retro, / });
    expect(row).toHaveFocus();
    expect(within(list).queryByRole('button', { name: /Standup/ })).not.toBeInTheDocument();
  });

  it('Cancel in Edit returns to details (with Back still available), not the list', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const day = await openDay(user);
    await user.click(inDialog(day, TIMED_NAME));
    await clickEdit(user);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    const details = screen.getByRole('dialog', { name: 'Standup' });
    expect(within(details).getByRole('button', { name: 'Edit' })).toHaveFocus();
    expect(within(details).getByRole('button', { name: `Back to ${TODAY_TITLE}` })).toBeInTheDocument();
    expect(h.update).not.toHaveBeenCalled();
  });

  describe('Remove inside the day modal', () => {
    it('row Remove with events remaining returns to the list and toasts "Event removed"', async () => {
      applyRemove();
      const user = userEvent.setup();
      renderPage(<CalendarPage />);
      const day = await openDay(user);
      await user.click(within(day).getByRole('button', { name: 'Remove Standup' }));
      await confirmRemove(user);
      await waitFor(() => expect(h.remove).toHaveBeenCalledWith('e1'));
      const list = await screen.findByRole('dialog', { name: TODAY_TITLE });
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(within(list).getAllByRole('listitem')).toHaveLength(1);
      expect(within(list).queryByRole('button', { name: /Standup/ })).not.toBeInTheDocument();
      expect(screen.getByText('Event removed')).toBeInTheDocument();
    });

    it('details Remove with events remaining returns to the list and toasts "Event removed"', async () => {
      applyRemove();
      const user = userEvent.setup();
      renderPage(<CalendarPage />);
      const day = await openDay(user);
      await user.click(inDialog(day, TIMED_NAME));
      await clickRemove(user);
      await confirmRemove(user);
      await waitFor(() => expect(h.remove).toHaveBeenCalledWith('e1'));
      const list = await screen.findByRole('dialog', { name: TODAY_TITLE });
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      expect(within(list).getAllByRole('listitem')).toHaveLength(1);
      expect(screen.getByText('Event removed')).toBeInTheDocument();
      expect(screen.queryByText(/No events left/)).not.toBeInTheDocument();
    });

    it('row Remove of the last event closes the modal, toasts "No events left" and focuses the day button', async () => {
      h.state = { events: [TIMED], loading: false, error: null };
      applyRemove();
      const user = userEvent.setup();
      renderPage(<CalendarPage />);
      const day = await openDay(user);
      await user.click(within(day).getByRole('button', { name: 'Remove Standup' }));
      await confirmRemove(user);
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(screen.getByText(`Event removed. No events left on ${TODAY_TITLE}.`)).toBeInTheDocument();
      expect(screen.queryByText('Event removed')).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole('button', { name: dayName(now) })).toHaveFocus());
    });

    it('details Remove of the last event closes the modal, toasts "No events left" and focuses the day button', async () => {
      h.state = { events: [TIMED], loading: false, error: null };
      applyRemove();
      const user = userEvent.setup();
      renderPage(<CalendarPage />);
      const day = await openDay(user);
      await user.click(inDialog(day, TIMED_NAME));
      await clickRemove(user);
      await confirmRemove(user);
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(screen.getByText(`Event removed. No events left on ${TODAY_TITLE}.`)).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole('button', { name: dayName(now) })).toHaveFocus());
    });

    it('the "last event" toast names the opened day, not today', async () => {
      applyRemove();
      const user = userEvent.setup();
      renderPage(<CalendarPage />);
      const day = await openDay(user, otherDate);
      await user.click(within(day).getByRole('button', { name: 'Remove Elsewhere' }));
      await confirmRemove(user);
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(screen.getByText(`Event removed. No events left on ${dayTitle(otherDate)}.`)).toBeInTheDocument();
    });

    it('a rejected remove keeps the day modal intact and shows no toast', async () => {
      h.remove.mockRejectedValue(new Error('nope'));
      const user = userEvent.setup();
      renderPage(<CalendarPage />);
      const day = await openDay(user);
      await user.click(within(day).getByRole('button', { name: 'Remove Standup' }));
      const alert = screen.getByRole('alertdialog');
      await user.click(within(alert).getByRole('button', { name: 'Remove' }));
      expect(await within(alert).findByRole('alert')).toHaveTextContent("Burrow couldn't finish that. Try again.");
      expect(screen.queryByText('Event removed')).not.toBeInTheDocument();
      expect(screen.getByRole('dialog', { name: TODAY_TITLE })).toBeInTheDocument();
    });
  });
});

describe('chips and search results open details directly', () => {
  it('a chip opens details with no Back button and no day list', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.click(surfaceOf(TIMED_NAME, 'grid'));
    const dialog = screen.getByRole('dialog', { name: 'Standup' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(within(dialog).queryByRole('button', { name: /^Back/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('list')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Edit' })).toHaveFocus();
  });

  it('a search result opens details with no Back button', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.type(screen.getByLabelText('Search events'), 'standup');
    await user.click(surfaceOf(TIMED_NAME, 'search'));
    const dialog = screen.getByRole('dialog', { name: 'Standup' });
    expect(within(dialog).queryByRole('button', { name: /^Back/ })).not.toBeInTheDocument();
  });

  it('Remove from a chip-opened details never reports "No events left"', async () => {
    h.state = { events: [TIMED], loading: false, error: null };
    applyRemove();
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.click(surfaceOf(TIMED_NAME, 'grid'));
    await clickRemove(user);
    await confirmRemove(user);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('Event removed')).toBeInTheDocument();
    expect(screen.queryByText(/No events left/)).not.toBeInTheDocument();
  });
});

describe('search', () => {
  const searchBox = () => screen.getByLabelText('Search events');

  it('shows results only while the query is non-empty and clearing hides them', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    expect(screen.queryByRole('list', { name: 'Search results' })).not.toBeInTheDocument();
    await user.type(searchBox(), 'standup');
    const list = screen.getByRole('list', { name: 'Search results' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('1 event found')).toBeInTheDocument();
    await user.clear(searchBox());
    expect(screen.queryByRole('list', { name: 'Search results' })).not.toBeInTheDocument();
    expect(screen.queryByText(/events? found/)).not.toBeInTheDocument();
  });

  it('a whitespace-only query shows nothing', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.type(searchBox(), '   ');
    expect(screen.queryByRole('list', { name: 'Search results' })).not.toBeInTheDocument();
    expect(screen.queryByText(/No events match/)).not.toBeInTheDocument();
    expect(screen.queryByText(/events? found/)).not.toBeInTheDocument();
  });

  it('shows the no-match message and a live "0 events found" status with no list', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.type(searchBox(), 'zzz');
    expect(screen.getByText('No events match “zzz”.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Search results' })).not.toBeInTheDocument();
    const status = screen.getByText('0 events found');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('matches summary, location and description, case-insensitively, sorted by start', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.type(searchBox(), 'i');
    // "Imported" (00:00) matches by summary, "Standup" (10:00) by its "Daily" notes
    expect(screen.getByText('2 events found')).toBeInTheDocument();
    const items = within(screen.getByRole('list', { name: 'Search results' })).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Imported');
    expect(items[1]).toHaveTextContent('Standup');
    await user.clear(searchBox());
    await user.type(searchBox(), 'ROOM 1');
    expect(screen.getByText('1 event found')).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Search results' })).getByRole('button', { name: /^Open event: Standup/ }),
    ).toBeInTheDocument();
  });

  it('a search row opens details; closing keeps the query and results', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.type(searchBox(), 'standup');
    await user.click(surfaceOf(TIMED_NAME, 'search'));
    expect(screen.getByRole('dialog', { name: 'Standup' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(searchBox()).toHaveValue('standup');
    expect(screen.getByRole('list', { name: 'Search results' })).toBeInTheDocument();
  });
});

describe('header Add', () => {
  it('prefills the selected day', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    await user.click(document.querySelector(`[data-day-key="${keyOf(otherDate)}"]`));
    await user.keyboard('{Escape}');
    expect(selectedDayButtons().map((b) => b.dataset.dayKey)).toEqual([keyOf(otherDate)]);
    await user.click(screen.getByRole('button', { name: 'Add event' }));
    const form = screen.getByRole('dialog', { name: 'Add event' });
    expect(within(form).getByLabelText('Date')).toHaveValue(keyOf(otherDate));
  });

  it('Cancel closes the modal (no day list underneath) and focuses the header Add', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const add = screen.getByRole('button', { name: 'Add event' });
    await user.click(add);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(add).toHaveFocus();
  });

  it('keeps its accessible name through the sr-only label', () => {
    renderPage(<CalendarPage />);
    const add = screen.getByRole('button', { name: 'Add event' });
    expect(add.querySelector('.sr-only')).toHaveTextContent('Add event');
  });
});

describe('focus returns to the opener', () => {
  const crowded = () => {
    const mk = (id, summary, hour) => ({ ...TIMED, id, summary, start: at(hour), end: at(hour, 30) });
    h.state = {
      events: [mk('a', 'Alpha', 8), mk('b', 'Bravo', 9), mk('c', 'Charlie', 10), mk('d', 'Delta', 11)],
      loading: false,
      error: null,
    };
  };

  it('the day button, on Escape and on the header Close', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const btn = screen.getByRole('button', { name: dayName(now) });
    await openDay(user);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(btn).toHaveFocus();
    await openDay(user);
    await user.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' })[0]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(btn).toHaveFocus();
  });

  it('the "+N more" button', async () => {
    crowded();
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const more = screen.getByRole('button', { name: `Show 2 more events on ${TODAY_LABEL}` });
    await user.click(more);
    expect(screen.getByRole('dialog', { name: TODAY_TITLE })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(more).toHaveFocus();
  });

  it('"+N more" after opening an event row, then closing the details', async () => {
    crowded();
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const more = screen.getByRole('button', { name: `Show 2 more events on ${TODAY_LABEL}` });
    await user.click(more);
    await user.click(inDialog(screen.getByRole('dialog'), /^Open event: Delta, /));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(more).toHaveFocus();
  });

  it('the day button after closing from details opened via a day row', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const btn = screen.getByRole('button', { name: dayName(now) });
    const day = await openDay(user);
    await user.click(inDialog(day, TIMED_NAME));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(btn).toHaveFocus();
  });

  it('the header Add after Escape', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const add = screen.getByRole('button', { name: 'Add event' });
    await user.click(add);
    await user.keyboard('{Escape}');
    expect(add).toHaveFocus();
  });

  it('a chip and a search row, each on Escape', async () => {
    const user = userEvent.setup();
    renderPage(<CalendarPage />);
    const chip = surfaceOf(TIMED_NAME, 'grid');
    await user.click(chip);
    await user.keyboard('{Escape}');
    expect(chip).toHaveFocus();
    await user.type(screen.getByLabelText('Search events'), 'standup');
    const row = surfaceOf(TIMED_NAME, 'search');
    await user.click(row);
    await user.keyboard('{Escape}');
    expect(row).toHaveFocus();
  });
});

describe('CalendarPage new-item intent', () => {
  it('opens the add dialog once for ?new=1 and removes the param', async () => {
    renderPage(<CalendarPage />, '/page?new=1');
    expect(await screen.findByRole('dialog', { name: 'Add event' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/page$/));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('opens no dialog without the param', () => {
    renderPage(<CalendarPage />, '/page');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
