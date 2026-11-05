// ci:always-run
// The switch for PDF and DOCX parsing (server/folders/docGate.js, issue #67): off by default, the developer variable is
// honoured only in an unbundled source checkout, and a real esbuild bundle with the sidecar defines ignores it. Reads
// the source tree (it bundles docGate.js), so it carries the always-run marker above.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { bundleDefine } from '../../scripts/desktop/workerBundle.js';
import { DOC_PARSING_ENV, docParsingCompiledIn, docParsingEnabled } from '../folders/docGate.js';
import { isSourceCheckout } from '../license/channelSeam.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const ON = { [DOC_PARSING_ENV]: '1' };
const DEV_UNBUNDLED = { compiled: true, release: false, checkout: true };

describe('docParsingEnabled', () => {
  it('is off by default and for any value other than exactly 1', () => {
    expect(docParsingEnabled({}, DEV_UNBUNDLED)).toBe(false);
    for (const v of ['', '0', 'true', 'yes', ' 1', '1 ', '01', 'on']) {
      expect(docParsingEnabled({ [DOC_PARSING_ENV]: v }, DEV_UNBUNDLED), JSON.stringify(v)).toBe(false);
    }
  });

  it('is on only for BURROW_DOC_PARSING=1 in an unbundled source checkout', () => {
    expect(docParsingEnabled(ON, DEV_UNBUNDLED)).toBe(true);
  });

  it('ignores the variable in a release build', () => {
    expect(docParsingEnabled(ON, { ...DEV_UNBUNDLED, release: true })).toBe(false);
  });

  it('ignores the variable outside a source checkout (release zip, Docker)', () => {
    expect(docParsingEnabled(ON, { ...DEV_UNBUNDLED, checkout: false })).toBe(false);
  });

  it('ignores the variable when the bundler compiled parsing out', () => {
    expect(docParsingEnabled(ON, { ...DEV_UNBUNDLED, compiled: false })).toBe(false);
  });

  it('reads the real environment by default and is not compiled out when unbundled', () => {
    expect(docParsingCompiledIn()).toBe(true);
    expect(docParsingEnabled({})).toBe(false);
    expect(docParsingEnabled(ON)).toBe(isSourceCheckout());
  });
});

describe('the sidecar bundle', () => {
  let tmp;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-docgate-'));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  it('bakes __BURROW_DOC_PARSING__ false for every channel and distribution', () => {
    for (const channel of ['stable', 'dev']) {
      expect(bundleDefine('0.1.0', { channel }).__BURROW_DOC_PARSING__, channel).toBe('false');
    }
    expect(bundleDefine('0.1.0', { distribution: 'store' }).__BURROW_DOC_PARSING__).toBe('false');
    expect(bundleDefine('0.1.0', { distribution: 'store', dataLocation: 'userprofile' }).__BURROW_DOC_PARSING__).toBe('false');
  });

  /** Bundles docGate.js (with or without the sidecar defines) and loads it with BURROW_DOC_PARSING=1. */
  async function enabledIn(name, define) {
    const file = path.join(tmp, `${name}.cjs`);
    await build({
      entryPoints: [path.join(ROOT, 'server', 'folders', 'docGate.js')],
      outfile: file,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      logLevel: 'silent',
      define,
      // Only the import.meta.url stand-in; the bundle banner of the sidecar also resets process warning handlers.
      banner: { js: `var __importMetaUrl = ${JSON.stringify(pathToFileURL(path.join(ROOT, 'server', 'license', 'channelSeam.js')).href)};` },
    });
    const saved = process.env[DOC_PARSING_ENV];
    process.env[DOC_PARSING_ENV] = '1';
    try {
      const mod = require(file);
      return { enabled: mod.docParsingEnabled(), compiled: mod.docParsingCompiledIn() };
    } finally {
      if (saved === undefined) delete process.env[DOC_PARSING_ENV];
      else process.env[DOC_PARSING_ENV] = saved;
    }
  }

  it('cannot be turned on by the environment (control: the same bundle without the defines can)', async () => {
    const control = await enabledIn('control', { 'import.meta.url': '__importMetaUrl' });
    expect(control).toEqual({ enabled: isSourceCheckout(), compiled: true });
    for (const channel of ['stable', 'dev']) {
      const bundled = await enabledIn(channel, bundleDefine('0.1.0', { channel }));
      expect(bundled, channel).toEqual({ enabled: false, compiled: false });
    }
  });
});
