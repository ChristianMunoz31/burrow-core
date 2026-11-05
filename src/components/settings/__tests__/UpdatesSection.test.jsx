import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import UpdatesSection, { STORE_UPDATES_COPY } from '../UpdatesSection';

vi.mock('../../../services/updateService', () => ({ updateService: { check: vi.fn(), install: vi.fn(), manual: vi.fn() } }));
vi.mock('../../../services/networkService', () => ({ networkService: { get: vi.fn(), set: vi.fn() } }));
vi.mock('../../../hooks/useAppInfo', () => ({ useAppInfo: vi.fn() }));
import { useAppInfo } from '../../../hooks/useAppInfo';
import { updateService } from '../../../services/updateService';
import { networkService } from '../../../services/networkService';

const wrap = (ui = <UpdatesSection />) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
};

const checkedAt = '2030-01-01T10:30:00Z';
const SHA = 'ab'.repeat(32);
const BASE = 'https://github.com/ChristianMunoz31/burrow-releases/releases';
const OPENS = ' (opens in your browser)';
const UNAVAILABLE = "Couldn't check for updates right now. Try again in a little while.";
const noEmDash = (el) => expect(el.textContent).not.toMatch(/[—–]/);
const info = (over = {}) => ({
  info: { version: '1.0.0', channel: 'stable', distribution: 'direct', desktop: true, ...over },
  isLoading: false,
});
const features = (enabled) => ({
  features: [
    { id: 'weather', enabled: false, label: 'Weather', description: 'x', hosts: ['api.open-meteo.com'] },
    { id: 'updates', enabled, label: 'Update check', description: 'x', hosts: ['github.com'] },
  ],
});
const available = (over = {}) => ({
  status: 'available',
  current: '1.0.0',
  latest: '1.1.0',
  url: `${BASE}/tag/v1.1.0`,
  publishedAt: '2030-01-01T00:00:00Z',
  channel: 'stable',
  source: 'release',
  checkedAt,
  notes: 'New:\n- A plain line',
  canInstall: false,
  canDownload: false,
  ...over,
});
const ready = (over = {}) => ({
  status: 'ready',
  version: '1.1.0',
  arch: 'x64',
  fileName: 'Burrow-Setup-x64.exe',
  installerUrl: `${BASE}/download/v1.1.0/Burrow-Setup-x64.exe`,
  sha256: SHA,
  sumsUrl: `${BASE}/download/v1.1.0/SHA256SUMS.txt`,
  backupId: 'b1',
  ...over,
});
const on = () => networkService.get.mockResolvedValue(features(true));
const off = () => networkService.get.mockResolvedValue(features(false));

beforeEach(() => {
  useAppInfo.mockReturnValue(info());
  off();
  networkService.set.mockImplementation(async (id, enabled) => features(enabled));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('UpdatesSection: header and editions', () => {
  it('shows the title, subtitle, version and the stable desktop edition', async () => {
    const { container } = wrap();
    expect(screen.getByRole('heading', { name: 'Updates' })).toBeInTheDocument();
    expect(screen.getByText('Get the newest Burrow. Nothing is downloaded until you choose to.')).toBeInTheDocument();
    expect(screen.getByText('You have Burrow 1.0.0.')).toBeInTheDocument();
    expect(screen.getByText('Desktop app, direct download')).toBeInTheDocument();
    await screen.findByRole('switch');
    noEmDash(container);
  });

  it('says Running in your browser outside the desktop app, and omits an unknown version', async () => {
    useAppInfo.mockReturnValue(info({ desktop: false, version: 'unknown' }));
    wrap();
    expect(screen.getByText('Running in your browser')).toBeInTheDocument();
    expect(screen.queryByText(/You have Burrow/)).toBeNull();
    await screen.findByRole('switch');
  });

  it('shows a skeleton while the app info loads, and no switch or check yet', () => {
    useAppInfo.mockReturnValue({ info: null, isLoading: true });
    wrap();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
    expect(updateService.check).not.toHaveBeenCalled();
  });
});

describe('UpdatesSection: Microsoft Store', () => {
  it('shows the Store copy and an https Store link, with no switch, no Check now and no request', async () => {
    useAppInfo.mockReturnValue(info({ distribution: 'store' }));
    on();
    const { container } = wrap();
    expect(screen.getByText(STORE_UPDATES_COPY)).toBeInTheDocument();
    expect(STORE_UPDATES_COPY).toBe('Updates come from the Microsoft Store. Burrow does not check for updates itself.');
    expect(screen.getByText('Desktop app from the Microsoft Store')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: `Open in Microsoft Store${OPENS}` });
    expect(link).toHaveAttribute('href', 'https://apps.microsoft.com/detail/9NT29CNPKBK4');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
    await waitFor(() => expect(updateService.check).not.toHaveBeenCalled());
    noEmDash(container);
  });
});

describe('UpdatesSection: Burrow Dev', () => {
  it('shows the instruction, with no switch, no Check now and no request', async () => {
    useAppInfo.mockReturnValue(info({ channel: 'dev', version: '1.1.0-dev.20301001.abc1234' }));
    on();
    const { container } = wrap();
    expect(container).toHaveTextContent('Burrow Dev updates from its source folder with npm run dev:update. It never updates itself.');
    expect(screen.getByText('npm run dev:update')).toHaveClass('font-mono');
    expect(screen.getByText('Burrow Dev, a test build')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
    await waitFor(() => expect(updateService.check).not.toHaveBeenCalled());
    noEmDash(container);
  });
});

describe('UpdatesSection: the switch and Check now', () => {
  it('reflects the updates feature and toggles it through the network settings', async () => {
    const user = userEvent.setup();
    wrap();
    const sw = await screen.findByRole('switch', { name: 'Check for updates when I open Settings' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).toHaveAccessibleDescription(/same switch as Update check in Settings > Network/);
    await user.click(sw);
    await waitFor(() => expect(networkService.set).toHaveBeenCalledWith('updates', true));
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
  });

  it('makes no update call on mount while the switch is off, and says what Check now does', async () => {
    const { container } = wrap();
    await screen.findByRole('switch');
    expect(screen.getByText('Checking turns on update checks. You can turn them off again here.')).toBeInTheDocument();
    await waitFor(() => expect(networkService.get).toHaveBeenCalled());
    expect(updateService.check).not.toHaveBeenCalled();
    expect(screen.queryByText(/Last checked/)).toBeNull();
    noEmDash(container);
  });

  it('checks once on mount while the switch is on, and hides the turn-on note', async () => {
    on();
    updateService.check.mockResolvedValue({ status: 'current', current: '1.0.0', latest: '1.0.0', checkedAt });
    wrap();
    expect(await screen.findByText('You have the latest version.')).toBeInTheDocument();
    expect(updateService.check).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Checking turns on update checks/)).toBeNull();
    expect(screen.getByText(/^Last checked /)).toBeInTheDocument();
  });

  it('Check now with the switch off turns it on first, then checks with refresh', async () => {
    updateService.check.mockResolvedValue({ status: 'current', current: '1.0.0', latest: '1.0.0', checkedAt });
    const user = userEvent.setup();
    wrap();
    await screen.findByRole('switch');
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('You have the latest version.')).toBeInTheDocument();
    expect(networkService.set).toHaveBeenCalledWith('updates', true);
    expect(updateService.check).toHaveBeenCalledWith({ refresh: true });
    expect(networkService.set.mock.invocationCallOrder[0]).toBeLessThan(updateService.check.mock.invocationCallOrder[0]);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('a failed save shows the error and makes no check', async () => {
    networkService.set.mockRejectedValue(new Error('down'));
    const user = userEvent.setup();
    wrap();
    await screen.findByRole('switch');
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save that change. Try again.");
    expect(updateService.check).not.toHaveBeenCalled();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: 'Check now' })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('shows Checking... on the button and in the live region while a check runs', async () => {
    on();
    let finish;
    updateService.check.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    wrap();
    await screen.findByRole('switch');
    const live = screen.getByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    await waitFor(() => expect(live).toHaveTextContent('Checking for updates...'));
    expect(screen.getByRole('button', { name: 'Checking...' })).toHaveAttribute('aria-disabled', 'true');
    finish({ status: 'current', current: '1.0.0', latest: '1.0.0', checkedAt });
    await waitFor(() => expect(live).toHaveTextContent('You have the latest version.'));
    expect(screen.getByRole('status')).toBe(live);
    expect(screen.getByRole('button', { name: 'Check now' })).toBeInTheDocument();
  });

  it.each([
    ['an unavailable result', () => updateService.check.mockResolvedValue({ status: 'unavailable', current: '1.0.0', reason: 'not_found', checkedAt })],
    ['a failed request', () => updateService.check.mockRejectedValue(new Error('403'))],
  ])('shows the unavailable line for %s and rechecks with refresh', async (_label, arrange) => {
    on();
    arrange();
    const user = userEvent.setup();
    const { container } = wrap();
    const line = UNAVAILABLE;
    expect(await screen.findByText(line)).toBeInTheDocument();
    noEmDash(container);
    updateService.check.mockResolvedValue({ status: 'current', current: '1.0.0', latest: '1.0.0', checkedAt });
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('You have the latest version.')).toBeInTheDocument();
    expect(updateService.check).toHaveBeenLastCalledWith({ refresh: true });
    expect(screen.queryByText(line)).toBeNull();
  });
});

describe('UpdatesSection: an available update', () => {
  const open = async (status, user) => {
    on();
    updateService.check.mockResolvedValue(status);
    const utils = wrap();
    await screen.findByRole('heading', { name: `Burrow ${status.latest} is available` });
    return { ...utils, user };
  };

  it('shows the release date, the notes as plain text and a safe GitHub link (web: nothing to install)', async () => {
    const notes = '<script>alert(1)</script>\n[click](https://evil.example)\n<img src=x onerror=alert(1)>';
    const { container } = await open(available({ notes }));
    expect(screen.getByText(/^Released /)).toBeInTheDocument();
    const region = screen.getByRole('region', { name: "What's new" });
    expect(region.textContent).toBe(notes);
    expect(region).toHaveClass('whitespace-pre-wrap');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    const link = screen.getByRole('link', { name: `See what's new on GitHub${OPENS}` });
    expect(link).toHaveAttribute('href', `${BASE}/tag/v1.1.0`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(screen.getByText('To update, download the new version from the releases page.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download and install' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Get the installer' })).toBeNull();
    noEmDash(container);
  });

  it('omits the notes block when there are none, and the date when it is unknown', async () => {
    await open(available({ notes: null, publishedAt: null }));
    expect(screen.queryByText("What's new")).toBeNull();
    expect(screen.queryByText(/^Released /)).toBeNull();
  });

  it.each([['javascript:alert(1)'], ['https://evil.example/x'], ['http://github.com/x'], [`${BASE.replace('/releases', '')}/other`], [undefined]])(
    'renders no link for an unsafe url %s',
    async (url) => {
      await open(available({ url }));
      expect(screen.queryByRole('link')).toBeNull();
    },
  );

  it('shows the install button and no license note, whatever the answer carries', async () => {
    const { container } = await open(available({ canInstall: true }));
    expect(screen.queryByRole('note')).toBeNull();
    expect(container.textContent).not.toMatch(/licen[sc]e|\bPro\b|trial/i);
    expect(screen.getByRole('button', { name: 'Download and install' })).toBeEnabled();
    expect(screen.getByRole('region', { name: "What's new" })).toBeInTheDocument();
    noEmDash(container);
  });

  it('canInstall shows the backup note and the install panel, which installs only on the click', async () => {
    updateService.install.mockResolvedValue({ status: 'handed_off', version: '1.1.0', backupId: 'b1' });
    const user = userEvent.setup();
    const { container } = await open(available({ canInstall: true, source: 'manifest' }));
    expect(
      screen.getByText(
        'Before it updates, Burrow saves a backup of your data. If the backup fails, nothing is downloaded. The new version also keeps a copy of your data file before it changes anything.',
      ),
    ).toBeInTheDocument();
    expect(updateService.install).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Download and install' }));
    expect(await screen.findByText('Installing, Burrow will restart')).toBeInTheDocument();
    expect(updateService.install).toHaveBeenCalledWith('1.1.0');
    expect(updateService.manual).not.toHaveBeenCalled();
    noEmDash(container);
  });

  it('canDownload shows Get the installer, and the click shows the link, the command and the hash', async () => {
    updateService.manual.mockResolvedValue(ready());
    const user = userEvent.setup();
    const { container } = await open(available({ canDownload: true }));
    expect(screen.getByText('Burrow saves a backup of your data first. Then your browser downloads the installer.')).toBeInTheDocument();
    expect(updateService.manual).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Get the installer' }));
    expect(await screen.findByRole('heading', { name: 'Backup saved. Download Burrow 1.1.0' })).toHaveFocus();
    expect(updateService.manual).toHaveBeenCalledWith('1.1.0');
    const download = screen.getByRole('link', { name: `Download Burrow-Setup-x64.exe${OPENS}` });
    expect(download).toHaveAttribute('href', `${BASE}/download/v1.1.0/Burrow-Setup-x64.exe`);
    expect(download).toHaveAttribute('target', '_blank');
    expect(download).toHaveAttribute('rel', 'noopener noreferrer');
    expect(container).toHaveTextContent('Get-FileHash "$env:USERPROFILE\\Downloads\\Burrow-Setup-x64.exe" -Algorithm SHA256');
    expect(screen.getByText(SHA)).toHaveClass('font-mono', 'break-all');
    expect(screen.getByText('The hash must be:')).toBeInTheDocument();
    expect(container).toHaveTextContent('check that the download is complete and unchanged before you run it');
    expect(screen.getByText('If your browser saved it under another name or folder, use that path.')).toBeInTheDocument();
    expect(container).toHaveTextContent(
      'If it is different, delete the file and download it again. If it matches, the download is complete and unchanged: close Burrow and run the installer. Your data stays on your computer.',
    );
    expect(container.textContent).not.toMatch(/safe/i);
    expect(screen.getByText(SHA).className).not.toContain('bg-black');
    expect(container).toHaveTextContent('Windows may show "Windows protected your PC". Click More info, then Run anyway.');
    expect(container).toHaveTextContent('The checksum comes from SHA256SUMS.txt (opens in your browser) on GitHub.');
    expect(screen.getByRole('link', { name: `SHA256SUMS.txt${OPENS}` })).toHaveAttribute('href', `${BASE}/download/v1.1.0/SHA256SUMS.txt`);
    expect(screen.queryByRole('button', { name: 'Get the installer' })).toBeNull();
    noEmDash(container);
  });

  it('shows Saving a backup... while the installer is prepared, and guards a double click', async () => {
    updateService.manual.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    await open(available({ canDownload: true }));
    const button = screen.getByRole('button', { name: 'Get the installer' });
    await user.dblClick(button);
    expect(await screen.findByRole('button', { name: 'Saving a backup...' })).toHaveAttribute('aria-disabled', 'true');
    expect(updateService.manual).toHaveBeenCalledTimes(1);
  });

  it('shows the server message when getting the installer is refused, and allows another try', async () => {
    updateService.manual.mockRejectedValueOnce(
      Object.assign(new Error('Burrow is busy with a backup. Try again in a minute.'), { userFacing: true, code: 'backup_busy' }),
    );
    const user = userEvent.setup();
    await open(available({ canDownload: true }));
    await user.click(screen.getByRole('button', { name: 'Get the installer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Burrow is busy with a backup. Try again in a minute.');
    updateService.manual.mockResolvedValueOnce(ready());
    await user.click(screen.getByRole('button', { name: 'Get the installer' }));
    expect(await screen.findByRole('link', { name: `Download Burrow-Setup-x64.exe${OPENS}` })).toBeInTheDocument();
  });

  it.each([
    ['an installer url on another host', { installerUrl: 'https://evil.example/Burrow-Setup-x64.exe' }],
    ['an installer url with a query', { installerUrl: `${BASE}/download/v1.1.0/Burrow-Setup-x64.exe?x=1` }],
    ['an installer url for another file', { installerUrl: `${BASE}/download/v1.1.0/other.exe` }],
    ['a javascript url', { installerUrl: 'javascript:alert(1)' }],
    ['an uppercase hash', { sha256: SHA.toUpperCase() }],
    ['a short hash', { sha256: 'ab'.repeat(31) }],
    ['a non-hex hash', { sha256: 'zz'.repeat(32) }],
    ['another version', { version: '1.0.9' }],
    ['an installer url for another version', { installerUrl: `${BASE}/download/v1.0.9/Burrow-Setup-x64.exe` }],
    ['a file name that does not match the url', { fileName: 'Burrow-Setup-arm64.exe' }],
    ['a strange file name', { fileName: '..\\evil.exe' }],
  ])('shows the generic error and no link for %s', async (_label, over) => {
    updateService.manual.mockResolvedValue(ready(over));
    const user = userEvent.setup();
    const { container } = await open(available({ canDownload: true }));
    await user.click(screen.getByRole('button', { name: 'Get the installer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Burrow couldn't start the update. Close and reopen Burrow, then try again.",
    );
    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull();
    expect(container.textContent).not.toContain('evil.example');
  });

  it('does not render the checksum file link when its url is not the pinned one', async () => {
    updateService.manual.mockResolvedValue(ready({ sumsUrl: 'https://evil.example/SHA256SUMS.txt' }));
    const user = userEvent.setup();
    const { container } = await open(available({ canDownload: true }));
    await user.click(screen.getByRole('button', { name: 'Get the installer' }));
    await screen.findByRole('link', { name: `Download Burrow-Setup-x64.exe${OPENS}` });
    expect(screen.queryByRole('link', { name: /SHA256SUMS/ })).toBeNull();
    expect(container).toHaveTextContent('The checksum comes from SHA256SUMS.txt on GitHub.');
  });

  it('a newer version replaces the install panel, starting fresh', async () => {
    updateService.install.mockRejectedValueOnce(
      Object.assign(new Error('Burrow is busy with a backup. Try again in a minute.'), { userFacing: true, code: 'backup_busy' }),
    );
    const user = userEvent.setup();
    const { container } = await open(available({ canInstall: true }));
    await user.click(screen.getByRole('button', { name: 'Download and install' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Burrow is busy with a backup');
    updateService.check.mockResolvedValue(available({ canInstall: true, latest: '1.2.0' }));
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByRole('heading', { name: 'Burrow 1.2.0 is available' })).toBeInTheDocument();
    expect(within(container).getByRole('button', { name: 'Download and install' })).toBeEnabled();
    expect(screen.queryByText(/Burrow is busy with a backup/)).toBeNull();
  });

  it('Check now during the installing state keeps it, holds the button and makes no new request', async () => {
    updateService.install.mockResolvedValue({ status: 'handed_off', version: '1.1.0', backupId: 'b1' });
    const user = userEvent.setup();
    await open(available({ canInstall: true }));
    await user.click(screen.getByRole('button', { name: 'Download and install' }));
    await screen.findByText('Installing, Burrow will restart');
    const check = screen.getByRole('button', { name: 'Check now' });
    await waitFor(() => expect(check).toHaveAttribute('aria-disabled', 'true'));
    await user.click(check);
    expect(updateService.check).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Installing, Burrow will restart')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download and install' })).toBeNull();
  });

  it('holds the switch while the update is handed off: no save, and the installing state stays', async () => {
    updateService.install.mockResolvedValue({ status: 'handed_off', version: '1.1.0', backupId: 'b1' });
    const user = userEvent.setup();
    await open(available({ canInstall: true }));
    await user.click(screen.getByRole('button', { name: 'Download and install' }));
    await screen.findByText('Installing, Burrow will restart');
    const sw = screen.getByRole('switch');
    await waitFor(() => expect(sw).toHaveAttribute('aria-disabled', 'true'));
    await user.click(sw);
    expect(networkService.set).not.toHaveBeenCalled();
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Installing, Burrow will restart')).toBeInTheDocument();
  });

  it("the card's Check again clears the section's failed-check line on success", async () => {
    updateService.install.mockRejectedValueOnce(
      Object.assign(new Error('Burrow could not check.'), { userFacing: true, code: 'update_check_unavailable' }),
    );
    const user = userEvent.setup();
    await open(available({ canInstall: true }));
    updateService.check.mockRejectedValueOnce(new Error('403'));
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText(UNAVAILABLE)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Download and install' }));
    await user.click(await screen.findByRole('button', { name: 'Check again' }));
    updateService.check.mockResolvedValue(available({ canInstall: true }));
    await waitFor(() => expect(screen.queryByText(UNAVAILABLE)).toBeNull());
  });

  it('keeps the card and the installer link mounted while a recheck runs, and Checking... stays on the button and live region', async () => {
    updateService.manual.mockResolvedValue(ready());
    const user = userEvent.setup();
    await open(available({ canDownload: true }));
    await user.click(screen.getByRole('button', { name: 'Get the installer' }));
    await screen.findByRole('link', { name: `Download Burrow-Setup-x64.exe${OPENS}` });
    let finish;
    updateService.check.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByRole('button', { name: 'Checking...' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Checking for updates...')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Burrow 1.1.0 is available' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: `Download Burrow-Setup-x64.exe${OPENS}` })).toBeInTheDocument();
    await act(async () => finish(available({ canDownload: true })));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check now' })).toBeInTheDocument());
    expect(screen.getByRole('link', { name: `Download Burrow-Setup-x64.exe${OPENS}` })).toBeInTheDocument();
  });

  it('hides the card once the status is no longer available', async () => {
    const user = userEvent.setup();
    await open(available());
    updateService.check.mockResolvedValue({ status: 'current', current: '1.1.0', latest: '1.1.0', checkedAt });
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('You have the latest version.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /is available/ })).toBeNull();
  });

  it('announces the available version through the live region, for screen readers only', async () => {
    await open(available());
    const line = screen.getByText('Burrow 1.1.0 is available.');
    expect(line).toHaveAttribute('role', 'status');
    expect(line).toHaveClass('sr-only');
  });

  it('the installer status line announces the saving state', async () => {
    updateService.manual.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    await open(available({ canDownload: true }));
    await user.click(screen.getByRole('button', { name: 'Get the installer' }));
    const saving = await screen.findByText('Saving a backup of your data...');
    expect(saving.closest('[role="status"]')).toHaveAttribute('aria-live', 'polite');
  });

  it('disables Check now while the installer is being prepared', async () => {
    updateService.manual.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    await open(available({ canDownload: true }));
    await user.click(screen.getByRole('button', { name: 'Get the installer' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check now' })).toHaveAttribute('aria-disabled', 'true'));
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(updateService.check).toHaveBeenCalledTimes(1);
  });
});

describe('UpdatesSection: loading failures and Check now details', () => {
  it('shows a line and Retry, with no switch and no Check now, when the app info cannot be read', async () => {
    const refetch = vi.fn();
    useAppInfo.mockReturnValue({ info: null, isLoading: false, refetch });
    on();
    const user = userEvent.setup();
    const { container } = wrap();
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load details about this copy of Burrow.");
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(updateService.check).not.toHaveBeenCalled());
    noEmDash(container);
  });

  it('shows a line and Retry when the network settings cannot be loaded, then recovers', async () => {
    networkService.get.mockRejectedValueOnce(new Error('down')).mockResolvedValue(features(false));
    const user = userEvent.setup();
    wrap();
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load update settings.");
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('switch')).toBeInTheDocument();
    expect(networkService.get).toHaveBeenCalledTimes(2);
  });

  it('Check now with the switch off makes exactly one check request, and it refreshes', async () => {
    updateService.check.mockResolvedValue({ status: 'current', current: '1.0.0', latest: '1.0.0', checkedAt });
    const user = userEvent.setup();
    wrap();
    await screen.findByRole('switch');
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('You have the latest version.')).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(updateService.check).toHaveBeenCalledTimes(1);
    expect(updateService.check).toHaveBeenCalledWith({ refresh: true });
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('turning the switch on by hand still makes the normal first check', async () => {
    updateService.check.mockResolvedValue({ status: 'current', current: '1.0.0', latest: '1.0.0', checkedAt });
    const user = userEvent.setup();
    wrap();
    await user.click(await screen.findByRole('switch'));
    expect(await screen.findByText('You have the latest version.')).toBeInTheDocument();
    expect(updateService.check).toHaveBeenCalledTimes(1);
    expect(updateService.check).toHaveBeenCalledWith();
  });

  it('a double click on Check now sends one request', async () => {
    on();
    updateService.check.mockResolvedValueOnce({ status: 'current', current: '1.0.0', latest: '1.0.0', checkedAt });
    const user = userEvent.setup();
    wrap();
    await screen.findByText('You have the latest version.');
    updateService.check.mockReturnValue(new Promise(() => {}));
    await user.dblClick(screen.getByRole('button', { name: 'Check now' }));
    expect(updateService.check).toHaveBeenCalledTimes(2);
  });

  it('ignores a second click on the switch while the first save runs', async () => {
    let finish;
    networkService.set.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const user = userEvent.setup();
    wrap();
    const sw = await screen.findByRole('switch');
    await user.click(sw);
    await user.click(sw);
    expect(networkService.set).toHaveBeenCalledTimes(1);
    await act(async () => finish(features(true)));
  });

  it('a failed recheck after an earlier result says so, and a later success clears the line', async () => {
    on();
    updateService.check.mockResolvedValueOnce({ status: 'current', current: '1.0.0', latest: '1.0.0', checkedAt });
    const user = userEvent.setup();
    wrap();
    expect(await screen.findByText('You have the latest version.')).toBeInTheDocument();
    updateService.check.mockRejectedValueOnce(new Error('403'));
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText(UNAVAILABLE)).toBeInTheDocument();
    expect(screen.queryByText('You have the latest version.')).toBeNull();
    updateService.check.mockResolvedValueOnce({ status: 'current', current: '1.0.0', latest: '1.0.0', checkedAt });
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('You have the latest version.')).toBeInTheDocument();
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
  });

  it('Check now with the switch off, a saved switch and a failed recheck, is not stuck: the next Check now works', async () => {
    updateService.check.mockRejectedValueOnce(new Error('403'));
    const user = userEvent.setup();
    wrap();
    await screen.findByRole('switch');
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText(UNAVAILABLE)).toBeInTheDocument();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    updateService.check.mockResolvedValue({ status: 'current', current: '1.0.0', latest: '1.0.0', checkedAt });
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('You have the latest version.')).toBeInTheDocument();
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
    expect(updateService.check).toHaveBeenCalledTimes(2);
    expect(updateService.check).toHaveBeenLastCalledWith({ refresh: true });
  });

  it('links the turn-on note to Check now with aria-describedby only while the switch is off', async () => {
    const user = userEvent.setup();
    wrap();
    await screen.findByRole('switch');
    expect(screen.getByRole('button', { name: 'Check now' })).toHaveAccessibleDescription(
      'Checking turns on update checks. You can turn them off again here.',
    );
    await user.click(screen.getByRole('switch'));
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByRole('button', { name: /Check now|Checking/ })).not.toHaveAttribute('aria-describedby');
  });
});
