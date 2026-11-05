import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import JaviPanel from '../JaviPanel';
import { EMPTY_AGENT } from '../timeline';
import { TRANSACTION_IMPORT_EVENT } from '../../budget/openTransactionImport';

// The panel reads Javi's source from the status query; these tests are not about that.
vi.mock('../../../hooks/useJarvisStatus', () => ({
  useJarvisStatus: () => ({ status: null, loading: false, error: null }),
}));

afterEach(cleanup);

const idleThread = { messages: [], status: 'idle', error: null, lastRequestMessages: null, partial: '' };

function setup(pageKey) {
  const order = [];
  const onClose = vi.fn(() => order.push('close'));
  const listener = () => order.push('import');
  window.addEventListener(TRANSACTION_IMPORT_EVENT, listener);
  render(
    <MemoryRouter>
      <JaviPanel
        id="panel"
        pageKey={pageKey}
        pageLabel="Page"
        thread={idleThread}
        suggestions={[]}
        agent={EMPTY_AGENT}
        onSend={vi.fn()}
        onSuggestion={vi.fn()}
        onNewAdvice={vi.fn()}
        onRetry={vi.fn()}
        onRespond={vi.fn()}
        onNewChat={vi.fn()}
        onClose={onClose}
      />
    </MemoryRouter>,
  );
  return { order, onClose, off: () => window.removeEventListener(TRANSACTION_IMPORT_EVENT, listener) };
}

describe('JaviPanel budget import button', () => {
  it('closes the panel first, then asks for the import dialog', async () => {
    const user = userEvent.setup();
    const { order, onClose, off } = setup('budget');
    await user.click(screen.getByRole('button', { name: 'Import transactions' }));
    off();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['close', 'import']);
  });

  it('is only offered on the budget page', () => {
    const { off } = setup('todos');
    off();
    expect(screen.queryByRole('button', { name: 'Import transactions' })).not.toBeInTheDocument();
  });
});
