import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import AiSourceBadge from '../AiSourceBadge';

afterEach(cleanup);

describe('AiSourceBadge', () => {
  it('names the cloud host', () => {
    render(<AiSourceBadge ai={{ kind: 'cloud', host: 'api.example.com' }} />);
    expect(screen.getByText('Cloud: api.example.com')).toBeInTheDocument();
  });

  it('names the machine on your network', () => {
    render(<AiSourceBadge ai={{ kind: 'lan', host: 'nas.example.com' }} />);
    expect(screen.getByText('On your network: nas.example.com')).toBeInTheDocument();
  });

  it('says on this computer for local', () => {
    render(<AiSourceBadge ai={{ kind: 'local', host: null }} />);
    expect(screen.getByText('On this computer')).toBeInTheDocument();
  });

  it('exposes the full text as a title for truncated hosts', () => {
    const { container } = render(<AiSourceBadge ai={{ kind: 'cloud', host: 'api.example.com' }} />);
    expect(container.querySelector('[data-ai-kind="cloud"]')).toHaveAttribute('title', 'Cloud: api.example.com');
  });

  it('marks the kind for styling hooks and hides decorative icons from assistive tech', () => {
    const { container } = render(<AiSourceBadge ai={{ kind: 'cloud', host: 'api.example.com' }} />);
    expect(container.querySelector('[data-ai-kind="cloud"]')).toBeInTheDocument();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('falls back to plain words when the host is missing', () => {
    render(<AiSourceBadge ai={{ kind: 'cloud', host: null }} />);
    expect(screen.getByText('Cloud: your provider')).toBeInTheDocument();
  });

  it.each([[undefined], [null], [{ kind: 'mystery', host: 'x' }]])('renders nothing for %j', (ai) => {
    const { container } = render(<AiSourceBadge ai={ai} />);
    expect(container).toBeEmptyDOMElement();
  });
});
