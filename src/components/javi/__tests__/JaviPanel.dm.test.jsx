import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import JaviPanel from '../JaviPanel';
import { EMPTY_AGENT } from '../timeline';

// The DM look of the panel: header, greeting, bubble tails, the "New for you" strip and the spoken reply cap.
vi.mock('../../../hooks/useJarvisStatus', () => ({
  useJarvisStatus: () => ({ status: { ai: { kind: 'local', host: null } }, loading: false, error: null }),
}));

afterEach(() => {
  cleanup();
});

const idleThread = { messages: [], status: 'idle', error: null, lastRequestMessages: null, partial: '' };
const card = (content = 'Two todos are due today.') => ({
  ...idleThread,
  messages: [{ id: 'a1', role: 'assistant', auto: true, at: 1, content }],
});
const rowsOf = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `page:p${i}`, kind: 'page', page: `p${i}`, to: `/p${i}`, label: `Page ${i} changed since your last insight`, at: '' }));

function setup(overrides = {}) {
  const props = {
    id: 'panel',
    pageKey: 'todos',
    pageLabel: 'Todos',
    thread: idleThread,
    suggestions: [],
    agent: EMPTY_AGENT,
    onSend: vi.fn(),
    onNewAdvice: vi.fn(),
    onRetry: vi.fn(),
    onClose: vi.fn(),
    onOpenItem: vi.fn(),
    ...overrides,
  };
  const ui = (p) => (
    <MemoryRouter>
      <JaviPanel {...p} />
    </MemoryRouter>
  );
  const view = render(ui(props));
  return { props, ...view, rerenderWith: (next) => view.rerender(ui({ ...props, ...next })) };
}

describe('DM header', () => {
  it('shows the avatar, Javi, the AI helper tag and About {page}', () => {
    setup();
    const dialog = screen.getByRole('dialog', { name: 'Javi' });
    expect(within(dialog).getByText('AI helper')).toBeVisible();
    expect(within(dialog).getByText('About Todos')).toBeInTheDocument();
    expect(within(dialog).queryByText(/About:/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Get a new insight for this page' })).toBeInTheDocument();
  });
});

describe('greeting and bubbles', () => {
  it('the one insight bubble gets the tail and a Report link', () => {
    setup({ thread: card('Insight text') });
    expect(screen.getByText('Insight text').closest('.glass-javi-inner')).toHaveClass('rounded-2xl', 'rounded-bl-md');
    expect(screen.getAllByRole('link', { name: 'Report this Javi reply by email' })).toHaveLength(1);
  });


  it('the greeting is code text: no tail, no Report link, and Get insight asks for an insight', async () => {
    const user = userEvent.setup();
    const { props } = setup();
    const greeting = screen.getByText(/Want a quick insight about Todos\?/);
    expect(greeting.className).not.toMatch(/rounded-bl-md/);
    expect(screen.queryByRole('link', { name: /Report/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Get insight' }));
    expect(props.onNewAdvice).toHaveBeenCalledTimes(1);
  });

  it('open after a change shows exactly one assistant bubble and no composer in a core-only build', () => {
    setup({ thread: card(), rows: rowsOf(1) });
    expect(document.querySelectorAll('.glass-javi-inner')).toHaveLength(1);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('never says chat in its own copy', () => {
    setup({ thread: card(), rows: rowsOf(2) });
    expect(screen.getByRole('dialog').textContent).not.toMatch(/chat/i);
  });
});

describe('New for you strip', () => {
  it('sits after the thread without the module (the insight first in tab order)', () => {
    setup({ thread: card('The insight'), rows: rowsOf(1) });
    const strip = screen.getByText('New for you');
    const insight = screen.getByText('The insight');
    expect(strip.compareDocumentPosition(insight) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(0);
  });


  it('renders exactly rows.length row buttons, no disclosure, and a click opens the item', async () => {
    const user = userEvent.setup();
    const rows = rowsOf(5);
    const { props } = setup({ rows });
    const list = screen.getByRole('list', { name: 'New for you' });
    expect(within(list).getAllByRole('button')).toHaveLength(5);
    expect(list).toHaveClass('max-h-32', 'overflow-y-auto');
    expect(screen.queryByText(/more/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show/i })).not.toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: rows[2].label }));
    expect(props.onOpenItem).toHaveBeenCalledWith(rows[2]);
  });

  it('is absent with zero rows', () => {
    setup({ rows: [] });
    expect(screen.queryByText('New for you')).not.toBeInTheDocument();
  });

});

describe('live region', () => {
  const status = () => screen.getAllByRole('status').find((el) => el.closest('.glass-javi-body'));

  it('reads a short reply and says "Javi replied." for one over 300 characters', () => {
    const { rerenderWith } = setup({ thread: idleThread });
    rerenderWith({ thread: card('Short reply.') });
    expect(status()).toHaveTextContent('Javi said: Short reply.');
    rerenderWith({ thread: { ...idleThread, messages: [{ id: 'a9', role: 'assistant', auto: true, at: 9, content: 'x'.repeat(301) }] } });
    expect(status()).toHaveTextContent(/^Javi replied\.$/);
  });
});
