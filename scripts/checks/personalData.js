// Fails when tracked text files contain data that looks personal: emails, phone numbers, SSNs,
// card numbers, home-directory paths, public IPv4 addresses, or any term from the private
// denylist (gitignored `.personal-denylist` and env PERSONAL_DENYLIST). Denylist terms are never
// printed. Usage: node scripts/checks/personalData.js [--staged]
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO_ROOT, listStagedFiles, listTrackedFiles, readStaged, readWorking } from './gitFiles.js'

const ALLOW_FILE = path.join(REPO_ROOT, 'scripts', 'checks', 'personal-data.allow.json')
const DENYLIST_FILE = path.join(REPO_ROOT, '.personal-denylist')

const SKIP_NAMES = new Set(['package-lock.json'])
const SKIP_EXT = /\.(svg|png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|eot|zip|gz|pdf|db|sqlite|bak|mp3|mp4|wasm)$/i

const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g
const ALLOWED_EMAIL_DOMAIN =
  /(^|\.)(example\.(com|org|net)|users\.noreply\.github\.com)$|\.(test|invalid|example|localhost)$/i
const PHONE_RE = /(?<![\w.])(?:\+?1[ .-]?)?\(?[2-9]\d{2}\)?[ .-]\d{3}[ .-]\d{4}(?![\w-])/g
const FICTIONAL_PHONE = /555[ .-]?01\d\d/
const SSN_RE = /(?<![\d-])(\d{3})-(\d{2})-(\d{4})(?![\d-])/g
const CARD_RE = /(?<![\w.-])\d(?:[ -]?\d){12,18}(?![\w.-])/g
const WIN_HOME_RE = /[A-Za-z]:(?:\\{1,4}|\/)Users(?:\\{1,4}|\/)([^\\/\s"'`<>:*?|]+)/g
const UNIX_HOME_RE = /(?<![\w.~-])\/(?:Users|home)\/([^\\/\s"'`<>:*?|]+)/g
const ALLOWED_HOME_NAMES = /^(runner|node|user|users|you|me|name|username|example|tester|public|default|shared|your[-_ ]?name)$/i
const IPV4_RE = /(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w]|\.\d)/g

function isPlaceholderName(name) {
  return /^[<$%{[]/.test(name) || /[>}\]%]$/.test(name) || ALLOWED_HOME_NAMES.test(name)
}

function isAllowedIp([a, b, c]) {
  return (
    a === 127 ||
    a === 10 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a === 255
  )
}

export function luhnValid(digits) {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

/** Parses newline or comma separated terms. Blank lines and `#` comment lines are dropped. */
export function parseDenylist(raw) {
  return String(raw ?? '')
    .split(/[\r\n,]+/)
    .map((t) => t.trim())
    .filter((t) => t && !t.startsWith('#'))
}

/** Denylist terms from `.personal-denylist` (if present) followed by env PERSONAL_DENYLIST. */
export function loadDenylist({ env = process.env, file = DENYLIST_FILE } = {}) {
  const fromFile = existsSync(file) ? parseDenylist(readFileSync(file, 'utf8')) : []
  return [...fromFile, ...parseDenylist(env.PERSONAL_DENYLIST)]
}

const stringList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : [])

/**
 * Normalizes the parsed allowlist JSON. `paths` are whole-file skips, `strings` apply to every
 * file, and `perPath` entries `{ "path": glob, "strings": [...] }` apply only to files matching
 * the glob. A string only exempts a finding whose whole match equals it (see scanText).
 */
export function parseAllowlist(parsed) {
  const src = parsed && typeof parsed === 'object' ? parsed : {}
  return {
    paths: stringList(src.paths),
    strings: stringList(src.strings),
    perPath: (Array.isArray(src.perPath) ? src.perPath : [])
      .filter((e) => e && typeof e.path === 'string')
      .map((e) => ({ path: e.path, strings: stringList(e.strings) })),
  }
}

export function loadAllowlist(file = ALLOW_FILE) {
  if (!existsSync(file)) return parseAllowlist({})
  return parseAllowlist(JSON.parse(readFileSync(file, 'utf8')))
}

/** Global allowed strings plus the ones scoped to globs that match `file`. */
export function allowStringsFor(allow, file) {
  const scoped = allow.perPath.filter((e) => globToRegExp(e.path).test(file)).flatMap((e) => e.strings)
  return [...allow.strings, ...scoped]
}

/** Lowercased `Users/name` form of a home-path match: drive and separator style are ignored. */
const normalizeHome = (s) =>
  s
    .replace(/^[A-Za-z]:/, '')
    .replace(/[\\/]+/g, '/')
    .replace(/^\//, '')
    .toLowerCase()

/** True when an allowed string equals the whole finding (home paths compare by normalized path). */
function isAllowedMatch(kind, matched, allowStrings) {
  if (kind === 'home-path') {
    const wanted = normalizeHome(matched)
    return allowStrings.some((s) => normalizeHome(s) === wanted)
  }
  return allowStrings.includes(matched)
}

const WORD_CHAR = /[A-Za-z0-9_]/

/** True when [start, end) sits inside an allowed string occurrence that has non-word edges. */
function isCoveredByAllowed(line, start, end, allowStrings) {
  for (const s of allowStrings) {
    let from = line.indexOf(s)
    while (from !== -1) {
      const to = from + s.length
      const before = from > 0 ? line[from - 1] : ''
      const after = to < line.length ? line[to] : ''
      if (from <= start && end <= to && !WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true
      from = line.indexOf(s, from + 1)
    }
  }
  return false
}

/** Finds denylist terms in a repo-relative path. Terms are never returned, only their index. */
export function scanPath(file, denylist = []) {
  const lower = String(file).toLowerCase()
  const hits = []
  denylist.forEach((term, termIndex) => {
    if (term && lower.includes(term.toLowerCase())) hits.push({ termIndex })
  })
  return hits
}

/** Converts a simple glob (`**`, `*`, `?`) into an anchored RegExp over forward-slash paths. */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*'
      i += 1
      if (glob[i + 1] === '/') i += 1
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/**
 * Scans text and returns findings `{ line, col, kind, match }`. `match` is null for denylist hits
 * so a term can never leak through a report. `allowStrings` exempt only a finding whose whole match
 * equals one (a denylist hit is exempt only when it lies inside an allowed string with non-word
 * edges), so an allowed short address never excuses a longer one ending with it. `kind` is one of email, phone, ssn, card, home-path,
 * public-ip, denylist (with `termIndex`).
 */
export function scanText(text, { denylist = [], allowStrings = [] } = {}) {
  const findings = []
  const terms = denylist.map((t) => t.toLowerCase())
  const rawLines = String(text).split(/\r?\n/)
  rawLines.forEach((rawLine, idx) => {
    const line = rawLine
    const add = (m, kind) => {
      if (isAllowedMatch(kind, m[0], allowStrings)) return
      findings.push({ line: idx + 1, col: m.index + 1, kind, match: m[0] })
    }

    for (const m of line.matchAll(EMAIL_RE)) if (!ALLOWED_EMAIL_DOMAIN.test(m[1])) add(m, 'email')
    for (const m of line.matchAll(PHONE_RE)) if (!FICTIONAL_PHONE.test(m[0])) add(m, 'phone')
    for (const m of line.matchAll(SSN_RE)) {
      const [, area, group, serial] = m
      if (area !== '000' && area !== '666' && area[0] !== '9' && group !== '00' && serial !== '0000') add(m, 'ssn')
    }
    for (const m of line.matchAll(CARD_RE)) {
      const digits = m[0].replace(/[ -]/g, '')
      if (digits.length >= 13 && digits.length <= 19 && !/^(\d)\1+$/.test(digits) && luhnValid(digits)) {
        add(m, 'card')
      }
    }
    for (const re of [WIN_HOME_RE, UNIX_HOME_RE]) {
      for (const m of line.matchAll(re)) if (!isPlaceholderName(m[1])) add(m, 'home-path')
    }
    for (const m of line.matchAll(IPV4_RE)) {
      const octets = m.slice(1, 5).map(Number)
      if (octets.every((o) => o <= 255) && !isAllowedIp(octets)) add(m, 'public-ip')
    }
    if (terms.length) {
      const lower = line.toLowerCase()
      terms.forEach((term, termIndex) => {
        let from = lower.indexOf(term)
        while (from !== -1) {
          if (!isCoveredByAllowed(line, from, from + term.length, allowStrings)) {
            findings.push({ line: idx + 1, col: from + 1, kind: 'denylist', match: null, termIndex })
          }
          from = lower.indexOf(term, from + term.length)
        }
      })
    }
  })
  return findings
}

export function isCheckedFile(file) {
  // The allowlist itself necessarily holds the fixture strings it exempts.
  if (file === 'scripts/checks/personal-data.allow.json') return false
  return !SKIP_NAMES.has(path.posix.basename(file)) && !SKIP_EXT.test(file)
}

function looksBinary(text) {
  return text.slice(0, 8192).includes('\u0000')
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const staged = argv.includes('--staged')
  const allow = loadAllowlist()
  const allowPaths = allow.paths.map(globToRegExp)
  const denylist = loadDenylist({ env })
  const all = staged ? listStagedFiles() : listTrackedFiles()
  let failures = 0
  for (const file of all) {
    for (const hit of scanPath(file, denylist)) {
      failures += 1
      console.error(`<redacted path>: denylist term #${hit.termIndex + 1} in a file path`)
    }
  }
  const files = all.filter((f) => isCheckedFile(f) && !allowPaths.some((re) => re.test(f)))
  for (const file of files) {
    const text = staged ? readStaged(file) : readWorking(file)
    if (text === null || looksBinary(text)) continue
    for (const f of scanText(text, { denylist, allowStrings: allowStringsFor(allow, file) })) {
      failures += 1
      const label = f.kind === 'denylist' ? `denylist term #${f.termIndex + 1}` : `possible ${f.kind}`
      console.error(`${file}:${f.line}:${f.col} ${label}`)
    }
  }
  if (failures) {
    console.error(
      `\ncheck:personal failed: ${failures} finding(s). Remove the data, or if it is a deliberate public value ` +
        'add it to scripts/checks/personal-data.allow.json.',
    )
    return 1
  }
  console.log(`check:personal ok (${files.length} files, ${denylist.length} denylist term(s))`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
