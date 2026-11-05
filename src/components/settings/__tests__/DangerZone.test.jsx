import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DangerZone from '../DangerZone';

configure({ asyncUtilTimeout: 5000 });

vi.mock('../../../hooks/useBackups', () => ({ useBackups: () => ({ data: null }) }));
vi.mock('../../../auth/useAuth', () => ({ useAuth: () => ({ enabled: false }) }));

afterEach(cleanup);

function setup() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <DangerZone />
    </QueryClientProvider>,
  );
}

describe('DangerZone', () => {
  it('is a clearly named section that says what is deleted, what is kept and that it cannot be undone', () => {
    setup();
    const zone = screen.getByRole('region', { name: 'Danger zone' });
    expect(zone).toHaveTextContent('permanently deletes everything you saved in Burrow on this computer');
    expect(zone).toHaveTextContent('Kept: your license (unless you remove it), your Pro trial status, and your backups (unless you delete them too).');
    expect(zone).toHaveTextContent('This cannot be undone.');
    expect(zone).not.toHaveTextContent(/database|sqlite|—/i);
  });

  it('does not load or show the dialog until the button is pressed, then opens it', async () => {
    setup();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Erase all my data' }));
    expect(await screen.findByRole('dialog', { name: 'Erase all my data' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review and erase' })).toBeDisabled();
  });

  it('closes the dialog with Cancel and returns focus to the button', async () => {
    setup();
    const trigger = screen.getByRole('button', { name: 'Erase all my data' });
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
