import { Suspense } from 'react';
import { useTheme } from '../contexts/ThemeContext';
import { useToast } from '../contexts/ToastContext';
import { useAppInfo } from '../hooks/useAppInfo';
import { useSyncedSetting } from '../hooks/useSyncedSetting';
import {
  SETTINGS_DEFAULTS,
  SETTINGS_KEYS,
  normalizeBudgetMonthMode,
  normalizeBudgetView,
  normalizeJaviAdvisorButton,
  normalizeJaviAutoAdvise,
  normalizeJaviCharacter,
  normalizeNavHideSubcategories,
} from '../constants/settingsDefaults';
import { usePageContext } from '../contexts/PageContextContext';
import { buildSettingsContext } from '../utils/javiBuilders/settings';
import AppearanceSection from '../components/settings/AppearanceSection';
import BudgetSection from '../components/settings/BudgetSection';
import GeneralSection from '../components/settings/GeneralSection';
import AiSection from '../components/settings/AiSection';
import DataStorageSection from '../components/settings/DataStorageSection';
import PrivacyActivitySection from '../components/settings/PrivacyActivitySection';
import NetworkSection from '../components/settings/NetworkSection';
import ApiKeysSection from '../components/settings/ApiKeysSection';
import ResetControl from '../components/settings/ResetControl';
import SettingsLayout from '../components/settings/SettingsLayout';
import UpdatesSection from '../components/settings/UpdatesSection';
import { SETTINGS_EXTENSIONS } from '../extensions/settingsExtensions';
import BuildIdentityLine from '../components/settings/BuildIdentityLine';

export default function Settings() {
  const toast = useToast();
  const { info } = useAppInfo();
  const { theme, preference, setPreference, bgDark, bgLight, setBgDark, setBgLight } = useTheme();
  const [storedView, setView] = useSyncedSetting(
    SETTINGS_KEYS.budgetView,
    SETTINGS_DEFAULTS.budgetView,
  );
  const [storedMonthMode, setMonthMode] = useSyncedSetting(
    SETTINGS_KEYS.budgetMonth,
    SETTINGS_DEFAULTS.budgetMonth,
  );
  const [storedAdvisorButton, setAdvisorButton] = useSyncedSetting(
    SETTINGS_KEYS.javiAdvisorButton,
    SETTINGS_DEFAULTS.javiAdvisorButton,
  );
  const [storedAutoAdvise, setAutoAdvise] = useSyncedSetting(
    SETTINGS_KEYS.javiAutoAdvise,
    SETTINGS_DEFAULTS.javiAutoAdvise,
  );
  const [storedJaviCharacter, setJaviCharacter] = useSyncedSetting(
    SETTINGS_KEYS.javiCharacter,
    SETTINGS_DEFAULTS.javiCharacter,
  );
  const [storedNavHideSubcategories, setNavHideSubcategories] = useSyncedSetting(
    SETTINGS_KEYS.navHideSubcategories,
    SETTINGS_DEFAULTS.navHideSubcategories,
  );
  const advisorButton = normalizeJaviAdvisorButton(storedAdvisorButton);
  const autoAdvise = normalizeJaviAutoAdvise(storedAutoAdvise);
  const javiCharacter = normalizeJaviCharacter(storedJaviCharacter);
  const navHideSubcategories = normalizeNavHideSubcategories(storedNavHideSubcategories);

  usePageContext('settings', () =>
    buildSettingsContext({
      themePreference: preference,
      advisorButton,
      autoAdvise,
    }),
  );

  // Values apply locally at once; saving to the data file is best-effort. One error toast
  // per user action (a reset saves several keys) when the save fails.
  const saveOptions = () => {
    let shown = false;
    return {
      onError: () => {
        if (shown) return;
        shown = true;
        toast({
          message: "Couldn't save settings. Changes are kept on this device only.",
          type: 'error',
        });
      },
    };
  };
  const withSave = (setter) => (value) => setter(value, saveOptions());

  const resetAppearance = (opts) => {
    setPreference(SETTINGS_DEFAULTS.theme, opts);
    setBgDark(SETTINGS_DEFAULTS.bgDark, opts);
    setBgLight(SETTINGS_DEFAULTS.bgLight, opts);
  };

  const resetBudget = (opts) => {
    setView(SETTINGS_DEFAULTS.budgetView, opts);
    setMonthMode(SETTINGS_DEFAULTS.budgetMonth, opts);
  };

  const resetGeneral = (opts) => {
    setAdvisorButton(SETTINGS_DEFAULTS.javiAdvisorButton, opts);
    setAutoAdvise(SETTINGS_DEFAULTS.javiAutoAdvise, opts);
    setJaviCharacter(SETTINGS_DEFAULTS.javiCharacter, opts);
    setNavHideSubcategories(SETTINGS_DEFAULTS.navHideSubcategories, opts);
  };

  const done = (label, fn) => () => {
    fn(saveOptions());
    toast({ message: `${label} reset to defaults.`, type: 'success' });
  };

  const resetAll = () => {
    const opts = saveOptions();
    resetAppearance(opts);
    resetBudget(opts);
    resetGeneral(opts);
    toast({ message: 'All settings reset to defaults.', type: 'success' });
  };

  return (
    <SettingsLayout>
      <div className="mb-5">
        <h2 className="text-xl font-bold text-slate-slate100 tracking-tight">Settings</h2>
        <p className="text-sm text-slate-slate400 mt-1">Your preferences. Saved on this computer.</p>
      </div>

      <div className="space-y-4">
        <AppearanceSection
          preference={preference}
          resolvedTheme={theme}
          onPreferenceChange={withSave(setPreference)}
          bgDark={bgDark}
          bgLight={bgLight}
          onBgDarkChange={withSave(setBgDark)}
          onBgLightChange={withSave(setBgLight)}
          onReset={done('Appearance', resetAppearance)}
        />
        <BudgetSection
          view={normalizeBudgetView(storedView)}
          monthMode={normalizeBudgetMonthMode(storedMonthMode)}
          onViewChange={withSave(setView)}
          onMonthModeChange={withSave(setMonthMode)}
          onReset={done('Budget', resetBudget)}
        />
        <GeneralSection
          advisorButton={advisorButton}
          onAdvisorButtonChange={withSave(setAdvisorButton)}
          autoAdvise={autoAdvise}
          onAutoAdviseChange={withSave(setAutoAdvise)}
          javiCharacter={javiCharacter}
          onJaviCharacterChange={withSave(setJaviCharacter)}
          navHideSubcategories={navHideSubcategories}
          onNavHideSubcategoriesChange={withSave(setNavHideSubcategories)}
          onReset={done('General', resetGeneral)}
        />
        <AiSection />
        <DataStorageSection />
        <PrivacyActivitySection />
        <NetworkSection />
        <ApiKeysSection />
        <UpdatesSection />
        {SETTINGS_EXTENSIONS.filter((e) => e.enabled(info) === true).map(({ id, Component }) => (
          <Suspense key={id} fallback={null}>
            <Component />
          </Suspense>
        ))}
        <div className="flex flex-col items-start gap-1.5 pt-2">
          <ResetControl label="all settings" triggerText="Reset all to defaults" onConfirm={resetAll} />
          <p className="text-xs text-slate-slate400">
            Does not change your AI model choices or connected services.
          </p>
        </div>
        <BuildIdentityLine />
      </div>
    </SettingsLayout>
  );
}
