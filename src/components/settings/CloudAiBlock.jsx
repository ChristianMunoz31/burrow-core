import { useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LINK_CLASS } from '../shared/AiUnavailable';
import { BTN } from './pillStyles';
import { CloudKey, SaveError } from './aiFormParts';
import { INPUT_CLASS, LABEL_CLASS, PRIMARY_BTN } from './aiFormStyles';
import CloudCategoryList from './CloudCategoryList';
import CloudAiConsentDialog from './CloudAiConsentDialog';
import { CLOUD_CATEGORY_DEFAULTS } from '../../constants/cloudAi';

const BANNER = 'rounded-lg bg-accent-amber/15 p-3 text-sm text-accent-amber';

/**
 * Your own cloud AI: provider address, model and key, what it may see, and the switch. Nothing
 * here turns cloud AI on by itself; only the consent dialog does, after two ticked statements.
 * @param {{ ai: ReturnType<typeof import('../../hooks/useAiSettings').useAiSettings>,
 *   settings: import('../../services/aiSettingsService').AiSettings }} props
 */
export default function CloudAiBlock({ ai, settings }) {
  const urlId = useId();
  const modelId = useId();
  const tokenId = useId();
  const readyHintId = useId();
  const { cloud, provider } = settings;
  const consent = cloud.consent ?? { current: false };
  const host = cloud.host ?? null;
  const savedBaseUrl = cloud.baseUrl ?? null;
  const active = cloud.active === true;
  const paused = provider === 'openai_compat' && !consent.current;
  const networkOff = consent.current && !cloud.optIn && !active;
  const categories = cloud.categories ?? CLOUD_CATEGORY_DEFAULTS;

  const [baseUrl, setBaseUrl] = useState(cloud.baseUrl ?? '');
  const [model, setModel] = useState(cloud.model ?? '');
  const [tokenParam, setTokenParam] = useState(cloud.tokenParam ?? 'max_tokens');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [offBusy, setOffBusy] = useState(false);
  const [offError, setOffError] = useState(null);
  const [providerChanged, setProviderChanged] = useState(false);
  const turnOffRef = useRef(null);

  const saveCloud = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setProviderChanged(false);
    const hadConsent = consent.current === true;
    try {
      const saved = await ai.setCloud({ baseUrl: baseUrl.trim(), model: model.trim(), tokenParam });
      if (hadConsent && saved?.cloud?.consent?.current !== true) setProviderChanged(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    if (offBusy) return;
    setOffBusy(true);
    setOffError(null);
    try {
      await ai.disableCloud();
    } catch (err) {
      setOffError(err);
    } finally {
      setOffBusy(false);
    }
  };

  const openDialog = () => {
    if (cloud.ready && host && savedBaseUrl) setDialogOpen(true);
  };

  const confirm = async (input) => {
    await ai.enableCloud(input);
    setDialogOpen(false);
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-slate400">
        Javi sends your questions to a company you choose, using your own account with them. You pay that
        company, not Burrow.
      </p>

      {active && (
        <div role="status" className="rounded-lg bg-accent-green/15 p-3 text-sm text-accent-green">
          Javi is using your cloud AI at {host}.
        </div>
      )}
      {paused && (
        <div role="status" className={BANNER}>
          <p>Cloud AI is paused until you confirm it again. Javi is running on this computer for now.</p>
          <button
            type="button"
            onClick={openDialog}
            aria-disabled={!cloud.ready || undefined}
            aria-describedby={cloud.ready ? undefined : readyHintId}
            className={`${BTN} mt-2`}
          >
            Review and turn on
          </button>
          {!cloud.ready && (
            <p id={readyHintId} className="mt-1 text-xs">
              Add the provider address, model and API key first.
            </p>
          )}
        </div>
      )}
      {providerChanged && (
        <div role="status" className={BANNER}>
          Provider changed. Confirm cloud AI again.
        </div>
      )}
      {networkOff && (
        <div role="status" className={BANNER}>
          Cloud AI is off because &quot;Cloud AI provider&quot; is off in{' '}
          <Link to={{ pathname: '/settings', hash: '#network' }} className={LINK_CLASS}>
            Settings &gt; Network
          </Link>
          .
        </div>
      )}

      <form onSubmit={saveCloud} className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor={urlId} className={LABEL_CLASS}>
            Provider address
          </label>
          <input
            id={urlId}
            type="text"
            inputMode="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
            autoComplete="off"
            className={`${INPUT_CLASS} font-mono`}
          />
          {host && (
            <p className="mt-1 text-xs text-slate-slate400">
              Requests go to <span className="font-mono text-slate-slate300">{host}</span>.
            </p>
          )}
        </div>
        <div>
          <label htmlFor={modelId} className={LABEL_CLASS}>
            Cloud model
          </label>
          <input
            id={modelId}
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            className={`${INPUT_CLASS} font-mono`}
          />
        </div>
        <details className="sm:col-span-2">
          <summary className="cursor-pointer text-xs font-semibold text-slate-slate300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]">
            Advanced options
          </summary>
          <div className="mt-2 sm:max-w-xs">
            <label htmlFor={tokenId} className={LABEL_CLASS}>
              Token limit parameter
            </label>
            <select
              id={tokenId}
              value={tokenParam}
              onChange={(e) => setTokenParam(e.target.value)}
              className={INPUT_CLASS}
            >
              <option value="max_tokens">max_tokens</option>
              <option value="max_completion_tokens">max_completion_tokens</option>
            </select>
          </div>
        </details>
        <div className="sm:col-span-2">
          <button type="submit" aria-disabled={busy || undefined} className={BTN}>
            {busy ? 'Saving…' : 'Save provider'}
          </button>
          <SaveError error={error} kind="cloud" />
        </div>
      </form>

      <CloudKey onChanged={ai.refresh} />

      <CloudCategoryList
        key={host ?? 'none'}
        categories={categories}
        host={host}
        onChange={ai.setCloudCategories}
      />

      <div className="space-y-1.5 border-t border-white/10 pt-4">
        {active ? (
          <>
            <button
              ref={turnOffRef}
              type="button"
              onClick={turnOff}
              aria-disabled={offBusy || undefined}
              className={BTN}
            >
              Turn off cloud AI
            </button>
            <SaveError error={offError} kind="cloud" />
          </>
        ) : (
          !paused && (
            <>
              <button
                type="button"
                onClick={openDialog}
                aria-disabled={!cloud.ready || undefined}
                aria-describedby={cloud.ready ? undefined : readyHintId}
                className={PRIMARY_BTN}
              >
                Turn on cloud AI
              </button>
              {!cloud.ready && (
                <p id={readyHintId} className="text-xs text-slate-slate400">
                  Add the provider address, model and API key first.
                </p>
              )}
            </>
          )
        )}
      </div>

      {dialogOpen && host && savedBaseUrl && (
        <CloudAiConsentDialog
          host={host}
          baseUrl={savedBaseUrl}
          finalFocusRef={turnOffRef}
          categories={categories}
          onConfirm={confirm}
          onCancel={() => setDialogOpen(false)}
        />
      )}
    </div>
  );
}
