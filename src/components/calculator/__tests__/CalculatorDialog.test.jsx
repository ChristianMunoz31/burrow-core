import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const RealNumberFormat = Intl.NumberFormat;
let defaultLocale = 'en-US';
// Fresh module per test: the session history is module-level state by design.
let CalculatorDialog;

function renderDialog(props = {}) {
  return render(<CalculatorDialog onClose={() => {}} finalFocusRef={{ current: null }} {...props} />);
}
const input = () => screen.getByRole('textbox', { name: 'Calculation' });
// The live region is the element the input points at with aria-describedby.
const region = () => document.getElementById(input().getAttribute('aria-describedby'));

async function calc(user, text) {
  await user.clear(input());
  await user.type(input(), `${text}{Enter}`);
}

beforeEach(async () => {
  vi.resetModules();
  CalculatorDialog = (await import('../CalculatorDialog')).default;
  defaultLocale = 'en-US';
  // A regular function, not an arrow: formatDecimal calls it with `new`.
  vi.spyOn(Intl, 'NumberFormat').mockImplementation(function (locales, options) {
    return new RealNumberFormat(locales ?? defaultLocale, options);
  });
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('CalculatorDialog', () => {
  it('is a modal dialog named Calculator with the input focused', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Calculator' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(input()).toHaveFocus();
  });

  it('Enter evaluates: live region, plain value in the input, history row', async () => {
    const user = userEvent.setup();
    renderDialog();
    await calc(user, '0.1 + 0.2');
    expect(region()).toHaveTextContent('Result: 0.3');
    expect(region()).toHaveAttribute('aria-live', 'polite');
    expect(input()).toHaveValue('0.3');
    expect(screen.getByRole('button', { name: '0.1 + 0.2 = 0.3' })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('the Calculate button does the same', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(input(), '2 * 3');
    await user.click(screen.getByRole('button', { name: 'Calculate' }));
    expect(region()).toHaveTextContent('Result: 6');
    expect(input()).toHaveValue('6');
  });

  it('shows 1/3 rounded to ten places', async () => {
    const user = userEvent.setup();
    renderDialog();
    await calc(user, '1/3');
    expect(region()).toHaveTextContent('Result: 0.3333333333');
  });

  it('Enter on empty input does nothing', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(input(), '{Enter}');
    expect(region()).toHaveTextContent('');
    expect(screen.queryByText('Recent results')).not.toBeInTheDocument();
  });

  it('an error keeps the text, marks the field invalid and typing clears it', async () => {
    const user = userEvent.setup();
    renderDialog();
    await calc(user, '5 / 0');
    expect(region()).toHaveTextContent("You can't divide by zero. Change the number you divide by.");
    expect(input()).toHaveAttribute('aria-invalid', 'true');
    expect(input()).toHaveAttribute('aria-describedby', region().id);
    expect(input()).toHaveValue('5 / 0');
    expect(screen.queryByText('Recent results')).not.toBeInTheDocument();
    await user.type(input(), '1');
    expect(input()).not.toHaveAttribute('aria-invalid');
  });

  it('a repeated result adds no duplicate row but is announced again', async () => {
    const user = userEvent.setup();
    renderDialog();
    await calc(user, '1 + 2');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    const seen = [];
    const observer = new MutationObserver(() => seen.push(region().textContent));
    observer.observe(region(), { childList: true, subtree: true, characterData: true });
    await calc(user, '3'); // equals the last result
    await Promise.resolve();
    observer.disconnect();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(seen).toContain(''); // cleared first, so the live region speaks again
    expect(region()).toHaveTextContent('Result: 3');
  });

  it('the error message does not inherit the result styling', async () => {
    const user = userEvent.setup();
    renderDialog();
    await calc(user, '5 / 0');
    expect(region().className).not.toMatch(/text-lg|font-semibold/);
    await calc(user, '2 * 3');
    expect(screen.getByText('6').className).toMatch(/font-semibold/);
  });

  it('keeps the last 10 results, newest first', async () => {
    const user = userEvent.setup();
    renderDialog();
    for (let i = 1; i <= 11; i += 1) await calc(user, `${i} + 0`);
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(10);
    expect(rows[0]).toHaveTextContent('11 + 0 = 11');
    expect(rows[9]).toHaveTextContent('2 + 0 = 2');
  });

  it('clicking a history row recalls its value and focuses the input', async () => {
    const user = userEvent.setup();
    renderDialog();
    await calc(user, '1/4');
    await calc(user, '9');
    await user.click(screen.getByRole('button', { name: '1/4 = 0.25' }));
    expect(input()).toHaveValue('0.25');
    expect(input()).toHaveFocus();
  });

  it('history survives remount and is empty after a fresh module import', async () => {
    const user = userEvent.setup();
    const first = renderDialog();
    await calc(user, '7 + 1');
    first.unmount();
    renderDialog();
    expect(screen.getByRole('button', { name: '7 + 1 = 8' })).toBeInTheDocument();
    cleanup();

    vi.resetModules();
    const Fresh = (await import('../CalculatorDialog')).default;
    render(<Fresh onClose={() => {}} finalFocusRef={{ current: null }} />);
    expect(screen.queryByText('Recent results')).not.toBeInTheDocument();
  });

  it('has only Close, Calculate and history buttons: no Cancel, no Copy', async () => {
    const user = userEvent.setup();
    renderDialog();
    await calc(user, '1+1');
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(names).toEqual(['Close', 'Calculate', '1+1 = 2']);
  });

  it('displays in the runtime locale while the input keeps the plain value (de-DE)', async () => {
    defaultLocale = 'de-DE';
    const user = userEvent.setup();
    renderDialog();
    await calc(user, '0.1 + 0.2');
    expect(region()).toHaveTextContent('Result: 0,3');
    expect(screen.getByRole('button', { name: '0.1 + 0.2 = 0,3' })).toBeInTheDocument();
    expect(input()).toHaveValue('0.3');
  });
});
