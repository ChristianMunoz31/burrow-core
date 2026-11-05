import { Link } from 'react-router-dom';

const LINK_CLASS =
  'font-medium underline underline-offset-2 hover:text-slate-slate100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]';

/**
 * Inline empty state shown when a gated feature answers 403 network_opt_in_required.
 * `name` is the feature's display name (e.g. "Weather"). Dashboard widgets are already
 * wrapped in a link, so they pass `link={false}` (no nested anchor) and the card's own
 * link leads to the page that carries the real one.
 */
export default function NetworkOptInNotice({
  name,
  link = true,
  className = 'text-xs text-slate-slate400',
}) {
  return (
    <p role="status" className={className}>
      {name} is off because it calls the internet.{' '}
      {link ? (
        <Link to={{ pathname: '/settings', hash: '#network' }} className={LINK_CLASS}>
          Turn it on in Settings → Network
        </Link>
      ) : (
        'Turn it on in Settings → Network'
      )}
      .
    </p>
  );
}
