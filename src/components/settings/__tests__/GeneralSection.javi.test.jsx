import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import GeneralSection from '../GeneralSection';

vi.mock('../../../hooks/useJarvisStatus', () => ({
  useJarvisStatus: () => ({ status: null, loading: false }),
}));

vi.mock('../DisplayNameField', () => ({ default: () => null }));

afterEach(cleanup);

const autoSwitch = () => screen.getByRole('switch', { name: 'Get an insight when Javi opens' });
const buttonSwitch = () => screen.getByRole('switch', { name: 'Show the Javi bar' });
const base = { onReset: vi.fn() };

describe('GeneralSection Javi advisor settings', () => {
  it('defaults both switches to On', () => {
    render(
      <MemoryRouter>
        <GeneralSection {...base} />
      </MemoryRouter>,
    );
    expect(buttonSwitch()).toBeChecked();
    expect(autoSwitch()).toBeChecked();
  });

  it('reports changes through the callbacks', async () => {
    const onAdvisorButtonChange = vi.fn();
    const onAutoAdviseChange = vi.fn();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <GeneralSection
          {...base}
          advisorButton
          autoAdvise
          onAdvisorButtonChange={onAdvisorButtonChange}
          onAutoAdviseChange={onAutoAdviseChange}
        />
      </MemoryRouter>,
    );
    await user.click(buttonSwitch());
    expect(onAdvisorButtonChange).toHaveBeenCalledWith(false);
    await user.click(autoSwitch());
    expect(onAutoAdviseChange).toHaveBeenCalledWith(false);
  });

  it('has no Workspace mode group, and its subtitle covers Profile, Javi and the menu.', () => {
    render(
      <MemoryRouter>
        <GeneralSection {...base} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('group', { name: 'Workspace mode' })).not.toBeInTheDocument();
    expect(screen.getByText('Profile, Javi and the menu.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset general settings' })).toBeInTheDocument();
  });

  it('no longer repeats the AI model choice from Settings > AI', () => {
    render(
      <MemoryRouter>
        <GeneralSection {...base} />
      </MemoryRouter>,
    );
    expect(screen.queryByText("Javi's AI model")).not.toBeInTheDocument();
  });

  it('keeps auto-advise enabled when the bar is Off, since Javi still opens from search', () => {
    render(
      <MemoryRouter>
        <GeneralSection {...base} advisorButton={false} autoAdvise />
      </MemoryRouter>,
    );
    expect(autoSwitch()).not.toHaveAttribute('aria-disabled');
    expect(buttonSwitch()).not.toBeChecked();
    expect(screen.getByText(/You can still open Javi from search or with Alt\+J\./)).toBeInTheDocument();
    expect(buttonSwitch()).toHaveAccessibleDescription(
      'Shows the Javi bar in the bottom-right corner, with a count when something is new. You can still open Javi from search or with Alt+J.',
    );
    expect(screen.queryByText(/round Javi button/)).not.toBeInTheDocument();
    expect(screen.getByText(/Javi gets a new insight when you open it after the page changes\./)).toBeInTheDocument();
  });
});
