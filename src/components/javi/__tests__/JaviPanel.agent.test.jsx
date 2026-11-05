import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../hooks/useEntitlements', async () => (await import('../../../test-utils/entitlements.js')).entitlementsModule());
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import JaviPanel from '../JaviPanel';
import { EMPTY_AGENT } from '../timeline';
import {
  FREE_STATE,
  refreshEntitlementsMock,
  resetEntitlementsState,
  setEntitlementsState,
} from '../../../test-utils/entitlements.js';

// BuyProLink and ProGateNotice read the license status; this is a Free user whose trial ended.
const license = vi.hoisted(() => ({ status: null }));
vi.mock('../../../hooks/useLicense', () => ({ useLicense: () => ({ status: license.status }) }));

// The panel reads Javi's source from the status query; these tests are not about that.
vi.mock('../../../hooks/useJarvisStatus', () => ({
  useJarvisStatus: () => ({ status: null, loading: false, error: null }),
}));

const FREE_LICENSE = {
  state: 'update_window_passed',
  pro: false,
  license: null,
  proSource: null,
  purchaseUrl: 'https://example.com/buy-burrow-pro',
  trial: { state: 'ended' },
};

beforeEach(() => {
  license.status = FREE_LICENSE;
  refreshEntitlementsMock.mockClear();
});
afterEach(() => {
  cleanup();
  resetEntitlementsState();
});

const idleThread = { messages: [], status: 'idle', error: null, lastRequestMessages: null, partial: '' };

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


describe('JaviPanel Pro gate per feature in a build without the Pro UI', () => {
  const composer = () => screen.queryByRole('textbox', { name: 'Message Javi' });

  it('a Store license past its update window gets the one-insight panel and the not-included notice, no composer', () => {
    setEntitlementsState({ ...FREE_STATE, proScope: 'features_until', includedFeatures: ['javi_tools'] });
    setup({ askBlocked: true });
    expect(composer()).not.toBeInTheDocument();
    expect(document.querySelector('[data-reason="pro_not_included"][data-capability="javi_conversation"]')).not.toBeNull();
  });

  it('a Pro user in a core build gets the Free panel with the not-included notice instead of a buy link', () => {
    setEntitlementsState({ ...FREE_STATE, pro: true });
    setup({ askBlocked: true });
    expect(composer()).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Buy Burrow Pro/ })).not.toBeInTheDocument();
    expect(document.querySelector('[data-reason="pro_not_included"]')).not.toBeNull();
  });
});

describe('JaviPanel entitlement shape', () => {
  const card = { id: 'a1', role: 'assistant', content: 'Your one insight', auto: true, at: 10 };
  const withCard = { ...idleThread, messages: [card] };
  const chip = () => screen.queryByRole('button', { name: 'What should I tackle first?' });
  const composer = () => screen.queryByRole('textbox', { name: 'Message Javi' });
  const newChat = () => screen.queryByRole('button', { name: 'Start a new conversation with Javi' });
  const hintText = /Ask follow-up questions with Pro./;

  describe('Free', () => {
    beforeEach(() => setEntitlementsState(FREE_STATE));

    it('has no chips, composer or New conversation, but keeps Refresh and Close', async () => {
      const user = userEvent.setup();
      const { props } = setup({ thread: withCard });
      expect(chip()).not.toBeInTheDocument();
      expect(composer()).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
      expect(newChat()).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Get a new insight for this page' }));
      expect(props.onNewAdvice).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'Collapse Javi' })).toBeInTheDocument();
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
      expect(screen.queryByText(hintText)).not.toBeInTheDocument();
    });

    it('shows the card with the passive Pro hint and the Buy link', () => {
      setup({ thread: withCard });
      expect(screen.getByText('Your one insight')).toBeInTheDocument();
      const hint = document.querySelector('[data-capability="javi_conversation"]');
      expect(hint).toHaveTextContent('Ask follow-up questions with Pro.');
      const link = screen.getByRole('link', { name: /Buy Burrow Pro/ });
      expect(link).toHaveAttribute('href', 'https://example.com/buy-burrow-pro');
      expect(hint).toContainElement(link);
    });

    it('omits the Buy link when no purchase URL is configured, keeping the hint text', () => {
      license.status = { ...FREE_LICENSE, purchaseUrl: null };
      setup({ thread: withCard });
      expect(screen.getByText(hintText)).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /Buy Burrow Pro/ })).not.toBeInTheDocument();
    });

    it('shows no hint while the card is loading or after an error', () => {
      const { rerenderWith } = setup({ thread: { ...withCard, status: 'loading' } });
      expect(screen.queryByText(hintText)).not.toBeInTheDocument();
      rerenderWith({
        thread: {
          ...withCard,
          status: 'error',
          error: { message: 'Nope', code: 'unknown', retryAfterMs: null, at: 1 },
          lastRequestMessages: [],
        },
      });
      expect(screen.queryByText(hintText)).not.toBeInTheDocument();
    });

    it('renders one card even if the thread still holds follow-up turns', () => {
      const thread = {
        ...idleThread,
        messages: [
          card,
          { id: 'u1', role: 'user', content: 'a follow-up question', at: 11 },
          { id: 'a2', role: 'assistant', content: 'a follow-up answer', at: 12 },
        ],
      };
      setup({ thread });
      expect(screen.getByText('Your one insight')).toBeInTheDocument();
      expect(screen.queryByText('a follow-up question')).not.toBeInTheDocument();
      expect(screen.queryByText('a follow-up answer')).not.toBeInTheDocument();
    });

    it('shows the Pro notice for a blocked palette question, with no red error', () => {
      setup({ thread: withCard, askBlocked: true });
      expect(document.querySelectorAll('[data-capability="javi_conversation"]').length).toBeGreaterThan(0);
      expect(screen.getByText(/This is a Burrow Pro feature/)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('does not show the notice without askBlocked or a pro_required error', () => {
      setup({ thread: withCard });
      expect(screen.queryByText(/This is a Burrow Pro feature/)).not.toBeInTheDocument();
    });

    it('a pro_required advice error shows the notice, not the red row or Retry, and re-reads the license', () => {
      const thread = {
        ...idleThread,
        status: 'error',
        error: { message: 'raw pro text', code: 'pro_required', retryAfterMs: null, at: 1 },
        lastRequestMessages: [{ role: 'user', content: 'hi' }],
      };
      setup({ thread });
      expect(screen.getByText(/This is a Burrow Pro feature/)).toBeInTheDocument();
      expect(screen.queryByText('raw pro text')).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
      expect(refreshEntitlementsMock).toHaveBeenCalled();
    });

    it('a non-Pro advice error still shows the red row and Retry', () => {
      const thread = {
        ...idleThread,
        status: 'error',
        error: { message: 'Javi took too long.', code: 'timeout', retryAfterMs: null, at: 1 },
        lastRequestMessages: [],
      };
      setup({ thread });
      expect(screen.getByRole('alert')).toHaveTextContent('Javi took too long.');
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
      expect(refreshEntitlementsMock).not.toHaveBeenCalled();
    });

    it('trial ended: the card, the hint and no composer', () => {
      setup({ thread: withCard });
      expect(screen.getByText('Your one insight')).toBeInTheDocument();
      expect(screen.getByText(hintText)).toBeInTheDocument();
      expect(composer()).not.toBeInTheDocument();
      expect(chip()).not.toBeInTheDocument();
    });
  });

  it('Pro with a pro_required advice error (stale entitlement) still re-reads the license', () => {
    const thread = {
      ...idleThread,
      status: 'error',
      error: { message: 'raw pro text', code: 'pro_required', retryAfterMs: null, at: 1 },
      lastRequestMessages: [{ role: 'user', content: 'hi' }],
    };
    setup({ thread });
    expect(refreshEntitlementsMock).toHaveBeenCalled();
  });
});
