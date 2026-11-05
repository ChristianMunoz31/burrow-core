import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { titleForPath, useDocumentTitle } from '../useDocumentTitle';

function Probe({ path }) {
  useDocumentTitle(path);
  return null;
}

afterEach(cleanup);

describe('titleForPath', () => {
  it('is just Burrow on Home and on unknown paths', () => {
    expect(titleForPath('/')).toBe('Burrow');
    expect(titleForPath('/nowhere')).toBe('Burrow');
  });

  it('uses the nav label for a page and for its sub-pages', () => {
    expect(titleForPath('/todos')).toBe('Todos · Burrow');
    expect(titleForPath('/settings/data')).toBe('Settings · Burrow');
    expect(titleForPath('/budget/planner')).toBe('Budget · Burrow');
  });

  it('keeps the titles of the pages that left the drawer or became Shared', () => {
    expect(titleForPath('/settings')).toBe('Settings · Burrow');
    expect(titleForPath('/calendar')).toBe('Calendar · Burrow');
    expect(titleForPath('/folders')).toBe('Folders · Burrow');
  });

  it('prefers the most specific nav item', () => {
    expect(titleForPath('/budget/subscriptions')).toBe('Subscriptions · Burrow');
  });
});

describe('useDocumentTitle', () => {
  it('sets and updates document.title with the route', () => {
    const { rerender } = render(<Probe path="/habits" />);
    expect(document.title).toBe('Habits · Burrow');
    rerender(<Probe path="/" />);
    expect(document.title).toBe('Burrow');
  });
});
