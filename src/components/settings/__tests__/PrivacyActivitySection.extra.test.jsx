import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PrivacyActivitySection from '../PrivacyActivitySection';

const list = vi.hoisted(() => vi.fn());
vi.mock('../../../services/auditService', () => ({ auditService: { list } }));

const entry = (id, over = {}) => ({
  id: String(id),
  createdAt: `2026-01-0${id}T10:00:00.000Z`,
  kind: 'llm',
  feature: 'jarvis',
  page: null,
  provider: 'groq',
  model: 'gpt-oss',
  status: 'ok',
  context: `context for ${id}`,
  meta: {},
  ...over,
});

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PrivacyActivitySection />
    </QueryClientProvider>,
  );
}

beforeEach(() => list.mockReset());
afterEach(cleanup);

describe('PrivacyActivitySection: expand / collapse', () => {
  it('starts collapsed, expands, and collapses again', async () => {
    list.mockResolvedValue({ entries: [entry(1)], nextBefore: null, available: true });
    renderSection();
    const toggle = await screen.findByRole('button', { name: /^Javi, / });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('context for 1')).not.toBeInTheDocument();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAccessibleName(/^Javi, /);
    expect(screen.getByText('context for 1')).toBeInTheDocument();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('context for 1')).not.toBeInTheDocument();
  });

  it('wires aria-controls to the panel that holds the context', async () => {
    list.mockResolvedValue({ entries: [entry(1)], nextBefore: null, available: true });
    renderSection();
    const toggle = await screen.findByRole('button', { name: /, / });
    await userEvent.click(toggle);
    const panel = document.getElementById(toggle.getAttribute('aria-controls'));
    expect(panel).not.toBeNull();
    expect(panel).not.toHaveAttribute('hidden');
    expect(within(panel).getByText('context for 1')).toBeInTheDocument();
  });

  it('expands rows independently', async () => {
    list.mockResolvedValue({ entries: [entry(1), entry(2)], nextBefore: null, available: true });
    renderSection();
    const toggles = await screen.findAllByRole('button', { name: /^Javi, / });
    await userEvent.click(toggles[1]);
    expect(screen.getByText('context for 2')).toBeInTheDocument();
    expect(screen.queryByText('context for 1')).not.toBeInTheDocument();
  });

  it('renders stored context as plain text, never as HTML', async () => {
    list.mockResolvedValue({
      entries: [entry(1, { context: '<img src=x onerror=alert(1)> [redacted]' })],
      nextBefore: null,
      available: true,
    });
    const { container } = renderSection();
    await userEvent.click(await screen.findByRole('button', { name: /, / }));
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)> [redacted]')).toBeInTheDocument();
  });

  it('shows the redacted marker verbatim', async () => {
    list.mockResolvedValue({
      entries: [entry(1, { context: '{"apiKey":"[redacted]"}' })],
      nextBefore: null,
      available: true,
    });
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: /, / }));
    expect(screen.getByText('{"apiKey":"[redacted]"}')).toBeInTheDocument();
  });
});

describe('PrivacyActivitySection: row content', () => {
  it('shows kind and status pills and falls back to the raw feature id', async () => {
    list.mockResolvedValue({
      entries: [entry(1, { feature: 'brand_new_feature', status: 'error', kind: 'export', provider: null, model: null })],
      nextBefore: null,
      available: true,
    });
    renderSection();
    expect(await screen.findByText('brand_new_feature')).toBeInTheDocument();
    expect(screen.getByText('export')).toBeInTheDocument();
    expect(screen.getByText('error')).toBeInTheDocument();
    expect(screen.queryByText('groq / gpt-oss')).not.toBeInTheDocument();
  });

  it('renders provider and model together and an ok status', async () => {
    list.mockResolvedValue({ entries: [entry(1)], nextBefore: null, available: true });
    renderSection();
    expect(await screen.findByText('groq / gpt-oss')).toBeInTheDocument();
    expect(screen.getByText('ok')).toBeInTheDocument();
  });

  it('exposes the entries as a labelled list with a machine-readable time', async () => {
    list.mockResolvedValue({ entries: [entry(1), entry(2)], nextBefore: null, available: true });
    const { container } = renderSection();
    const ul = await screen.findByRole('list', { name: 'Recent activity' });
    expect(within(ul).getAllByRole('listitem')).toHaveLength(2);
    expect(container.querySelector('time')).toHaveAttribute('datetime', '2026-01-01T10:00:00.000Z');
  });

  it('tolerates an unparseable timestamp without crashing', async () => {
    list.mockResolvedValue({ entries: [entry(1, { createdAt: 'not-a-date' })], nextBefore: null, available: true });
    renderSection();
    expect(await screen.findByText('Javi')).toBeInTheDocument();
  });

  it('always shows the privacy intro', async () => {
    list.mockResolvedValue({ entries: [], nextBefore: null, available: true });
    renderSection();
    expect(await screen.findByText(/last 90 days \(max 5,000\)/)).toBeInTheDocument();
    expect(screen.getByText(/Known key and token formats are removed before storage\./)).toBeInTheDocument();
  });
});

describe('PrivacyActivitySection: load more and refresh', () => {
  it('requests the first page without a cursor and appends later pages in order', async () => {
    list
      .mockResolvedValueOnce({ entries: [entry(1)], nextBefore: 'cursor-1', available: true })
      .mockResolvedValueOnce({ entries: [entry(2, { feature: 'briefing' })], nextBefore: 'cursor-2', available: true })
      .mockResolvedValueOnce({ entries: [entry(3, { feature: 'javi_advice' })], nextBefore: null, available: true });
    renderSection();
    await screen.findByText('Javi');
    expect(list.mock.calls[0][0]).toMatchObject({ before: null });
    expect(list.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('Daily briefing');
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ before: 'cursor-1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('Javi advice');
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ before: 'cursor-2' }));

    const rows = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(rows[0]).toContain('Javi');
    expect(rows[1]).toContain('Daily briefing');
    expect(rows[2]).toContain('Javi advice');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('keeps an already-expanded row open after loading more', async () => {
    list
      .mockResolvedValueOnce({ entries: [entry(1)], nextBefore: 'c', available: true })
      .mockResolvedValueOnce({ entries: [entry(2)], nextBefore: null, available: true });
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: /, / }));
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await vi.waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    expect(screen.getByText('context for 1')).toBeInTheDocument();
  });

  it('does not show Load more on a last page', async () => {
    list.mockResolvedValue({ entries: [entry(1)], nextBefore: null, available: true });
    renderSection();
    await screen.findByText('Javi');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('Refresh refetches the list', async () => {
    list.mockResolvedValue({ entries: [entry(1)], nextBefore: null, available: true });
    renderSection();
    await screen.findByText('Javi');
    expect(list).toHaveBeenCalledTimes(1);
    list.mockResolvedValue({
      entries: [entry(1), entry(2, { feature: 'briefing' })],
      nextBefore: null,
      available: true,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Daily briefing')).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('keeps the rows already shown when Load more fails, with an inline alert and a Retry that refetches the next page', async () => {
    list
      .mockResolvedValueOnce({ entries: [entry(1)], nextBefore: 'c', available: true })
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ entries: [entry(2, { feature: 'briefing' })], nextBefore: null, available: true });
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load activity.");
    expect(screen.getByText('Javi')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Recent activity' })).toBeInTheDocument();

    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Daily briefing')).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ before: 'c' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the blocking error with a Retry when the first load fails and there are no entries', async () => {
    list
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce({ entries: [entry(1)], nextBefore: null, available: true });
    renderSection();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load activity.");
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Javi')).toBeInTheDocument();
  });

  it('Refresh resets to page 1 instead of replaying every loaded page', async () => {
    list
      .mockResolvedValueOnce({ entries: [entry(1)], nextBefore: 'c1', available: true })
      .mockResolvedValueOnce({ entries: [entry(2, { feature: 'briefing' })], nextBefore: null, available: true })
      .mockResolvedValueOnce({ entries: [entry(3, { feature: 'javi_advice' })], nextBefore: null, available: true });
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await screen.findByText('Daily briefing');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Javi advice')).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(3);
    expect(list.mock.calls[2][0].before).toBeNull();
    expect(screen.queryByText('Javi')).not.toBeInTheDocument();
    expect(screen.queryByText('Daily briefing')).not.toBeInTheDocument();
  });

  it('announces completed loads and refreshes in a persistent status region', async () => {
    list
      .mockResolvedValueOnce({ entries: [entry(1)], nextBefore: 'c1', available: true })
      .mockResolvedValueOnce({
        entries: [entry(2, { feature: 'briefing' }), entry(3, { feature: 'javi_advice' })],
        nextBefore: null,
        available: true,
      })
      .mockResolvedValueOnce({ entries: [entry(1)], nextBefore: null, available: true });
    renderSection();
    await screen.findByText('Javi');
    const live = () => screen.getAllByRole('status').find((el) => el.classList.contains('sr-only'));
    expect(live()).toHaveTextContent('');
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await vi.waitFor(() => expect(live()).toHaveTextContent('Loaded 2 more entries'));
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await vi.waitFor(() => expect(live()).toHaveTextContent('Activity refreshed'));
  });

  it('does not refetch on window focus', async () => {
    list.mockResolvedValue({ entries: [entry(1)], nextBefore: null, available: true });
    renderSection();
    await screen.findByText('Javi');
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 20));
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe('PrivacyActivitySection: accessibility and display', () => {
  it('gives each expand button a static distinct name carrying the time, with aria-expanded for state', async () => {
    list.mockResolvedValue({ entries: [entry(1), entry(2)], nextBefore: null, available: true });
    renderSection();
    const toggles = await screen.findAllByRole('button', { name: /^Javi, / });
    expect(toggles).toHaveLength(2);
    expect(toggles[0].getAttribute('aria-label')).not.toBe(toggles[1].getAttribute('aria-label'));
    const before = toggles[0].getAttribute('aria-label');
    await userEvent.click(toggles[0]);
    expect(toggles[0].getAttribute('aria-label')).toBe(before);
    expect(toggles[0]).toHaveAttribute('aria-expanded', 'true');
    expect(toggles[0].className).toMatch(/min-h-9/);
    expect(toggles[0].className).toMatch(/min-w-9/);
    expect(toggles[0].className).toMatch(/inline-flex/);
  });

  it('renders the context as a scrollable focusable labelled region', async () => {
    list.mockResolvedValue({ entries: [entry(1)], nextBefore: null, available: true });
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: /^Javi, / }));
    const region = screen.getByRole('region', { name: /^Context for Javi, / });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region.className).toMatch(/max-h-64/);
    expect(region.className).toMatch(/overflow-auto/);
  });

  it('shows one loading status with an accessible name while the first page loads', async () => {
    let resolve;
    list.mockReturnValue(new Promise((r) => (resolve = r)));
    renderSection();
    expect(screen.getByRole('status', { name: 'Loading activity' })).toBeInTheDocument();
    resolve({ entries: [], nextBefore: null, available: true });
    expect(await screen.findByText('No activity recorded yet.')).toBeInTheDocument();
  });

  it('adds the year only for dates outside the current year and titles the full date', async () => {
    const thisYear = new Date().getFullYear();
    list.mockResolvedValue({
      entries: [
        entry(1, { createdAt: new Date(thisYear, 5, 15, 10, 0).toISOString() }),
        entry(2, { createdAt: '2019-03-04T10:00:00.000Z', feature: 'briefing' }),
      ],
      nextBefore: null,
      available: true,
    });
    const { container } = renderSection();
    await screen.findByText('Daily briefing');
    const [current, old] = container.querySelectorAll('time');
    expect(current.textContent).not.toMatch(/\b20\d\d\b/);
    expect(old.textContent).toMatch(/2019/);
    expect(old).toHaveAttribute('title', new Date('2019-03-04T10:00:00.000Z').toLocaleString());
  });

  it('skips the <time> element for an invalid date', async () => {
    list.mockResolvedValue({ entries: [entry(1, { createdAt: 'not-a-date' })], nextBefore: null, available: true });
    const { container } = renderSection();
    await screen.findByText('Javi');
    expect(container.querySelector('time')).toBeNull();
    expect(screen.getByRole('button', { name: 'Javi, unknown time' })).toBeInTheDocument();
  });

  it('shows the unavailable state in an amber status box', async () => {
    list.mockResolvedValue({ entries: [], nextBefore: null, available: false, reason: 'not_configured' });
    renderSection();
    const text = await screen.findByText("Burrow can't open your data file. Try restarting Burrow.");
    const box = text.closest('[role="status"]');
    expect(box).not.toBeNull();
    expect(box.className).toMatch(/bg-accent-amber/);
  });

  it('merges the subtitle and intro into one description', async () => {
    list.mockResolvedValue({ entries: [], nextBefore: null, available: true });
    renderSection();
    await screen.findByText('No activity recorded yet.');
    expect(screen.getAllByText(/last 90 days/)).toHaveLength(1);
    expect(screen.queryByText(/What AI requests, exports and sign-ins were recorded/)).not.toBeInTheDocument();
  });
});

describe('PrivacyActivitySection: unavailable states', () => {
  it('shows the unavailable hint and no list or load-more when the database is unavailable', async () => {
    list.mockResolvedValue({ entries: [], nextBefore: null, available: false, reason: 'not_configured' });
    renderSection();
    expect(await screen.findByText("Burrow can't open your data file. Try restarting Burrow.")).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(screen.queryByText('No activity recorded yet.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('falls back to a generic message for an unknown reason', async () => {
    list.mockResolvedValue({ entries: [], nextBefore: null, available: false, reason: 'weird' });
    renderSection();
    expect(await screen.findByText("Activity log isn't available right now.")).toBeInTheDocument();
  });

  it('lets the user Refresh from the unavailable state and picks up the data', async () => {
    list.mockResolvedValueOnce({ entries: [], nextBefore: null, available: false, reason: 'not_configured' });
    renderSection();
    await screen.findByText("Burrow can't open your data file. Try restarting Burrow.");
    list.mockResolvedValueOnce({ entries: [entry(1)], nextBefore: null, available: true });
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Javi')).toBeInTheDocument();
    expect(screen.queryByText(/isn't set up yet/)).not.toBeInTheDocument();
  });

  it('shows Loading before the first response resolves', async () => {
    let resolve;
    list.mockReturnValue(new Promise((r) => (resolve = r)));
    renderSection();
    expect(screen.getByRole('status', { name: 'Loading activity' })).toBeInTheDocument();
    resolve({ entries: [], nextBefore: null, available: true });
    expect(await screen.findByText('No activity recorded yet.')).toBeInTheDocument();
  });
});
