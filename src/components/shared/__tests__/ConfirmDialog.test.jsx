import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConfirmDialog from '../ConfirmDialog';
import { userError } from '../../../utils/apiError';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const setup = (props = {}) => {
  const onConfirm = props.onConfirm ?? vi.fn().mockResolvedValue(undefined);
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      title="Remove habit?"
      message="Run will be deleted."
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...(props.confirmLabel ? { confirmLabel: props.confirmLabel } : {})}
      {...(props.icon === undefined ? {} : { icon: props.icon })}
    />,
  );
  return { onConfirm, onCancel };
};

describe('ConfirmDialog', () => {
  it('renders an alertdialog described by the message, with Cancel focused', () => {
    setup();
    const dlg = screen.getByRole('alertdialog', { name: 'Remove habit?' });
    expect(dlg).toHaveAccessibleDescription('Run will be deleted.');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('Cancel calls onCancel only', async () => {
    const { onConfirm, onCancel } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('never uses window.confirm', async () => {
    const spy = vi.spyOn(window, 'confirm');
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(spy).not.toHaveBeenCalled();
  });

  it('shows busy state and blocks dismissal while confirming', async () => {
    let resolve;
    const onConfirm = vi.fn(() => new Promise((r) => (resolve = r)));
    const { onCancel } = setup({ onConfirm });
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const busyBtn = await screen.findByRole('button', { name: 'Removing…' });
    expect(busyBtn).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveAttribute('aria-busy', 'true');
    resolve();
  });

  it('busy text follows the confirm label, not a hard-coded Removing', async () => {
    const onConfirm = vi.fn(() => new Promise(() => {}));
    setup({ onConfirm, confirmLabel: 'Copy and replace' });
    await userEvent.click(screen.getByRole('button', { name: 'Copy and replace' }));
    expect(await screen.findByRole('button', { name: 'Copy and replace…' })).toBeDisabled();
    expect(screen.queryByText('Removing…')).not.toBeInTheDocument();
  });

  it('shows the trash icon only for remove-style labels', () => {
    const { unmount } = render(
      <ConfirmDialog title="t" message="m" onConfirm={() => {}} onCancel={() => {}} confirmLabel="Delete" />,
    );
    expect(document.body.innerHTML).toContain('lucide-trash');
    unmount();
    render(<ConfirmDialog title="t" message="m" onConfirm={() => {}} onCancel={() => {}} confirmLabel="Move license" />);
    expect(screen.getByRole('button', { name: 'Move license' }).querySelector('svg')).toBeNull();
  });

  it('shows the generic copy, not the raw error, and stays open when confirm rejects', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('Server said no'));
    const { onCancel } = setup({ onConfirm });
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Burrow couldn't finish that. Try again.");
    expect(screen.queryByText(/Server said no/)).not.toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove' })).toBeEnabled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove' })).toHaveFocus());
    expect(screen.getByRole('alertdialog')).not.toHaveAttribute('aria-busy');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('shows deliberate copy from a userFacing error', async () => {
    const onConfirm = vi.fn().mockRejectedValue(userError('1 of 3 could not be removed'));
    setup({ onConfirm });
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('1 of 3 could not be removed');
  });
});
