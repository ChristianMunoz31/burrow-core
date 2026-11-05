import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import AppShell from '../AppShell';

// Only the content padding that keeps the Javi bar off the page's last row is under test.
vi.mock('../BurgerMenu', () => ({ default: () => null }));
vi.mock('../TopBar', () => ({ default: () => null }));
vi.mock('../../palette/LazyCommandPalette', () => ({ default: () => null }));
vi.mock('../../license/TrialNotice', () => ({ default: () => null }));
vi.mock('../../javi/JaviAdvisor', () => ({ default: () => null }));

const settings = vi.hoisted(() => ({ value: { showButton: true, autoAdvise: true } }));
vi.mock('../../../hooks/useJaviSettings', () => ({ useJaviSettings: () => settings.value }));

function content(path) {
  const { container } = render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell>
        <p>page body</p>
      </AppShell>
    </MemoryRouter>,
  );
  return container.querySelector('.animate-page-in');
}

afterEach(() => {
  cleanup();
  settings.value = { showButton: true, autoAdvise: true };
});

describe('AppShell content padding for the Javi bar', () => {
  it('reserves pb-16 while the bar shows', () => {
    const el = content('/todos');
    expect(el).toHaveClass('pb-16');
    expect(el).not.toHaveClass('pb-24');
  });

  it('reserves nothing on a page without Javi (/folders)', () => {
    expect(content('/folders')).not.toHaveClass('pb-16');
  });

  it.each(['/', '/settings', '/settings/x', '/settings/data'])('reserves nothing on %s (no Javi bar there)', (path) => {
    expect(content(path)).not.toHaveClass('pb-16');
  });

  it('reserves nothing with the bar setting off', () => {
    settings.value = { showButton: false, autoAdvise: true };
    expect(content('/todos')).not.toHaveClass('pb-16');
  });
});
