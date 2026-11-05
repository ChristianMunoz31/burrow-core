// Prints whether each store in config/store.json is configured, for the owner to sanity-check after
// pasting product ids. Never prints an id, never contacts a store. Not part of `npm run check`: the
// committed file holds placeholders, which must not fail CI.
// Usage: node scripts/checks/storeConfig.js [--require gumroad|lemonsqueezy|all]
// With --require, exits 1 when a named store is not configured (for a release gate).
import { pathToFileURL } from 'node:url'
import { GUMROAD, GUMROAD_PURCHASE_URL, LEMON_SQUEEZY, SUPPORT_CONTACT } from '../../server/license/storeConfig.js'
import { gumroad } from '../../server/license/stores/gumroad.js'
import { lemonSqueezy } from '../../server/license/stores/lemonSqueezy.js'

const CONFIG = { SUPPORT_CONTACT, GUMROAD, LEMON_SQUEEZY }

/**
 * @returns {{ id: string, label: string, configured: boolean, detail: string }[]}
 */
export function describeStores() {
  return [
    {
      id: 'gumroad',
      label: 'Gumroad',
      configured: gumroad.isConfigured(CONFIG),
      detail: GUMROAD.freeProductId ? 'Pro product set, student/nonprofit product set' : 'Pro product set, no student/nonprofit product',
    },
    {
      id: 'lemonsqueezy',
      label: 'Lemon Squeezy',
      configured: lemonSqueezy.isConfigured(CONFIG),
      detail: `${LEMON_SQUEEZY.productIds.length} product(s), ${Object.keys(LEMON_SQUEEZY.variantEditions).length} variant(s)`,
    },
  ]
}

/**
 * @param {string[]} argv
 * @returns {string[]} store ids named by --require
 */
export function requiredFrom(argv) {
  const i = argv.indexOf('--require')
  if (i === -1) return []
  const value = argv[i + 1]
  if (value === 'all') return ['gumroad', 'lemonsqueezy']
  if (value !== 'gumroad' && value !== 'lemonsqueezy') throw new Error('--require needs gumroad, lemonsqueezy or all')
  return [value]
}

function main() {
  const required = requiredFrom(process.argv.slice(2))
  const stores = describeStores()
  for (const s of stores) {
    console.log(`${s.label}: ${s.configured ? `configured (${s.detail})` : 'NOT configured (off)'}`)
  }
  console.log(`Support contact: ${SUPPORT_CONTACT ? 'set' : 'not set (buyers see "the seller")'}`)
  console.log(`Buy button: ${GUMROAD_PURCHASE_URL ? `shows ${GUMROAD_PURCHASE_URL}` : 'hidden (no valid gumroad.proPurchaseUrl)'}`)
  const missing = stores.filter((s) => required.includes(s.id) && !s.configured)
  if (missing.length > 0) {
    console.error(`Required but not configured: ${missing.map((s) => s.label).join(', ')}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
