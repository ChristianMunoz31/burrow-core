import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Pin } from 'lucide-react';
import ItemActions, { IconButton } from '../ItemActions';

afterEach(cleanup);

describe('ItemActions', () => {
  it('labels buttons with the item name and fires callbacks', async () => {
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    render(<ItemActions name="Run" onEdit={onEdit} onRemove={onRemove} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit Run' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove Run' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('omits buttons whose callback is missing and renders children first', () => {
    render(
      <ItemActions name="Run" onRemove={() => {}}>
        <IconButton label="Pin Run" icon={Pin} onClick={() => {}} />
      </ItemActions>,
    );
    expect(screen.queryByRole('button', { name: 'Edit Run' })).not.toBeInTheDocument();
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toHaveAccessibleName('Pin Run');
    expect(buttons[1]).toHaveAccessibleName('Remove Run');
  });

  it.each(['pointerDown', 'mouseDown', 'touchStart', 'keyDown'])('does not propagate %s', (type) => {
    const parent = vi.fn();
    const props = { [`on${type[0].toUpperCase()}${type.slice(1)}`]: parent };
    render(
      <div {...props}>
        <ItemActions name="Run" onEdit={() => {}} />
      </div>,
    );
    fireEvent[type](screen.getByRole('button', { name: 'Edit Run' }));
    expect(parent).not.toHaveBeenCalled();
  });

  it('does not propagate click to a parent', async () => {
    const parent = vi.fn();
    render(
      <div onClick={parent}>
        <ItemActions name="Run" onEdit={() => {}} />
      </div>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Edit Run' }));
    expect(parent).not.toHaveBeenCalled();
  });

  it('applies reveal-on-hover and extra className', () => {
    const { container } = render(<ItemActions name="Run" onEdit={() => {}} className="absolute" />);
    expect(container.firstChild).toHaveClass('reveal-on-hover', 'absolute');
  });

  it('IconButton merges className with its base classes', () => {
    render(<IconButton label="x" icon={Pin} className="text-accent-indigo" onClick={() => {}} />);
    const btn = screen.getByRole('button', { name: 'x' });
    expect(btn).toHaveClass('text-accent-indigo', 'inline-flex', 'rounded-md');
  });

  it('IconButton is type=button', () => {
    render(<IconButton label="x" icon={Pin} />);
    expect(screen.getByRole('button', { name: 'x' })).toHaveAttribute('type', 'button');
  });
});
