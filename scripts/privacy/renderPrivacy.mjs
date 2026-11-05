// Renders the public privacy policy as a static, self-contained site from the same registry the
// in-app Settings > Network page reads (server/netFeatures.js). No scripts, fonts, images or
// trackers; inline CSS only; light and dark through prefers-color-scheme.
// Usage: node scripts/privacy/renderPrivacy.mjs   (writes pages/)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NETWORK_FEATURES } from '../../server/netFeatures.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const PAGES_DIR = path.join(ROOT, 'pages')
const MS_PRIVACY = 'https://privacy.microsoft.com/privacystatement'

const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'))

const STORE_CONFIG = 'config/msstore.json'

/**
 * The Store data location the committed privacy page already describes, read from its text. Used only when
 * config/msstore.json is absent (the public core export leaves it out with the rest of the Store release setup), so the
 * page is re-rendered as committed instead of guessing a different Store edition.
 * @param {string} dir the pages/ folder
 * @returns {'appdata' | 'userprofile'}
 */
export function committedStoreDataLocation(dir = PAGES_DIR) {
  const file = path.join(dir, 'privacy', 'index.html')
  if (!existsSync(file)) return 'appdata'
  return readFileSync(file, 'utf8').includes('%USERPROFILE%\\Burrow Data') ? 'userprofile' : 'appdata'
}

/**
 * Where the Store edition keeps its data: config/msstore.json "dataLocation" (default appdata). Without that file (public
 * core export) it follows the committed page, so the Store edition line is not compared against a config that is not there.
 * @returns {'appdata' | 'userprofile'}
 */
export function storeDataLocationFromConfig() {
  if (!existsSync(path.join(ROOT, STORE_CONFIG))) return committedStoreDataLocation()
  const location = readJson(STORE_CONFIG).dataLocation ?? 'appdata'
  if (location !== 'appdata' && location !== 'userprofile') {
    throw new Error('config/msstore.json dataLocation must be appdata or userprofile')
  }
  return location
}

/**
 * Where the data folder is, per edition, for the policy text. The direct download edition always keeps %APPDATA%\Burrow. The
 * Microsoft Store edition keeps it there too, unless the Store build was made with the userprofile data location (config/msstore.json
 * "dataLocation", the fallback when Partner Center refuses unvirtualizedResources): then it is %USERPROFILE%\Burrow Data.
 * @param {'appdata' | 'userprofile'} storeDataLocation
 */
export function dataFolderText(storeDataLocation) {
  const appdata = '<code>%APPDATA%\\Burrow</code>'
  const profile = '<code>%USERPROFILE%\\Burrow Data</code>'
  if (storeDataLocation === 'userprofile') {
    return {
      short: `Your data stays on your computer: ${appdata} for the direct download edition, and ${profile} (inside your user folder) for the Microsoft Store edition.`,
      remove: `Uninstalling Burrow does not delete your data folder, so your data survives a reinstall. To remove everything, uninstall Burrow and then delete its data folder: ${appdata} for the direct download edition, ${profile} for the Microsoft Store edition (paste the path into the File Explorer address bar).`,
    }
  }
  return {
    short: `Your data stays on your computer, in the folder ${appdata}, in both the direct download edition and the Microsoft Store edition.`,
    remove: `Uninstalling Burrow does not delete your data folder, so your data survives a reinstall. To remove everything, uninstall Burrow and then delete the folder ${appdata} (paste that into the File Explorer address bar).`,
  }
}

/** @param {string} s */
export const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/

/** @param {unknown} v */
export const isEmail = (v) => typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v)

/**
 * A mailto: URL for a validated address, percent-encoded (the @ stays literal) and then HTML-escaped.
 * @param {string} email
 */
export function mailtoHref(email) {
  if (!isEmail(email)) throw new Error('not a valid email address')
  return esc('mailto:' + encodeURIComponent(email).replace(/%40/g, '@'))
}

const CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#1c2230;--muted:#505a6e;--line:#d6dbe4;--card:#f5f7fa;--link:#0b5cad}
@media (prefers-color-scheme:dark){:root{--bg:#10141c;--fg:#e6e9ef;--muted:#a3adc0;--line:#2b3445;--card:#182030;--link:#7db4f0}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:46rem;margin:0 auto;padding:2rem 1.25rem 4rem}
h1{font-size:1.9rem;line-height:1.2;margin:0 0 .25rem}
h2{font-size:1.25rem;margin:2.25rem 0 .5rem;border-top:1px solid var(--line);padding-top:1.25rem}
h3{font-size:1.05rem;margin:0 0 .35rem}
a{color:var(--link)}
code{font:.9em ui-monospace,Consolas,monospace;background:var(--card);padding:.1em .35em;border-radius:4px}
.meta{color:var(--muted);margin:0 0 1.5rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:1rem 1.15rem;margin:0 0 1rem}
.card p{margin:.3rem 0}
.k{font-weight:600}
ul{padding-left:1.25rem}
footer{margin-top:3rem;color:var(--muted);font-size:.9rem}`

const page = ({ title, description, body }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${esc(description)}">
<meta name="robots" content="index,follow">
<title>${esc(title)}</title>
<style>
${CSS}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`

const featureCard = (f) => `<section class="card" id="${esc(f.id)}">
<h3>${esc(f.label)} (<code>${esc(f.id)}</code>)</h3>
<p><span class="k">Connects to:</span> ${f.hosts.map((h) => `<code>${esc(h)}</code>`).join(', ')}</p>
<p><span class="k">What is sent:</span> ${esc(f.policy.sent)}</p>
<p><span class="k">When:</span> ${esc(f.policy.when)}</p>
<p><span class="k">What the app tells you:</span> ${esc(f.description)}</p>
</section>`

/**
 * @param {{ policyVersion: string, effectiveDate: string }} privacy
 * @param {string} contact
 * @param {readonly { id: string, label: string, description: string, hosts: readonly string[], policy: { sent: string, when: string } }[]} features
 * @param {{ storeDataLocation?: 'appdata' | 'userprofile' }} [opts] the data location of the Store edition (see dataFolderText)
 */
export function renderPrivacyPage(privacy, contact, features = NETWORK_FEATURES, { storeDataLocation = 'appdata' } = {}) {
  const mail = esc(contact)
  const folder = dataFolderText(storeDataLocation)
  const href = mailtoHref(contact)
  const body = `<h1>Burrow privacy policy</h1>
<p class="meta">Version ${esc(privacy.policyVersion)}. Effective ${esc(privacy.effectiveDate)}. Applies to Burrow: Private Life Organizer, the Windows app from Neural Foundry, both the Microsoft Store edition and the direct download edition.</p>

<h2>Who we are</h2>
<p>Burrow is made by Neural Foundry, an individual developer. Contact: <a href="${href}">${mail}</a>.</p>

<h2>The short version</h2>
<ul>
<li>${folder.short}</li>
<li>No accounts. No telemetry. No analytics. The developer does not receive your data.</li>
<li>Burrow does not contact the internet on its own. Every feature that does is off until you turn it on in Settings &gt; Network or click a button for it.</li>
<li>The Network activity page in Settings &gt; Privacy &amp; activity lists recent outbound connections Burrow has made. Burrow keeps that list for 90 days.</li>
</ul>

<h2>Every connection Burrow can make</h2>
<p>This list is generated from the same registry that the Network page in the app uses, so the two cannot disagree. Each feature is off by default.</p>
${features.map(featureCard).join('\n')}

<h2>Downloading an AI model</h2>
<p>By default, Javi (the assistant) talks only to Ollama on your own computer (<code>127.0.0.1</code>). Burrow does not install Ollama. If you click Get Ollama, your browser opens ollama.com. When you click Download model, Ollama, not Burrow, downloads the model from the Ollama library. Burrow makes no internet call for it.</p>

<h2>Cloud AI with your own key</h2>
<p>Cloud AI is off by default. If you turn it on, Burrow sends prompts and the data Javi reads to the endpoint you chose, using your own API key, and only for the data categories you allow. Budget, todos, calendar, habits, bookmarks, countdowns and focus are on by default once cloud is enabled; health, notes, journal and the files of folders you add are off until you allow them. A few items have no data category, so those choices do not limit them: weather results that Javi looks up, and the advice Javi gives on the Settings page. They can be sent whenever cloud AI is on. You accept a consent screen first, and you pay the provider yourself. Saved API keys are stored encrypted on your computer and are not included in backups or exports.</p>

<h2>Links that send nothing from Burrow</h2>
<p>The Buy Burrow Pro button opens the seller's page in your default browser. The Report content link in Javi and the Help menu opens your default mail app with an empty message to <a href="${href}">${mail}</a>. Burrow itself sends nothing for these. If you send the email, your mail provider and we receive what you write.</p>

<h2>Microsoft Store</h2>
<p>If you installed Burrow from the Microsoft Store, Microsoft may collect data about the install, purchase and updates under the <a href="${MS_PRIVACY}">Microsoft privacy statement</a>. Burrow does not receive that data. The Store edition delivers updates through the Store and makes no update request itself.</p>

<h2>Purchases</h2>
<p>Burrow Pro is sold by Gumroad or Lemon Squeezy, which handle checkout, tax and refunds under their own privacy policies. They hold your purchase details, not Burrow.</p>

<h2>Deleting your data</h2>
<ul>
<li>In Burrow, open Settings &gt; Data &amp; storage &gt; Danger zone and choose Erase all my data. It asks you to confirm, offers an export first and can delete backups too.</li>
<li>${folder.remove}</li>
</ul>

<h2>Children</h2>
<p>Burrow collects no personal information from anyone, including children, because it collects no information at all. Anything a child enters stays on that computer.</p>

<h2>Changes to this policy</h2>
<p>If the way Burrow handles data changes, this page changes with it and the version and effective date above are updated. Any new outbound connection must be added to the registry that produces the list above, so it appears here before it ships.</p>

<h2>Contact</h2>
<p>Questions: <a href="${href}">${mail}</a>.</p>
<footer>Generated from the Burrow network feature registry. Version ${esc(privacy.policyVersion)}.</footer>`
  return page({
    title: 'Burrow privacy policy',
    description: 'Burrow keeps your data on your computer. No accounts, no telemetry. Every outbound connection is listed here.',
    body,
  })
}

/** @param {string} contact */
export function renderIndexPage(contact) {
  return page({
    title: 'Burrow',
    description: 'Burrow: Private Life Organizer. Privacy policy.',
    body: `<h1>Burrow</h1>
<p class="meta">Burrow: Private Life Organizer, by Neural Foundry.</p>
<ul>
<li><a href="privacy/">Privacy policy</a></li>
<li>Support: <a href="${mailtoHref(contact)}">${esc(contact)}</a></li>
</ul>`,
  })
}

/**
 * Every generated file, keyed by its path relative to pages/ (forward slashes), as text.
 * Pure and deterministic: reads only committed config (and, without config/msstore.json, the committed privacy page).
 * @returns {Record<string, string>}
 */
export function renderPages() {
  const contact = readJson('config/store.json').supportContact
  const privacy = readJson('config/privacy.json')
  if (!isEmail(contact)) throw new Error('config/store.json supportContact is not an email address')
  if (typeof privacy.policyVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(String(privacy.effectiveDate))) {
    throw new Error('config/privacy.json needs policyVersion and an effectiveDate like 2026-10-08')
  }
  const storeDataLocation = storeDataLocationFromConfig()
  return {
    '.nojekyll': '',
    'index.html': renderIndexPage(contact),
    'privacy/index.html': renderPrivacyPage(privacy, contact, NETWORK_FEATURES, { storeDataLocation }),
  }
}

/** Writes the rendered site into pages/ (creates folders, never deletes). */
export function writePages(dir = PAGES_DIR, files = renderPages()) {
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(dir, ...rel.split('/'))
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, text, 'utf8')
  }
  return Object.keys(files)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const written = writePages()
  console.log(`Wrote ${written.length} files to pages/`)
}
