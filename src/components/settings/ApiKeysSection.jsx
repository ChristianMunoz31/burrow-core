import { KeyRound } from 'lucide-react';
import SectionCard from '../shared/SectionCard';
import { sectionProps } from './settingsSections';
import { ListSkeleton } from '../shared/Skeleton';
import ApiKeyRow from './ApiKeyRow';
import { BTN } from './pillStyles';
import { useSecrets } from '../../hooks/useSecrets';

const CLOUD_KEY_NAME = 'AI_CLOUD_API_KEY'; // managed in Settings > AI
const CANT_SAVE = "Burrow can't store tokens securely on this computer right now.";

/** Returns { title, hint } when writes are blocked, else null. */
function describeBlock(data) {
  if (!data.encryption?.enabled) {
    return {
      title: CANT_SAVE,
      hint: "Burrow can't store tokens securely because its encryption file couldn't be created. Check that Burrow's data folder is writable.",
    };
  }
  if ((data.storage && !data.storage.available) || data.writesAllowed === false || !data.writable) {
    return { title: CANT_SAVE, hint: null };
  }
  return null;
}

export default function ApiKeysSection() {
  const { data, isLoading, error, refetch, save, remove, test } = useSecrets();
  const block = data ? describeBlock(data) : null;
  const secrets = data ? data.secrets.filter((secret) => secret.name !== CLOUD_KEY_NAME) : [];
  const writable = !!data && !block;
  const writesAllowed = !!data && (data.writesAllowed ?? data.writable) === true;

  return (
    <SectionCard
      {...sectionProps('api-keys')}
      title="Connected services"
      subtitle="Tokens for services you connect, like Oura. Stored encrypted on this computer."
      icon={KeyRound}
    >
      {isLoading ? (
        <ListSkeleton rows={4} />
      ) : !data ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-accent-amber">
            Couldn&apos;t load connected services.
          </p>
          <button type="button" onClick={() => refetch()} className={BTN}>
            Retry
          </button>
        </div>
      ) : (
        <>
          {error && (
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <p role="alert" className="text-sm text-accent-amber">
                Couldn&apos;t refresh connected services. Showing the last known state.
              </p>
              <button type="button" onClick={() => refetch()} className={BTN}>
                Retry
              </button>
            </div>
          )}
          {block && (
            <div role="status" className="mb-3 rounded-lg bg-accent-amber/15 p-3 text-sm text-accent-amber">
              <p className="font-semibold">{block.title}</p>
              {block.hint && <p className="mt-0.5 text-xs">{block.hint}</p>}
            </div>
          )}
          <ul role="list" aria-label="Connected services" className="divide-y divide-white/10">
            {secrets.map((secret) => (
              <ApiKeyRow
                key={secret.name}
                secret={secret}
                writable={writable}
                writesAllowed={writesAllowed}
                disabledReason={block ? 'Saving is disabled right now.' : null}
                onSave={save}
                onRemove={remove}
                onTest={test}
              />
            ))}
          </ul>
        </>
      )}
    </SectionCard>
  );
}
