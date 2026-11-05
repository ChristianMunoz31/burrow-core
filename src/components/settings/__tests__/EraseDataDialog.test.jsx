import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import EraseDataDialog from '../EraseDataDialog';
import { downloadExport } from '../../../services/exportService';
import { eraseAllData, requestEraseToken } from '../../../services/eraseService';
import { lsKey } from '../../../utils/storageKeys';
import { useAuth } from '../../../auth/useAuth';

configure({ asyncUtilTimeout: 5000 });

vi.mock('../../../services/exportService', () => ({ downloadExport: vi.fn() }));
vi.mock('../../../services/eraseService', async (importOriginal) => ({
  ...(await importOriginal()),
  requestEraseToken: vi.fn(),
  eraseAllData: vi.fn(),
}));
vi.mock('../../../hooks/useBackups', () => ({ useBackups: () => ({ data: { location: 'C:\\Data\\Burrow\\backups' } }) }));
vi.mock('../../../auth/useAuth', () => ({ useAuth: vi.fn() }));

const FAILED = 'Nothing was erased. Close and reopen Burrow, then try again.';
const INCOMPLETE =
  'Your data was erased, but the final cleanup did not finish. Close and reopen Burrow, then open Settings, Data & storage and choose Erase all my data again to finish.';
const original = window.location;
let replace;
let reload;

function setup() {
  const onClose = vi.fn();
  const client = new QueryClient();
  client.setQueryData(['todos'], [{ id: 1 }]);
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={client}>
      <EraseDataDialog onClose={onClose} />
    </QueryClientProvider>,
  );
  return { user, onClose, client };
}

const review = () => screen.getByRole('button', { name: 'Review and erase' });
const typeErase = (user, text = 'ERASE') => user.type(screen.getByLabelText(/Type ERASE to confirm/), text);
const finalDialog = () => screen.getByRole('alertdialog', { name: 'Erase everything now?' });

beforeEach(() => {
  downloadExport.mockReset().mockResolvedValue({ filename: 'burrow-export.zip', complete: true });
  requestEraseToken.mockReset().mockResolvedValue({ token: 'tok-123' });
  eraseAllData.mockReset().mockResolvedValue({ erased: true });
  useAuth.mockReset().mockReturnValue({ enabled: false });
  replace = vi.fn();
  reload = vi.fn();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...original, replace, reload } });
  localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'location', { configurable: true, value: original });
});

describe('typed confirmation', () => {
  it('keeps Review and erase disabled until ERASE is typed exactly, case-sensitive', async () => {
    const { user } = setup();
    expect(review()).toBeDisabled();
    await typeErase(user, 'erase');
    expect(review()).toBeDisabled();
    await user.clear(screen.getByLabelText(/Type ERASE to confirm/));
    await typeErase(user, 'ERASE ');
    expect(review()).toBeDisabled();
    await user.clear(screen.getByLabelText(/Type ERASE to confirm/));
    await typeErase(user);
    expect(review()).toBeEnabled();
  });

  it('starts with the final export on and the two destructive extras off', () => {
    setup();
    expect(screen.getByRole('checkbox', { name: /Download a final export first/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^Also delete all backups on this computer/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^Also remove my license from this computer/ })).not.toBeChecked();
    expect(screen.queryByRole('checkbox', { name: /I understand/ })).not.toBeInTheDocument();
  });

  it('unticking the export asks for "I understand I can\'t undo this" before the button can work', async () => {
    const { user } = setup();
    await typeErase(user);
    expect(review()).toBeEnabled();
    await user.click(screen.getByRole('checkbox', { name: /Download a final export first/ }));
    expect(review()).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: "I understand I can't undo this" }));
    expect(review()).toBeEnabled();
    await user.click(screen.getByRole('checkbox', { name: /Download a final export first/ }));
    expect(screen.queryByRole('checkbox', { name: /I understand/ })).not.toBeInTheDocument();
  });

  it('warns that deleting backups removes the only way back', () => {
    setup();
    expect(screen.getByText(/Backups are the only way to get your data back after erasing/)).toBeInTheDocument();
  });
});

describe('the password (web sign-in only)', () => {
  it('is not asked for without sign-in', () => {
    setup();
    expect(screen.queryByLabelText(/Your Burrow password/)).not.toBeInTheDocument();
  });

  it('is required when sign-in is on, and sent with the erase', async () => {
    useAuth.mockReturnValue({ enabled: true });
    const { user } = setup();
    await typeErase(user);
    expect(review()).toBeDisabled();
    await user.type(screen.getByLabelText(/Your Burrow password/), 'pw-1');
    expect(review()).toBeEnabled();
    await user.click(review());
    await user.click(within(finalDialog()).getByRole('button', { name: 'Erase my data' }));
    await waitFor(() => expect(eraseAllData).toHaveBeenCalled());
    expect(eraseAllData).toHaveBeenCalledWith({ token: 'tok-123', phrase: 'ERASE', removeLicense: false, deleteBackups: false, password: 'pw-1' });
  });
});

describe('the final confirm dialog', () => {
  it('lists what is deleted and what is kept, says it cannot be undone, and erases nothing yet', async () => {
    const { user } = setup();
    await typeErase(user);
    await user.click(review());
    const dialog = finalDialog();
    expect(within(dialog).getByText('This cannot be undone.')).toBeInTheDocument();
    const deleted = within(within(dialog).getByRole('heading', { name: 'Deleted:' }).closest('section'));
    for (const text of [/transactions, to-dos, calendar/, 'Javi conversations and memory', /activity log, settings, name/, 'Saved API keys']) {
      expect(deleted.getByText(text)).toBeInTheDocument();
    }
    const kept = within(within(dialog).getByRole('heading', { name: 'Kept:' }).closest('section'));
    expect(kept.getByText('Your license activation (it includes your purchase email), unless you remove it.')).toBeInTheDocument();
    expect(kept.getByText('Your Pro trial status is kept.')).toBeInTheDocument();
    expect(
      kept.getByText(
        'Your finished backups stay in C:\\Data\\Burrow\\backups and can restore everything.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('A final export is saved first.')).toBeInTheDocument();
    expect(downloadExport).not.toHaveBeenCalled();
    expect(eraseAllData).not.toHaveBeenCalled();
  });

  it('reflects the options: license removed, backups deleted, no export', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('checkbox', { name: /Download a final export first/ }));
    await user.click(screen.getByRole('checkbox', { name: "I understand I can't undo this" }));
    await user.click(screen.getByRole('checkbox', { name: /^Also delete all backups on this computer/ }));
    await user.click(screen.getByRole('checkbox', { name: /^Also remove my license from this computer/ }));
    await typeErase(user);
    await user.click(review());
    const dialog = finalDialog();
    expect(within(dialog).getByText('Your license will be removed from this computer.')).toBeInTheDocument();
    expect(within(dialog).getByText('Your Pro trial status is kept.')).toBeInTheDocument();
    expect(within(dialog).getByText('All backups will be deleted too, so nothing can restore your data.')).toBeInTheDocument();
    expect(within(dialog).queryByText(/can restore everything/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/purchase email/)).not.toBeInTheDocument();
    expect(within(dialog).getByText('No export will be saved.')).toBeInTheDocument();
  });

  it('Go back returns to the choices without erasing', async () => {
    const { user } = setup();
    await typeErase(user);
    await user.click(review());
    await user.click(within(finalDialog()).getByRole('button', { name: 'Go back' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Type ERASE to confirm/)).toHaveValue('ERASE');
    expect(eraseAllData).not.toHaveBeenCalled();
  });
});

describe('erasing', () => {
  const confirmAll = async (user) => {
    await typeErase(user);
    await user.click(review());
    await user.click(within(finalDialog()).getByRole('button', { name: 'Erase my data' }));
  };

  it('saves the export first, then asks for a token, then erases, clears the browser copy and returns to the start', async () => {
    localStorage.setItem('burrow.profile', '{"onboardedAt":"x"}');
    localStorage.setItem('other.key', 'keep');
    const calls = [];
    downloadExport.mockImplementation(async () => calls.push('export'));
    requestEraseToken.mockImplementation(async () => {
      calls.push('token');
      return { token: 'tok-9' };
    });
    eraseAllData.mockImplementation(async () => calls.push('erase'));
    const { user, client } = setup();
    await user.click(screen.getByRole('checkbox', { name: /^Also remove my license from this computer/ }));
    await confirmAll(user);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    expect(calls).toEqual(['export', 'token', 'erase']);
    expect(eraseAllData).toHaveBeenCalledWith({ token: 'tok-9', phrase: 'ERASE', removeLicense: true, deleteBackups: false });
    expect(localStorage.getItem('burrow.profile')).toBeNull();
    expect(localStorage.getItem('other.key')).toBe('keep');
    expect(client.getQueryData(['todos'])).toBeUndefined();
  });

  it('skips the export when it was turned off, and sends deleteBackups when ticked', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('checkbox', { name: /Download a final export first/ }));
    await user.click(screen.getByRole('checkbox', { name: "I understand I can't undo this" }));
    await user.click(screen.getByRole('checkbox', { name: /^Also delete all backups on this computer/ }));
    await confirmAll(user);
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(downloadExport).not.toHaveBeenCalled();
    expect(eraseAllData).toHaveBeenCalledWith({ token: 'tok-123', phrase: 'ERASE', removeLicense: false, deleteBackups: true });
  });

  it('stops when the export fails: nothing is erased, and it says so', async () => {
    downloadExport.mockRejectedValue(new Error('Export failed with internal detail.'));
    const { user } = setup();
    await confirmAll(user);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't download the final export. Try again, or untick Download a final export first.");
    expect(alert).not.toHaveTextContent('internal detail');
    expect(requestEraseToken).not.toHaveBeenCalled();
    expect(eraseAllData).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(within(finalDialog()).getByRole('button', { name: 'Erase my data' })).toBeEnabled();
  });

  it('shows the server message when erasing fails, keeps the data on screen, and lets the user try again', async () => {
    eraseAllData.mockRejectedValueOnce(Object.assign(new Error(FAILED), { status: 500 }));
    const { user } = setup();
    await confirmAll(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(FAILED);
    expect(replace).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    await user.click(within(finalDialog()).getByRole('button', { name: 'Erase my data' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    expect(requestEraseToken).toHaveBeenCalledTimes(2);
  });

  it('falls back to the fixed "nothing was erased" copy when the error has no message', async () => {
    eraseAllData.mockRejectedValueOnce(Object.assign(new Error(''), { status: 500 }));
    const { user } = setup();
    await confirmAll(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(FAILED);
  });

  it('after erase_incomplete the data is gone: closes, clears the browser copy, reloads to the start, offers no retry', async () => {
    eraseAllData.mockRejectedValueOnce(Object.assign(new Error(INCOMPLETE), { status: 500, code: 'erase_incomplete' }));
    localStorage.setItem('burrow.theme', 'dark');
    const { user, onClose, client } = setup();
    await confirmAll(user);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    expect(onClose).toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(client.getQueryData(['todos'])).toBeUndefined();
    // No second export and no second token: a retry would export an empty app and ask for another erase.
    expect(downloadExport).toHaveBeenCalledTimes(1);
    expect(requestEraseToken).toHaveBeenCalledTimes(1);
    expect(eraseAllData).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // The start screen shows the server's message once.
    expect(window.sessionStorage.getItem(lsKey('erase:note'))).toBe(INCOMPLETE);
  });

  it('when Burrow does not answer, says the outcome is unknown and offers Reload (no automatic retry)', async () => {
    eraseAllData.mockRejectedValueOnce(Object.assign(new Error('x'), { unsure: true }));
    const { user } = setup();
    await confirmAll(user);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Burrow did not answer. Reload Burrow to check whether your data was erased.');
    expect(within(finalDialog()).getByRole('button', { name: 'Erase my data' })).toBeDisabled();
    await user.click(within(alert).getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('shows the fixed copy for an expired or used confirmation as the server sends it', async () => {
    const message = 'This erase confirmation expired after 2 minutes. Choose Erase all my data again to start over.';
    eraseAllData.mockRejectedValueOnce(Object.assign(new Error(message), { status: 410 }));
    const { user } = setup();
    await confirmAll(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });
});
