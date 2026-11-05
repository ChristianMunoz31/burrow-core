// Guard for the build-only `emptySvgSchema` plugin in vite.config.js. It replaces property-information's SVG
// attribute table with an empty one to save bundle size, which is only safe while no `<svg>` element can reach the
// Markdown renderer. Markdown output becomes an `<svg>` only through raw HTML (rehype-raw or another rehype plugin),
// so this test fails as soon as one is added; remove the plugin from vite.config.js first in that case.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Every .js/.jsx file under src/, tests excluded. */
function sourceFiles(dir = path.join(ROOT, 'src')) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(jsx?|tsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('emptySvgSchema stays safe', () => {
  it('the plugin is build-only and targets only property-information/lib/svg.js', () => {
    const config = read('vite.config.js');
    expect(config).toContain("name: 'burrow-empty-svg-schema'");
    expect(config).toContain("apply: 'build'");
    expect(config).toMatch(/property-information\\\/lib\\\/svg\\\.js/);
  });

  it('no rehype plugin or raw HTML path is installed or imported', () => {
    const pkg = JSON.parse(read('package.json'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(deps).filter((name) => /rehype/.test(name))).toEqual([]);
    // Imports and props only: comments that mention rehype (e.g. "No rehype-raw") are fine.
    const RAW_HTML_PATH = /from\s+['"][^'"]*rehype[^'"]*['"]|import\(\s*['"][^'"]*rehype|rehypePlugins\s*[=:{]|allowDangerousHtml|skipHtml\s*=\s*\{\s*false/;
    const offenders = sourceFiles().filter((file) => RAW_HTML_PATH.test(fs.readFileSync(file, 'utf8')));
    expect(offenders.map((file) => path.relative(ROOT, file))).toEqual([]);
  });

  it('the Markdown stack uses only the parse-only GFM plugin', () => {
    const impl = read('src/components/shared/MarkdownImpl.jsx');
    expect(impl).toContain("import remarkGfm from './remarkGfmParse.js';");
    expect(impl).toContain('const REMARK_PLUGINS = [remarkGfm];');
    expect(impl).not.toMatch(/rehype/i);
    const plugin = read('src/components/shared/remarkGfmParse.js');
    expect(plugin).not.toMatch(/rehype|toMarkdown|ToMarkdown/);
  });

  it('the native structuredClone swap is build-only, runs before resolution and keeps a one-argument contract', () => {
    const config = read('vite.config.js');
    expect(config).toContain("name: 'burrow-native-structured-clone'");
    expect(config).toMatch(/name: 'burrow-native-structured-clone',\s*enforce: 'pre',\s*apply: 'build'/);
    expect(config).toContain("'export default (value) => structuredClone(value);'");
    // The swap is safe only while every caller passes plain data as its single argument (no ungap options).
    const callers = ['node_modules/mdast-util-to-hast/lib/state.js', 'node_modules/mdast-util-to-hast/lib/footer.js'];
    for (const file of callers) {
      const calls = read(file).match(/structuredClone\([^)]*\)/g) ?? [];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call).not.toContain(',');
    }
  });
});
