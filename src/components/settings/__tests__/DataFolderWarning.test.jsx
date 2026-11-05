import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import BuildIdentityLine from '../BuildIdentityLine';
import DataFolderWarning from '../DataFolderWarning';
import { formatBuildIdentity } from '../../../utils/buildIdentity';

const synced = vi.hoisted(() => ({ store: {} }));
// The saved settings, in memory: the real hook talks to the server.
vi.mock('../../../hooks/useSyncedSetting', async () => {
  const React = await import('react');
  return {
    useSyncedSetting: (key, fallback) => {
      const [, bump] = React.useState(0);
      const value = synced.store[key] ?? fallback;
      const set = (next) => {
        synced.store[key] = next;
        bump((n) => n + 1);
      };
      return [value, set, { isFetched: true, isLoading: false }];
    },
  };
});

const appInfo = vi.hoisted(() => ({ info: null }));
vi.mock('../../../hooks/useAppInfo', () => ({ useAppInfo: () => ({ info: appInfo.info }) }));

beforeEach(() => {
  synced.store = {};
});
afterEach(() => {
  cleanup();
  appInfo.info = null;
});

describe('DataFolderWarning', () => {
  const WARN = { code: 'onedrive', message: 'Your Burrow data folder is inside OneDrive. Syncing a live database can damage it.' };

  it('shows the warning once, without blocking, and remembers the dismissal per folder', async () => {
    const user = userEvent.setup();
    appInfo.info = { dataDir: 'C:\\Users\\example\\OneDrive\\Burrow', dataFolderWarning: WARN };
    const first = render(<DataFolderWarning />);
    expect(screen.getByText(/Your Burrow data folder is inside OneDrive. Syncing a live database can damage it./)).toBeInTheDocument();
    expect(screen.getByText(/Move the folder out of OneDrive/)).toBeInTheDocument();
    expect(screen.getByText(/It is in C:\\Users\\example\\OneDrive\\Burrow\./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();
    // Next visit: still dismissed for that folder.
    const again = render(<DataFolderWarning />);
    expect(again.container).toBeEmptyDOMElement();
    again.unmount();
    // Another folder warns again.
    appInfo.info = { dataDir: 'C:\\Users\\example\\OneDrive\\Other', dataFolderWarning: WARN };
    render(<DataFolderWarning />);
    expect(screen.getByText(/inside OneDrive/)).toBeInTheDocument();
  });

  it('shows nothing when there is no warning', () => {
    appInfo.info = { dataDir: 'C:\\Users\\example\\Burrow Data', dataFolderWarning: null };
    const { container } = render(<DataFolderWarning />);
    expect(container).toBeEmptyDOMElement();
  });

  it('a linked folder gets its own text without the OneDrive advice', () => {
    appInfo.info = { dataDir: 'D:\\Burrow', dataFolderWarning: { code: 'linked', message: 'Your Burrow data folder is a linked folder, so another program may sync or move it. Syncing a live database can damage it.' } };
    render(<DataFolderWarning />);
    expect(screen.getByText(/linked folder/)).toBeInTheDocument();
    expect(screen.queryByText(/Move the folder out of OneDrive/)).not.toBeInTheDocument();
  });
});

describe('build identity shows the data location and the data folder', () => {
  it('formatBuildIdentity adds the user folder note only for the userprofile data location', () => {
    const base = { version: '1.0.0', channel: 'stable', distribution: 'store', commit: 'abc1234', buildDate: '2026-10-05T12:00:00Z' };
    expect(formatBuildIdentity({ ...base, dataLocation: 'userprofile' })).toBe(
      ['Version 1.0.0', 'stable', 'Microsoft Store', 'data in your user folder', 'abc1234', 'built 2026-10-05'].join(' · '),
    );
    expect(formatBuildIdentity({ ...base, dataLocation: 'appdata' })).toBe(['Version 1.0.0', 'stable', 'Microsoft Store', 'abc1234', 'built 2026-10-05'].join(' · '));
    expect(formatBuildIdentity(base)).toBe(formatBuildIdentity({ ...base, dataLocation: 'appdata' }));
  });

  it('BuildIdentityLine prints the resolved data folder on its own line', () => {
    appInfo.info = { version: '1.0.0', channel: 'stable', distribution: 'store', dataLocation: 'userprofile', dataDir: 'C:\\Users\\example\\Burrow Data' };
    render(<BuildIdentityLine />);
    expect(screen.getByTestId('build-identity')).toHaveTextContent('data in your user folder');
    expect(screen.getByTestId('data-folder-identity')).toHaveTextContent('Data folder: C:\\Users\\example\\Burrow Data');
  });
});
