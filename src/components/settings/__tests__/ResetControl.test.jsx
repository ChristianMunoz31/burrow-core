import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import ResetControl from '../ResetControl';

afterEach(cleanup);

describe('ResetControl', () => {
  it('shows a "Reset {label}" trigger and no confirm group initially', () => {
    render(<ResetControl label="Appearance" onConfirm={() => {}} />);
    expect(screen.getByRole('button', { name: 'Reset Appearance' })).toBeInTheDocument();
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });

  it('uses triggerText when provided', () => {
    render(<ResetControl label="all settings" triggerText="Reset all to defaults" onConfirm={() => {}} />);
    expect(screen.getByRole('button', { name: 'Reset all to defaults' })).toBeInTheDocument();
  });

  it('clicking the trigger shows the confirm group with focus on Cancel', async () => {
    const user = userEvent.setup();
    render(<ResetControl label="Budget" onConfirm={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Reset Budget' }));
    const group = screen.getByRole('group', { name: 'Confirm reset of Budget' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Reset Budget' })).not.toBeInTheDocument();
  });

  it('Confirm calls onConfirm once and closes the group', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<ResetControl label="Budget" onConfirm={onConfirm} />);
    await user.click(screen.getByRole('button', { name: 'Reset Budget' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset Budget' })).toHaveFocus();
  });

  it('Cancel does not call onConfirm and returns focus to the trigger', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<ResetControl label="Budget" onConfirm={onConfirm} />);
    await user.click(screen.getByRole('button', { name: 'Reset Budget' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Reset Budget' })).toHaveFocus();
  });

  it('Escape cancels, returns focus to the trigger and does not bubble', async () => {
    const onConfirm = vi.fn();
    const outer = vi.fn();
    const user = userEvent.setup();
    render(
      <div onKeyDown={outer}>
        <ResetControl label="Budget" onConfirm={onConfirm} />
      </div>,
    );
    await user.click(screen.getByRole('button', { name: 'Reset Budget' }));
    await user.keyboard('{Escape}');
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset Budget' })).toHaveFocus();
    // Only the Enter/click path may bubble; Escape inside the group is stopped.
    expect(outer.mock.calls.filter(([e]) => e.key === 'Escape')).toHaveLength(0);
  });

  it('the confirm group is described by the visible question text', async () => {
    const user = userEvent.setup();
    render(<ResetControl label="Budget" onConfirm={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Reset Budget' }));
    const group = screen.getByRole('group', { name: 'Confirm reset of Budget' });
    const id = group.getAttribute('aria-describedby');
    expect(id).toBeTruthy();
    const question = document.getElementById(id);
    expect(question).toHaveTextContent('Reset Budget to defaults?');
    expect(question).toBeVisible();
    expect(group).toHaveAccessibleDescription('Reset Budget to defaults?');
  });

  it('two controls use distinct description ids', async () => {
    const user = userEvent.setup();
    render(
      <>
        <ResetControl label="A" onConfirm={() => {}} />
        <ResetControl label="B" onConfirm={() => {}} />
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Reset A' }));
    await user.click(screen.getByRole('button', { name: 'Reset B' }));
    const ids = screen.getAllByRole('group').map((g) => g.getAttribute('aria-describedby'));
    expect(new Set(ids).size).toBe(2);
  });

  it('can be opened again after cancelling', async () => {
    const user = userEvent.setup();
    render(<ResetControl label="General" onConfirm={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Reset General' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Reset General' }));
    expect(screen.getByRole('group', { name: 'Confirm reset of General' })).toBeInTheDocument();
  });
});
