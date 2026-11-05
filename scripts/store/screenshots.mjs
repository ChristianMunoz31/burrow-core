// Renders the six Microsoft Store screenshots (1920x1080 PNG, plain and captioned) from the built UI.
//
//   npm run build            (once; this script needs dist/)
//   npm run store:screenshots
//
// Output: %LOCALAPPDATA%\burrow-release\store\screenshots\<name>.png and <name>-caption.png (outside
// the repo). Nothing is uploaded or published.
//
// Safety: the app runs against a throwaway data dir under the OS temp dir with generated demo data
// (scripts/seedDemo.js), on a free loopback port, with the bundled fake Ollama for Javi. The server
// env is scrubbed and every network call is blocked (e2e/support/burrowServer.js, the same harness
// the e2e tests use). The browser may only reach the sandbox server: any other request is aborted
// and fails the run. The temp dir and every process are removed at the end, also on failure.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startBurrow } from '../../e2e/support/burrowServer.js';
import { javi } from '../../e2e/pages/javi.js';
import {
  HEIGHT,
  SHOTS,
  WIDTH,
  assertPngSize,
  assertTempDataDir,
  captionOverlay,
  isAllowedRequest,
  screenshotsDir,
  variantFiles,
} from './screenshotLib.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const JAVI_QUESTION = 'How did my spending look this month?';

const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Fake model for the Javi shot. It never calculates: it asks for the budget summary tool (the code
 * that does the math) and then words the numbers that tool returned.
 */
function fakeChat(body) {
  const messages = body.messages ?? [];
  const tools = (body.tools ?? []).map((t) => t?.function?.name);
  const last = messages[messages.length - 1];
  if (tools.includes('get_budget_summary') && last?.role === 'user' && String(last.content).includes(JAVI_QUESTION)) {
    return { content: '', tool_calls: [{ function: { name: 'get_budget_summary', arguments: {} } }] };
  }
  if (last?.role === 'tool') {
    let s;
    try {
      s = JSON.parse(String(last.content));
    } catch {
      return { content: 'I could not read your budget just now. Please try again.' };
    }
    const top = (s.topCategories ?? []).slice(0, 3).map((c) => `${c.category} (${money(c.spent)})`);
    const list = top.length === 3 ? `${top[0]}, ${top[1]} and ${top[2]}` : top.join(' and ');
    return {
      content: `This month you brought in ${money(s.income)} and spent ${money(s.expenses)} across ${s.transactionCount} transactions, which leaves ${money(s.net)}. Your biggest categories were ${list}. Burrow worked these totals out from your own transactions on this PC.`,
    };
  }
  return { content: 'I can look up your budget, todos and calendar. Just ask.' };
}

async function settle(page) {
  await page.addStyleTag({
    content: '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}',
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
}

async function renderShot(browser, server, shot, outDir, blocked) {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    colorScheme: shot.theme,
    reducedMotion: 'reduce',
    locale: 'en-US',
    serviceWorkers: 'block',
    baseURL: server.url,
  });
  try {
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (isAllowedRequest(url, server.url)) return route.continue();
      blocked.push(url);
      return route.abort();
    });
    const page = await context.newPage();
    // The welcome and trial notices are first-run chrome; mark them seen so they do not cover the UI.
    for (const notice of ['welcome', 'ending_soon', 'ended']) {
      await context.request.post(`${server.url}/api/license/trial/notice`, {
        data: { notice },
        headers: { Origin: server.url },
      });
    }
    // A fresh demo folder has no backup yet, which would put a reminder banner on Home.
    await context.request.post(`${server.url}/api/backups`, { data: {}, headers: { Origin: server.url } });
    await page.goto(shot.url);
    await page.getByRole('heading', { level: 2, name: shot.heading, exact: true }).first().waitFor();

    if (shot.javi) {
      const j = javi(page);
      await j.open();
      await j.ask(JAVI_QUESTION);
      await j.message('Your biggest categories').waitFor({ timeout: 30_000 });
    }
    if (shot.section) await page.locator(shot.section).scrollIntoViewIfNeeded();
    await settle(page);

    const files = variantFiles(shot);
    const plain = await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' });
    assertPngSize(plain, files.plain);
    fs.writeFileSync(path.join(outDir, files.plain), plain);

    const { css, html } = captionOverlay(shot.caption);
    await page.addStyleTag({ content: css });
    await page.evaluate((markup) => document.body.insertAdjacentHTML('beforeend', markup), html);
    const captioned = await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' });
    assertPngSize(captioned, files.caption);
    fs.writeFileSync(path.join(outDir, files.caption), captioned);
    console.log(`  ${files.plain}, ${files.caption} (${shot.theme})`);
  } finally {
    await context.close();
  }
}

async function main() {
  if (!fs.existsSync(path.join(REPO_ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/ is missing. Run `npm run build` first, then `npm run store:screenshots`.');
  }
  const outDir = screenshotsDir();
  fs.mkdirSync(outDir, { recursive: true });
  // Drop PNGs of an earlier shot list (NN-name.png only) so the folder holds exactly this run.
  for (const f of fs.readdirSync(outDir)) if (/^\d\d-[\w-]+\.png$/.test(f)) fs.rmSync(path.join(outDir, f));

  const server = await startBurrow({ seed: true, ollama: 'fake', fakeChat });
  let browser = null;
  const blocked = [];
  try {
    assertTempDataDir(server.dataDir);
    console.log(`Demo server ${server.url} (data dir ${server.dataDir})`);
    browser = await chromium.launch();
    for (const shot of SHOTS) await renderShot(browser, server, shot, outDir, blocked);
    if (blocked.length) throw new Error(`The page tried to reach outside the sandbox: ${[...new Set(blocked)].join(', ')}`);
    const outbound = server.outbound();
    if (outbound.length) throw new Error(`The server attempted ${outbound.length} outbound connection(s).`);
    console.log(`Done. ${SHOTS.length * 2} PNGs in ${outDir}`);
  } finally {
    await browser?.close().catch(() => {});
    await server.stop();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});


