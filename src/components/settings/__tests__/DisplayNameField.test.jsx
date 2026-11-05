import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DisplayNameField from '../DisplayNameField';

vi.mock('../../../services/profileService', () => ({
  profileService: { get: vi.fn(), update: vi.fn() },
}));
import { profileService } from '../../../services/profileService';

function renderField() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DisplayNameField />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  profileService.get.mockResolvedValue({ displayName: 'Sam', onboardedAt: '2026-01-01T00:00:00Z' });
  profileService.update.mockImplementation(async (patch) => ({
    displayName: patch.displayName ?? null,
    onboardedAt: '2026-01-01T00:00:00Z',
  }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function ready() {
  const input = await screen.findByLabelText('Display name');
  await waitFor(() => expect(input).toHaveValue('Sam'));
  return input;
}

describe('DisplayNameField', () => {
  it('shows the current name under an accessible label', async () => {
    renderField();
    await ready();
  });

  it('saves with the Save button', async () => {
    const user = userEvent.setup();
    renderField();
    const input = await ready();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.clear(input);
    await user.type(input, 'Alex');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(profileService.update).toHaveBeenCalledWith({ displayName: 'Alex' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('saves on blur', async () => {
    const user = userEvent.setup();
    renderField();
    const input = await ready();
    await user.clear(input);
    await user.type(input, 'Robin');
    await user.tab();
    await waitFor(() => expect(profileService.update).toHaveBeenCalledWith({ displayName: 'Robin' }));
  });

  it('sends one PUT when clicking Save after typing (no blur duplicate)', async () => {
    const user = userEvent.setup();
    renderField();
    const input = await ready();
    await user.clear(input);
    await user.type(input, 'Alex');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    expect(profileService.update).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite in-progress typing when the server value arrives', async () => {
    let resolveGet;
    profileService.get.mockImplementation(() => new Promise((r) => { resolveGet = r; }));
    localStorage.setItem(
      'burrow.profile',
      JSON.stringify({ displayName: null, onboardedAt: '2026-01-01T00:00:00Z' }),
    );
    const user = userEvent.setup();
    renderField();
    const input = await screen.findByLabelText('Display name');
    await user.type(input, 'Typing');
    resolveGet({ displayName: 'Server', onboardedAt: '2026-01-01T00:00:00Z' });
    await waitFor(() => expect(profileService.get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(input).toHaveValue('Typing');
  });

  it('does not save when nothing changed', async () => {
    const user = userEvent.setup();
    renderField();
    const input = await ready();
    await user.click(input);
    await user.tab();
    expect(profileService.update).not.toHaveBeenCalled();
  });

  it('says so when the server could not store the name', async () => {
    profileService.update.mockRejectedValue(new Error('503'));
    const user = userEvent.setup();
    renderField();
    const input = await ready();
    await user.clear(input);
    await user.type(input, 'Alex');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Saved in this browser only/)).toBeInTheDocument();
  });
});
