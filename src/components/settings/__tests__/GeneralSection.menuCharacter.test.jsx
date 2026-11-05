import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import GeneralSection from '../GeneralSection';
import { JAVI_CHARACTERS } from '../../../constants/javiCharacters';

vi.mock('../../../hooks/useJarvisStatus', () => ({
  useJarvisStatus: () => ({ status: null, loading: false }),
}));

vi.mock('../DisplayNameField', () => ({ default: () => null }));

vi.mock('../../license/ProGateNotice', () => ({
  default: ({ capability }) => <div data-testid="pro-gate" data-capability={capability} />,
}));

afterEach(cleanup);

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
  it('shows the four characters with Butler selected by default', () => {
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

describe('GeneralSection Javi character when locked (Pro perk)', () => {
  it('marks the three Pro characters, keeps Butler plain and mentions Pro in the hint', () => {
    renderSection({ charactersLocked: true });
    expect(screen.getByRole('radio', { name: 'Butler' })).toBeChecked();
    for (const label of ['Valet', 'Concierge', 'Majordomo']) {
      expect(screen.getByRole('radio', { name: `${label} (Pro)` })).toBeInTheDocument();
      expect(screen.queryByRole('radio', { name: label })).not.toBeInTheDocument();
    }
    expect(characterGroup()).toHaveAccessibleDescription(
      JAVI_CHARACTERS[0].description + HINT_TAIL + ' Valet, Concierge and Majordomo come with Burrow Pro.',
    );
  });

  it('shows Butler even when a Pro character is saved', () => {
    renderSection({ charactersLocked: true, javiCharacter: 'valet' });
    expect(screen.getByRole('radio', { name: 'Butler' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Valet (Pro)' })).not.toBeChecked();
  });

  it('does not save a Pro pick and shows the Pro notice instead', async () => {
    const onJaviCharacterChange = vi.fn();
    const user = userEvent.setup();
    renderSection({ charactersLocked: true, onJaviCharacterChange });
    expect(screen.queryByTestId('pro-gate')).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Valet (Pro)' }));
    expect(onJaviCharacterChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('pro-gate')).toHaveAttribute('data-capability', 'javi_characters');
    expect(screen.getByRole('radio', { name: 'Butler' })).toBeChecked();
  });

  it('is unchanged when not locked: no labels, no notice, the pick is saved', async () => {
    const onJaviCharacterChange = vi.fn();
    const user = userEvent.setup();
    renderSection({ onJaviCharacterChange });
    await user.click(screen.getByRole('radio', { name: 'Valet' }));
    expect(onJaviCharacterChange).toHaveBeenCalledWith('valet');
    expect(screen.queryByTestId('pro-gate')).not.toBeInTheDocument();
  });
});
