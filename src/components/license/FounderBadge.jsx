import { PILL } from '../settings/pillStyles';

// Deep purple with gold text: 7.2:1, the same in light and dark themes (fixed colors); a CanvasText border keeps it visible in forced-colors mode.
const FOUNDER_BADGE = 'bg-[#5b21b6] text-[#fde68a] forced-colors:border forced-colors:border-[CanvasText]';

/** The "Founding member" pill. Render it only while the founder perk is active. */
export default function FounderBadge({ className = '' }) {
  return <span className={`${PILL} ${FOUNDER_BADGE} ${className}`.trim()}>Founding member</span>;
}
