import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import NetworkActivityPanel from '../NetworkActivityPanel';
import VerifyYourself from '../VerifyYourself';
import PrivacyActivitySection from '../PrivacyActivitySection';

const list = vi.hoisted(() => vi.fn());
const auditList = vi.hoisted(() => vi.fn());
const appInfo = vi.hoisted(() => vi.fn());
vi.mock('../../../services/appInfoService', () => ({ getAppInfo: appInfo }));
vi.mock('../../../services/networkActivityService', () => ({ networkActivityService: { list } }));
vi.mock('../../../services/auditService', () => ({ auditService: { list: auditList } }));

const entry = (id, over = {}) => ({
  id,
  feature: 'weather',
  label: 'Weather',
  host: 'api.open-meteo.com',
  at: `2026-01-0${id}T10:00:00.000Z`,
  result: 'ok',
  ...over,
});

const wrap = (ui) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
};

beforeEach(() => {
  list.mockReset();
  auditList.mockReset();
  appInfo.mockReset();
  appInfo.mockResolvedValue({ version: '1.0.0', channel: 'stable', desktop: true });
  auditList.mockResolvedValue({ entries: [], nextBefore: null, available: true });
});
afterEach(cleanup);

describe('NetworkActivityPanel', () => {
  it('lists the update hosts and shows the app-made download as started', async () => {
    list.mockResolvedValue({
      entries: [
        entry('2', { feature: 'updates', label: 'Update download (Burrow app)', host: 'github.com', result: 'started' }),
        entry('1', { feature: 'updates', label: 'Updates', host: 'github.com', result: 'ok' }),
      ],
      nextBefore: null,
    });
    const { container } = wrap(<NetworkActivityPanel />);
    expect(await screen.findByText('Update download (Burrow app)')).toBeInTheDocument();
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]).getByText('started')).toHaveClass('text-slate-slate300');
    expect(within(rows[0]).getByText('github.com')).toBeInTheDocument();
    const text = container.textContent;
    expect(text).toContain('release-assets.githubusercontent.com');
    expect(text).toContain('objects.githubusercontent.com');
    expect(text).toContain('Update download (Burrow app)');
    expect(text).not.toMatch(/[—–]/);
  });

  it('renders feature, host, time and result for each connection', async () => {
    list.mockResolvedValue({
      entries: [
        entry('1'),
        entry('2', { feature: 'updates', label: 'Updates', host: 'api.github.com', result: 'failed' }),
        entry('3', { feature: 'model_pull', label: 'Model download (through Ollama)', host: 'Ollama on this computer', result: 'blocked' }),
      ],
      nextBefore: null,
    });
    wrap(<NetworkActivityPanel />);
    expect(await screen.findByText('Weather')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Feature', 'Website', 'Time', 'Result']);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText('api.open-meteo.com')).toBeInTheDocument();
    expect(within(rows[0]).getByText('ok')).toBeInTheDocument();
    expect(within(rows[1]).getByText('failed')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Model download (through Ollama)')).toBeInTheDocument();
    expect(within(rows[2]).getByText('blocked')).toBeInTheDocument();
    expect(rows[0].querySelector('time')).toHaveAttribute('dateTime', '2026-01-01T10:00:00.000Z');
  });

  it('shows the empty state', async () => {
    list.mockResolvedValue({ entries: [], nextBefore: null });
    wrap(<NetworkActivityPanel />);
    expect(await screen.findByText("Burrow hasn't connected to the internet.")).toBeInTheDocument();
    expect(screen.getByText('It only connects for features you turn on, like weather or update checks.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows the error state with what to do next', async () => {
    list.mockRejectedValue(new Error('boom'));
    wrap(<NetworkActivityPanel />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load network activity.");
    list.mockResolvedValueOnce({ entries: [entry('1')], nextBefore: null });
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Weather')).toBeInTheDocument();
  });

  it('shows one loading status with the panel label', () => {
    list.mockReturnValue(new Promise(() => {}));
    wrap(<NetworkActivityPanel />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status', { name: 'Loading network activity' })).toBeInTheDocument();
  });

  it('loads more with the cursor', async () => {
    list
      .mockResolvedValueOnce({ entries: [entry('2')], nextBefore: 'cursor-1' })
      .mockResolvedValueOnce({ entries: [entry('1', { host: 'api.github.com', label: 'Updates' })], nextBefore: null });
    wrap(<NetworkActivityPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Updates')).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ before: 'cursor-1' }));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('fetches on its own past an empty page that has older rows, and never claims no connections', async () => {
    list
      .mockResolvedValueOnce({ entries: [], nextBefore: 'c1' })
      .mockResolvedValueOnce({ entries: [], nextBefore: 'c2' })
      .mockResolvedValueOnce({ entries: [entry('1')], nextBefore: null });
    wrap(<NetworkActivityPanel />);
    expect(await screen.findByText('Weather')).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(3);
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ before: 'c1' }));
    expect(list).toHaveBeenNthCalledWith(3, expect.objectContaining({ before: 'c2' }));
    expect(screen.queryByText("Burrow hasn't connected to the internet.")).toBeNull();
  });

  it('stops auto-fetching after five pages and offers Load more instead of the empty claim', async () => {
    let n = 0;
    list.mockImplementation(async () => {
      n += 1;
      return { entries: [], nextBefore: `c${n}` };
    });
    wrap(<NetworkActivityPanel />);
    expect(await screen.findByText('No connections in recent activity.')).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(5);
    expect(screen.queryByText("Burrow hasn't connected to the internet.")).toBeNull();
    list.mockResolvedValueOnce({ entries: [entry('1')], nextBefore: null });
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Weather')).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(6);
  });

  it('keeps loaded pages and offers Retry when Load more fails', async () => {
    list
      .mockResolvedValueOnce({ entries: [entry('2')], nextBefore: 'c1' })
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ entries: [entry('1', { label: 'Updates', host: 'api.github.com' })], nextBefore: null });
    wrap(<NetworkActivityPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load network activity.");
    expect(screen.getByText('Weather')).toBeInTheDocument();
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Updates')).toBeInTheDocument();
    expect(screen.getByText('Weather')).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ before: 'c1' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('marks Load more busy while the next page loads', async () => {
    let release;
    list.mockResolvedValueOnce({ entries: [entry('2')], nextBefore: 'c1' }).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    wrap(<NetworkActivityPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    const busy = await screen.findByRole('button', { name: 'Loading…' });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    release({ entries: [], nextBefore: null });
    await screen.findByText('Weather');
  });

  it('describes the list without "every" or "each time" and says up to 90 days', async () => {
    list.mockResolvedValue({ entries: [entry('1')], nextBefore: null });
    const { container } = wrap(<NetworkActivityPanel />);
    await screen.findByText('Weather');
    expect(container.textContent).toContain(
      'Connections Burrow made for features you turned on, newest first, for up to 90 days. Only the feature, the website, the time and the result are kept. What you typed or saved is never shown here.',
    );
    expect(container.textContent).not.toMatch(/\bevery\b|each time/i);
  });

  it('only ever renders host-level text: no URL, query string or payload', async () => {
    // Even if a broken server sent extra fields, the table has no place to show them.
    list.mockResolvedValue({
      entries: [
        entry('1', {
          url: 'https://api.open-meteo.com/v1/forecast?latitude=12.3&longitude=45.6',
          payload: '{"prompt":"my private note"}',
          key: 'sk-secret-key',
          body: 'request body',
        }),
      ],
      nextBefore: null,
    });
    const { container } = wrap(<NetworkActivityPanel />);
    await screen.findByText('Weather');
    const text = container.textContent;
    for (const leaked of ['latitude', 'longitude', 'private note', 'sk-secret-key', 'request body', 'https://', '?']) {
      expect(text).not.toContain(leaked);
    }
  });
});

describe('VerifyYourself', () => {
  it('renders the four steps and the checksum command in the desktop app', async () => {
    wrap(<VerifyYourself />);
    expect(await screen.findByText('Watch the connections')).toBeInTheDocument();
    expect(screen.getByText('Turn off Wi-Fi')).toBeInTheDocument();
    expect(screen.getByText('Check your download')).toBeInTheDocument();
    expect(screen.getByText('See what Burrow connected to')).toBeInTheDocument();
    expect(screen.getByText('Get-FileHash .\\Burrow-Setup-x64.exe -Algorithm SHA256')).toBeInTheDocument();
    expect(screen.getByText('burrow-server.exe')).toBeInTheDocument();
    expect(screen.getByText('msedgewebview2.exe')).toBeInTheDocument();
    expect(screen.getByText(/connections from that name are not a reliable sign of what Burrow does/)).toBeInTheDocument();
    expect(screen.queryByText(/look for/)).toBeNull();
    // Burrow.exe is named only for the click-to-install download, never as the process to look for.
    expect(screen.getAllByText('Burrow.exe')).toHaveLength(1);
    expect(screen.getAllByText('127.0.0.1').length).toBeGreaterThan(0);
    expect(screen.getByText(/Open Network activity in this section to see the connections Burrow made/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'the latest release page' });
    expect(link).toHaveAttribute('href', 'https://github.com/ChristianMunoz31/burrow-releases/releases/latest');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('says the Burrow app, not the server, contacts GitHub after a Download and install click, and that updates are signature checked', async () => {
    const { container } = wrap(<VerifyYourself />);
    await screen.findByText('Watch the connections');
    const text = container.textContent.replace(/\s+/g, ' ');
    expect(text).toContain(
      "If you click Download and install for an update, the Burrow app (Burrow.exe, not the local server) connects to github.com and GitHub's download servers (release-assets.githubusercontent.com, objects.githubusercontent.com) to get the installer, and only after that click.",
    );
    expect(text).toContain(
      "Updates installed from inside Burrow are checked against Burrow's signing key before they run; a file that fails the check is never installed.",
    );
  });

  it('names the Dev process on the dev channel', async () => {
    appInfo.mockResolvedValue({ version: '0.2.0-dev', channel: 'dev', desktop: true });
    wrap(<VerifyYourself />);
    expect(await screen.findByText('burrow-dev-server.exe')).toBeInTheDocument();
    expect(screen.queryByText('burrow-server.exe')).toBeNull();
  });

  it('hides the process and download steps outside the desktop app and says so', async () => {
    appInfo.mockResolvedValue({ version: '1.0.0', channel: 'stable', desktop: false });
    wrap(<VerifyYourself />);
    expect(await screen.findByText('These steps are for the desktop app.')).toBeInTheDocument();
    expect(screen.queryByText('Watch the connections')).toBeNull();
    expect(screen.queryByText('Check your download')).toBeNull();
    expect(screen.queryByText('msedgewebview2.exe')).toBeNull();
    expect(screen.getByText('Turn off Wi-Fi')).toBeInTheDocument();
    expect(screen.getByText('See what Burrow connected to')).toBeInTheDocument();
  });

  it('has no em dashes, no self-host claim, and states the core source truthfully', async () => {
    const { container } = wrap(<VerifyYourself />);
    await screen.findByText('Watch the connections');
    const text = container.textContent;
    expect(text).not.toMatch(/[—–]/);
    expect(text).not.toMatch(/self.?host/i);
    expect(text).toMatch(/AGPL-3\.0-only/);
    expect(text).toMatch(/Pro features are a private module/);
    const link = screen.getByRole('link', { name: 'github.com/ChristianMunoz31/burrow-core' });
    expect(link).toHaveAttribute('href', 'https://github.com/ChristianMunoz31/burrow-core');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(text).not.toMatch(/Pro(?:'s)?s+(?:source|features?)s+(?:is|are)s+(?:public|open source)/i);
  });

  it('makes no network calls of its own (the app info read is mocked)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    wrap(<VerifyYourself />);
    await screen.findByText('Watch the connections');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('Privacy & activity section entry points', () => {
  it('loads each panel only when opened', async () => {
    list.mockResolvedValue({ entries: [], nextBefore: null });
    wrap(<PrivacyActivitySection />);
    expect(list).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Network activity' }));
    expect(await screen.findByText("Burrow hasn't connected to the internet.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Verify it yourself' }));
    expect(await screen.findByText('Turn off Wi-Fi')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Network activity' })).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('Privacy & activity list', () => {
  it('labels network rows "network", keeps other kinds, and mentions internet connections', async () => {
    auditList.mockResolvedValue({
      entries: [
        { id: 'a', createdAt: '2026-01-02T10:00:00.000Z', kind: 'export', feature: 'network_call', status: 'ok', meta: {}, context: null },
        { id: 'b', createdAt: '2026-01-01T10:00:00.000Z', kind: 'export', feature: 'data_export', status: 'ok', meta: {}, context: null },
      ],
      nextBefore: null,
      available: true,
    });
    wrap(<PrivacyActivitySection />);
    const list = await screen.findByRole('list', { name: 'Recent activity' });
    const items = within(list).getAllByRole('listitem');
    expect(within(items[0]).getByText('network')).toBeInTheDocument();
    expect(within(items[0]).queryByText('export')).toBeNull();
    expect(within(items[1]).getByText('export')).toBeInTheDocument();
    expect(screen.getByText(/internet connections from the last 90 days/)).toBeInTheDocument();
  });
});
