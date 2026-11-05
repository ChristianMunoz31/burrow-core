import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PrivacyActivitySection from '../PrivacyActivitySection';
import { SHOW_NETWORK_ACTIVITY_EVENT } from '../settingsSections';

const list = vi.hoisted(() => vi.fn());
vi.mock('../../../services/auditService', () => ({ auditService: { list } }));

const entry = (id, over = {}) => ({
  id,
  createdAt: `2026-01-0${id}T10:00:00.000Z`,
  kind: 'llm',
  feature: 'javi_advice',
  page: 'budget',
  provider: 'groq',
  model: 'gpt-oss',
  status: 'ok',
  context: '{"question":"hi"}',
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

beforeEach(() => {
  list.mockReset();
});
afterEach(cleanup);

describe('PrivacyActivitySection', () => {
  it('opens the Network activity panel when the Network section asks for it', async () => {
    list.mockResolvedValue({ entries: [], nextBefore: null, available: true });
    renderSection();
    const button = await screen.findByRole('button', { name: 'Network activity' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    act(() => {
      window.dispatchEvent(new CustomEvent(SHOW_NETWORK_ACTIVITY_EVENT));
    });
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders rows with labels and toggles redacted context', async () => {
    list.mockResolvedValue({ entries: [entry('1'), entry('2', { feature: 'sign_in', kind: 'auth', context: null })], nextBefore: null, available: true });
    renderSection();
    expect(await screen.findByText('Javi advice')).toBeInTheDocument();
    expect(screen.getByText('Sign-in')).toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: /^Javi advice, / });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('{"question":"hi"}')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Sign-in, / }));
    expect(screen.getByText('No context stored')).toBeInTheDocument();
  });

  it('loads more using nextBefore', async () => {
    list
      .mockResolvedValueOnce({ entries: [entry('1')], nextBefore: '2026-01-01T10:00:00.000Z', available: true })
      .mockResolvedValueOnce({ entries: [entry('2', { feature: 'jarvis' })], nextBefore: null, available: true });
    renderSection();
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Javi')).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ before: '2026-01-01T10:00:00.000Z' }));
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('shows the not-configured and empty states', async () => {
    list.mockResolvedValueOnce({ entries: [], nextBefore: null, available: false, reason: 'not_configured' });
    renderSection();
    expect(await screen.findByText("Burrow can't open your data file. Try restarting Burrow.")).toBeInTheDocument();
    cleanup();
    list.mockResolvedValueOnce({ entries: [], nextBefore: null, available: true });
    renderSection();
    expect(await screen.findByText('No activity recorded yet.')).toBeInTheDocument();
  });

  it('shows an alert when the request fails', async () => {
    list.mockRejectedValue(new Error('nope'));
    renderSection();
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load activity.");
  });
});

describe('PrivacyActivitySection sign-in attempt notes', () => {
  it('shows attempts on error rows and failed_attempts_before on success rows', async () => {
    const signIn = { feature: 'sign_in', kind: 'auth', context: null };
    list.mockResolvedValue({
      entries: [
        entry('1', { ...signIn, status: 'error', meta: { attempts: 3 } }),
        entry('2', { ...signIn, status: 'ok', meta: { failed_attempts_before: 3 } }),
        entry('3', { ...signIn, status: 'ok', meta: {} }),
      ],
      nextBefore: null,
      available: true,
    });
    renderSection();
    expect(await screen.findByText('3 attempts')).toBeInTheDocument();
    expect(screen.getByText('after 3 failed attempts')).toBeInTheDocument();
    expect(screen.getAllByText(/attempts?$/)).toHaveLength(2);
  });
});
