/** Same --playwright and --browser arguments as map-ui.mjs. Uses isolated component fixtures. */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';
const { values } = parseArgs({ options: { playwright: { type: 'string' }, browser: { type: 'string' } } });
const { chromium } = await import(values.playwright ? pathToFileURL(values.playwright).href : 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), 'pact-ending-check-'));
const vite = await createServer({ configFile: path.join(root, 'web/vite.config.ts'), server: { port: 0, host: '127.0.0.1' }, plugins: [{ name: 'ending-fixture', configureServer(server) {
  server.middlewares.use('/__ending-check', async (_req, res) => {
    const source = `/@fs/${path.join(root, 'tests/browser/ending-fixture.jsx').replaceAll('\\', '/')}`;
    res.setHeader('Content-Type', 'text/html');
    res.end(await server.transformIndexHtml('/__ending-check', `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="${source}"></script></body></html>`));
  });
} }] });
let browser;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, ...(values.browser ? { executablePath: values.browser } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__ending-check`);
  for (const kind of ['pact_concluded', 'jinyang_falls', 'no_assistance', 'talks_failed']) {
    await page.getByRole('button', { name: kind, exact: true }).click();
    await page.locator('.cg.phase-map').waitFor();
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await page.locator('.cg.phase-card').waitFor();
    await page.locator('.cg').screenshot({ path: path.join(output, `${kind}.png`) });
    await page.getByRole('button', { name: 'Replay ending' }).click();
    await page.locator('.cg.phase-map').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'pact_concluded', exact: true }).click();
  await page.locator('.cg.phase-card').waitFor();
  const bounds = await page.locator('.cg').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391);
  await page.locator('.cg').screenshot({ path: path.join(output, 'mobile.png') });
  await page.getByRole('button', { name: 'Review the pact' }).click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, screenshots: output }));
} finally { await browser?.close(); await vite.close(); }
