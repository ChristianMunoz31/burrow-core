import { useEffect, useRef, useState } from 'react';
import { Play, Pause, RotateCcw, SkipForward, Timer } from 'lucide-react';
import SectionCard from '../shared/SectionCard';
import LoadError from '../shared/LoadError';
import { btnPrimary, btnSecondary } from '../shared/formStyles';
import { useToast } from '../../contexts/ToastContext';
import { useFocus } from '../../hooks/useFocus';
import { useSyncedSetting } from '../../hooks/useSyncedSetting';
import { usePageContext } from '../../contexts/PageContextContext';
import { buildFocusContext } from '../../utils/javiBuilders/focus';

const DEFAULTS = { workMin: 25, breakMin: 5 };

function fmt(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const clampMinutes = (value) => Math.max(1, Math.min(180, Math.round(Number(value) || 0)));

// Minutes field: keeps what you type as a draft so it can be cleared and retyped, and
// applies the 1 to 180 limit when you leave the field. An empty or invalid draft reverts.
function MinutesField({ label, value, onCommit }) {
  const [draft, setDraft] = useState(null);
  const commit = () => {
    if (draft != null && draft.trim() !== '' && Number.isFinite(Number(draft))) {
      onCommit(clampMinutes(draft));
    }
    setDraft(null);
  };
  return (
    <label className="flex items-center justify-between text-sm text-slate-slate300">
      {label}
      <input
        type="number"
        min={1}
        max={180}
        value={draft ?? value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        className="w-16 px-2 py-1 text-sm rounded-md glass-input text-slate-slate100 focus:border-slate-slateBlueLight focus:outline-none tabular-nums"
      />
    </label>
  );
}

export default function FocusPage() {
  const { today, sessions, log, error, refresh } = useFocus();
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try {
      await refresh();
    } finally {
      setRetrying(false);
    }
  };
  const toast = useToast();
  // When the current focus block began (ISO), so a logged session records the real start.
  const startedAtRef = useRef(null);
  usePageContext(
    'focus',
    () => buildFocusContext({ today, sessions, error, now: new Date() }),
    sessions.length > 0 && sessions,
  );
  // Work/break lengths are saved to the database (with a localStorage cache).
  const [stored, setStored] = useSyncedSetting('pos:focus', DEFAULTS);
  const cfg = { ...DEFAULTS, ...stored };
  const [phase, setPhase] = useState('focus'); // 'focus' | 'break'
  const [running, setRunning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(() => cfg.workMin * 60);
  // Planned length (seconds) of the current block. Changing the minutes settings only
  // changes this for the next block once the current one has started.
  const [blockSecs, setBlockSecs] = useState(() => cfg.workMin * 60);

  // Count down once per second while running. Phase transitions are handled in
  // the effect below so this stays a pure functional update.
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => setSecondsLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [running]);

  // When the clock reaches zero, log a completed focus session and auto-advance
  // to the next phase (focus → break → focus), keeping the timer running.
  /* eslint-disable react-hooks/set-state-in-effect -- timer phase transition */
  useEffect(() => {
    if (!running || secondsLeft !== 0) return;
    if (phase === 'focus') {
      const startedAt =
        startedAtRef.current ?? new Date(Date.now() - blockSecs * 1000).toISOString();
      startedAtRef.current = null;
      log({
        kind: 'focus',
        durationMin: Math.round(blockSecs / 60),
        startedAt,
      }).catch(() => {
        toast({
          message: "Couldn't save that focus session. It won't show in today's count.",
          type: 'error',
        });
      });
      setPhase('break');
      setBlockSecs(cfg.breakMin * 60);
      setSecondsLeft(cfg.breakMin * 60);
    } else {
      startedAtRef.current = new Date().toISOString();
      setPhase('focus');
      setBlockSecs(cfg.workMin * 60);
      setSecondsLeft(cfg.workMin * 60);
    }
  }, [secondsLeft, running, phase, blockSecs, cfg.workMin, cfg.breakMin, log, toast]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // A block is idle until it starts; once started (running or paused) its length is fixed.
  const blockIdle = !running && secondsLeft === blockSecs;
  const toggleRunning = () => {
    if (!running && phase === 'focus' && !startedAtRef.current) {
      startedAtRef.current = new Date().toISOString();
    }
    setRunning((r) => !r);
  };
  const reset = () => {
    startedAtRef.current = null;
    setRunning(false);
    const next = (phase === 'focus' ? cfg.workMin : cfg.breakMin) * 60;
    setBlockSecs(next);
    setSecondsLeft(next);
  };
  const skip = () => {
    startedAtRef.current = running && phase === 'break' ? new Date().toISOString() : null;
    if (phase === 'focus') {
      setPhase('break');
      setBlockSecs(cfg.breakMin * 60);
      setSecondsLeft(cfg.breakMin * 60);
    } else {
      setPhase('focus');
      setBlockSecs(cfg.workMin * 60);
      setSecondsLeft(cfg.workMin * 60);
    }
  };

  const setLen = (key, value) => {
    const n = clampMinutes(value);
    setStored((prev) => ({ ...DEFAULTS, ...prev, [key]: n }));
    // Reflect the new length now only if the matching block has not started; a running
    // or paused block keeps its length and the new one applies to the next block.
    if (blockIdle) {
      if ((key === 'workMin' && phase === 'focus') || (key === 'breakMin' && phase === 'break')) {
        setBlockSecs(n * 60);
        setSecondsLeft(n * 60);
      }
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
      <SectionCard
        title={phase === 'focus' ? 'Focus' : 'Break'}
        icon={Timer}
        className="lg:col-span-2"
      >
        <div className="flex flex-col items-center py-6">
          <div className="text-7xl font-bold text-slate-slate100 tabular-nums leading-none">
            {fmt(secondsLeft)}
          </div>
          <div className="text-xs uppercase tracking-widest text-slate-slate500 mt-3">
            {phase === 'focus'
              ? `${Math.round(blockSecs / 60)}-min focus block`
              : `${Math.round(blockSecs / 60)}-min break`}
          </div>
          <div className="flex items-center gap-2 mt-6">
            <button
              type="button"
              onClick={toggleRunning}
              className={`${btnPrimary} px-5 py-2.5`}
            >
              {running ? <Pause size={16} /> : <Play size={16} />}
              {running ? 'Pause' : 'Start'}
            </button>
            <button
              type="button"
              onClick={reset}
              className={`${btnSecondary} inline-flex items-center gap-2`}
            >
              <RotateCcw size={16} /> Reset
            </button>
            <button
              type="button"
              onClick={skip}
              className={`${btnSecondary} inline-flex items-center gap-2`}
            >
              <SkipForward size={16} /> Skip
            </button>
          </div>
        </div>
      </SectionCard>

      <div className="space-y-5">
        <SectionCard title="Today">
          {error && error.status === 503 ? (
            <p className="text-sm text-slate-slate300">
              Burrow can&apos;t open your data file, so sessions can&apos;t be logged. Try restarting Burrow.
            </p>
          ) : error ? (
            <LoadError thing="focus sessions" onRetry={retry} retrying={retrying} />
          ) : (
            <>
              <div className="text-3xl font-bold text-slate-slate100 tabular-nums leading-none">
                {today.count}
              </div>
              <div className="text-xs text-slate-slate400 mt-1">
                focus session{today.count === 1 ? '' : 's'} · {today.minutes} min
              </div>
            </>
          )}
        </SectionCard>

        <SectionCard title="Settings">
          <div className="space-y-3">
            <MinutesField
              label="Focus minutes"
              value={cfg.workMin}
              onCommit={(n) => setLen('workMin', n)}
            />
            <MinutesField
              label="Break minutes"
              value={cfg.breakMin}
              onCommit={(n) => setLen('breakMin', n)}
            />
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
