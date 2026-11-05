// ci:always-run
// scripts/release/disableDevTools.mjs: the release zip step that removes devtools/ and scans for the markers.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { disableDevTools } from '../../scripts/release/disableDevTools.mjs'
import { DEV_TOOLS_MARKER, DEV_TOOLS_ROUTE_MARKER } from '../../scripts/checks/channelMarker.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const STALE = ['server', 'license', 'devOverride.js']

let root
const put = (parts, text) => {
  const file = path.join(root, ...parts)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
const exists = (parts) => fs.existsSync(path.join(root, ...parts))

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-disable-dev-'))
  put(['devtools', 'server', 'license', 'devOverride.js'], `log('${DEV_TOOLS_MARKER}');\n`)
  put(['devtools', 'ui', 'DeveloperSection.jsx'], `<div data-dev-tools="${DEV_TOOLS_MARKER}" />\n`)
  put(['server.js'], 'export {};\n')
  put(['server', 'devExtensionsLoader.js'], 'export async function importDevExtension() { return null; }\n')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('disableDevTools', () => {
  it('removes devtools/ and finds no marker', () => {
    expect(disableDevTools(root)).toEqual({ removed: true, leftovers: [] })
    expect(exists(['devtools'])).toBe(false)
    expect(exists(['server.js'])).toBe(true)
  })

  it('is idempotent', () => {
    disableDevTools(root)
    expect(disableDevTools(root)).toEqual({ removed: false, leftovers: [] })
  })

  it('works on a tree that never had devtools/ (a git archive honours export-ignore)', () => {
    fs.rmSync(path.join(root, 'devtools'), { recursive: true })
    expect(disableDevTools(root)).toEqual({ removed: false, leftovers: [] })
  })

  it('reports a leftover marker in runtime code, with the root-relative path', () => {
    put(['server', 'other.js'], `const x = '${DEV_TOOLS_MARKER}';\n`)
    put(['src', 'ui.jsx'], `// ${DEV_TOOLS_MARKER}\n`)
    put(['dist', 'assets', 'app.js'], `a="${DEV_TOOLS_MARKER}"\n`)
    const { leftovers } = disableDevTools(root)
    expect(leftovers.map((p) => p.split(path.sep).join('/')).sort()).toEqual(['dist/assets/app.js', 'server/other.js', 'src/ui.jsx'])
  })

  it('reports a leftover route marker too', () => {
    put(['server', 'routes.js'], `app.get('/api${DEV_TOOLS_ROUTE_MARKER}');\n`)
    put(['dist', 'assets', 'svc.js'], `fetch("/api${DEV_TOOLS_ROUTE_MARKER}")\n`)
    const { leftovers } = disableDevTools(root)
    expect(leftovers.map((p) => p.split(path.sep).join('/')).sort()).toEqual(['dist/assets/svc.js', 'server/routes.js'])
  })

  it('ignores tests, docs and scripts, which mention the markers on purpose', () => {
    put(['server', '__tests__', 'x.test.js'], DEV_TOOLS_MARKER)
    put(['docs', 'LICENSING.md'], `${DEV_TOOLS_MARKER} ${DEV_TOOLS_ROUTE_MARKER}`)
    put(['scripts', 'checks', 'channelMarker.js'], DEV_TOOLS_MARKER)
    expect(disableDevTools(root).leftovers).toEqual([])
  })

  it('fails when the old in-core override module is back', () => {
    put(STALE, 'export const DEV_TOOLS_COMPILED = true;\n')
    expect(() => disableDevTools(root)).toThrow(/devOverride\.js/)
    expect(exists(['devtools'])).toBe(true) // nothing is removed on a refusal
  })
})

describe('the CLI', () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'release', 'disableDevTools.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, BURROW_DATA_DIR: path.join(os.tmpdir(), 'burrow-disable-dev-data'), BURROW_SCHEDULER: '0' },
  })

  it('exits 0 and removes devtools/ on a clean tree', () => {
    const res = run(root)
    expect(res.status).toBe(0)
    expect(res.stdout).toMatch(/devtools\/ removed/)
    expect(exists(['devtools'])).toBe(false)
  })

  it('exits 1 on a leftover marker and 2 without an argument', () => {
    put(['dist', 'app.js'], DEV_TOOLS_MARKER)
    expect(run(root).status).toBe(1)
    expect(run().status).toBe(2)
  })
})
