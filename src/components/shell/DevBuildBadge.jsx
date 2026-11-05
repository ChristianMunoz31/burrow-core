import { useAppInfo } from '../../hooks/useAppInfo';
import { PILL, TONE_CLASS } from '../settings/pillStyles';

// TopBar centers its row; the shared pill style aligns to the start.
const BADGE = PILL.replace('self-start', 'self-center');

/** Small "Dev build" pill for Burrow Dev. Renders nothing in the stable channel. */
export default function DevBuildBadge() {
  const { info } = useAppInfo();
  if (info?.channel !== 'dev') return null;
  return (
    <span
      title={`Burrow Dev ${info.version}`}
      className={`${BADGE} ${TONE_CLASS.warn} shrink-0 whitespace-nowrap`}
    >
      <span className="sm:hidden">Dev</span>
      <span className="hidden sm:inline">Dev build</span>
      <span className="sr-only"> (Burrow Dev {info.version})</span>
    </span>
  );
}
