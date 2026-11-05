import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import JaviPanel from '../JaviPanel';
import { EMPTY_AGENT } from '../timeline';
import { PRO_NOT_INCLUDED_COPY } from '../../../constants/proFeatures';

// Whether the private module's UI is compiled into the build under test (the real core file says false).
const build = vi.hoisted(() => ({ moduleIncluded: false }));
vi.mock('../../../extensions/proExtensions', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    get PRO_UI_INCLUDED() {
      return build.moduleIncluded;
    },
  };
});

// The panel reads Javi's source from the status query; these tests are not about that.
vi.mock('../../../hooks/useJarvisStatus', () => ({
  useJarvisStatus: () => ({ status: null, loading: false, error: null }),
}));

afterEach(() => {
  cleanup();
  build.moduleIncluded = false;
});

const idleThread = { messages: [], status: 'idle', error: null, lastRequestMessages: null, partial: '' };
const card = { id: 'a1', role: 'assistant', content: 'Your one insight', auto: true, at: 10 };
const withCard = { ...idleThread, messages: [card] };

function setup(overrides = {}) {
  const props = {
    id: 'panel',
    pageKey: 'todos',
    pageLabel: 'Todos',
    thread: idleThread,
    suggestions: ['What should I tackle first?'],
    agent: EMPTY_AGENT,
    onSend: vi.fn(),
    onSuggestion: vi.fn(),
    onNewAdvice: vi.fn(),
    onRetry: vi.fn(),
    onRespond: vi.fn(),
    onNewChat: vi.fn(),
    onClose: vi.fn(),
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

const chip = () => screen.queryByRole('button', { name: 'What should I tackle first?' });
const composer = () => screen.queryByRole('textbox', { name: 'Message Javi' });
const newChat = () => screen.queryByRole('button', { name: 'Start a new conversation with Javi' });
const notIncluded = () => document.querySelector('[data-reason="pro_not_included"]');

describe('JaviPanel in a core-only build (the private module is not compiled in)', () => {
  it('keeps the advice follow-up chips, Refresh and Close; the composer and New conversation come from the module', async () => {
    const user = userEvent.setup();
    const { props } = setup({ thread: withCard });
    expect(chip()).toBeInTheDocument();
    expect(composer()).not.toBeInTheDocument();
    expect(newChat()).not.toBeInTheDocument();
    await user.click(chip());
    expect(props.onSuggestion).toHaveBeenCalledWith('What should I tackle first?');
    await user.click(screen.getByRole('button', { name: 'Get a new insight for this page' }));
    expect(props.onNewAdvice).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Collapse Javi' })).toBeInTheDocument();
  });

  it('shows the whole advice thread, follow-up turns included', () => {
    const thread = {
      ...idleThread,
      messages: [
        card,
        { id: 'u1', role: 'user', content: 'a follow-up question', at: 11 },
        { id: 'a2', role: 'assistant', content: 'a follow-up answer', at: 12 },
      ],
    };
    setup({ thread });
    expect(screen.getByText('a follow-up question')).toBeInTheDocument();
    expect(screen.getByText('a follow-up answer')).toBeInTheDocument();
  });

  it('shows no hint about upgrading and no link to buy anything', () => {
    const { container } = setup({ thread: withCard });
    expect(container.textContent).not.toMatch(/\bpro\b|buy|upgrade|licen[sc]e|trial/i);
    expect(screen.queryByRole('link', { name: /buy|upgrade|license/i })).not.toBeInTheDocument();
    expect(notIncluded()).toBeNull();
  });

  it('shows the not-included notice for a blocked palette question, with no red error', () => {
    setup({ thread: withCard, askBlocked: true });
    expect(notIncluded()).not.toBeNull();
    expect(screen.getByText(PRO_NOT_INCLUDED_COPY)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('puts initial focus on Close', async () => {
    setup({ thread: withCard });
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Collapse Javi' })).toHaveFocus());
  });

  it('shows the greeting with Get insight', async () => {
    const user = userEvent.setup();
    const { props } = setup();
    expect(screen.getByText(/Want a quick insight about /)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Get insight' }));
    expect(props.onNewAdvice).toHaveBeenCalledTimes(1);
  });

  it('an advice error shows the red row and Retry, whatever its code', () => {
    const thread = {
      ...idleThread,
      status: 'error',
      error: { message: 'Javi took too long.', code: 'timeout', retryAfterMs: null, at: 1 },
      lastRequestMessages: [],
    };
    setup({ thread });
    expect(screen.getByRole('alert')).toHaveTextContent('Javi took too long.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('JaviPanel when the private module is compiled in', () => {
  it('shows New conversation and no not-included notice', () => {
    build.moduleIncluded = true;
    setup({ thread: withCard, askBlocked: true });
    expect(newChat()).toBeInTheDocument();
    expect(notIncluded()).toBeNull();
    expect(chip()).toBeInTheDocument();
  });
});
