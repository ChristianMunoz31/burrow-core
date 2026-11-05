import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import CategoryEditor from '../CategoryEditor';

afterEach(cleanup);

const structure = {
  groups: { added: [{ id: 'g-goals', name: 'Goals', isIncome: false, sortOrder: 999999 }] },
  categories: { added: [{ id: 'c-trip', name: 'Trip fund', groupId: 'g-goals', sortOrder: 1024 }] },
};

function setup() {
  const setStructure = vi.fn();
  const setDefaults = vi.fn();
  render(
    <CategoryEditor
      structure={structure}
      setStructure={setStructure}
      defaults={{}}
      setDefaults={setDefaults}
    />,
  );
  return { setStructure, setDefaults };
}

describe('CategoryEditor deletes', () => {
  it('asks before deleting a custom group, naming its custom categories, and Cancel changes nothing', async () => {
    const { setStructure } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Delete group Goals' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('"Goals" and its 1 custom category will be permanently deleted.');
    expect(setStructure).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(setStructure).not.toHaveBeenCalled();
  });

  it('deletes the group only after confirming', async () => {
    const { setStructure } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Delete group Goals' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    expect(setStructure).toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('asks before deleting a custom category', async () => {
    const { setStructure } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Delete Trip fund' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('"Trip fund" will be permanently deleted.');
    expect(setStructure).not.toHaveBeenCalled();
  });
});

describe('CategoryEditor Escape', () => {
  it('discards a half-typed rename on Escape instead of committing it', async () => {
    const { setStructure } = setup();
    const input = screen.getByLabelText('Group name Goals');
    await userEvent.clear(input);
    await userEvent.type(input, 'Typo');
    await userEvent.keyboard('{Escape}');
    expect(setStructure).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Group name Goals')).toHaveValue('Goals');
  });

  it('discards a half-typed default budget on Escape', async () => {
    const { setDefaults } = setup();
    await userEvent.type(screen.getByLabelText('Default budget for Trip fund'), '99');
    await userEvent.keyboard('{Escape}');
    expect(setDefaults).not.toHaveBeenCalled();
  });

  it('still commits a rename on blur', async () => {
    const { setStructure } = setup();
    const input = screen.getByLabelText('Group name Goals');
    await userEvent.clear(input);
    await userEvent.type(input, 'Plans');
    await userEvent.tab();
    expect(setStructure).toHaveBeenCalledTimes(1);
  });

  it('returns focus to the new group field after a delete is confirmed', async () => {
    function Host() {
      const [st, setSt] = useState(structure);
      return <CategoryEditor structure={st} setStructure={setSt} defaults={{}} setDefaults={() => {}} />;
    }
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Delete group Goals' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    expect(screen.queryByLabelText('Group name Goals')).not.toBeInTheDocument();
    expect(screen.getByLabelText('New group name')).toHaveFocus();
  });
});
