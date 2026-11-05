import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import Markdown from '../Markdown';
import { allowSlowSuite } from '../../../test-utils/slowSuite';

// The first test opens a cold lazy chunk; React holds its reveal at least 300 ms after the fallback,
// which leaves too little of the 1 s findBy default on a busy full run.
allowSlowSuite();

afterEach(cleanup);

describe('Markdown (lazy)', () => {
  it('shows the raw text, hidden from assistive tech, until the parser chunk loads, then renders GFM', async () => {
    const { container } = render(<Markdown>{'**bold** and\n\n| a | b |\n| - | - |\n| 1 | 2 |'}</Markdown>);
    expect(container.querySelector('p[aria-hidden="true"]')).toHaveTextContent('**bold**');
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(container.querySelector('strong')).toHaveTextContent('bold');
    expect(container.querySelector('p[aria-hidden="true"]')).toBeNull();
  });

  it('passes disallowedElements and components through to react-markdown', async () => {
    const { container } = render(
      <Markdown disallowedElements={['img']} unwrapDisallowed components={{ a: ({ children }) => <b data-x="1">{children}</b> }}>
        {'![alt text](http://x.test/i.png) [link](http://x.test)'}
      </Markdown>,
    );
    expect(await screen.findByText('link')).toHaveAttribute('data-x', '1');
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders no svg element, even when a caller tries to turn raw HTML on', async () => {
    const source = 'before\n\n<svg viewBox="0 0 1 1"><circle/></svg>\n\nafter';
    const { container } = render(
      <Markdown rehypePlugins={[]} remarkRehypeOptions={{ allowDangerousHtml: true }} allowDangerousHtml>
        {source}
      </Markdown>,
    );
    await screen.findByText('before', {}, { timeout: 3000 });
    await waitFor(() => expect(container.querySelector('p[aria-hidden="true"]')).toBeNull());
    expect(container.querySelector('svg, circle')).toBeNull();
  });

  it('parses every GFM extension without remark-gfm (strikethrough, task list, autolink, footnote, table alignment)', async () => {
    const source = [
      '~~gone~~ and www.example.test',
      '',
      '- [x] done',
      '- [ ] open',
      '',
      'Note[^1]',
      '',
      '| left | right |',
      '| :- | -: |',
      '| 1 | 2 |',
      '',
      '[^1]: The footnote.',
    ].join('\n');
    const { container } = render(<Markdown>{source}</Markdown>);
    await screen.findByRole('table');
    expect(container.querySelector('del')).toHaveTextContent('gone');
    expect(container.querySelector('a[href="http://www.example.test"]')).toHaveTextContent('www.example.test');
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    expect([...boxes].map((box) => box.checked)).toEqual([true, false]);
    expect(container.querySelector('sup a[data-footnote-ref]')).toBeInTheDocument();
    expect(container.querySelector('section[data-footnotes]')).toHaveTextContent('The footnote.');
    expect(container.querySelector('td[style*="right"], th[style*="right"]')).toBeInTheDocument();
  });
});
