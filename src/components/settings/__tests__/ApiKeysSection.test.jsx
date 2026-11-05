import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ApiKeysSection from '../ApiKeysSection';

vi.mock('../../../services/secretsService', () => ({
  secretsService: { list: vi.fn(), save: vi.fn(), remove: vi.fn(), test: vi.fn() },
}));
import { secretsService } from '../../../services/secretsService';
import { allowSlowSuite } from '../../../test-utils/slowSuite';

const SENTINEL = 'gsk_SENTINELvalue1234567890abcdef';

const secret = (over = {}) => ({
  name: 'GROQ_API_KEY',
  label: 'Groq',
  provider: 'groq',
  description: 'Fallback AI provider',
  configured: false,
  source: 'none',
  last4: null,
  updatedAt: null,
  envFallback: false,
  stale: false,
  testable: true,
  ...over,
});

const listing = (secrets, over = {}) => ({
  encryption: { enabled: true },
  storage: { available: true },
  writable: true,
  secrets,
  ...over,
});

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ApiKeysSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, client };
}

const row = (label) => screen.getByText(label, { selector: 'p' }).closest('li');

beforeEach(() => {
  Object.values(secretsService).forEach((fn) => fn.mockReset());
});
afterEach(cleanup);

// Heavy render-and-wait suite: raise the time limits so a busy machine does not trip them.
allowSlowSuite();

describe('ApiKeysSection states', () => {
  it('lists connected services only: the cloud AI key lives in Settings > AI', async () => {
    secretsService.list.mockResolvedValue(
      listing([
        secret({ name: 'AI_CLOUD_API_KEY', label: 'Cloud AI', provider: 'cloud_ai' }),
        secret({ name: 'OURA_TOKEN', label: 'Oura Ring', provider: 'oura' }),
      ]),
    );
    renderSection();
    expect(await screen.findByRole('list', { name: 'Connected services' })).toBeInTheDocument();
    expect(screen.getByText('Oura Ring', { selector: 'p' })).toBeInTheDocument();
    expect(screen.queryByText('Cloud AI', { selector: 'p' })).not.toBeInTheDocument();
    expect(screen.getByText('Tokens for services you connect, like Oura. Stored encrypted on this computer.')).toBeInTheDocument();
  });

  it('explains a missing encryption file in plain language', async () => {
    secretsService.list.mockResolvedValue(
      listing([secret()], { encryption: { enabled: false, reason: 'missing' }, writable: false }),
    );
    renderSection();
    expect(await screen.findByText(/its encryption file couldn't be created/)).toBeInTheDocument();
  });

  it('shows a loading state', () => {
    secretsService.list.mockReturnValue(new Promise(() => {}));
    renderSection();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  it('shows a generic error with Retry', async () => {
    secretsService.list.mockRejectedValueOnce(Object.assign(new Error('boom detail'), { status: 500 }));
    renderSection();
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load connected services.");
    expect(screen.queryByText(/boom detail/)).not.toBeInTheDocument();
    secretsService.list.mockResolvedValueOnce(listing([secret()]));
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Not set')).toBeInTheDocument();
  });

  it('shows each badge, the stale pill and the masked value', async () => {
    secretsService.list.mockResolvedValue(
      listing([
        secret({ source: 'settings', configured: true, last4: '1234', updatedAt: '2026-01-02T12:00:00.000Z' }),
        secret({ name: 'OPENAI_API_KEY', label: 'OpenAI', source: 'env', configured: true, last4: '9876' }),
        secret({ name: 'OURA_TOKEN', label: 'Oura Ring', source: 'none', stale: true }),
      ]),
    );
    renderSection();
    await screen.findByText('Saved in settings');
    expect(within(row('Groq')).getByText('Saved in settings')).toBeInTheDocument();
    expect(screen.getByText('••••1234')).toBeInTheDocument();
    expect(within(row('OpenAI')).getByText('Set outside the app')).toBeInTheDocument();
    expect(screen.getByText('••••9876')).toBeInTheDocument();
    expect(within(row('Oura Ring')).getByText('Not set')).toBeInTheDocument();
    expect(within(row('Oura Ring')).getByText("Can't decrypt saved key")).toBeInTheDocument();
    expect(screen.queryByText(/SECRETS_ENCRYPTION_KEY/)).not.toBeInTheDocument();
  });

  it('shows the encryption-disabled notice and disables writes without removing focusability', async () => {
    secretsService.list.mockResolvedValue(
      listing(
        [
          secret({ source: 'settings', configured: true, last4: '1234' }),
          secret({ name: 'OPENAI_API_KEY', label: 'OpenAI', source: 'env', configured: true, last4: '9876' }),
        ],
        { encryption: { enabled: false, reason: 'missing' }, writable: false, writesAllowed: true },
      ),
    );
    secretsService.test.mockResolvedValue({ ok: true });
    renderSection();
    expect(await screen.findByText("Burrow can't store tokens securely on this computer right now.")).toBeInTheDocument();
    const replace = screen.getByRole('button', { name: 'Replace Groq key' });
    expect(replace).toHaveAttribute('aria-disabled', 'true');
    expect(replace).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove Groq key' })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(replace);
    expect(screen.queryByLabelText('Groq API key')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Test OpenAI key' }));
    expect(secretsService.test).toHaveBeenCalledWith('OPENAI_API_KEY');
    expect(await screen.findByText('Key works')).toBeInTheDocument();
  });

  it('disables Test when writes are not allowed, or the key is not configured', async () => {
    secretsService.list.mockResolvedValue(
      listing(
        [
          secret({ source: 'env', configured: true, last4: null }),
          secret({ name: 'OPENAI_API_KEY', label: 'OpenAI' }),
        ],
        { writable: false, writesAllowed: false },
      ),
    );
    renderSection();
    await screen.findByText("Burrow can't store tokens securely on this computer right now.");
    const test = screen.getByRole('button', { name: 'Test Groq key' });
    await userEvent.click(test);
    expect(secretsService.test).not.toHaveBeenCalled();
    expect(test).toHaveAttribute('aria-disabled', 'true');
    expect(test).toHaveAccessibleDescription('Saving is disabled right now.');
    expect(screen.getByRole('button', { name: 'Set OpenAI key' })).toHaveAccessibleDescription('Saving is disabled right now.');
    expect(screen.queryByRole('button', { name: 'Test OpenAI key' })).not.toBeInTheDocument();
  });

  it('describes a disabled Remove with the reason', async () => {
    secretsService.list.mockResolvedValue(
      listing([secret({ source: 'settings', configured: true, last4: '1234' })], {
        writable: false,
        writesAllowed: false,
      }),
    );
    renderSection();
    expect(await screen.findByRole('button', { name: 'Remove Groq key' })).toHaveAccessibleDescription('Saving is disabled right now.');
  });

  it('falls back to writable when writesAllowed is absent', async () => {
    secretsService.list.mockResolvedValue(listing([secret({ source: 'env', configured: true })]));
    secretsService.test.mockResolvedValue({ ok: true });
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Test Groq key' }));
    expect(secretsService.test).toHaveBeenCalledTimes(1);
  });

  it('masks a configured key without digits when last4 is null', async () => {
    secretsService.list.mockResolvedValue(listing([secret({ source: 'env', configured: true, last4: null })]));
    renderSection();
    expect(await screen.findByText('••••')).toBeInTheDocument();
    expect(screen.queryByText(/null/)).not.toBeInTheDocument();
  });

  it('shows the sign-in notice when writes are disabled on this deployment', async () => {
    secretsService.list.mockResolvedValue(listing([secret()], { writable: false, writesAllowed: false }));
    renderSection();
    const copy = await screen.findByText("Burrow can't store tokens securely on this computer right now.");
    expect(copy.closest('[role="status"]')).not.toBeNull();
  });

  it.each([
    ['not_configured', "Burrow can't store tokens securely on this computer right now."],
    ['unavailable', "Burrow can't store tokens securely on this computer right now."],
  ])('explains unavailable storage (%s)', async (reason, copy) => {
    secretsService.list.mockResolvedValue(
      listing([secret()], { storage: { available: false, reason }, writable: false, writesAllowed: true }),
    );
    renderSection();
    expect(await screen.findByText(copy)).toBeInTheDocument();
  });

  it('explains a missing schema', async () => {
    secretsService.list.mockResolvedValue(
      listing([secret()], { storage: { available: false, reason: 'schema_missing' }, writable: false }),
    );
    renderSection();
    expect(await screen.findByText("Burrow can't store tokens securely on this computer right now.")).toBeInTheDocument();
  });
});

describe('ApiKeysSection set/replace', () => {
  async function openForm() {
    secretsService.list.mockResolvedValue(listing([secret()]));
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Set Groq key' }));
    return screen.getByLabelText('Groq API key');
  }

  it('uses a password input with autocomplete off and a show/hide toggle', async () => {
    const input = await openForm();
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).toHaveAttribute('spellcheck', 'false');
    const toggle = screen.getByRole('button', { name: 'Show Groq key' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(toggle);
    expect(input).toHaveAttribute('type', 'text');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('sends the value, clears the input, never writes storage, and returns focus', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    secretsService.save.mockResolvedValue(secret({ source: 'settings', last4: '7890' }));
    const input = await openForm();
    await userEvent.type(input, SENTINEL);
    expect(input.value).toBe(SENTINEL);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(secretsService.save).toHaveBeenCalledWith('GROQ_API_KEY', SENTINEL);
    await waitFor(() => expect(screen.queryByLabelText('Groq API key')).not.toBeInTheDocument());
    expect(input.value).toBe('');
    const written = setItem.mock.calls.flat().join('|');
    expect(written).not.toContain(SENTINEL);
    expect(screen.queryByText(new RegExp(SENTINEL))).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /(Set|Replace) Groq key/ })).toHaveFocus());
    setItem.mockRestore();
  });

  it.each([
    [{ status: 400, code: 'invalid_value' }, "That doesn't look like a valid key for this provider."],
    [{ status: 403, code: 'writes_disabled' }, "Burrow can't save tokens right now."],
    [{ status: 503, code: 'encryption_disabled' }, "Burrow can't save tokens right now."],
    [{ status: 503, code: 'schema_missing' }, "Burrow can't save tokens right now."],
    [{ status: 429 }, 'Too many attempts. Wait a moment and try again.'],
    [{ status: 404, code: 'unknown_secret' }, "That key isn't recognised."],
    [{ status: 500, code: 'something_else' }, "Couldn't save the key. Try again."],
  ])('maps %j to fixed copy, ignoring raw server text', async (shape, copy) => {
    secretsService.save.mockRejectedValue(Object.assign(new Error('RAW SERVER TEXT'), shape));
    const input = await openForm();
    await userEvent.type(input, 'bad value');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(copy);
    expect(alert).toHaveTextContent('Re-enter the key to try again.');
    expect(screen.queryByText(/RAW SERVER TEXT/)).not.toBeInTheDocument();
    expect(input.value).toBe('');
  });

  it('keeps the form open with a hint and clears the value after a failed save', async () => {
    secretsService.save.mockRejectedValue(Object.assign(new Error('x'), { status: 400, code: 'invalid_value' }));
    const input = await openForm();
    await userEvent.type(input, 'bad value');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Re-enter the key to try again.');
    expect(screen.getByLabelText('Groq API key')).toBeInTheDocument();
    expect(input.value).toBe('');
  });

  it('uses fixed copy for non-API failures', async () => {
    secretsService.save.mockRejectedValue(new Error('TypeError: fetch failed for secret abc'));
    const input = await openForm();
    await userEvent.type(input, 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save the key. Try again.");
  });

  it('opts the input out of password managers and re-hides the value on blur', async () => {
    const input = await openForm();
    expect(input).toHaveAttribute('data-1p-ignore');
    expect(input).toHaveAttribute('data-lpignore', 'true');
    expect(input).toHaveAttribute('data-bwignore');
    await userEvent.click(screen.getByRole('button', { name: 'Show Groq key' }));
    expect(input).toHaveAttribute('type', 'text');
    await userEvent.click(document.body);
    expect(input).toHaveAttribute('type', 'password');
  });

  it('never leaks the key to the DOM, console or localStorage', async () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    secretsService.save.mockRejectedValue(Object.assign(new Error(SENTINEL), { status: 400, code: 'invalid_value' }));
    const input = await openForm();
    await userEvent.type(input, SENTINEL);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('alert');
    expect(document.body.innerHTML).not.toContain(SENTINEL);
    expect(input.value).toBe('');
    const logged = spies.flatMap((s) => s.mock.calls).flat().map(String).join('|');
    expect(logged).not.toContain(SENTINEL);
    expect(setItem.mock.calls.flat().join('|')).not.toContain(SENTINEL);
    expect(JSON.stringify({ ...localStorage })).not.toContain(SENTINEL);
    spies.forEach((s) => s.mockRestore());
    setItem.mockRestore();
  });

  it('ignores Escape and Cancel while saving', async () => {
    let resolve;
    secretsService.save.mockReturnValue(new Promise((r) => (resolve = r)));
    const input = await openForm();
    await userEvent.type(input, 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(cancel);
    await userEvent.keyboard('{Escape}');
    expect(screen.getByLabelText('Groq API key')).toBeInTheDocument();
    await act(async () => resolve(secret({ source: 'settings', configured: true })));
    await waitFor(() => expect(screen.queryByLabelText('Groq API key')).not.toBeInTheDocument());
  });

  it('Escape cancels and clears', async () => {
    const input = await openForm();
    await userEvent.type(input, 'abc');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByLabelText('Groq API key')).not.toBeInTheDocument();
    expect(secretsService.save).not.toHaveBeenCalled();
    expect(input.value).toBe('');
  });
});

describe('ApiKeysSection save hygiene', () => {
  it('keeps the saved value out of the query and mutation caches', async () => {
    secretsService.list.mockResolvedValue(listing([secret()]));
    secretsService.save.mockResolvedValue(secret({ source: 'settings', configured: true, last4: '7890' }));
    const { client } = renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Set Groq key' }));
    await userEvent.type(screen.getByLabelText('Groq API key'), SENTINEL);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByLabelText('Groq API key')).not.toBeInTheDocument());
    const queries = JSON.stringify(client.getQueryCache().getAll().map((q) => q.state));
    const mutations = JSON.stringify(client.getMutationCache().getAll().map((m) => m.state));
    expect(queries).not.toContain(SENTINEL);
    expect(mutations).not.toContain(SENTINEL);
    expect(queries).toContain('GROQ_API_KEY');
  });

  it('explains that Oura must be turned on and links to Settings > Network on the opt-in error', async () => {
    secretsService.list.mockResolvedValue(listing([secret({ source: 'env', configured: true })]));
    secretsService.test.mockRejectedValue(
      Object.assign(new Error('Key testing is off.'), { status: 403, code: 'network_opt_in_required' }),
    );
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Test Groq key' }));
    expect(await screen.findByText(/Turn on Oura in/)).toBeInTheDocument();
    expect(screen.getByText(/to test this token\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings > Network' })).toHaveAttribute('href', '/settings#network');
    expect(screen.queryByText("Couldn't run the test")).not.toBeInTheDocument();
  });

  it('clears a previous test result after a successful save', async () => {
    secretsService.list.mockResolvedValue(listing([secret({ source: 'env', configured: true })]));
    secretsService.test.mockResolvedValue({ ok: false, reason: 'unauthorized' });
    secretsService.save.mockResolvedValue(secret({ source: 'settings', configured: true }));
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Test Groq key' }));
    expect(await screen.findByText('Key was rejected')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Set Groq key' }));
    await userEvent.type(screen.getByLabelText('Groq API key'), 'newvalue');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByLabelText('Groq API key')).not.toBeInTheDocument());
    expect(screen.queryByText('Key was rejected')).not.toBeInTheDocument();
  });

  it('ignores a test result that resolves after a save', async () => {
    secretsService.list.mockResolvedValue(listing([secret({ source: 'env', configured: true })]));
    let resolveTest;
    secretsService.test.mockReturnValue(new Promise((r) => (resolveTest = r)));
    secretsService.save.mockResolvedValue(secret({ source: 'settings', configured: true }));
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Test Groq key' }));
    await userEvent.click(screen.getByRole('button', { name: 'Set Groq key' }));
    await userEvent.type(screen.getByLabelText('Groq API key'), 'newvalue');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByLabelText('Groq API key')).not.toBeInTheDocument());
    await act(async () => resolveTest({ ok: true }));
    expect(screen.queryByText('Key works')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test Groq key' })).toHaveAttribute('aria-busy', 'false');
  });

  it.each([[{ status: 429, code: 'rate_limited' }], [{ status: 429 }]])(
    'shows the rate-limit message for a save failing with %j',
    async (shape) => {
      secretsService.list.mockResolvedValue(listing([secret()]));
      secretsService.save.mockRejectedValue(Object.assign(new Error('RAW'), shape));
      renderSection();
      await userEvent.click(await screen.findByRole('button', { name: 'Set Groq key' }));
      await userEvent.type(screen.getByLabelText('Groq API key'), 'abc');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts. Wait a moment and try again.');
    },
  );
});

describe('ApiKeysSection background refetch', () => {
  it('keeps the list and open form when a refetch fails, with an inline banner', async () => {
    secretsService.list.mockResolvedValueOnce(listing([secret()]));
    const { client } = renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Set Groq key' }));
    const input = screen.getByLabelText('Groq API key');
    await userEvent.type(input, 'abc');
    secretsService.list.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    await act(async () => {
      await client.refetchQueries({ queryKey: ['secrets'] });
    });
    expect(await screen.findByText(/Couldn't refresh connected services/)).toBeInTheDocument();
    expect(screen.getByLabelText('Groq API key')).toBe(input);
    expect(input.value).toBe('abc');
    expect(screen.getByText('Groq')).toBeInTheDocument();
  });
});

describe('ApiKeysSection remove and test', () => {
  beforeEach(() => {
    secretsService.list.mockResolvedValue(
      listing([secret({ source: 'settings', configured: true, last4: '1234', envFallback: true })]),
    );
  });

  it('confirms removal inline; Escape cancels', async () => {
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Groq key' }));
    const group = screen.getByRole('group', { name: 'Confirm removal of Groq key' });
    expect(group).toHaveTextContent('The value set outside the app will be used instead.');
    expect(within(group).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: /Confirm removal/ })).not.toBeInTheDocument();
    expect(secretsService.remove).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove Groq key' })).toHaveFocus();
  });

  it('calls remove after confirming', async () => {
    secretsService.remove.mockResolvedValue(secret({ source: 'env' }));
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Groq key' }));
    await userEvent.click(within(screen.getByRole('group')).getByRole('button', { name: 'Remove' }));
    expect(secretsService.remove).toHaveBeenCalledWith('GROQ_API_KEY');
    await waitFor(() => expect(screen.queryByRole('group', { name: /Confirm removal/ })).not.toBeInTheDocument());
  });

  it('sends a single DELETE on a double click', async () => {
    let resolve;
    secretsService.remove.mockReturnValue(new Promise((r) => (resolve = r)));
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Groq key' }));
    await userEvent.dblClick(within(screen.getByRole('group')).getByRole('button', { name: 'Remove' }));
    expect(secretsService.remove).toHaveBeenCalledTimes(1);
    await act(async () => resolve(secret({ source: 'env' })));
  });

  it('ignores a test result that resolves after a removal', async () => {
    let resolveTest;
    secretsService.test.mockReturnValue(new Promise((r) => (resolveTest = r)));
    secretsService.remove.mockResolvedValue(secret({ source: 'env' }));
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Test Groq key' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove Groq key' }));
    await userEvent.click(within(screen.getByRole('group')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: /Confirm removal/ })).not.toBeInTheDocument());
    await act(async () => resolveTest({ ok: false, reason: 'unauthorized' }));
    expect(screen.queryByText('Key was rejected')).not.toBeInTheDocument();
  });

  it('reports a working key', async () => {
    secretsService.test.mockResolvedValue({ ok: true });
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Test Groq key' }));
    expect(secretsService.test).toHaveBeenCalledWith('GROQ_API_KEY');
    expect(await screen.findByText('Key works')).toBeInTheDocument();
  });

  it('maps failure reasons to copy', async () => {
    secretsService.test.mockResolvedValue({ ok: false, reason: 'unauthorized' });
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Test Groq key' }));
    expect(await screen.findByText('Key was rejected')).toBeInTheDocument();
  });

  it.each([
    ['rate_limited', 'Provider rate-limited the check, try later'],
    ['unreachable', "Couldn't reach provider"],
    ['not_configured', 'No key set'],
    ['upstream_error', 'Provider returned an error'],
  ])('maps test reason %s to copy', async (reason, copy) => {
    secretsService.test.mockResolvedValue({ ok: false, reason });
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Test Groq key' }));
    expect(await screen.findByText(copy)).toBeInTheDocument();
  });

  it('shows the rate-limit message when the test request itself is limited', async () => {
    secretsService.test.mockRejectedValue(Object.assign(new Error('x'), { status: 429, code: 'rate_limited' }));
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Test Groq key' }));
    expect(await screen.findByText('Too many attempts. Wait a moment and try again.')).toBeInTheDocument();
  });

  it('shows an alert when removal fails and keeps the key', async () => {
    secretsService.remove.mockRejectedValue(Object.assign(new Error('RAW'), { status: 500 }));
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Groq key' }));
    await userEvent.click(within(screen.getByRole('group')).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't remove the key. Try again.");
    expect(screen.queryByText(/RAW/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Groq key' })).toBeInTheDocument();
  });
});
