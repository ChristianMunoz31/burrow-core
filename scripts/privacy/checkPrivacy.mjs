// Fails when the committed pages/ output differs from a fresh in-memory render, or when a
// network feature id or host from server/netFeatures.js is missing from the rendered policy.
// Usage: node scripts/privacy/checkPrivacy.mjs   (npm run check:privacy)
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { NETWORK_FEATURES } from '../../server/netFeatures.js'
import { PAGES_DIR, esc, renderPages } from './renderPrivacy.mjs'

const STORE_CONFIG = path.join(PAGES_DIR, '..', 'config', 'msstore.json')

/**
 * @param {Record<string, string>} rendered fresh render, keyed by relative path
 * @param {(rel: string) => string | null} readCommitted committed file text, or null when absent
 * @param {readonly { id: string, hosts: readonly string[] }[]} features
 * @returns {string[]} problems; empty means in step
 */
export function findPrivacyProblems(rendered, readCommitted, features = NETWORK_FEATURES) {
  const problems = []
  for (const [rel, text] of Object.entries(rendered)) {
    const committed = readCommitted(rel)
    if (committed === null) problems.push(`pages/${rel} is missing (run npm run privacy:render)`)
    else if (committed !== text) problems.push(`pages/${rel} is out of date (run npm run privacy:render)`)
  }
  const policy = rendered['privacy/index.html'] ?? ''
  for (const f of features) {
    if (!policy.includes(`id="${esc(f.id)}"`) || !policy.includes(`<code>${esc(f.id)}</code>`)) {
      problems.push(`feature id "${f.id}" is missing from the rendered privacy page`)
    }
    for (const host of f.hosts) {
      if (!policy.includes(esc(host))) problems.push(`host "${host}" (feature ${f.id}) is missing from the rendered privacy page`)
    }
  }
  return problems
}

const readFromDisk = (rel) => {
  const file = path.join(PAGES_DIR, ...rel.split('/'))
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!existsSync(STORE_CONFIG)) {
    console.log('check:privacy: config/msstore.json is not in this tree (public core); the Store data folder line follows the committed page')
  }
  const problems = findPrivacyProblems(renderPages(), readFromDisk)
  if (problems.length > 0) {
    for (const p of problems) console.error(`check:privacy: ${p}`)
    process.exit(1)
  }
  console.log('check:privacy: pages/ matches the network feature registry')
}
