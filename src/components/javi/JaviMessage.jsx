import { useMemo } from 'react';
import { Wallet, CheckSquare, HeartPulse, Calendar } from 'lucide-react';
import Markdown from '../shared/Markdown';
import { stripDashes } from '../../utils/javiDashes';

const DISALLOWED = ['img'];

// Links open in a new tab and never leak the opener. Images are dropped (not rendered),
// which blocks markdown-image exfiltration of page context. No rehype-raw: model output
// can never inject HTML.
// Only http(s) links are live, and the real hostname is shown after the link text so a
// misleading label cannot disguise the destination. Anything else renders as plain text.
function safeHost(href) {
  try {
    const url = new URL(String(href ?? ''));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : null;
  } catch {
    return null;
  }
}

function SafeLink({ href, children }) {
  const host = safeHost(href);
  if (!host) return <span>{children}</span>;
  return (
    <>
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>{' '}
      <span className="text-slate-slate300">({host})</span>
    </>
  );
}

// Category lines the advisor writes in bold (Money, Tasks, Health, Schedule) get their own colour as a
// small caps label; any other bold text is just emphasised. Bullets are action items (see .javi-actions).
const CATEGORY_COLORS = {
  money: 'text-accent-green',
  tasks: 'text-accent-amber',
  health: 'text-accent-teal',
  schedule: 'text-accent-blue',
};

// Decorative icons added here, not by the model (its prompt forbids emoji), so they are always the same.
// The same lucide icons the nav uses, so they share its chunk.
const CATEGORY_ICONS = { money: Wallet, tasks: CheckSquare, health: HeartPulse, schedule: Calendar };

function textOf(children) {
  if (typeof children === 'string') return children;
  if (Array.isArray(children) && children.length === 1 && typeof children[0] === 'string') return children[0];
  return '';
}

function Strong({ children }) {
  const key = textOf(children).replace(/:$/, '').trim().toLowerCase();
  const color = CATEGORY_COLORS[key];
  if (color) {
    const Icon = CATEGORY_ICONS[key];
    return (
      <strong className={`${color} text-xs font-bold uppercase tracking-wide`}>
        <Icon size={12} aria-hidden="true" className="mr-1 inline-block align-[-1px]" />
        {children}
      </strong>
    );
  }
  return <strong className="font-semibold text-slate-slate100">{children}</strong>;
}

// role="list" keeps list semantics in WebKit, which drops them under list-style: none.
function ActionList({ className, children, ...props }) {
  // eslint-disable-next-line no-unused-vars -- react-markdown's `node` must not reach the DOM
  const { node, ...rest } = props;
  return (
    <ul {...rest} role="list" className={className ? `${className} javi-actions` : 'javi-actions'}>
      {children}
    </ul>
  );
}

const PLAIN_COMPONENTS = { a: SafeLink, strong: Strong };
const ACTION_COMPONENTS = { ...PLAIN_COMPONENTS, ul: ActionList };

/**
 * One chat bubble in the Javi panel. `actions` (default true) shows bullets as action rows; the daily briefing
 * passes false because its bullets are observations.
 * @param {{ role: 'user'|'assistant', content: string, actions?: boolean }} props
 */
export default function JaviMessage({ role, content, actions = true }) {
  const shown = useMemo(() => (role === 'user' ? content : stripDashes(content)), [role, content]);
  if (role === 'user') {
    return (
      <div className="text-right">
        <p className="glass-javi-user inline-block max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md px-3.5 py-2.5 text-left text-base leading-relaxed text-slate-slate100">
          <span className="sr-only">You said: </span>
          {content}
        </p>
      </div>
    );
  }
  return (
    <div>
      <div className="glass-javi-inner inline-block max-w-[92%] rounded-2xl rounded-bl-md px-3.5 py-2.5 text-left text-base leading-relaxed text-slate-slate200">
        <span className="sr-only">Javi said: </span>
        <div className="prose-jarvis break-words [&_table]:block [&_table]:overflow-x-auto">
          <Markdown disallowedElements={DISALLOWED} unwrapDisallowed components={actions ? ACTION_COMPONENTS : PLAIN_COMPONENTS}>
            {shown}
          </Markdown>
        </div>
      </div>
    </div>
  );
}
