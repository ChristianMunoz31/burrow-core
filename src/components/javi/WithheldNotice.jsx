import { Link } from 'react-router-dom';
import { LINK_CLASS } from '../shared/AiUnavailable';

// Keeps the "Settings > AI." path on one line when the sentence wraps.
const PATH_RE = /(Settings > AI\.?)/;

function NoBreakPath({ text }) {
  return text.split(PATH_RE).map((part, i) =>
    PATH_RE.test(part) ? (
      <span key={i} className="whitespace-nowrap">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

/**
 * Tells the user that some of their data was not shared with cloud AI. Plain notice, not an
 * error. `message` is the server's fixed sentence.
 * @param {{ message: string, className?: string }} props
 */
export default function WithheldNotice({ message, className = '' }) {
  if (!message) return null;
  return (
    <div
      role="status"
      className={`glass-javi-chip max-w-[92%] rounded-xl px-3 py-2 text-xs text-slate-slate300 ${className}`}
    >
      <p>
        <NoBreakPath text={message} />
      </p>
      <p className="mt-1">
        <Link to={{ pathname: '/settings', hash: '#ai' }} className={LINK_CLASS}>
          Change what cloud AI can see
        </Link>
      </p>
    </div>
  );
}
