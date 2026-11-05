import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ReportLink from '../ReportLink';
import { REPORT_EMAIL, reportContentHref } from '../reportContent';

describe('ReportLink (policy 11.16)', () => {
  afterEach(cleanup);

  it('is a link with an accessible name', () => {
    render(<ReportLink />);
    const link = screen.getByRole('link', { name: 'Report this Javi reply by email' });
    expect(link).toHaveTextContent('Report');
  });

  it('is a mailto link with a subject and an empty template, and no message content', () => {
    render(<ReportLink />);
    const href = screen.getByRole('link').getAttribute('href');
    expect(href).toBe(reportContentHref());
    const url = new URL(href);
    expect(url.protocol).toBe('mailto:');
    expect(decodeURIComponent(url.pathname)).toBe(REPORT_EMAIL);
    expect(url.searchParams.get('subject')).toBe('Burrow: report AI content');
    expect(url.searchParams.get('body')).toMatch(/^Describe what Javi said/);
    expect([...url.searchParams.keys()].sort()).toEqual(['body', 'subject']);
    expect(href).not.toMatch(/[ +]/);
  });

  it('takes an aria-label for the briefing and keeps a 24 px target on narrow screens', () => {
    render(<ReportLink label="Report this briefing by email" />);
    const link = screen.getByRole('link', { name: 'Report this briefing by email' });
    expect(link).toHaveClass('max-sm:inline-flex', 'max-sm:min-h-6', 'max-sm:items-center');
  });

  it('takes no message text', () => {
    expect(reportContentHref.length).toBe(0);
  });

  it('uses the support address from config/store.json', () => {
    const store = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'config', 'store.json'), 'utf8'));
    expect(REPORT_EMAIL).toBe(store.supportContact);
  });
});
