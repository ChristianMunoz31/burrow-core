import { Link } from 'react-router-dom';
import { LINK_CLASS } from '../shared/AiUnavailable';
import ApiKeyRow from './ApiKeyRow';
import { useSecrets } from '../../hooks/useSecrets';

const CLOUD_KEY_NAME = 'AI_CLOUD_API_KEY';

// Codes the settings API sends on a failed write: model_not_installed and model_lacks_tools
// (PUT models), ollama_unavailable (PUT models answers 503 when it cannot list models),
// invalid_host (PUT host and the cloud base URL in PUT cloud: one validator), invalid_model
// and invalid_token_param (PUT cloud), cloud_not_configured (PUT provider), invalid_body,
// and network_opt_in_required (handled separately below).
const ERROR_COPY = {
  model_not_installed: 'That model is not installed. Refresh the list and pick an installed one.',
  model_lacks_tools: 'That model cannot use tools. Pick one with the tools tag.',
  ollama_unavailable: "Burrow can't reach Ollama right now, so the model was not saved. Start Ollama, then try again.",
  invalid_host: 'That address is not valid. Use a URL like http://127.0.0.1:11434.',
  invalid_model: 'That model name is not valid. Use the name exactly as the provider lists it.',
  invalid_token_param: "That setting isn't supported.",
  cloud_not_configured: 'Add the provider address, model and API key first.',
};
// invalid_host on the cloud address carries a finer `reason` from the server's validator.
const PRIVATE_ADDRESS_COPY =
  "That address points to this computer or a private network. Use your provider's public address. For Ollama on another computer, use Ollama address under Advanced.";
const CLOUD_INVALID_HOST_COPY = {
  https_required: 'Use an https:// address.',
  private_address: PRIVATE_ADDRESS_COPY,
  local_name: PRIVATE_ADDRESS_COPY,
};
const CLOUD_INVALID_HOST_FALLBACK =
  'That address is not valid. Use an https:// address, for example https://api.example.com/v1';

const cloudCopy = (error) => {
  if (error.code !== 'invalid_host') return null;
  return CLOUD_INVALID_HOST_COPY[error.reason] ?? CLOUD_INVALID_HOST_FALLBACK;
};

const OPT_IN_FEATURE = {
  aiLan: 'Ollama on another computer',
  cloudAi: 'Cloud AI provider',
};

/**
 * Inline, fixed copy for a failed write. Raw server text is never rendered. `kind` picks the
 * copy for the Ollama host form (`host`) or the cloud endpoint form (`cloud`).
 */
export function SaveError({ error, kind = 'host' }) {
  if (!error) return null;
  if (error.code === 'network_opt_in_required') {
    const feature = OPT_IN_FEATURE[error.feature] ?? 'the matching option';
    return (
      <p role="alert" className="mt-1.5 text-xs text-accent-amber">
        This is off until you allow it. Turn on &quot;{feature}&quot; in{' '}
        <Link to={{ pathname: '/settings', hash: '#network' }} className={LINK_CLASS}>
          Settings &gt; Network
        </Link>
        .
      </p>
    );
  }
  return (
    <p role="alert" className="mt-1.5 text-xs text-accent-amber">
      {(kind === 'cloud' ? cloudCopy(error) : null) ??
        ERROR_COPY[error.code] ??
        "Couldn't save that change. Try again."}
    </p>
  );
}

/** The cloud API key row. `onChanged` runs after a save or removal so AI status can refresh. */
export function CloudKey({ onChanged }) {
  const { data, isLoading, save, remove, test } = useSecrets();
  if (isLoading) return null;
  const secret = data?.secrets?.find((s) => s.name === CLOUD_KEY_NAME);
  if (!secret) {
    return (
      <p className="text-xs text-slate-slate400">
        You can save the API key here once Burrow is able to store it securely.
      </p>
    );
  }
  const writable = data.writable === true && data.writesAllowed !== false;
  return (
    <ul role="list" aria-label="Cloud AI API key" className="divide-y divide-white/10">
      <ApiKeyRow
        secret={secret}
        writable={writable}
        writesAllowed={writable}
        disabledReason={writable ? undefined : 'Saving keys is unavailable right now.'}
        onSave={async (name, value) => {
          const status = await save(name, value);
          await onChanged?.();
          return status;
        }}
        onRemove={async (name) => {
          const status = await remove(name);
          await onChanged?.();
          return status;
        }}
        onTest={test}
      />
    </ul>
  );
}
