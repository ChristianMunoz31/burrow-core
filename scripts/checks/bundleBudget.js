// Fails when the gzipped size of the built UI exceeds scripts/checks/bundle-budget.json.
// Run `npm run build` first. Prints a markdown table (also appended to $GITHUB_STEP_SUMMARY in CI).
// Open core (docs/adr/0001-open-core-split.md 3.13): the core keys are measured over the assets NOT named pro-*
// (in both modes); the Pro keys (proTotalJsGzipKb, proInitialJsGzipKb) over assets/pro-*.js and are checked only
// when Pro assets exist and the budget file has them; the combined totals are printed, never enforced.
// Usage: node scripts/checks/bundleBudget.js
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { REPO_ROOT } from './gitFiles.js'

const ASSETS_DIR = path.join(REPO_ROOT, 'dist', 'assets')
const BUDGET_FILE = path.join(REPO_ROOT, 'scripts', 'checks', 'bundle-budget.json')

const kb = (bytes) => Math.round((bytes / 1024) * 100) / 100

/**
 * Asset file names the browser needs before the app can start: the entry module script plus every
 * modulepreload link in `dist/index.html`. Lazy route chunks are not listed there.
 */
export function initialAssetNames(html) {
  const names = []
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    const src = /\btype\s*=\s*["']module["']/i.test(tag) ? /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag) : null
    if (src) names.push(src[1])
  }
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const href = /\brel\s*=\s*["']modulepreload["']/i.test(tag) ? /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag) : null
    if (href) names.push(href[1])
  }
  return [...new Set(names.map((n) => path.posix.basename(n.split('?')[0])))].filter((n) => n.endsWith('.js'))
}

/**
 * Sums gzip sizes (KiB) from a list of `{ name, gzipBytes }` assets. Pass `initialNames` (from
 * initialAssetNames) to also get `initialJsGzipKb`, the gzip sum of the scripts needed at startup.
 */
export function summarize(assets, initialNames) {
  const js = assets.filter((a) => a.name.endsWith('.js'))
  const css = assets.filter((a) => a.name.endsWith('.css'))
  const total = (list) => list.reduce((sum, a) => sum + a.gzipBytes, 0)
  const summary = {
    totalJsGzipKb: kb(total(js)),
    largestJsGzipKb: kb(js.reduce((max, a) => Math.max(max, a.gzipBytes), 0)),
    totalCssGzipKb: kb(total(css)),
  }
  if (initialNames) summary.initialJsGzipKb = kb(total(js.filter((a) => initialNames.includes(a.name))))
  return summary
}

/**
 * Compares measured sizes with a budget. Returns `{ rows, ok }`. The three original keys are always
 * required; `initialJsGzipKb` is checked only when the budget file has it.
 */
export function evaluate(measured, budget) {
  const keys = ['totalJsGzipKb', 'largestJsGzipKb', 'totalCssGzipKb']
  if ('initialJsGzipKb' in budget) keys.push('initialJsGzipKb')
  const rows = keys.map((key) => ({
    key,
    measured: measured[key],
    budget: budget[key],
    ok: typeof budget[key] === 'number' && measured[key] <= budget[key],
  }))
  return { rows, ok: rows.every((r) => r.ok) }
}

/** Prefix of every Pro asset (the `pro` group chunk and the pro-<Name> lazy chunks). */
export const isProAsset = (name) => name.startsWith('pro-')

/**
 * Splits the assets into core and Pro and measures each (ADR 3.13).
 * @param {{ name: string, gzipBytes: number }[]} assets
 * @param {string[] | undefined} initialNames
 * @returns {{ core: object, pro: { proTotalJsGzipKb: number, proInitialJsGzipKb: number } | null, combined: { combinedTotalJsGzipKb: number, combinedInitialJsGzipKb?: number } }}
 */
export function measureSplit(assets, initialNames) {
  const core = summarize(assets.filter((a) => !isProAsset(a.name)), initialNames)
  const proAssets = assets.filter((a) => isProAsset(a.name))
  const all = summarize(assets, initialNames)
  const combined = { combinedTotalJsGzipKb: all.totalJsGzipKb }
  if ('initialJsGzipKb' in all) combined.combinedInitialJsGzipKb = all.initialJsGzipKb
  if (proAssets.length === 0) return { core, pro: null, combined }
  const proSummary = summarize(proAssets, initialNames ?? [])
  return { core, pro: { proTotalJsGzipKb: proSummary.totalJsGzipKb, proInitialJsGzipKb: proSummary.initialJsGzipKb ?? 0 }, combined }
}

/**
 * Pro keys: checked only when Pro assets exist and the budget has the key; otherwise reported.
 * @returns {{ rows: { key: string, measured: number, budget: number | string, ok: boolean }[], ok: boolean }}
 */
export function evaluatePro(pro, budget) {
  if (!pro) return { rows: [], ok: true }
  const rows = ['proTotalJsGzipKb', 'proInitialJsGzipKb'].map((key) => {
    const has = typeof budget[key] === 'number'
    return { key, measured: pro[key], budget: has ? budget[key] : 'not set', ok: !has || pro[key] <= budget[key] }
  })
  return { rows, ok: rows.every((r) => r.ok) }
}

export function toMarkdown(rows, extra = []) {
  const lines = ['### Bundle size (gzip, KiB)', '', '| Metric | Measured | Budget | Status |', '| --- | ---: | ---: | --- |']
  for (const r of rows) lines.push(`| ${r.key} | ${r.measured} | ${r.budget} | ${r.ok ? 'ok' : 'OVER'} |`)
  for (const r of extra) lines.push(`| ${r.key} | ${r.measured} | ${r.budget} | ${r.status} |`)
  return lines.join('\n')
}

export function readAssets(dir = ASSETS_DIR) {
  return readdirSync(dir)
    .filter((name) => /\.(js|css)$/.test(name))
    .map((name) => ({ name, gzipBytes: gzipSync(readFileSync(path.join(dir, name))).length }))
}

export function main(env = process.env) {
  if (!existsSync(ASSETS_DIR)) {
    console.error('check:bundle needs a build. Run `npm run build` first.')
    return 1
  }
  const budget = JSON.parse(readFileSync(BUDGET_FILE, 'utf8'))
  const indexHtml = path.join(REPO_ROOT, 'dist', 'index.html')
  const initialNames = existsSync(indexHtml) ? initialAssetNames(readFileSync(indexHtml, 'utf8')) : undefined
  const split = measureSplit(readAssets(), initialNames)
  const core = evaluate(split.core, budget)
  const pro = evaluatePro(split.pro, budget)
  const ok = core.ok && pro.ok
  const combinedRows = Object.entries(split.combined).map(([key, measured]) => ({ key, measured, budget: 'n/a', status: 'info' }))
  const table = toMarkdown([...core.rows, ...pro.rows], combinedRows)
  console.log(table)
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${table}\n`)
  if (!ok) {
    console.error('\ncheck:bundle failed: the bundle grew past its budget. Trim it, or raise scripts/checks/bundle-budget.json on purpose.')
    return 1
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
