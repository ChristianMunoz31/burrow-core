import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Cpu } from 'lucide-react';
import SectionCard from '../shared/SectionCard';
import OllamaSetup from '../shared/OllamaSetup';
import { LINK_CLASS } from '../shared/AiUnavailable';
import { sectionProps } from './settingsSections';
import { ListSkeleton } from '../shared/Skeleton';
import SegmentedRadio from './SegmentedRadio';
import CloudAiBlock from './CloudAiBlock';
import { SaveError } from './aiFormParts';
import { INPUT_CLASS, LABEL_CLASS } from './aiFormStyles';
import { BTN, PILL, TONE_CLASS } from './pillStyles';
import { useAiSettings } from '../../hooks/useAiSettings';

const DEFAULT_HOST = 'http://127.0.0.1:11434';

// Probe codes whose server hint already matches the fixed "open the app or run ollama serve"
// copy below; showing it too would say the same thing twice.
const HINT_REPEATS_COPY = new Set(['connection_refused']);

// Chat-select label for models that technically chat but are a poor fit for Javi.
const SMALL_CONTEXT = 4096;
const modelOptionLabel = (m) => {
  const caps = Array.isArray(m.capabilities) ? m.capabilities : [];
  const notes = [];
  if (caps.includes('vision') && !caps.includes('tools')) notes.push('vision model');
  if (typeof m.contextLength === 'number' && m.contextLength > 0 && m.contextLength < SMALL_CONTEXT) {
    notes.push('small context');
  }
  return notes.length ? `${m.name} (${notes.join(', ')})` : m.name;
};

function StatusBlock({ settings, isFetching, onRefresh, showRetry }) {
  const { ollama, enabled } = settings;
  const extraHint =
    ollama.error?.hint && !HINT_REPEATS_COPY.has(ollama.error.code) ? ollama.error.hint : null;
  const tone = ollama.running ? TONE_CLASS.ok : TONE_CLASS.warn;
  let pill = ollama.running ? 'Ollama is running' : 'Ollama is not running';
  // With AI off the server does not probe Ollama, so there is nothing to report about it.
  if (!enabled) pill = 'AI is off';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start gap-x-2 gap-y-2">
        <div role="status" className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`${PILL} ${enabled ? tone : TONE_CLASS.muted}`}>{pill}</span>
            {ollama.running && !ollama.loopback && (
              <span className={`${PILL} ${TONE_CLASS.muted}`}>another computer</span>
            )}
          </div>
          {ollama.running && (
            <p className="text-xs text-slate-slate400">
              <span className="font-mono text-slate-slate300">{ollama.host}</span>
              {ollama.version && <> · version {ollama.version}</>}
            </p>
          )}
        </div>
        {showRetry && (
          <button type="button" onClick={onRefresh} disabled={isFetching} className={BTN}>
            {isFetching ? 'Checking…' : 'Retry'}
          </button>
        )}
      </div>
      {!enabled && (
        <p className="text-xs text-slate-slate300">
          AI features are turned off on this computer.
        </p>
      )}
      {enabled && !ollama.running && (
        <div className="space-y-2">
          <OllamaSetup />
          {extraHint && <p className="text-xs text-slate-slate300">{extraHint}</p>}
        </div>
      )}
    </div>
  );
}

const canChat = (m) => !Array.isArray(m.capabilities) || m.capabilities.includes('completion');
const canUseTools = (m) => Array.isArray(m.capabilities) && m.capabilities.includes('tools');

function ModelSelect({ id, label, hint, slot, installed, disabled, onChange, toolsOnly }) {
  const options = installed.filter(toolsOnly ? canUseTools : canChat);
  const hintId = `${id}-hint`;
  const missing = slot.selected && !options.some((m) => m.name === slot.selected);
  const isInstalled = installed.some((m) => m.name === slot.selected);
  let missingNote = 'not installed';
  if (isInstalled) missingNote = toolsOnly ? 'no tools support' : 'cannot answer questions';
  const noToolModels = toolsOnly && options.length === 0;
  return (
    <div>
      <label htmlFor={id} className={LABEL_CLASS}>
        {label}
      </label>
      <select
        id={id}
        value={slot.selected ?? ''}
        aria-disabled={disabled || undefined}
        aria-describedby={hintId}
        onChange={(e) => {
          if (disabled) return;
          onChange(e.target.value || null);
        }}
        className={`${INPUT_CLASS} sm:max-w-xs ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
      >
        <option value="">Automatic ({slot.effective ?? 'none available'})</option>
        {missing && (
          <option value={slot.selected}>
            {slot.selected} ({missingNote})
          </option>
        )}
        {options.map((m) => (
          <option key={m.name} value={m.name}>
            {modelOptionLabel(m)}
          </option>
        ))}
      </select>
      <p id={hintId} className="mt-1 text-xs text-slate-slate400">
        {hint}
      </p>
      {noToolModels && (
        <p className="mt-1 text-xs text-accent-amber">
          No installed model supports tools. Download one, for example qwen2.5:7b.
        </p>
      )}
    </div>
  );
}

function ModelSelects({ settings, installed, onSave }) {
  const chatId = useId();
  const toolId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const { chat, tools } = settings.models;

  const save = async (patch) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await onSave({ chatModel: chat.selected, toolModel: tools.selected, ...patch });
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <ModelSelect
          id={chatId}
          label="Model for answers"
          hint="Used for Javi's page advice and the daily briefing."
          slot={chat}
          installed={installed}
          disabled={busy}
          onChange={(chatModel) => save({ chatModel })}
        />
        <ModelSelect
          id={toolId}
          label="Model for your data"
          hint="Used when Javi reads or changes your data. Only models that support tools are listed."
          slot={tools}
          installed={installed}
          disabled={busy}
          toolsOnly
          onChange={(toolModel) => save({ toolModel })}
        />
      </div>
      <SaveError error={error} />
      <p role="status" className="text-xs text-slate-slate300 empty:hidden">
        {saved ? 'Saved.' : ''}
      </p>
      <p className="text-xs text-slate-slate400">
        Memory guide: 7B models need about 8 GB of free RAM, and 3B models need about 4 GB.
      </p>
    </div>
  );
}

function HostBlock({ settings, onSave }) {
  const hostId = useId();
  const { ollama } = settings;
  const [value, setValue] = useState(ollama.hostSource === 'settings' ? ollama.host : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (host) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await onSave(host);
      setValue(next?.ollama?.hostSource === 'settings' ? next.ollama.host : '');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(value.trim() || null);
        }}
      >
        <label htmlFor={hostId} className={LABEL_CLASS}>
          Ollama address
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id={hostId}
            type="text"
            inputMode="url"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={DEFAULT_HOST}
            spellCheck={false}
            autoComplete="off"
            className={`${INPUT_CLASS} flex-1 font-mono`}
          />
          <button type="submit" aria-disabled={busy || undefined} className={BTN}>
            Save address
          </button>
        </div>
      </form>
      <p className="mt-1 text-xs text-slate-slate400">
        Leave empty and save to use {DEFAULT_HOST}. An address on another computer needs the Network setting for
        Ollama on another computer turned on in{' '}
        <Link to={{ pathname: '/settings', hash: '#network' }} className={LINK_CLASS}>
          Settings &gt; Network
        </Link>
        .
      </p>
      <SaveError error={error} kind="host" />
    </div>
  );
}

function Advanced({ settings, onSetHost }) {
  return (
    <details className="border-t border-white/10 pt-4">
      <summary className="cursor-pointer text-xs font-semibold text-slate-slate300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]">
        Advanced
      </summary>
      <div className="mt-4 space-y-6">
        <HostBlock
          key={`${settings.ollama.hostSource}:${settings.ollama.host}`}
          settings={settings}
          onSave={onSetHost}
        />
      </div>
    </details>
  );
}

const SOURCE_OPTIONS = [
  { value: 'local', label: 'On this computer (recommended)' },
  { value: 'cloud', label: 'Your own cloud AI (optional)' },
];

export default function AiSection() {
  const ai = useAiSettings();
  const { settings, installed } = ai;
  // null until the user picks or cloud is found selected; after that the choice sticks, so
  // turning cloud off from its own panel does not yank the user away from it.
  const [choice, setChoice] = useState(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState(null);

  const cloudSelected = Boolean(settings) && (settings.cloud?.active === true || settings.provider === 'openai_compat');
  if (choice === null && cloudSelected) setChoice('cloud');
  const mode = choice ?? 'local';

  // Picking cloud only reveals the panel; nothing is saved or sent until the consent dialog is
  // confirmed. Picking this computer turns cloud AI off if it was on (or waiting for consent).
  const chooseSource = async (next) => {
    if (switching) return;
    setChoice(next);
    setSwitchError(null);
    if (next !== 'local' || !cloudSelected) return;
    setSwitching(true);
    try {
      await ai.disableCloud();
    } catch (err) {
      setChoice('cloud');
      setSwitchError(err);
    } finally {
      setSwitching(false);
    }
  };

  // The guided setup card has its own Check again, which refreshes everything below.
  const setupShown =
    Boolean(settings) &&
    settings.enabled &&
    (!settings.ollama.running ||
      (!ai.modelsLoading && Array.isArray(installed) && installed.length === 0));

  let body;
  if (ai.isLoading) {
    body = <ListSkeleton rows={3} />;
  } else if (!settings) {
    body = (
      <div className="flex flex-wrap items-center gap-3">
        <p role="alert" className="text-sm text-accent-amber">
          Couldn&apos;t load AI settings.
        </p>
        <button type="button" onClick={() => ai.refresh()} className={BTN}>
          Retry
        </button>
      </div>
    );
  } else {
    body = (
      <div className="space-y-5">
        <div aria-busy={switching || undefined}>
          <SegmentedRadio
            legend="Where Javi runs"
            name="javi-source"
            value={mode}
            onChange={chooseSource}
            options={SOURCE_OPTIONS}
          />
          <SaveError error={switchError} kind="cloud" />
        </div>
        {mode === 'cloud' ? (
          <CloudAiBlock ai={ai} settings={settings} />
        ) : (
          <>
            <StatusBlock
              settings={settings}
              isFetching={ai.isFetching}
              onRefresh={() => ai.refresh()}
              showRetry={!setupShown}
            />
            {settings.ollama.running &&
              (ai.modelsLoading ? (
                <ListSkeleton rows={2} />
              ) : installed && installed.length > 0 ? (
                <ModelSelects settings={settings} installed={installed} onSave={ai.setModels} />
              ) : installed ? (
                <OllamaSetup />
              ) : (
                <p role="alert" className="text-xs text-accent-amber">
                  Couldn&apos;t list installed models. Try Retry.
                </p>
              ))}
          </>
        )}
        <Advanced settings={settings} onSetHost={ai.setHost} />
      </div>
    );
  }

  return (
    <SectionCard
      {...sectionProps('ai')}
      title="AI"
      subtitle="Javi runs on your computer through Ollama. Nothing leaves your computer unless you turn on a cloud provider."
      icon={Cpu}
    >
      {body}
    </SectionCard>
  );
}
