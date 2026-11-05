import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import BuildIdentityLine from '../BuildIdentityLine';

vi.mock('../../../hooks/useAppInfo', () => ({ useAppInfo: vi.fn() }));
import { useAppInfo } from '../../../hooks/useAppInfo';

// The core list is empty in every stable build; tests push a fake developer section into this mutable copy.
const extensions = vi.hoisted(() => []);
vi.mock('../../../extensions/settingsExtensions', () => ({ SETTINGS_EXTENSIONS: extensions }));

const SEP = ' · ';

afterEach(() => {
  extensions.length = 0;
  cleanup();
  vi.clearAllMocks();
});

describe('BuildIdentityLine', () => {
  it('renders the full line', () => {
    useAppInfo.mockReturnValue({
      info: { version: '0.1.0', channel: 'stable', commit: 'abc1234', buildDate: '2026-10-05T12:00:00Z' },
    });
    render(<BuildIdentityLine />);
    expect(screen.getByTestId('build-identity')).toHaveTextContent(
      ['Version 0.1.0', 'stable', 'abc1234', 'built 2026-10-05'].join(SEP),
    );
  });

  it('hides unknown parts (null commit and build date)', () => {
    useAppInfo.mockReturnValue({ info: { version: '0.1.0', channel: 'dev', commit: null, buildDate: null } });
    render(<BuildIdentityLine />);
    const el = screen.getByTestId('build-identity');
    expect(el).toHaveTextContent(`Version 0.1.0${SEP}dev`);
    expect(el.textContent).not.toMatch(/unknown|null|built|undefined/i);
  });

  it('renders only the parts present when the server omits keys', () => {
    useAppInfo.mockReturnValue({ info: { version: '0.1.0', channel: 'stable', desktop: false } });
    render(<BuildIdentityLine />);
    expect(screen.getByTestId('build-identity').textContent).toBe(`Version 0.1.0${SEP}stable`);
  });

  it('hides an "unknown" version', () => {
    useAppInfo.mockReturnValue({ info: { version: 'unknown', channel: 'stable', commit: null, buildDate: null } });
    render(<BuildIdentityLine />);
    expect(screen.getByTestId('build-identity').textContent).toBe('stable');
  });

  it('renders nothing while the info is not loaded', () => {
    useAppInfo.mockReturnValue({ info: null });
    const { container } = render(<BuildIdentityLine />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('build-identity')).not.toBeInTheDocument();
  });

  it('renders nothing when every part is empty or invalid', () => {
    useAppInfo.mockReturnValue({ info: { version: '', channel: null, commit: null, buildDate: 'garbage' } });
    const { container } = render(<BuildIdentityLine />);
    expect(container).toBeEmptyDOMElement();
  });
  it('says "stable" alone when no developer section shows, even if the server has the tools', () => {
    useAppInfo.mockReturnValue({ info: { version: '0.1.0', channel: 'stable', devTools: true } });
    render(<BuildIdentityLine />);
    expect(screen.getByTestId('build-identity').textContent).toBe(`Version 0.1.0${SEP}stable`);
  });

  it('says "stable · developer tools" when the developer section shows', () => {
    extensions.push({ id: 'developer', enabled: (info) => info?.devTools === true });
    useAppInfo.mockReturnValue({ info: { version: '0.1.0', channel: 'stable', devTools: true } });
    render(<BuildIdentityLine />);
    expect(screen.getByTestId('build-identity').textContent).toBe(`Version 0.1.0${SEP}stable${SEP}developer tools`);
  });

  it('a compiled-in section the server turns off adds nothing', () => {
    extensions.push({ id: 'developer', enabled: (info) => info?.devTools === true });
    useAppInfo.mockReturnValue({ info: { version: '0.1.0', channel: 'stable', devTools: false } });
    render(<BuildIdentityLine />);
    expect(screen.getByTestId('build-identity').textContent).toBe(`Version 0.1.0${SEP}stable`);
  });
});
