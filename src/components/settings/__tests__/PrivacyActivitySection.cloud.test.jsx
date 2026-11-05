import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
  provider: 'openai_compat',
  model: 'some-model',
  status: 'ok',
  context: 'redacted context',
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

describe('PrivacyActivitySection cloud rows', () => {
  it('says where a cloud request went and what was and was not shared', async () => {
    list.mockResolvedValue({
      entries: [
        entry(1, {
          meta: {
            ai_kind: 'cloud',
            ai_host: 'api.example.com',
            shared: ['todos', 'budget', 'calendar'],
            withheld: ['journal', 'health'],
          },
        }),
      ],
      nextBefore: null,
      available: true,
    });
    renderSection();
    expect(
      await screen.findByText(
        'Sent to api.example.com. Shared: Budget, Todos and Calendar. Not shared: Health and Journal.',
      ),
    ).toBeInTheDocument();
  });

  it('says nothing when nothing was shared or withheld, and a single kind has no "and"', async () => {
    list.mockResolvedValue({
      entries: [
        entry(1, { meta: { ai_kind: 'cloud', ai_host: 'api.example.com', shared: [], withheld: ['notes'] } }),
        entry(2, { meta: { ai_kind: 'cloud', ai_host: 'api.example.com', shared: ['focus'], withheld: [] } }),
      ],
      nextBefore: null,
      available: true,
    });
    renderSection();
    expect(await screen.findByText('Sent to api.example.com. Shared: nothing. Not shared: Notes.')).toBeInTheDocument();
    expect(screen.getByText('Sent to api.example.com. Shared: Focus sessions. Not shared: nothing.')).toBeInTheDocument();
  });

  it('ignores unknown category ids instead of printing them', async () => {
    list.mockResolvedValue({
      entries: [entry(1, { meta: { ai_kind: 'cloud', ai_host: 'api.example.com', shared: ['todos', 'mystery'], withheld: [] } })],
      nextBefore: null,
      available: true,
    });
    renderSection();
    expect(await screen.findByText('Sent to api.example.com. Shared: Todos. Not shared: nothing.')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('mystery');
  });

  it('adds nothing for local and network rows or rows with no meta', async () => {
    list.mockResolvedValue({
      entries: [
        entry(1, { meta: { ai_kind: 'local' } }),
        entry(2, { meta: { ai_kind: 'lan' } }),
        entry(3, { meta: {} }),
        entry(4, { meta: null }),
      ],
      nextBefore: null,
      available: true,
    });
    renderSection();
    expect(await screen.findAllByRole('listitem')).toHaveLength(4);
    expect(screen.queryByText(/Sent to/)).not.toBeInTheDocument();
  });

  it('labels the consent audit feature in plain words', async () => {
    list.mockResolvedValue({
      entries: [entry(1, { kind: 'settings', feature: 'cloud_ai_consent', provider: null, model: null, meta: { action: 'enabled' } })],
      nextBefore: null,
      available: true,
    });
    renderSection();
    expect(await screen.findByText('Cloud AI settings')).toBeInTheDocument();
  });
});
