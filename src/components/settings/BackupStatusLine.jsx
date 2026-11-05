import { statusSentence } from './backupStatusText';

export default function BackupStatusLine({ status, now }) {
  const text = statusSentence(status, now);
  if (!text) return null;
  const needsAttention = status.health !== 'ok' || Boolean(status.diskWarning) || status.recoveryRequired === true;
  return (
    <p role="status" aria-live="off" className={`mt-2 text-xs ${needsAttention ? 'text-accent-amber' : 'text-slate-slate300'}`}>
      {text}
    </p>
  );
}
