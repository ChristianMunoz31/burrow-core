import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import NotificationBell from '../NotificationBell';
import { FREE_STATE, UNKNOWN_STATE, resetEntitlementsState, setEntitlementsState } from '../../../test-utils/entitlements.js';

vi.mock('../../../hooks/useEntitlements', async () => (await import('../../../test-utils/entitlements.js')).entitlementsModule());

const h = vi.hoisted(() => ({
  alerts: [],
}));

vi.mock('../../../hooks/useBriefing', () => ({
  useBriefing: () => ({ alerts: h.alerts }),
}));

beforeEach(() => {
  h.alerts = [
    { severity: 'warn', text: 'Two todos are overdue.', to: '/todos' },
    { severity: 'info', text: 'One habit left today.', to: '/habits' },
    { severity: 'info', text: 'Trip in 3 days.', to: '/countdowns' },
  ];
});
afterEach(() => {
  cleanup();
  resetEntitlementsState();
});

const renderBell = () =>
  render(
    <MemoryRouter>
      <NotificationBell />
    </MemoryRouter>,
  );

describe('NotificationBell', () => {
  it('puts the alert count in the trigger name', () => {
    renderBell();
    expect(screen.getByRole('button', { name: 'Notifications, 3 alerts' })).toBeInTheDocument();
  });

  it('uses a singular name for one alert and a plain name for none', () => {
    h.alerts = [{ severity: 'info', text: 'One.', to: '/' }];
    const { unmount } = renderBell();
    expect(screen.getByRole('button', { name: 'Notifications, 1 alert' })).toBeInTheDocument();
    unmount();
    h.alerts = [];
    renderBell();
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('reports expanded state and controls a labelled popover', async () => {
    const user = userEvent.setup();
    renderBell();
    const trigger = screen.getByRole('button', { name: /^Notifications/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).not.toHaveAttribute('aria-controls');
    await user.click(trigger);
    const popover = screen.getByRole('dialog', { name: 'Today’s alerts' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', popover.id);
  });

  it('Escape closes the popover and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderBell();
    const trigger = screen.getByRole('button', { name: /^Notifications/ });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('moves focus to the trigger after choosing an alert', async () => {
    const user = userEvent.setup();
    renderBell();
    const trigger = screen.getByRole('button', { name: /^Notifications/ });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'One habit left today.' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe('NotificationBell tiers', () => {
  const openBell = async () => {
    const user = userEvent.setup();
    renderBell();
    await user.click(screen.getByRole('button', { name: /^Notifications/ }));
    return user;
  };

  it.each([
    ['Free', FREE_STATE],
    ['Pro', null],
    ['unknown', UNKNOWN_STATE],
  ])('shows the alerts and no refresh control (%s)', async (_label, state) => {
    if (state) setEntitlementsState(state);
    await openBell();
    expect(screen.getByText('Two todos are overdue.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh briefing' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
