import { useId, useState } from 'react';
import { ChevronDown, Database, Globe, HardDrive } from 'lucide-react';
import SectionCard from '../shared/SectionCard';
import { sectionProps } from './settingsSections';
import { PILL, TONE_CLASS } from './pillStyles';
import BackupsControl from './BackupsControl';
import CopyFromStableControl from './CopyFromStableControl';
import DangerZone from './DangerZone';
import DataExportControl from './DataExportControl';
import DataFolderWarning from './DataFolderWarning';
import ImportControl from './ImportControl';
import ImportFromDirectControl from './ImportFromDirectControl';
import { useAppInfo } from '../../hooks/useAppInfo';
import { describeLocation, groupStorageMap } from '../../constants/storageMap';

const SUBSECTION_HEADING = 'text-sm font-semibold text-slate-slate100';
const DIVIDER_COLOR = 'border-[color:var(--glass-border)]';
const SUBSECTION_DIVIDER = `border-t ${DIVIDER_COLOR} pt-6`;
const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]';

// Item pills sit in half-width columns, so they wrap: use a squarer shape than the badge pill.
const ITEM_PILL = `${PILL.replace('rounded-full', 'rounded-md')} whitespace-normal max-w-full`;
// Groups with nothing in them (e.g. browser-only data, when no module keeps any) are not shown.
const GROUPS = groupStorageMap().filter((group) => group.items.length > 0);

const GROUP_ICON = { database: Database, device: HardDrive, external: Globe };

function StorageGroup({ group }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const titleId = useId();
  const descId = useId();
  const Icon = GROUP_ICON[group.id] ?? Database;
  return (
    <div className="glass-subtle rounded-lg p-3">
      <h5>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          aria-labelledby={titleId}
          aria-describedby={descId}
          onClick={() => setOpen((prev) => !prev)}
          className={`flex w-full items-start gap-2 rounded-md text-left ${FOCUS_RING}`}
        >
          <Icon size={16} className="mt-0.5 shrink-0 text-slate-slate400" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span id={titleId} className={`block ${SUBSECTION_HEADING}`}>
              {group.title}
            </span>
            <span id={descId} className="mt-0.5 block text-xs text-slate-slate400">
              {group.description}
            </span>
          </span>
          <ChevronDown
            size={16}
            aria-hidden="true"
            className={`mt-0.5 shrink-0 text-slate-slate400 motion-safe:transition-transform ${open ? '' : '-rotate-90'}`}
          />
        </button>
      </h5>
      <div id={panelId} hidden={!open}>
        <ul role="list" className="mt-2 grid grid-cols-1 gap-x-4 sm:grid-cols-2">
          {group.items.map((entry) => {
            const where = describeLocation(entry);
            return (
              <li key={entry.id} className={`flex min-w-0 flex-col items-start gap-1 border-t ${DIVIDER_COLOR} py-2`}>
                <div className="min-w-0 max-w-full">
                  <p className="text-sm font-semibold text-slate-slate100">{entry.label}</p>
                  <p className="text-xs text-slate-slate400">{entry.detail}</p>
                </div>
                <span className={`${ITEM_PILL} ${TONE_CLASS[where.tone]}`}>{where.text}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

export default function DataStorageSection() {
  const locationHeadingId = useId();
  const { info } = useAppInfo();

  return (
    <SectionCard {...sectionProps('data-storage')} title="Data & storage" subtitle="Where your data is kept, plus backups, export and import." icon={Database}>
      <div className="space-y-6">
        <DataFolderWarning />
        <section aria-labelledby={locationHeadingId}>
          <h4 id={locationHeadingId} className={`mb-2 ${SUBSECTION_HEADING}`}>
            Where your data lives
          </h4>
          <div className="space-y-3">
            {GROUPS.map((group) => (
              <StorageGroup key={group.id} group={group} />
            ))}
          </div>
        </section>

        <div className={SUBSECTION_DIVIDER}>
          <BackupsControl />
        </div>

        {info?.distribution === 'store' && info?.dataLocation === 'userprofile' && (
          <div className={SUBSECTION_DIVIDER}>
            <ImportFromDirectControl />
          </div>
        )}

        {info?.channel === 'dev' && (
          <div className={SUBSECTION_DIVIDER}>
            <CopyFromStableControl />
          </div>
        )}

        <div className={SUBSECTION_DIVIDER}>
          <DataExportControl />
        </div>

        <div className={SUBSECTION_DIVIDER}>
          <ImportControl />
        </div>

        <div className={SUBSECTION_DIVIDER}>
          <DangerZone />
        </div>
      </div>
    </SectionCard>
  );
}
