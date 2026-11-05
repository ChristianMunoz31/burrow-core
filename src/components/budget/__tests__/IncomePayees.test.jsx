import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import IncomePayees from '../IncomePayees';

afterEach(cleanup);

const payee = { id: 'p1', name: 'Paycheck', amount: 1000, every: 2, unit: 'week', anchorDate: '2026-10-01' };

describe('IncomePayees', () => {
  it('asks before removing a payee', async () => {
    const setPayees = vi.fn();
    render(<IncomePayees month="2026-10" payees={[payee]} setPayees={setPayees} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Paycheck' }));
    expect(setPayees).not.toHaveBeenCalled();
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    expect(setPayees).toHaveBeenCalledWith([]);
  });

  it('returns focus to Add payee after a removal is confirmed', async () => {
    function Host() {
      const [payees, setPayees] = useState([payee]);
      return <IncomePayees month="2026-10" payees={payees} setPayees={setPayees} />;
    }
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Paycheck' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    expect(screen.queryByText('Paycheck')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add payee' })).toHaveFocus();
  });

  it('saves a new payee with Enter and names fields by their visible labels', async () => {
    const setPayees = vi.fn();
    render(<IncomePayees month="2026-10" payees={[]} setPayees={setPayees} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add payee' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Side gig');
    await userEvent.type(screen.getByLabelText('Amount'), '250');
    await userEvent.type(screen.getByLabelText('Starting'), '2026-10-05');
    expect(screen.getByLabelText('Every')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Name'), '{Enter}');
    expect(setPayees).toHaveBeenCalledTimes(1);
    expect(setPayees.mock.calls[0][0][0]).toMatchObject({ name: 'Side gig', amount: 250, anchorDate: '2026-10-05' });
  });
});
