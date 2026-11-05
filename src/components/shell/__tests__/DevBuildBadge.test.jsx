import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import DevBuildBadge from '../DevBuildBadge';

const appInfo = vi.hoisted(() => ({ info: null }));
vi.mock('../../../hooks/useAppInfo', () => ({ useAppInfo: () => ({ info: appInfo.info }) }));

afterEach(() => {
  cleanup();
  appInfo.info = null;
});

describe('DevBuildBadge', () => {
  it('renders nothing while the app info is not loaded', () => {
    const { container } = render(<DevBuildBadge />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing in the stable channel', () => {
    appInfo.info = { version: '0.1.0', channel: 'stable', desktop: true };
    const { container } = render(<DevBuildBadge />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a labelled "Dev build" pill in the dev channel', () => {
    appInfo.info = { version: '0.2.0-dev.20261005.abc1234', channel: 'dev', desktop: true };
    render(<DevBuildBadge />);
    const badge = screen.getByTitle('Burrow Dev 0.2.0-dev.20261005.abc1234');
    expect(badge).toHaveTextContent('Dev build');
    expect(badge).toHaveTextContent('Burrow Dev 0.2.0-dev.20261005.abc1234');
    expect(badge).toHaveClass('self-center');
    expect(badge).not.toHaveClass('self-start');
    expect(screen.getByText('Dev')).toHaveClass('sm:hidden');
  });
});
