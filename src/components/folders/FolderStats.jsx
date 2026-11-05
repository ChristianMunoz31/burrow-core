import { formatBytes } from '../../utils/backupFormat';
import { count, kindsOf } from '../../utils/folderStats';
import { KIND_LABELS, LIMIT_COPY, formatDate } from '../../constants/folders';

/** The limits a scan hit (a cap on files or text). Shown whenever present, because they change what the numbers mean. */
export function FolderLimits({ stats }) {
  const limits = (stats?.limitsHit ?? []).filter((id) => Object.hasOwn(LIMIT_COPY, id));
  return limits.map((id) => (
    <p key={id} className="text-sm text-accent-amber">
      {LIMIT_COPY[id]}
    </p>
  ));
}

/**
 * The rest of the inventory, behind the card's Details toggle: file kinds, date range, identical files and
 * the largest files.
 * @param {{ stats: object|null }} props
 */
export default function FolderDetails({ stats }) {
  if (!stats) return null;
  const kinds = kindsOf(stats);
  const first = stats.oldestModifiedAt && stats.newestModifiedAt ? formatDate(stats.oldestModifiedAt) : null;
  const last = first ? formatDate(stats.newestModifiedAt) : null;
  const range = first && (first === last ? `on ${first}` : `${first} to ${last}`);
  return (
    <div className="space-y-2 text-xs text-slate-slate400">
      {kinds.length > 0 && (
        <p>
          {kinds
            .map(([kind, v]) => `${count(v.files)} ${(KIND_LABELS[kind] ?? KIND_LABELS.other).toLowerCase()}`)
            .join(', ')}
          .
        </p>
      )}
      {range && <p>Files changed {range}.</p>}
      {stats.duplicateGroups > 0 && (
        <p>
          {count(stats.duplicateGroups)} {stats.duplicateGroups === 1 ? 'set' : 'sets'} of identical files.
        </p>
      )}
      {stats.largestFiles?.length > 0 && (
        <div>
          <h4 className="font-semibold text-slate-slate300">Largest files</h4>
          <ul className="mt-1 space-y-0.5">
            {stats.largestFiles.map((f) => (
              <li key={f.path} className="flex justify-between gap-3">
                <bdi className="break-all">{f.path}</bdi>
                <span className="shrink-0 tabular-nums">{formatBytes(f.bytes)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
