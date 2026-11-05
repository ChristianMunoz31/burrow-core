import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import BackgroundPicker from '../BackgroundPicker';
import { BACKGROUND_PRESETS } from '../../../constants/settingsDefaults';

afterEach(cleanup);

function Controlled({ initial = 'aurora', onChange }) {
  const [value, setValue] = useState(initial);
  return (
    <BackgroundPicker
      legend="Dark mode background"
      value={value}
      onChange={(v) => {
        onChange?.(v);
        setValue(v);
      }}
    />
  );
}

describe('BackgroundPicker', () => {
  it('renders a fieldset named by its legend with one radio per preset', () => {
    render(<Controlled />);
    const group = screen.getByRole('group', { name: 'Dark mode background' });
    expect(group.tagName).toBe('FIELDSET');
    expect(screen.getAllByRole('radio')).toHaveLength(BACKGROUND_PRESETS.length);
  });

  it('gives each radio an accessible name and exposes the checked state', () => {
    render(<Controlled initial="ocean" />);
    for (const p of BACKGROUND_PRESETS) {
      const radio = screen.getByRole('radio', { name: new RegExp(`^${p.label}`) });
      if (p.id === 'ocean') expect(radio).toBeChecked();
      else expect(radio).not.toBeChecked();
    }
  });

  it('hides decorative swatches from assistive tech', () => {
    const { container } = render(<Controlled />);
    const swatch = container.querySelector('.bg-swatch');
    expect(swatch.parentElement).toHaveAttribute('aria-hidden', 'true');
  });

  it('calls onChange with the preset id on click', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Controlled onChange={onChange} />);
    await user.click(screen.getByRole('radio', { name: /^Sunset/ }));
    expect(onChange).toHaveBeenCalledWith('sunset');
    expect(screen.getByRole('radio', { name: /^Sunset/ })).toBeChecked();
  });

  it('uses a shared radio group name (explicit or generated)', () => {
    const { rerender } = render(
      <BackgroundPicker legend="L" value="aurora" onChange={() => {}} name="grp" />,
    );
    expect(new Set(screen.getAllByRole('radio').map((r) => r.name))).toEqual(new Set(['grp']));
    rerender(<BackgroundPicker legend="L" value="aurora" onChange={() => {}} />);
    const names = new Set(screen.getAllByRole('radio').map((r) => r.name));
    expect(names.size).toBe(1);
    expect([...names][0]).toBeTruthy();
  });

  it('Tab from outside lands on the checked radio, not the first', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">before</button>
        <Controlled initial="forest" />
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'before' }));
    await user.tab();
    expect(screen.getByRole('radio', { name: /^Forest/ })).toHaveFocus();
  });

  it('a second Tab leaves the group (single tab stop)', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Controlled initial="forest" />
        <button type="button">after</button>
      </>,
    );
    await user.tab();
    expect(screen.getByRole('radio', { name: /^Forest/ })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus();
  });

  it('ArrowRight / ArrowDown move selection and call onChange', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Controlled initial="aurora" onChange={onChange} />);
    await user.tab();
    expect(screen.getByRole('radio', { name: /^Aurora/ })).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('ocean');
    expect(screen.getByRole('radio', { name: /^Ocean/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /^Ocean/ })).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenLastCalledWith('sunset');
    expect(screen.getByRole('radio', { name: /^Sunset/ })).toBeChecked();
  });

  it('ArrowLeft / ArrowUp move selection backwards and wrap', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Controlled initial="aurora" onChange={onChange} />);
    await user.tab();
    await user.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenLastCalledWith('founder');
    await user.keyboard('{ArrowUp}');
    expect(onChange).toHaveBeenLastCalledWith('solid');
  });

  it('Space on a focused unchecked radio selects it', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Controlled initial="aurora" onChange={onChange} />);
    screen.getByRole('radio', { name: /^Graphite/ }).focus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalledWith('graphite');
  });

  it('lists the purple-and-gold preset last for everyone, with its swatches and no founding wording', () => {
    const { container } = render(<Controlled />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(BACKGROUND_PRESETS.length);
    expect(radios.at(-1)).toHaveAccessibleName(/^Purple and gold/);
    expect(container.querySelectorAll('.bg-swatch[data-preset="founder"]')).toHaveLength(2);
    expect(container.textContent).not.toMatch(/founding|founder|member|license/i);
  });

  it('selecting purple and gold calls onChange with the founder id', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Controlled onChange={onChange} />);
    await user.click(screen.getByRole('radio', { name: /^Purple and gold/ }));
    expect(onChange).toHaveBeenCalledWith('founder');
    expect(screen.getByRole('radio', { name: /^Purple and gold/ })).toBeChecked();
  });
});
