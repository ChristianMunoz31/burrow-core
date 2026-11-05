import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CloudAiConsentDialog from '../CloudAiConsentDialog';
import { CLOUD_CATEGORY_DEFAULTS } from '../../../constants/cloudAi';

afterEach(cleanup);

const HOST = 'api.example.com';
const BASE_URL = `https://${HOST}/v1`;

function setup(over = {}) {
  const props = {
    host: HOST,
    baseUrl: BASE_URL,
    categories: { ...CLOUD_CATEGORY_DEFAULTS },
    onConfirm: vi.fn().mockResolvedValue(undefined),
    onCancel: vi.fn(),
    ...over,
  };
  render(<CloudAiConsentDialog {...props} />);
  return props;
}

const confirmButton = () => screen.getByRole('button', { name: 'Turn on cloud AI' });
const sendsBox = () => screen.getByRole('checkbox', { name: /my data goes to api\.example\.com/ });
const payBox = () => screen.getByRole('checkbox', { name: /I pay api\.example\.com directly/ });

describe('CloudAiConsentDialog copy', () => {
  it('names the host, what leaves and what stays', () => {
    setup();
    const dialog = screen.getByRole('dialog', { name: 'Turn on your own cloud AI' });
    expect(within(dialog).getByText(`Javi will send requests to ${HOST} instead of running on this computer.`)).toBeInTheDocument();
    expect(within(dialog).getByText('What leaves your computer:')).toBeInTheDocument();
    expect(within(dialog).getByText('What you ask Javi, and your recent conversation with Javi.')).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        'Data from the kinds you allow: Budget, Todos, Calendar, Habits, Bookmarks, Countdowns and Focus sessions.',
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('Your display name, if you set one.')).toBeInTheDocument();
    expect(within(dialog).getByText('What stays here:')).toBeInTheDocument();
    expect(
      within(dialog).getByText('Health, Notes, Journal and Folders. You can change this any time in Settings > AI.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Javi's saved memory about you.")).toBeInTheDocument();
    expect(
      within(dialog).getByText(`Your API key. It is stored encrypted on this computer and only sent to ${HOST}.`),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        /This also turns on "Cloud AI provider" in Settings > Network\./,
      ),
    ).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/[‒-―]/);
  });

  it('says no saved data leaves when every kind is off, and drops the stays-here line for none withheld', () => {
    const none = Object.fromEntries(Object.keys(CLOUD_CATEGORY_DEFAULTS).map((id) => [id, false]));
    setup({ categories: none });
    expect(screen.getByText('No saved data. Javi will only see what you type.')).toBeInTheDocument();
    cleanup();
    const all = Object.fromEntries(Object.keys(CLOUD_CATEGORY_DEFAULTS).map((id) => [id, true]));
    setup({ categories: all });
    expect(screen.queryByText(/You can change this any time in Settings > AI/)).not.toBeInTheDocument();
  });

  it('uses the default kinds when the payload has no categories', () => {
    setup({ categories: undefined });
    expect(screen.getByText(/Data from the kinds you allow: Budget, Todos/)).toBeInTheDocument();
  });

  it('has two native, labelled checkboxes that start unticked, and exact statements', () => {
    setup();
    expect(sendsBox()).not.toBeChecked();
    expect(payBox()).not.toBeChecked();
    expect(
      screen.getByText(
        `I understand my data goes to ${HOST}, and that company's privacy policy applies to it, not Burrow's.`,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        `I understand I pay ${HOST} directly for this. Burrow doesn't charge for it and can't see or limit the cost.`,
      ),
    ).toBeInTheDocument();
    expect(sendsBox().tagName).toBe('INPUT');
    expect(sendsBox()).toHaveAttribute('type', 'checkbox');
  });
});

describe('CloudAiConsentDialog opt-in flow', () => {
  it('focuses the first checkbox when it opens', () => {
    setup();
    expect(sendsBox()).toHaveFocus();
  });

  it('cannot confirm until both boxes are ticked, and says why', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    expect(confirmButton()).toHaveAttribute('aria-disabled', 'true');

    await user.click(confirmButton());
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Tick both boxes to continue.');
    expect(sendsBox()).toHaveFocus();

    await user.click(sendsBox());
    await user.click(confirmButton());
    expect(onConfirm).not.toHaveBeenCalled();
    expect(payBox()).toHaveFocus();
    expect(confirmButton()).toHaveAttribute('aria-describedby', screen.getByRole('alert').id);
  });

  it('clears the inline error once both boxes are ticked, then confirms with the exact body', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await user.click(confirmButton());
    expect(screen.getByRole('alert')).toHaveTextContent('Tick both boxes');

    await user.click(sendsBox());
    await user.click(payBox());
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
    expect(confirmButton()).not.toHaveAttribute('aria-disabled');

    await user.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith({
      version: 1,
      host: HOST,
      baseUrl: BASE_URL,
      acknowledgements: ['sends_data', 'pay_provider'],
    });
  });

  it('un-ticking a box disables confirm again', async () => {
    const user = userEvent.setup();
    const { onConfirm } = setup();
    await user.click(sendsBox());
    await user.click(payBox());
    await user.click(payBox());
    expect(confirmButton()).toHaveAttribute('aria-disabled', 'true');
    await user.click(confirmButton());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Cancel and Escape send nothing', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = setup();
    await user.click(sendsBox());
    await user.click(payBox());
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows fixed copy for a rejected confirm and lets the user try again', async () => {
    const user = userEvent.setup();
    const onConfirm = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('raw upstream text'), { code: 'host_changed' }))
      .mockRejectedValueOnce(Object.assign(new Error('raw upstream text'), { code: 'surprise' }))
      .mockResolvedValue(undefined);
    setup({ onConfirm });
    await user.click(sendsBox());
    await user.click(payBox());
    await user.click(confirmButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('The provider address changed. Close this and try again.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('raw upstream text');

    await user.click(confirmButton());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Couldn't turn on cloud AI. Try again."));

    await user.click(confirmButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(3));
  });

  it('cannot be cancelled or dismissed while the request is in flight', async () => {
    const user = userEvent.setup();
    let release;
    const onConfirm = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const { onCancel } = setup({ onConfirm });
    await user.click(sendsBox());
    await user.click(payBox());
    await user.click(confirmButton());
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).not.toHaveBeenCalled();
    release();
  });

  it('is described by the intro paragraph', () => {
    setup();
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(
      `Javi will send requests to ${HOST} instead of running on this computer.`,
    );
  });

  it('ignores a second click while the request is in flight', async () => {
    const user = userEvent.setup();
    let release;
    const onConfirm = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    setup({ onConfirm });
    await user.click(sendsBox());
    await user.click(payBox());
    await user.click(confirmButton());
    await user.click(screen.getByRole('button', { name: 'Turning on…' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    release();
  });
});
