import { Palette } from 'lucide-react';
import SectionCard from '../shared/SectionCard';
import { sectionProps } from './settingsSections';
import SegmentedRadio from './SegmentedRadio';
import BackgroundPicker from './BackgroundPicker';
import ResetControl from './ResetControl';
import { useTheme } from '../../contexts/ThemeContext';

const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export default function AppearanceSection({
  preference,
  resolvedTheme,
  onPreferenceChange,
  bgDark,
  bgLight,
  onBgDarkChange,
  onBgLightChange,
  onReset,
}) {
  const { founderUnlocked, founderSaved } = useTheme();
  return (
    <SectionCard
      {...sectionProps('appearance')}
      title="Appearance"
      subtitle="Theme and page background. Changes apply immediately."
      icon={Palette}
    >
      <div className="space-y-6">
        <SegmentedRadio
          legend="Theme"
          name="settings-theme"
          value={preference}
          onChange={onPreferenceChange}
          options={THEME_OPTIONS}
          hint={
            preference === 'system'
              ? `Follows your device setting (currently ${resolvedTheme}).`
              : undefined
          }
        />
        <BackgroundPicker
          legend="Dark mode background"
          name="settings-bg-dark"
          value={bgDark}
          onChange={onBgDarkChange}
          founderUnlocked={founderUnlocked}
        />
        <BackgroundPicker
          legend="Light mode background"
          name="settings-bg-light"
          value={bgLight}
          onChange={onBgLightChange}
          founderUnlocked={founderUnlocked}
        />
        {founderSaved && (
          <p className="text-xs text-slate-slate400">
            Your Founder background comes back when a Founding license is active.
          </p>
        )}
        <p className="text-xs text-slate-slate400">
          Backgrounds are hidden while your system's reduced transparency or increased contrast
          setting is on.
        </p>
      </div>
      <div className="mt-4 flex justify-end">
        <ResetControl label="appearance settings" onConfirm={onReset} />
      </div>
    </SectionCard>
  );
}
