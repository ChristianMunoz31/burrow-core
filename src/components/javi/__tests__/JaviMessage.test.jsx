import '@testing-library/jest-dom/vitest';
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import JaviMessage from '../JaviMessage';

afterEach(cleanup);

const ADVICE = '**Money**\n\n- Review the budget\n\n**Tasks:**\n\n- Finish the report\n\n**Health**\n\n**Schedule**\n\n**Other**';
const EMOJI = /[\u{1F300}-\u{1FAFF}✅☀-➿]/u;

describe('JaviMessage', () => {
  it('shows a hidden svg icon, not an emoji, before each category heading', async () => {
    const { container } = render(<JaviMessage role="assistant" content={ADVICE} />);
    await waitFor(() => expect(container.querySelector('strong')).toBeInTheDocument(), { timeout: 5000 });
    const headings = [...container.querySelectorAll('strong')];
    const categories = headings.filter((el) => /^(money|tasks|health|schedule)/i.test(el.textContent));
    expect(categories).toHaveLength(4);
    for (const el of categories) {
      const icon = el.querySelector('svg');
      expect(icon).toBeInTheDocument();
      expect(icon).toHaveAttribute('aria-hidden', 'true');
      expect(icon.nextSibling?.textContent ?? '').not.toBe('');
    }
    expect(container.textContent).not.toMatch(EMOJI);
    const other = headings.find((el) => el.textContent === 'Other');
    expect(other.querySelector('svg')).toBeNull();
  });

  it('renders bullets as action rows for an assistant message', async () => {
    const { container } = render(<JaviMessage role="assistant" content={ADVICE} />);
    await waitFor(() => expect(container.querySelector('ul.javi-actions')).toBeInTheDocument());
    expect(container.querySelector('ul.javi-actions')).toHaveAttribute('role', 'list');
  });

  it('keeps a nested list inside an action row as a list with list semantics', async () => {
    const { container } = render(<JaviMessage role="assistant" content={'- Plan the week\n  - Monday\n  - Tuesday'} />);
    await waitFor(() => expect(container.querySelector('ul.javi-actions ul')).toBeInTheDocument());
    const outer = container.querySelector('ul.javi-actions');
    const inner = outer.querySelector('ul');
    expect(inner).toHaveClass('javi-actions');
    expect(inner).toHaveAttribute('role', 'list');
    expect(inner.querySelectorAll(':scope > li')).toHaveLength(2);
    expect(outer.querySelectorAll(':scope > li')).toHaveLength(1);
  });

  it('renders plain bullets when actions is false (the briefing)', async () => {
    const { container } = render(<JaviMessage role="assistant" content={ADVICE} actions={false} />);
    await waitFor(() => expect(container.querySelector('ul')).toBeInTheDocument());
    expect(container.querySelector('ul.javi-actions')).toBeNull();
  });

  it('does not apply the action list to a user message', () => {
    const { container } = render(<JaviMessage role="user" content="- one\n- two" />);
    expect(container.querySelector('ul')).toBeNull();
    expect(container.querySelector('.javi-actions')).toBeNull();
  });
});
