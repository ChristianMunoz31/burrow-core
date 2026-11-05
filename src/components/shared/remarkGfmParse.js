import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

// remark-gfm without its markdown writer. remark-gfm also registers the GFM serializers, which pull in
// mdast-util-to-markdown and markdown-table, but Burrow only ever parses markdown (react-markdown never turns a tree
// back into text), so that half was dead weight in the MarkdownImpl chunk. Parsing is identical: the same micromark
// syntax extension and mdast extension, with remark-gfm's defaults.
export default function remarkGfmParse() {
  const data = this.data();
  (data.micromarkExtensions ||= []).push(gfm());
  (data.fromMarkdownExtensions ||= []).push(gfmFromMarkdown());
}
