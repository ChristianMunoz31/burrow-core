import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import BudgetSummaryCards from '../BudgetSummaryCards';

const base = { income: 5000, expenses: 3000, net: 2000, savingsRate: 40 };

describe('BudgetSummaryCards basis labels', () => {
  afterEach(cleanup);

  it('says planned income and planned expenses on the cards that show a plan', () => {
    render(<BudgetSummaryCards summary={{ ...base, incomePlanned: true, expensesPlanned: true }} />);
    expect(screen.getByText('Planned income')).toBeInTheDocument();
    expect(screen.getByText('Planned expenses')).toBeInTheDocument();
    expect(screen.queryByText('Income')).not.toBeInTheDocument();
    expect(screen.queryByText('Expenses')).not.toBeInTheDocument();
  });

  it('keeps the plain titles for real figures', () => {
    render(<BudgetSummaryCards summary={{ ...base, incomePlanned: false, expensesPlanned: false }} />);
    expect(screen.getByText('Income')).toBeInTheDocument();
    expect(screen.getByText('Expenses')).toBeInTheDocument();
    expect(screen.queryByText(/Planned/)).not.toBeInTheDocument();
  });

  it('labels each card on its own when only one is planned', () => {
    render(<BudgetSummaryCards summary={{ ...base, incomePlanned: false, expensesPlanned: true }} />);
    expect(screen.getByText('Income')).toBeInTheDocument();
    expect(screen.getByText('Planned expenses')).toBeInTheDocument();
  });

  it('shows plain titles when the summary does not say', () => {
    render(<BudgetSummaryCards summary={base} />);
    expect(screen.getByText('Income')).toBeInTheDocument();
    expect(screen.getByText('Expenses')).toBeInTheDocument();
    expect(screen.getByText('Net')).toBeInTheDocument();
    expect(screen.getByText('Savings rate')).toBeInTheDocument();
  });

  it('calls net and savings rate planned when both sides are planned', () => {
    render(<BudgetSummaryCards summary={{ ...base, incomePlanned: true, expensesPlanned: true }} />);
    expect(screen.getByText('Planned net')).toBeInTheDocument();
    expect(screen.getByText('Planned savings rate')).toBeInTheDocument();
    expect(screen.queryByText('Net')).not.toBeInTheDocument();
    expect(screen.queryByText('Savings rate')).not.toBeInTheDocument();
    expect(screen.queryByText('Plan vs actual')).not.toBeInTheDocument();
  });

  it('adds a "Plan vs actual" caption only when the sides are mixed', () => {
    const { rerender } = render(<BudgetSummaryCards summary={{ ...base, incomePlanned: false, expensesPlanned: true }} />);
    expect(screen.getByText('Plan vs actual')).toBeInTheDocument();
    expect(screen.getByText('Net')).toBeInTheDocument();
    rerender(<BudgetSummaryCards summary={{ ...base, incomePlanned: true, expensesPlanned: false }} />);
    expect(screen.getByText('Plan vs actual')).toBeInTheDocument();
    rerender(<BudgetSummaryCards summary={{ ...base, incomePlanned: false, expensesPlanned: false }} />);
    expect(screen.queryByText('Plan vs actual')).not.toBeInTheDocument();
  });
});
