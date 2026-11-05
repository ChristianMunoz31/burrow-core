import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import AppShell from '../AppShell';

// Stacking order (docs/design/minimal-shell-2026-10.md 4.3): the Javi bar and window (z-40) must share the
// shell's stacking context with the drawer (z-50) and the burger and command palette (z-[60]), so their scrims
// cover the bar. Mounted outside that `relative z-[1]` container, the bar's z-40 beat every z inside it.
vi.mock('../BurgerMenu', () => ({ default: () => <div data-testid="burger" /> }));
vi.mock('../TopBar', () => ({ default: () => null }));
vi.mock('../../palette/LazyCommandPalette', () => ({ default: () => <div data-testid="palette" /> }));
vi.mock('../../javi/JaviAdvisor', () => ({ default: () => <div data-testid="javi" /> }));
vi.mock('../../../hooks/useJaviSettings', () => ({ useJaviSettings: () => ({ showButton: true, autoAdvise: true }) }));

afterEach(cleanup);

describe('AppShell layers', () => {
  it('mounts Javi in the same stacking context as the drawer and the palette, after the page content', () => {
    render(
      <MemoryRouter initialEntries={['/todos']}>
        <AppShell>
          <p>page body</p>
        </AppShell>
      </MemoryRouter>,
    );
    const layer = screen.getByTestId('burger').parentElement;
    expect(layer).toHaveClass('relative', 'z-[1]');
    expect(layer).toContainElement(screen.getByTestId('palette'));
    expect(layer).toContainElement(screen.getByTestId('javi'));
    // Still after the content in DOM (and so tab) order.
    const main = layer.querySelector('main');
    expect(main.compareDocumentPosition(screen.getByTestId('javi')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the top bar between the Javi window and the drawer, so the bell popover is never under Javi', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { cwd } = await import('node:process');
    const src = readFileSync(resolve(cwd(), 'src/components/shell/TopBar.jsx'), 'utf8');
    const z = Number(/sticky top-0 z-\[?(\d+)\]?/.exec(src)?.[1]);
    expect(z).toBeGreaterThan(40); // Javi bar and window
    expect(z).toBeLessThan(50); // drawer scrim, modals
  });
});

