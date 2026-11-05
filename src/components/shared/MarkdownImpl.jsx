import ReactMarkdown from 'react-markdown';
import remarkGfm from './remarkGfmParse.js';

const REMARK_PLUGINS = [remarkGfm];
// The only props a caller may pass through. Anything else (a plugin list, parser options, a switch for raw HTML)
// is dropped, so no caller can let an <svg> reach the tree whose attribute table the production build stubs out.
const ALLOWED_PROPS = ['components', 'disallowedElements', 'allowedElements', 'unwrapDisallowed'];

// The only module that imports the markdown stack (react-markdown, the GFM parser extensions and the
// micromark/mdast tree). Load it through ./Markdown so it stays out of the entry chunk.
export default function MarkdownImpl({ children, ...props }) {
  const safe = Object.fromEntries(ALLOWED_PROPS.filter((key) => key in props).map((key) => [key, props[key]]));
  return (
    <ReactMarkdown {...safe} remarkPlugins={REMARK_PLUGINS}>
      {children}
    </ReactMarkdown>
  );
}
