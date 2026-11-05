// Loads the real client-side Javi page builders (src/utils/javiBuilders/*, javiContext.js) and the
// cross-insights math into Node for the eval, so page snapshots have exactly the shape the UI sends.
// Those files use Vite-style extensionless imports, so they are bundled in memory with esbuild
// (a dev dependency) and imported from a data: URL. Nothing is written to disk.
import { build } from 'esbuild';

const ENTRY = `
export { buildBudgetDashboardContext } from './src/utils/javiBuilders/budget';
export { buildTodosContext } from './src/utils/javiBuilders/todos';
export { buildHabitsContext } from './src/utils/javiBuilders/habits';
export { serializeJaviContext } from './src/utils/javiContext';
export { computeCrossInsights, toExplainSummary } from './src/utils/crossInsights';
`;

/**
 * Bundle and import the client builders.
 * @param {string} repoRoot Absolute path of the checkout.
 * @returns {Promise<{ buildBudgetDashboardContext: Function, buildTodosContext: Function, buildHabitsContext: Function,
 *   serializeJaviContext: Function, computeCrossInsights: Function, toExplainSummary: Function }>}
 */
export async function loadClientBuilders(repoRoot) {
  const out = await build({
    stdin: { contents: ENTRY, resolveDir: repoRoot, sourcefile: 'javi-eval-builders.js', loader: 'js' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
  });
  const code = out.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`);
}
