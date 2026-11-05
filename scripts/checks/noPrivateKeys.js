// Fails when a tracked or staged text file looks like it holds a private key: a PEM private key block, a minisign or
// Tauri updater signing key (the raw secret key header, the base64 form of that header that a Tauri key file starts
// with, or the minisign secret key blob), or any tracked file named *.key. Public keys are never flagged.
// The patterns are built from fragments (and the base64 forms at load time) so this file never matches itself.
// Findings print the file and line only, never the matched text.
// Usage: node scripts/checks/noPrivateKeys.js [--staged]
import { pathToFileURL } from 'node:url'
import { listStagedFiles, listTrackedFiles, readStaged, readWorking } from './gitFiles.js'

const SKIP_EXT = /\.(svg|png|jpe?g|gif|webp|ico|icns|woff2?|ttf|otf|eot|zip|gz|pdf|db|sqlite|bak|mp3|mp4|wasm)$/i

// Excluded by exact path: this file and its test, which spell the pattern out.
export const EXCLUDED_FILES = new Set([
  'scripts/checks/noPrivateKeys.js',
  'server/__tests__/license/noPrivateKeys.test.js',
])

// "untrusted comment: <tool> [encrypted] secret key" is the first line of a minisign or rsign secret key file, which is
// what `tauri signer generate` writes (base64 encoded as a whole, so its base64 form starts the file).
const COMMENT = 'untrusted comment' + ': '
const SECRET_HEADERS = ['rsign', 'minisign'].flatMap((tool) => [`${tool} encrypted secret` + ' key', `${tool} secret` + ' key'])

/** Base64 of the header text, cut to whole 3-byte groups so it is the same wherever the key text continues. */
const base64Prefix = (text) => {
  const bytes = Buffer.from(text, 'utf8')
  return bytes.subarray(0, bytes.length - (bytes.length % 3)).toString('base64')
}

export const PATTERNS = Object.freeze([
  { kind: 'pem-private-key', re: new RegExp(`-----BEGIN (?:[A-Z0-9]+ )*PRIVATE` + ` KEY-----`) },
  { kind: 'minisign-secret-key-header', re: new RegExp(`${COMMENT}(?:rsign|minisign) (?:encrypted )?secret` + ` key`) },
  {
    kind: 'tauri-secret-key-file',
    re: new RegExp(SECRET_HEADERS.map((h) => base64Prefix(COMMENT + h)).join('|')),
  },
  // The secret key line of a minisign key: "Ed" + kdf "Sc" or none, then a checksum algorithm "B2" (RWRTY0Iy / RWQAAEIy).
  { kind: 'minisign-secret-key-blob', re: /^(?:RWRTY0Iy|RWQAAEIy)[A-Za-z0-9+/=]{40,}\s*$/m },
])

const KEY_FILE_NAME = /\.key$/i

/**
 * Any tracked file named *.key is refused, whatever it holds (signing keys live outside every repo).
 * @param {string} file repo-relative path
 * @returns {boolean}
 */
export function isKeyFileName(file) {
  return KEY_FILE_NAME.test(file)
}

/**
 * @param {string} text
 * @returns {{ line: number, kind: string }[]}
 */
export function scanText(text) {
  const found = []
  for (const { kind, re } of PATTERNS) {
    const m = re.exec(text)
    if (m) found.push({ line: text.slice(0, m.index).split('\n').length, kind })
  }
  return found
}

export function isCheckedFile(file) {
  return !EXCLUDED_FILES.has(file) && !SKIP_EXT.test(file)
}

export function main(argv = process.argv.slice(2)) {
  const staged = argv.includes('--staged')
  const files = (staged ? listStagedFiles() : listTrackedFiles()).filter((file) => isKeyFileName(file) || isCheckedFile(file))
  let failures = 0
  for (const file of files) {
    if (isKeyFileName(file)) {
      failures += 1
      console.error(`${file}:1 is a key file by name (key-file-name)`)
      continue
    }
    const text = staged ? readStaged(file) : readWorking(file)
    if (text === null) continue
    for (const f of scanText(text)) {
      failures += 1
      console.error(`${file}:${f.line} looks like a private key (${f.kind})`)
    }
  }
  if (failures) {
    console.error(`\ncheck:keys failed: ${failures} possible private key(s). Remove them and rotate the key if it was real.`)
    return 1
  }
  console.log(`check:keys ok (${files.length} files)`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
