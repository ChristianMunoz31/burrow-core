import { useId, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import SectionCard from '../shared/SectionCard';
import { sectionProps } from './settingsSections';
import ResetControl from './ResetControl';
import DisplayNameField from './DisplayNameField';
import SwitchToggle from './SwitchToggle';
import SegmentedRadio from './SegmentedRadio';
import ProGateNotice from '../license/ProGateNotice';
import { JAVI_CHARACTERS } from '../../constants/javiCharacters';

// Butler is free; the other characters are a Pro perk (javi_characters). The server enforces it too.
const FREE_CHARACTER = JAVI_CHARACTERS[0].id;
const optionsFor = (locked) =>
  JAVI_CHARACTERS.map(({ id, label }) => ({ value: id, label: locked && id !== FREE_CHARACTER ? `${label} (Pro)` : label }));
const OPEN_OPTIONS = optionsFor(false);
const LOCKED_OPTIONS = optionsFor(true);

export default function GeneralSection({
  advisorButton = true,
  onAdvisorButtonChange,
  autoAdvise = true,
  onAutoAdviseChange,
  javiCharacter = 'butler',
  onJaviCharacterChange,
  charactersLocked = false,
  navHideSubcategories = false,
  onNavHideSubcategoriesChange,
  onReset,
}) {
  const buttonLabelId = useId();
  const buttonHintId = useId();
  const adviseLabelId = useId();
  const adviseHintId = useId();
  const [proAttempt, setProAttempt] = useState(false);
  const shown = charactersLocked ? FREE_CHARACTER : javiCharacter;
  const character = JAVI_CHARACTERS.find((c) => c.id === shown) ?? JAVI_CHARACTERS[0];
  const chooseCharacter = (id) => {
    if (charactersLocked && id !== FREE_CHARACTER) {
      setProAttempt(true);
      return;
    }
    setProAttempt(false);
    onJaviCharacterChange?.(id);
  };
  const navHideLabelId = useId();
  const navHideHintId = useId();
  return (
    <SectionCard
      {...sectionProps('general')}
      title="General"
      subtitle="Profile, Javi and the menu."
      icon={SlidersHorizontal}
    >
      <div className="space-y-6">
        <DisplayNameField />
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p id={buttonLabelId} className="text-sm font-semibold text-slate-slate100">
              Show the Javi bar
            </p>
            <p id={buttonHintId} className="mt-0.5 text-xs text-slate-slate400">
              Shows the Javi bar in the bottom-right corner, with a count when something is new. You can still open Javi
              from search or with Alt+J.
            </p>
          </div>
          <SwitchToggle
            checked={advisorButton}
            labelledBy={buttonLabelId}
            describedBy={buttonHintId}
            onChange={onAdvisorButtonChange}
          />
        </div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p id={adviseLabelId} className="text-sm font-semibold text-slate-slate100">
              Get an insight when Javi opens
            </p>
            <p id={adviseHintId} className="mt-0.5 text-xs text-slate-slate400">
              Javi gets a new insight when you open it after the page changes. Each insight counts toward Javi&apos;s limit
              of 20 requests every 15 minutes, shared with your questions.
            </p>
          </div>
          <SwitchToggle
            checked={autoAdvise}
            labelledBy={adviseLabelId}
            describedBy={adviseHintId}
            onChange={onAutoAdviseChange}
          />
        </div>
        <div>
          <SegmentedRadio
            legend="Javi's character"
            value={character.id}
            onChange={chooseCharacter}
            options={charactersLocked ? LOCKED_OPTIONS : OPEN_OPTIONS}
            hint={`${character.description} Same manners, different humor. Applies to the next insight.${
              charactersLocked ? ' Valet, Concierge and Majordomo come with Burrow Pro.' : ''
            }`}
          />
          {charactersLocked && proAttempt && <ProGateNotice capability="javi_characters" className="mt-2" />}
        </div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p id={navHideLabelId} className="text-sm font-semibold text-slate-slate100">
              Hide subcategories in the menu
            </p>
            <p id={navHideHintId} className="mt-0.5 text-xs text-slate-slate400">
              Shows each section as one link to its first page. Every page stays one search away.
            </p>
          </div>
          <SwitchToggle
            checked={navHideSubcategories}
            labelledBy={navHideLabelId}
            describedBy={navHideHintId}
            onChange={onNavHideSubcategoriesChange}
          />
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        <ResetControl label="general settings" onConfirm={onReset} />
      </div>
    </SectionCard>
  );
}
