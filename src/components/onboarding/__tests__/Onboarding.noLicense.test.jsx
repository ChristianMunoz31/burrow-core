import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { cwd } from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Onboarding from '../Onboarding';

vi.mock('../../../services/profileService', () => ({
  profileService: { get: vi.fn(), update: vi.fn() },
}));
vi.mock('../../../services/stateService', () => ({
  stateService: {
    get: vi.fn(async () => undefined),
    getAll: vi.fn(async () => ({})),
    put: vi.fn(async () => undefined),
  },
}));
vi.mock('../../../services/aiSettingsService', () => ({
  aiSettingsService: { setup: vi.fn(), pull: vi.fn() },
}));
import { profileService } from '../../../services/profileService';
import { aiSettingsService } from '../../../services/aiSettingsService';
import { __resetPullStoreForTests } from '../../../hooks/ollamaPullStore';
import { allowSlowSuite } from '../../../test-utils/slowSuite';

// The first test opens a cold lazy chunk; React holds its reveal at least 300 ms after the fallback,
// which leaves too little of the 1 s findBy default on a busy full run.
allowSlowSuite();

const LICENSING_WORDS = /licen[sc]e|activat|gumroad|lemon squeezy|\bpro\b|trial|founding|purchase/i;

beforeEach(() => {
  localStorage.clear();
  aiSettingsService.setup.mockResolvedValue({
    ollama: 'missing',
    host: 'http://127.0.0.1:11434',
    version: null,
    models: [],
    ready: false,
    ramGb: 16,
    recommended: { tier: 'mid', ramGb: 16, primary: [], optional: [] },
    canPull: true,
  });
  profileService.get.mockResolvedValue({ displayName: null, onboardedAt: null });
});
afterEach(() => {
  cleanup();
  __resetPullStoreForTests();
  vi.clearAllMocks();
});

describe('first-run onboarding has no licensing content', () => {
  it('renders no licensing copy on any step', async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Onboarding />
      </QueryClientProvider>,
    );
    const welcome = await screen.findByRole('dialog', { name: 'Welcome to Burrow' });
    expect(welcome.textContent).not.toMatch(LICENSING_WORDS);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const javi = await screen.findByRole('dialog', { name: 'Set up Javi' });
    expect(javi.textContent).not.toMatch(LICENSING_WORDS);
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));
    const budget = await screen.findByRole('dialog', { name: 'Starter budget' });
    expect(budget.textContent).not.toMatch(LICENSING_WORDS);
  });

  it('the onboarding source files do not mention licensing', () => {
    const dir = resolve(cwd(), 'src/components/onboarding');
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsx'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(resolve(dir, file), 'utf8'), file).not.toMatch(/licen[sc]e/i);
    }
  });
});
