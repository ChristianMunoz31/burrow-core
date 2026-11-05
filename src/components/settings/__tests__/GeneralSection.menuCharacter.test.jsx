import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import GeneralSection from '../GeneralSection';
import { JAVI_CHARACTERS } from '../../../constants/javiCharacters';

vi.mock('../../../hooks/useJarvisStatus', () => ({
  useJarvisStatus: () => ({ status: null, loading: false }),
}));

vi.mock('../DisplayNameField', () => ({ default: () => null }));

// Whether the private module's UI is compiled into the build under test.
const build = vi.hoisted(() => ({ moduleIncluded: true }));
vi.mock('../../../extensions/proExtensions', () => ({
  get PRO_UI_INCLUDED() {
    return build.moduleIncluded;
  },
}));

afterEach(() => {
  cleanup();
  build.moduleIncluded = true;
});

const renderSection = (props = {}) =>
  render(
    <MemoryRouter>
      <GeneralSection onReset={vi.fn()} {...props} />
    </MemoryRouter>,
  );
const hideSwitch = () => screen.getByRole('switch', { name: 'Hide subcategories in the menu' });
const characterGroup = () => screen.getByRole('group', { name: "Javi's character" });
const HINT_TAIL = ' Same manners, different humor. Applies to the next insight.';

describe('GeneralSection hide subcategories', () => {
  it('is off by default and explains how hidden pages stay reachable', () => {
    renderSection();
    expect(hideSwitch()).not.toBeChecked();
    expect(hideSwitch()).toHaveAccessibleDescription(
      'Shows each section as one link to its first page. Every page stays one search away.',
    );
  });

  it('reports the change through the callback', async () => {
    const onNavHideSubcategoriesChange = vi.fn();
    const user = userEvent.setup();
    renderSection({ onNavHideSubcategoriesChange });
    await user.click(hideSwitch());
    expect(onNavHideSubcategoriesChange).toHaveBeenCalledWith(true);
  });
});

describe('GeneralSection Javi character', () => {
  it('shows the four characters with Butler selected by default when the module is included', () => {
    renderSection();
    const labels = JAVI_CHARACTERS.map((c) => c.label);
    expect(labels).toEqual(['Butler', 'Valet', 'Concierge', 'Majordomo']);
    for (const label of labels) {
      expect(screen.getByRole('radio', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('radio', { name: 'Butler' })).toBeChecked();
    expect(characterGroup()).toHaveAccessibleDescription(JAVI_CHARACTERS[0].description + HINT_TAIL);
  });

  it('describes the selected character', () => {
    renderSection({ javiCharacter: 'concierge' });
    expect(screen.getByRole('radio', { name: 'Concierge' })).toBeChecked();
    expect(characterGroup()).toHaveAccessibleDescription(
      'Warm and a touch theatrical. Every task is a five-star request.' + HINT_TAIL,
    );
  });

  it('falls back to Butler for an unknown id', () => {
    renderSection({ javiCharacter: 'nope' });
    expect(screen.getByRole('radio', { name: 'Butler' })).toBeChecked();
  });

  it('reports the chosen id through the callback', async () => {
    const onJaviCharacterChange = vi.fn();
    const user = userEvent.setup();
    renderSection({ onJaviCharacterChange });
    await user.click(screen.getByRole('radio', { name: 'Majordomo' }));
    expect(onJaviCharacterChange).toHaveBeenCalledWith('majordomo');
  });
});

describe('GeneralSection Javi character in a core-only build', () => {
  beforeEach(() => {
    build.moduleIncluded = false;
  });

  it('offers Butler only, with no Pro label, notice or upgrade wording', () => {
    const { container } = renderSection();
    expect(screen.getAllByRole('radio')).toHaveLength(1);
    expect(screen.getByRole('radio', { name: 'Butler' })).toBeChecked();
    expect(characterGroup()).toHaveAccessibleDescription(JAVI_CHARACTERS[0].description + HINT_TAIL);
    expect(container.textContent).not.toMatch(/\bpro\b|buy|upgrade|licen[sc]e|trial/i);
  });

  it('shows Butler even when another character is saved, without rewriting the saved choice', () => {
    const onJaviCharacterChange = vi.fn();
    renderSection({ javiCharacter: 'valet', onJaviCharacterChange });
    expect(screen.getByRole('radio', { name: 'Butler' })).toBeChecked();
    expect(onJaviCharacterChange).not.toHaveBeenCalled();
  });
});
