import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { devToolsUiEnabled, devToolsUiPlugin } from './scripts/build/devToolsUi.js'
import { proUiEnabled, proUiPlugin } from './scripts/build/proUi.js'

// https://vite.dev/config/
// Markdown here never contains raw HTML (no rehype-raw), so an <svg> element can never reach
// hast-util-to-jsx-runtime. Its SVG attribute table (~10 KB) is dead weight in MarkdownImpl, so the
// production bundle swaps it for an empty schema.
let svgSchemaStubbed = false;
const emptySvgSchema = {
  name: 'burrow-empty-svg-schema',
  apply: 'build',
  transform(code, id) {
    // Module ids use forward slashes on every OS; normalise in case a plugin hands over a Windows path.
    if (!/node_modules\/property-information\/lib\/svg\.js$/.test(id.replaceAll('\\', '/'))) return null;
    svgSchemaStubbed = true;
    return {
      code: "import { create } from './util/create.js'; export const svg = create({ properties: {}, space: 'svg', transform: (_, p) => p });",
      map: null,
    };
  },
  buildEnd() {
    if (!svgSchemaStubbed) {
      // Fail loudly: otherwise the only symptom is a vague bundle-budget overrun.
      this.error('burrow-empty-svg-schema never matched property-information/lib/svg.js; update the plugin (or remove it and revisit the bundle budget).');
    }
  },
};

// mdast-util-to-hast clones plain hast data with @ungap/structured-clone, a polyfill for the native
// structuredClone. Every browser the build targets (and WebView2) has the native one, and all four call sites pass
// one plain-data argument, so the production bundle swaps the polyfill (~2.7 KB in MarkdownImpl) for it.
const NATIVE_CLONE_ID = '\0burrow-native-structured-clone';
let nativeCloneUsed = false;
const nativeStructuredClone = {
  name: 'burrow-native-structured-clone',
  enforce: 'pre',
  apply: 'build',
  buildStart() {
    nativeCloneUsed = false;
  },
  resolveId(source) {
    if (source !== '@ungap/structured-clone') return null;
    nativeCloneUsed = true;
    return NATIVE_CLONE_ID;
  },
  load(id) {
    return id === NATIVE_CLONE_ID ? 'export default (value) => structuredClone(value);' : null;
  },
  buildEnd(err) {
    // A build that already failed elsewhere keeps its own error.
    if (!err && !nativeCloneUsed) {
      this.error('burrow-native-structured-clone never saw @ungap/structured-clone; update the plugin (or remove it and revisit the bundle budget).');
    }
  },
};

// d3-scale's time and utc scales are the only users of d3-time-format (~8 KB raw in the charts chunk; its
// default locale runs at import). No chart in src uses a time or utc scale (recharts picks linear, band or point
// for every axis we draw), so the production bundle swaps it for functions that throw. A future time axis fails
// loudly here instead of rendering wrong labels: remove this plugin and revisit the bundle budget then.
const TIME_FORMAT_STUB_ID = '\0burrow-d3-time-format-stub';
let timeFormatStubbed = false;
const stubD3TimeFormat = {
  name: 'burrow-d3-time-format-stub',
  enforce: 'pre',
  apply: 'build',
  buildStart() {
    timeFormatStubbed = false;
  },
  resolveId(source) {
    if (source !== 'd3-time-format') return null;
    timeFormatStubbed = true;
    return TIME_FORMAT_STUB_ID;
  },
  load(id) {
    if (id !== TIME_FORMAT_STUB_ID) return null;
    return [
      "const unused = () => { throw new Error('d3-time-format is stubbed in vite.config.js; remove the stub to use a time scale.'); };",
      'export const timeFormat = unused;',
      'export const utcFormat = unused;',
    ].join('\n');
  },
  buildEnd(err) {
    if (!err && !timeFormatStubbed) {
      this.error('burrow-d3-time-format-stub never saw d3-time-format; update the plugin (or remove it and revisit the bundle budget).');
    }
  },
};

// The developer tools UI (devtools/ui) goes into `npm run dev`, `npm run build:devtools` and BURROW_CHANNEL=dev builds only.
// The Pro UI (pro/ui, the optional private Pro repo) goes into every run where pro/ exists; BURROW_REQUIRE_PRO=1 makes it required.
export default defineConfig(({ command, mode }) => ({
  plugins: [
    react(),
    emptySvgSchema,
    nativeStructuredClone,
    stubD3TimeFormat,
    devToolsUiPlugin(devToolsUiEnabled({ command, mode })),
    proUiPlugin(proUiEnabled()),
  ],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Module ids use forward slashes on every OS.
          groups: [
            // Statically imported Pro UI modules (pro/ui outside lazy/) form one `pro` chunk, so no Pro module lands in a
            // core chunk and the bundle budget can measure core and Pro apart. Lazy Pro components live in
            // pro/ui/lazy/pro-<Name>.jsx, whose chunks are named pro-<Name> (burrow-pro-ui checks both).
            { name: 'pro', test: /\/pro\/ui\/(?!lazy\/)/, priority: 4, includeDependenciesRecursively: false },
            // React itself must not be swept into a lazy group: the entry needs it first.
            { name: 'react', test: /node_modules\/(react|react-dom|scheduler)\//, priority: 3 },
            // Recharts and its d3/redux dependencies: only the pages that draw charts load this.
            {
              name: 'charts',
              test: /node_modules\/(recharts|d3-[^/]+|victory-vendor|internmap|decimal\.js-light|es-toolkit|immer|@reduxjs|redux|redux-thunk|reselect|react-redux|use-sync-external-store|eventemitter3|tiny-invariant)\//,
              priority: 2,
            },
            // The calculator engine and its evalAmount wrapper are needed only by lazy code (the amount fields of
            // the lazy pages and the calculator dialog). Left to `shared` they would grow the initial load; one
            // lazy chunk serves them all. Their own dependencies stay in `shared` (the entry needs those first).
            {
              name: 'calc',
              test: /\/src\/utils\/(calc|evalAmount)\.js$/,
              priority: 2,
              includeDependenciesRecursively: false,
            },
            // The budget plan modules and the subscription detector are imported by the Budget page and by Home's
            // Budget and Subscriptions cards (lazy widgets), so left to `shared` they would grow the initial load; one lazy chunk serves both. Their own dependencies
            // stay in `shared` (the entry needs those first).
            {
              name: 'budget-plan',
              test: /\/src\/(hooks\/(useBudgetPlan|useBudgetData)|utils\/(budgetPlan|budgetFromTransactions|budgetConfig|budgetAggregate|subscriptions)|data\/(budgetSample|budgetConfig))\.(js|json)$/,
              priority: 2,
              includeDependenciesRecursively: false,
            },
            // The Javi reply parts (bubble, source badge, Report link, briefing message) are used by the lazy Javi window
            // and by the lazy Javi card on Home, so left to `shared` they would grow the initial load; one lazy chunk
            // serves both. Their own dependencies stay in `shared` (the entry needs those first).
            {
              name: 'javi-parts',
              test: /\/src\/(components\/(javi\/(adviceParts|JaviMessage|ReportLink|reportContent|AiSourceBadge)|shared\/Markdown)|utils\/javiDashes)\.jsx?$/,
              priority: 2,
              includeDependenciesRecursively: false,
            },
            // dnd-kit and the sortable tile are used by Home and the Budget dashboard (both lazy), so left to `shared`
            // they would grow the initial load; one lazy chunk serves both.
            {
              name: 'dnd',
              test: /node_modules\/@dnd-kit\/|\/src\/components\/home\/WidgetTile\.jsx$/,
              priority: 2,
              includeDependenciesRecursively: false,
            },
            // Tiny modules shared by several lazy pages otherwise each become their own
            // chunk, and every cross-chunk binding costs bytes. One shared chunk is smaller overall.
            // lucide-react icons ship as one tiny module per icon; folding the shared ones into `shared`
            // saves the per-chunk overhead (the lazy Folders page pulled in several).
            { name: 'shared', test: /\/src\/|node_modules\/lucide-react\//, minShareCount: 2, priority: 1 },
          ],
        },
      },
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    // Relative /api calls in dev are forwarded to the local Burrow server
    // (127.0.0.1:4321, env BURROW_PORT).
    proxy: {
      '/api': 'http://127.0.0.1:4321',
    },
  },
}))
