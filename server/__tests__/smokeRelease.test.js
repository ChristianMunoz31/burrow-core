import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import path from 'node:path';
import {
  bootstrapTokenFor,
  buildSidecarEnv,
  extractCookie,
  findReady,
  isJsonType,
  looksLikeAppHtml,
  newSecretHex,
  parseReadyLine,
} from '../../scripts/release/smokeSidecar.js';
import { strFromU8, unzipSync } from 'fflate';
import { makeSmokeDocx, makeSmokePdf, smokeDocFiles } from '../../scripts/release/smokeDocs.js';
import { installArgs, readyFromServerLog, serverLogPath, uninstallArgs } from '../../scripts/release/smokeInstaller.js';
import { bootstrapToken, initDesktopAuth, resetDesktopAuth } from '../desktop/auth.js';

describe('smokeSidecar pure parts', () => {
  it('parses ready lines like the shell does', () => {
    expect(parseReadyLine('BURROW_READY {"port":51234,"dataDir":"C:\\\\d","version":"0.1.0"}\r\n')).toEqual({
      port: 51234, dataDir: 'C:\\d', version: '0.1.0',
    });
    for (const bad of ['', 'listening', 'BURROW_READY nope', 'BURROW_READY {"port":0,"dataDir":"d","version":"1"}',
      'BURROW_READY {"port":70000,"dataDir":"d","version":"1"}', 'BURROW_READY {"port":5,"version":"1"}']) {
      expect(parseReadyLine(bad)).toBeNull();
    }
    expect(findReady('noise\nBURROW_READY {"port":7,"dataDir":"d","version":"1"}\n')?.port).toBe(7);
    expect(findReady('noise only')).toBeNull();
  });

  it('computes the same bootstrap token as server/desktop/auth.js', () => {
    const secretHex = newSecretHex();
    expect(secretHex).toMatch(/^[0-9a-f]{64}$/);
    initDesktopAuth(Buffer.from(secretHex, 'hex'));
    try {
      expect(bootstrapTokenFor(secretHex)).toBe(bootstrapToken());
    } finally {
      resetDesktopAuth();
    }
    expect(bootstrapTokenFor('ab'.repeat(32))).toBe(
      crypto.createHmac('sha256', Buffer.from('ab'.repeat(32), 'hex')).update('burrow-bootstrap-v1').digest('hex'),
    );
    expect(() => bootstrapTokenFor('xyz')).toThrow(TypeError);
    expect(() => bootstrapTokenFor('AB'.repeat(32))).toThrow(TypeError);
  });

  it('extracts the desktop cookie', () => {
    expect(extractCookie('burrow_desktop=abc; HttpOnly; SameSite=Strict; Path=/')).toBe('burrow_desktop=abc');
    expect(extractCookie(['other=1; Path=/', 'burrow_desktop=zzz; HttpOnly'])).toBe('burrow_desktop=zzz');
    expect(extractCookie(['burrow_desktop=; Path=/'])).toBeNull();
    expect(extractCookie([])).toBeNull();
    expect(extractCookie(undefined)).toBeNull();
  });

  it('builds an allowlisted environment with an isolated profile (Windows)', () => {
    const profileDir = path.join('P', 'profile');
    const env = buildSidecarEnv({
      base: {
        SystemRoot: 'C:\\Windows', Temp: 'C:\\T', APPDATA: 'C:\\real\\AppData', LOCALAPPDATA: 'C:\\real\\Local',
        USERPROFILE: 'C:\\real', NODE_OPTIONS: '--require evil.js', OLLAMA_HOST: 'http://10.0.0.5:11434',
        APP_PASSWORD: 'x', GITHUB_TOKEN: 't', GH_TOKEN: 't', BURROW_DATA_DIR: 'C:\\real\\data', PATH: 'C:\\evil',
      },
      platform: 'win32', distDir: 'D', migrationsDir: 'M', dataDir: 'DATA', profileDir,
    });
    for (const key of ['NODE_OPTIONS', 'OLLAMA_HOST', 'APP_PASSWORD', 'GITHUB_TOKEN', 'GH_TOKEN']) expect(env).not.toHaveProperty(key);
    expect(env.PATH).toBe('C:\\Windows\\System32');
    expect(env.TEMP).toBe('C:\\T');
    expect(env.BURROW_DATA_DIR).toBe('DATA');
    expect(env.BURROW_DOC_PARSING).toBe('1');
    expect(env).toMatchObject({ BURROW_DESKTOP: '1', BURROW_HOST: '127.0.0.1', BURROW_PORT: '0', BURROW_NO_DOTENV: '1', BURROW_DIST_DIR: 'D', BURROW_MIGRATIONS_DIR: 'M' });
    for (const key of ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE']) expect(env[key].startsWith(profileDir)).toBe(true);
    expect(Object.values(env).join('|')).not.toMatch(/real|evil/);
  });

  it('uses the fixed PATH and HOME isolation elsewhere', () => {
    const env = buildSidecarEnv({ base: { HOME: '/tmp/fake-home', PATH: '/evil' }, platform: 'linux', distDir: 'd', migrationsDir: 'm', dataDir: 'x', profileDir: '/p' });
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe(path.join('/p', 'home'));
  });

  it('recognises JSON and app HTML responses', () => {
    expect(isJsonType('application/json; charset=utf-8')).toBe(true);
    expect(isJsonType('application/problem+json')).toBe(true);
    expect(isJsonType('text/html')).toBe(false);
    expect(isJsonType(null)).toBe(false);
    expect(looksLikeAppHtml('text/html; charset=utf-8', '<!DOCTYPE html><div id="root"></div>')).toBe(true);
    expect(looksLikeAppHtml('text/html', '<p>Open Burrow from its app icon.</p>')).toBe(false);
    expect(looksLikeAppHtml('application/json', '<!doctype html><div id="root">')).toBe(false);
  });
});

describe('smokeDocs synthetic documents', () => {
  it('builds a DOCX that the server unzip reads and a PDF with a valid trailer', () => {
    const entries = unzipSync(new Uint8Array(makeSmokeDocx(['One', 'a < b'])));
    expect(Object.keys(entries).sort()).toEqual(['[Content_Types].xml', 'word/document.xml']);
    const xml = strFromU8(entries['word/document.xml']);
    expect(xml).toContain('<w:t xml:space="preserve">One</w:t>');
    expect(xml).toContain('a &lt; b');
    const pdf = makeSmokePdf(['Hello (world)']).toString('latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('Hello \\(world\\)');
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(Object.keys(smokeDocFiles())).toEqual(['report.pdf', 'letter.docx', 'broken.pdf']);
  });
});

describe('smokeInstaller pure parts', () => {
  it('finds the ready line in server.log', () => {
    const log = '[shell] starting\r\n[out] BURROW_READY {"port":4242,"dataDir":"C:\\\\tmp","version":"0.1.0"}\r\n';
    expect(readyFromServerLog(log)).toEqual({ port: 4242, dataDir: 'C:\\tmp', version: '0.1.0' });
    expect(readyFromServerLog('[shell] starting')).toBeNull();
  });

  it('builds the NSIS arguments with /D= last and a blocking uninstall', () => {
    expect(installArgs('C:\\L\\BurrowSmoke')).toEqual(['/S', '/D=C:\\L\\BurrowSmoke']);
    expect(uninstallArgs('C:\\L\\BurrowSmoke')).toEqual(['/S', '_?=C:\\L\\BurrowSmoke']);
    expect(serverLogPath('C:\\L')).toBe(path.join('C:\\L', 'com.burrow.desktop', 'logs', 'server.log'));
  });
});

describe('shell channel', () => {
  it('passes BURROW_SHELL_CHANNEL=stable like the Tauri shell', () => {
    const env = buildSidecarEnv({ base: {}, platform: 'linux', distDir: 'd', migrationsDir: 'm', dataDir: 'x', profileDir: '/p' });
    expect(env.BURROW_SHELL_CHANNEL).toBe('stable');
  });
});
