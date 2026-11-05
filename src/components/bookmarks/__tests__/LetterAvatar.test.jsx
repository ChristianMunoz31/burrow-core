import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import LetterAvatar from '../LetterAvatar';
import { hostnameOf, hueForHost } from '../url';

afterEach(cleanup);

describe('LetterAvatar', () => {
  it('shows the first letter of the hostname, uppercased, without any image', () => {
    const { container } = render(<LetterAvatar url="https://www.github.com/burrow" />);
    expect(screen.getByTestId('letter-avatar')).toHaveTextContent('g');
    expect(container.querySelector('img')).toBeNull();
  });

  it('accepts a bare host', () => {
    render(<LetterAvatar url="docs.example.com" />);
    expect(screen.getByTestId('letter-avatar')).toHaveTextContent('d');
  });

  it('uses the same color for the same host and may differ across hosts', () => {
    const { unmount } = render(<LetterAvatar url="https://news.com/a" />);
    const first = screen.getByTestId('letter-avatar').style.backgroundColor;
    unmount();
    render(<LetterAvatar url="https://news.com/b" />);
    expect(screen.getByTestId('letter-avatar').style.backgroundColor).toBe(first);
    expect(hueForHost('news.com')).toBe(hueForHost('news.com'));
    expect(hueForHost('news.com')).not.toBe(hueForHost('github.com'));
  });

  it('falls back to a neutral icon for an unparseable URL', () => {
    render(<LetterAvatar url="http://" />);
    expect(screen.queryByTestId('letter-avatar')).toBeNull();
  });
});

describe('hostnameOf', () => {
  it('strips www and returns null for garbage', () => {
    expect(hostnameOf('https://www.example.org/x')).toBe('example.org');
    expect(hostnameOf('http://')).toBeNull();
  });
});
