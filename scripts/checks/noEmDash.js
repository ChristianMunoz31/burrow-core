// Fails when user-facing JSX source contains an em dash (U+2014). Comments are ignored; string
// literals, template literals and JSX text are not. Usage: node scripts/checks/noEmDash.js [--staged]
import { pathToFileURL } from 'node:url'
import { listStagedFiles, listTrackedFiles, readStaged, readWorking } from './gitFiles.js'

const EM_DASH_PATTERNS = [/—/g, /&mdash;/gi, /&#0*8212;/g, /&#x0*2014;/gi, /\\u2014/gi, /\\u\{0*2014\}/gi]

/** Replaces comment text with spaces (newlines kept) so offsets and line numbers stay stable. */
export function stripComments(text) {
  const out = text.split('')
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '
  }
  // Template literal state: each entry is the brace depth at which a `${` interpolation opened.
  const templateStack = []
  let braceDepth = 0
  let i = 0
  const n = text.length
  const scanTemplateBody = () => {
    // Positioned just after a backtick or the closing brace of an interpolation.
    while (i < n) {
      const c = text[i]
      if (c === '\\') i += 2
      else if (c === '`') {
        i += 1
        return
      } else if (c === '$' && text[i + 1] === '{') {
        templateStack.push(braceDepth)
        braceDepth += 1
        i += 2
        return
      } else i += 1
    }
  }
  while (i < n) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '/' && next === '/') {
      let end = text.indexOf('\n', i)
      if (end === -1) end = n
      blank(i, end)
      i = end
    } else if (c === '/' && next === '*') {
      let end = text.indexOf('*/', i + 2)
      end = end === -1 ? n : end + 2
      blank(i, end)
      i = end
    } else if (c === '"' || c === "'") {
      // JSX text can hold a lone apostrophe, so a quoted string never runs past the end of the line.
      let j = i + 1
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1
      i = j + 1
    } else if (c === '`') {
      i += 1
      scanTemplateBody()
    } else if (c === '{') {
      braceDepth += 1
      i += 1
    } else if (c === '}') {
      braceDepth -= 1
      i += 1
      if (templateStack.length && templateStack[templateStack.length - 1] === braceDepth) {
        templateStack.pop()
        scanTemplateBody()
      }
    } else i += 1
  }
  return out.join('')
}

/** Returns `[{ line, col, match }]` for every em dash outside comments. Lines and columns are 1-based. */
export function scanText(text) {
  const stripped = stripComments(text)
  const found = []
  for (const re of EM_DASH_PATTERNS) {
    for (const m of stripped.matchAll(re)) {
      const before = stripped.slice(0, m.index)
      const line = before.split('\n').length
      const col = m.index - before.lastIndexOf('\n')
      found.push({ line, col, match: m[0] })
    }
  }
  return found.sort((a, b) => a.line - b.line || a.col - b.col)
}

export function isCheckedFile(file) {
  return /^src\/.*\.jsx$/.test(file) && !/(^|\/)__tests__\//.test(file) && !/\.test\.jsx$/.test(file)
}

export function main(argv = process.argv.slice(2)) {
  const staged = argv.includes('--staged')
  const files = (staged ? listStagedFiles() : listTrackedFiles()).filter(isCheckedFile)
  let failures = 0
  for (const file of files) {
    const text = staged ? readStaged(file) : readWorking(file)
    if (text === null) continue
    for (const f of scanText(text)) {
      failures += 1
      console.error(`${file}:${f.line}:${f.col} em dash in user-facing source`)
    }
  }
  if (failures) {
    console.error(`\ncheck:em-dash failed: ${failures} em dash(es). Use a comma, colon, period or hyphen instead.`)
    return 1
  }
  console.log(`check:em-dash ok (${files.length} files)`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
