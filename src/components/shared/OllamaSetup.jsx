import { useEffect, useRef } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { btnPrimary, btnSecondary } from './formStyles';
import { useOllamaSetup } from '../../hooks/useOllamaSetup';

const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';

const PHASE_LABEL = {
  manifest: 'Preparing',
  downloading: 'Downloading',
  verifying: 'Verifying',
  finalizing: 'Finishing',
};

const PURPOSE_LABEL = {
  chat: 'For asking Javi questions',
  tools: 'For working with your data',
  both: 'For questions and working with your data',
};

const STOPPED_COPY = 'The download stopped. Check your internet connection, then try again.';

// Fixed copy per pull error code. Raw server text is never rendered.
const PULL_ERROR_COPY = {
  pull_requires_local_ollama:
    'Burrow can only download models to Ollama on this computer. Download the model in the Ollama app instead.',
  pull_in_progress: 'A download is already running. Wait for it to finish, then try again.',
  pull_failed: STOPPED_COPY,
  timeout: STOPPED_COPY,
  rate_limited: 'Too many download attempts. Try again in a few minutes.',
  ollama_unavailable: "Burrow can't reach Ollama right now. Open the Ollama app, then try again.",
  ai_not_configured: 'AI is turned off, so Burrow cannot download a model.',
  invalid_model: 'That model name is not valid.',
  network: "Couldn't reach Burrow. Try again.",
};
const PULL_ERROR_FALLBACK = 'The download did not finish. Your progress is kept, so try again.';
const FINISHED_NOT_READY = "The download finished, but Javi can't use it yet. Check again.";
const FINISHED_UNCONFIRMED = "The download finished, but Burrow couldn't confirm it. Check again.";

const CARD = 'rounded-lg bg-slate-slate700/40 p-3';

/** "1.2 of 2.0 GB"; the unit follows the total so both numbers share it. */
function formatProgress(completed, total) {
  const gb = total >= 1e9;
  const unit = gb ? 1e9 : 1e6;
  const digits = gb ? 1 : 0;
  return `${(completed / unit).toFixed(digits)} of ${(total / unit).toFixed(digits)} ${gb ? 'GB' : 'MB'}`;
}

function PrivacyNote() {
  return (
    <p className="text-xs text-slate-slate300">
      Ollama downloads the model from the Ollama library. Burrow does not use the internet for
      this.
    </p>
  );
}

function CheckAgain({ onClick, busy }) {
  return (
    <button type="button" onClick={onClick} disabled={busy} className={btnSecondary}>
      {busy ? 'Checking…' : 'Check again'}
    </button>
  );
}

function GetOllamaLink() {
  return (
    <a
      href={OLLAMA_DOWNLOAD_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={`${btnPrimary} no-underline`}
    >
      Get Ollama
      <span className="sr-only"> (opens in your browser)</span>
    </a>
  );
}

function Recommendation({ rec, disabled, onDownload, optional }) {
  return (
    <li className={`${CARD} space-y-1`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          {optional ? (
            <p className="font-mono text-sm font-semibold text-slate-slate100">{rec.name}</p>
          ) : (
            <>
              <p className="text-sm font-semibold text-slate-slate100">
                Recommended for your computer
              </p>
              <p className="font-mono text-xs text-slate-slate300">{rec.name}</p>
            </>
          )}
          <p className="text-xs text-slate-slate300">
            {PURPOSE_LABEL[rec.purpose] ?? PURPOSE_LABEL.chat} · about{' '}
            {Number(rec.downloadGb).toFixed(1)} GB
          </p>
        </div>
        <button
          type="button"
          onClick={() => onDownload(rec.name)}
          disabled={disabled}
          aria-label={`Download model ${rec.name}`}
          className={optional ? btnSecondary : btnPrimary}
        >
          Download model
        </button>
      </div>
      {rec.reason && <p className="text-xs text-slate-slate300">{rec.reason}</p>}
    </li>
  );
}

function Recommendations({ setup, busy, onDownload, intro }) {
  const { primary = [], optional = [] } = setup.recommended ?? {};
  const ramGb = setup.ramGb > 0 ? setup.ramGb : setup.recommended?.ramGb;
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-slate200">{intro}</p>
      {ramGb > 0 && (
        <p className="text-xs text-slate-slate300">
          Your computer has {ramGb} GB of memory, so this is the model we suggest.
        </p>
      )}
      {primary.length > 0 && (
        <ul role="list" aria-label="Recommended model" className="space-y-2">
          {primary.map((rec) => (
            <Recommendation key={rec.name} rec={rec} disabled={busy} onDownload={onDownload} />
          ))}
        </ul>
      )}
      {optional.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-slate300">Also available (optional)</p>
          <ul role="list" aria-label="Optional models" className="space-y-2">
            {optional.map((rec) => (
              <Recommendation
                key={rec.name}
                rec={rec}
                disabled={busy}
                onDownload={onDownload}
                optional
              />
            ))}
          </ul>
        </div>
      )}
      <PrivacyNote />
    </div>
  );
}

function PullProgress({ pull, onCancel }) {
  const known = pull.total > 0;
  const percent = known ? Math.min(100, Math.floor((pull.completed / pull.total) * 100)) : null;
  const phase = PHASE_LABEL[pull.phase] ?? PHASE_LABEL.manifest;
  return (
    <div className={`${CARD} space-y-2`}>
      <p className="text-sm text-slate-slate200">
        Getting <span className="font-mono font-semibold">{pull.model}</span>
      </p>
      <div
        role="progressbar"
        aria-label={`Download progress for ${pull.model}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={known ? `${percent} percent, ${phase}` : phase}
        className="h-2 w-full overflow-hidden rounded-full bg-slate-slate700/60"
      >
        <div
          className={`h-full rounded-full bg-slate-slateBlue transition-[width] motion-reduce:transition-none ${known ? '' : 'w-full animate-pulse motion-reduce:animate-none'}`}
          style={known ? { width: `${percent}%` } : undefined}
        />
      </div>
      {known && (
        <p className="text-xs tabular-nums text-slate-slate300">
          {percent}% · {formatProgress(pull.completed, pull.total)}
        </p>
      )}
      <p className="text-xs text-slate-slate300">
        Large models can take a while on a slow connection. The download keeps going if you leave
        this page.
      </p>
      <PrivacyNote />
      <button type="button" onClick={onCancel} className={btnSecondary}>
        Cancel
      </button>
    </div>
  );
}

const MESSAGE_ONLY = {
  stopped: 'Ollama is installed but not running. Open the Ollama app, then Check again.',
  unreachable:
    "Burrow can't reach Ollama right now. Make sure the Ollama app is open, then Check again.",
  remote:
    'Burrow is set to use Ollama on another computer, so models are managed there. Check again once a model is installed.',
  disabled: 'AI features are turned off on this computer, so there is nothing to set up.',
};

/**
 * Guided first-run Ollama setup: detects Ollama, recommends a model for this computer's
 * memory, downloads it with progress and reports when Javi is ready. `onReady` fires when a
 * usable model exists. `onBusyChange(true)` fires while a download runs (or its result is
 * being confirmed) so a parent can hold back Continue or close. The download lives in
 * `ollamaPullStore`, so it keeps going if this component unmounts; only Cancel stops it.
 */
export default function OllamaSetup({ onReady, onBusyChange }) {
  const { setup, isLoading, isFetching, checkAgain, pull, startPull, cancel } = useOllamaSetup();
  const ready = setup?.ready === true;
  const pulling = pull.status === 'pulling';
  const syncing = pull.status === 'done' && pull.syncing;
  const busy = pulling || syncing;
  const finishedNotReady = pull.status === 'done' && !pull.syncing && !ready;

  const onReadyRef = useRef(onReady);
  const onBusyRef = useRef(onBusyChange);
  useEffect(() => {
    onReadyRef.current = onReady;
    onBusyRef.current = onBusyChange;
  });
  useEffect(() => {
    if (ready) onReadyRef.current?.();
  }, [ready]);
  useEffect(() => {
    onBusyRef.current?.(busy);
    return () => onBusyRef.current?.(false);
  }, [busy]);

  let readyText = 'Javi is ready.';
  if (setup?.provider === 'ollama') readyText = 'Javi is ready. Everything runs on this computer.';
  else if (setup?.provider) {
    readyText = 'Javi is ready. It is using the cloud provider you set up in Settings.';
  }

  // One persistent live region: its text changes, so each step is announced once and no
  // pre-populated status node is ever inserted.
  let status = null;
  if (isLoading) {
    status = {
      text: 'Checking for Ollama…',
      className: 'text-sm text-slate-slate300',
      icon: (
        <Loader2
          size={14}
          aria-hidden="true"
          className="mt-0.5 shrink-0 animate-spin motion-reduce:animate-none"
        />
      ),
    };
  } else if (ready) {
    status = {
      text: readyText,
      className: 'text-sm text-accent-green',
      icon: <CheckCircle2 size={16} aria-hidden="true" className="mt-0.5 shrink-0" />,
    };
  } else if (pulling) {
    status = {
      text: `${PHASE_LABEL[pull.phase] ?? PHASE_LABEL.manifest}…`,
      className: 'text-xs font-semibold text-slate-slate300',
    };
  } else if (syncing) {
    status = { text: 'Download finished. Checking…', className: 'text-xs text-slate-slate300' };
  } else if (pull.status === 'cancelled') {
    status = {
      text: 'Download cancelled. You can start again and Ollama will pick up where it left off.',
      className: 'text-xs text-slate-slate300',
    };
  } else if (finishedNotReady) {
    status = {
      text: pull.syncFailed ? FINISHED_UNCONFIRMED : FINISHED_NOT_READY,
      className: 'text-xs text-accent-amber',
    };
  }

  let body;
  if (isLoading || ready) {
    body = null;
  } else if (!setup) {
    body = (
      <div className="space-y-3">
        <p className="text-sm text-slate-slate200">
          Couldn&apos;t check for Ollama. Try again in a moment.
        </p>
        <CheckAgain onClick={checkAgain} busy={isFetching} />
      </div>
    );
  } else if (pulling) {
    body = <PullProgress pull={pull} onCancel={cancel} />;
  } else if (setup.ollama === 'missing') {
    body = (
      <div className="space-y-3">
        <p className="text-sm text-slate-slate200">
          Javi, the AI helper, runs on a free app called Ollama on this computer, so nothing leaves
          the computer. Install Ollama, open it, then come back and press Check again.
        </p>
        <div className="flex flex-wrap gap-2">
          <GetOllamaLink />
          <CheckAgain onClick={checkAgain} busy={isFetching} />
        </div>
      </div>
    );
  } else if (MESSAGE_ONLY[setup.ollama]) {
    body = (
      <div className="space-y-3">
        <p className="text-sm text-slate-slate200">{MESSAGE_ONLY[setup.ollama]}</p>
        <CheckAgain onClick={checkAgain} busy={isFetching} />
      </div>
    );
  } else {
    const hasModels = Array.isArray(setup.models) && setup.models.length > 0;
    const intro = hasModels
      ? 'Ollama is running, but it has no model Javi can use yet. Download one to get started.'
      : 'Ollama is running. Javi needs a model to think with. Download one to get started.';
    body = (
      <div className="space-y-3">
        <Recommendations setup={setup} busy={busy} onDownload={startPull} intro={intro} />
        {pull.status === 'error' && (
          <p role="alert" className="text-xs text-accent-amber">
            {PULL_ERROR_COPY[pull.error?.code] ?? PULL_ERROR_FALLBACK}
          </p>
        )}
        <CheckAgain onClick={checkAgain} busy={isFetching} />
      </div>
    );
  }

  return (
    <div>
      <p
        aria-live="polite"
        className={`flex items-start gap-2 ${status?.className ?? ''} ${status && body ? 'mb-3' : ''}`}
      >
        {status?.icon}
        {status?.text}
      </p>
      {body}
    </div>
  );
}
