import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import NetworkOptInNotice from '../NetworkOptInNotice';
import HealthWidget from '../../health/HealthWidget';

const optIn = Object.assign(new Error('Weather is off.'), {
  status: 403,
  code: 'network_opt_in_required',
  feature: 'weather',
});

const hooks = vi.hoisted(() => ({ error: null }));
vi.mock('../../../hooks/useOura', () => ({
  useOura: () => ({ days: [], latest: null, loading: false, error: hooks.error }),
}));

afterEach(() => {
  cleanup();
  hooks.error = null;
});

const inRouter = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('NetworkOptInNotice', () => {
  it('explains the feature is off and links to Settings -> Network', () => {
    inRouter(<NetworkOptInNotice name="Weather" />);
    expect(screen.getByRole('status')).toHaveTextContent('Weather is off because it calls the internet.');
    expect(screen.getByRole('link', { name: /Settings → Network/ })).toHaveAttribute('href', '/settings#network');
  });
});

describe.each([
  ['Sleep & activity', HealthWidget, 'Oura'],
])('%s card on a 403 opt-in error', (_label, Widget, name) => {
  it('renders the inline empty state instead of a generic error', () => {
    hooks.error = optIn;
    inRouter(<Widget />);
    expect(screen.getByText(new RegExp(`${name} is off because it calls the internet`))).toBeInTheDocument();
    expect(screen.getByText(/Turn it on in Settings → Network/)).toBeInTheDocument();
    // The widget is one link to its page; no nested anchor inside it.
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.queryByText(/Could not/)).toBeNull();
  });

  it('keeps the generic message for other errors', () => {
    hooks.error = Object.assign(new Error('boom'), { status: 500 });
    inRouter(<Widget />);
    expect(screen.queryByText(/Settings → Network/)).toBeNull();
    expect(screen.getByText(/Could not/)).toBeInTheDocument();
  });
});
