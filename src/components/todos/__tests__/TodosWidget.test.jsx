import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import TodosWidget from '../TodosWidget';
import { renderWithProviders } from '../../../test-utils/renderWithProviders';
import { lsKey } from '../../../utils/storageKeys';

vi.mock('../../../services/todosService', () => ({
  todosService: {
    list: vi.fn(async () => [
      { id: 't1', title: 'Work item', context: 'work', done: false },
      { id: 't2', title: 'Home item', context: 'home', done: false },
      { id: 't3', title: 'Both item', context: 'both', done: false },
    ]),
  },
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('TodosWidget', () => {
  it('counts todos of every tag even when the stored mode is work', async () => {
    localStorage.setItem(lsKey('mode'), JSON.stringify('work'));
    renderWithProviders(
      <MemoryRouter>
        <TodosWidget />
      </MemoryRouter>,
    );
    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(screen.getByText('· Home item')).toBeInTheDocument();
  });

  it('marks the card aria-busy while its skeleton shows, then clears it', async () => {
    renderWithProviders(
      <MemoryRouter>
        <TodosWidget />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link')).toHaveAttribute('aria-busy', 'true');
    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(screen.getByRole('link')).not.toHaveAttribute('aria-busy');
  });
});
