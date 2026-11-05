import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import SwitchToggle from '../SwitchToggle';

afterEach(cleanup);

const setup = (props = {}) => {
  const onChange = vi.fn();
  render(
    <>
      <span id="lbl">Example</span>
      <SwitchToggle checked={false} disabled={false} labelledBy="lbl" onChange={onChange} {...props} />
    </>,
  );
  return { onChange, toggle: screen.getByRole('switch', { name: 'Example' }) };
};

describe('SwitchToggle', () => {
  it('is a button switch named by its label that reports its state', () => {
    const { toggle } = setup({ checked: true });
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('asks for the opposite value on click and on Space', async () => {
    const user = userEvent.setup();
    const { onChange, toggle } = setup({ checked: false });
    await user.click(toggle);
    expect(onChange).toHaveBeenLastCalledWith(true);
    toggle.focus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('stays focusable but does nothing while disabled (aria-disabled)', async () => {
    const user = userEvent.setup();
    const { onChange, toggle } = setup({ disabled: true });
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    await user.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
    toggle.focus();
    expect(toggle).toHaveFocus();
  });
});
