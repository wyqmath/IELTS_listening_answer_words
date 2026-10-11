/* Verify reusable vocabularies in isolated browsers; speech is a control simulation. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium, auditLaunch, auditOutput } = require('./playwright_runtime.cjs');
const root = path.resolve(__dirname, '..');
const example = JSON.parse(fs.readFileSync(path.join(__dirname, 'examples/vocab.json'), 'utf8'));
const report = { scope: 'custom sample data; simulated speech controls, no audible-output claim', cases: [] };
let server, browser;

function speechControls() {
  window.__customSpeech = [];
  const voices = [{ name: 'Test UK', lang: 'en-GB', voiceURI: 'test-uk', localService: true }];
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true,
    value: class { constructor(text) { this.text = text; } } });
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    getVoices: () => voices, addEventListener() {}, cancel() {}, pause() {}, resume() {},
    speak(u) { window.__customSpeech.push({ text: u.text, rate: u.rate, volume: u.volume }); u.onstart?.(); }
  } });
}

async function startServer() {
  const files = new Map([
    ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
    ['/app/app.js', ['app/app.js', 'text/javascript']], ['/app/styles.css', ['app/styles.css', 'text/css']],
    ['/app/data/vocab.js', ['app/data/vocab.js', 'text/javascript']], ['/app/assets/icon.svg', ['app/assets/icon.svg', 'image/svg+xml']]
  ]);
  server = http.createServer((req, res) => {
    const file = files.get(new URL(req.url, 'http://localhost').pathname);
    if (!file) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(path.join(root, file[0])));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}/`;
}

async function practiceCase(channel, transport, url) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  let active = structuredClone(example);
  const key = `tingjian.${example.datasetId}`, oldCustomKey = `tingjian.v2.${example.datasetId}`,
    legacy = { version: 2, dataset: '1533', records: { sentinel: { marked: true } } };
  await context.route('**/data/vocab.js', route => route.fulfill({ contentType: 'text/javascript',
    body: 'window.LISTENING_DATA = ' + JSON.stringify(active) + ';' }));
  await context.addInitScript(speechControls);
  await context.addInitScript(value => { if (!localStorage.getItem('tingjian.full.v2')) localStorage.setItem('tingjian.full.v2', JSON.stringify(value)); }, legacy);
  const page = await context.newPage(), errors = [], checks = [];
  page.on('pageerror', error => errors.push(error.message));
  const state = () => page.evaluate(k => JSON.parse(localStorage.getItem(k)), key);
  const currentId = async () => { const s = await state(); return s.session.ids[s.session.cursor]; };
  const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
  const speakCount = () => page.evaluate(() => window.__customSpeech.length);
  const go = async () => { await page.goto(url); await page.locator('#card-category').filter({ hasText: '·' }).waitFor(); };
  try {
    await go();
    check('three entries load without a fixed-size requirement', (await state()).session.ids.length === 3);
    check('legacy records stay separate', JSON.stringify(await page.evaluate(() => JSON.parse(localStorage.getItem('tingjian.full.v2')))) === JSON.stringify(legacy));
    for (const mode of ['listen', 'chinese', 'phonetic']) {
      await page.locator(`[data-mode="${mode}"]`).click();
      const before = await speakCount();
      await page.locator('#answer-input').press('Enter');
      check(`blank Enter plays in ${mode}`, await speakCount() === before + 1);
    }
    await page.locator('[data-mode="listen"]').click();
    await page.locator('#bookmark').click();
    check('custom bookmark persists', (await state()).records['demo-word'].marked);
    await context.addInitScript(({ saved, key, oldCustomKey }) => {
      if (sessionStorage.getItem('custom-migration-seeded')) return;
      localStorage.setItem(oldCustomKey, JSON.stringify(saved)); localStorage.removeItem(key);
      sessionStorage.setItem('custom-migration-seeded', 'true');
    }, { saved: await state(), key, oldCustomKey });
    await page.reload();
    check('custom records migrate to the key without a version', (await state()).records['demo-word'].marked);
    check('custom old key retires after successful migration', await page.evaluate(k => localStorage.getItem(k), oldCustomKey) === null);
    await page.locator('#hint-chinese').click();
    check('single Chinese hint is shown', await page.locator('#question-hints').isVisible());
    await page.locator('#answer-input').fill('wrong');
    await page.locator('#answer-input').press('Enter');
    check('wrong custom answer locks navigation', await page.locator('#next').isDisabled());
    await page.reload();
    check('correction lock survives reload', await page.locator('#next').isDisabled());
    await page.locator('#answer-input').fill('battery');
    await page.locator('#answer-input').press('Enter');
    check('correcting does not inflate independent answers', (await state()).records['demo-word'].attempts === 1 && (await state()).records['demo-word'].correct === 0);
    check('next advertises Enter after correction', (await page.locator('#next').innerText()).includes('↵'));
    await page.keyboard.press('Enter');
    check('Enter advances after correction', await currentId() === 'demo-phrase');
    check('single hint resets on navigation', await page.locator('#question-hints').isHidden());
    await page.locator('#default-phonetic').check();
    await page.locator('#answer-input').fill('in advance');
    await page.locator('#answer-input').press('Enter');
    check('synonyms are expanded', await page.locator('.synonym-chip').isVisible() && await page.locator('.synonym-details summary').count() === 0);
    await page.keyboard.press('Enter');
    check('default IPA hint remains on next entry', await page.locator('.question-hint.hint-ipa').isVisible());
    await page.locator('#answer-input').fill('12');
    await page.locator('#answer-input').press('Enter');
    check('numeric original is accepted', (await state()).session.result.correct);
    await page.keyboard.press('Enter');
    await page.locator('#previous').click();
    await page.locator('#answer-input').fill('twelve');
    await page.locator('#answer-input').press('Enter');
    check('numeric English reading is accepted', (await state()).session.result.correct);
    await page.locator('[data-mode="flashcard"]').click();
    let before = await speakCount();
    await page.keyboard.press('Enter');
    check('Enter reads a flashcard', await speakCount() === before + 1);
    await page.locator('#flip-card').click();
    before = await speakCount(); await page.keyboard.press('Enter');
    check('Enter reads after flipping', await speakCount() === before + 1);
    await page.locator('#next').click();
    before = await speakCount(); await page.keyboard.press('Enter');
    check('Enter reads after card navigation', await speakCount() === before + 1);
    await page.locator('[data-view="stats"]').click();
    const downloadEvent = page.waitForEvent('download'); await page.locator('#export-progress').click();
    const download = await downloadEvent, backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    check('backup uses custom identity and count', backup.dataset === example.datasetId && download.suggestedFilename().includes('3词'));
    await page.locator('#import-file').setInputFiles({ name: 'wrong-vocab.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ ...backup, dataset: 'another-vocabulary' })) });
    await page.locator('#toast').filter({ hasText: '导入失败' }).waitFor();
    check('foreign backup rejected before confirmation', !await page.locator('#confirm-dialog').isVisible());
    await page.locator('#import-file').setInputFiles({ name: 'correct-vocab.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    await page.locator('#confirm-dialog').waitFor(); await page.locator('#accept-confirm').click();
    check('matching backup restores records', (await state()).records['demo-word'].marked);
    active = { ...example, datasetId: 'another-vocabulary' }; await go();
    check('another vocabulary starts with separate records', await page.locator('#bookmark').getAttribute('aria-pressed') === 'false');
    active = structuredClone(example); await go();
    check('switching back restores the original bookmark', await page.locator('#bookmark').getAttribute('aria-pressed') === 'true');
    active = structuredClone(example); delete active.datasetId; await go();
    let generatedKey = await page.evaluate(() => Object.keys(localStorage).find(k => k.startsWith('tingjian.vocab-')));
    check('missing identity derives a stable key', Boolean(generatedKey));
    await page.locator('#bookmark').click(); await page.reload();
    check('derived identity survives reload', await page.locator('#bookmark').getAttribute('aria-pressed') === 'true');
    active = { ...example, datasetId: 'one-entry', items: [example.items[0]], count: 1 }; await go();
    check('one-entry vocabulary works', await page.locator('#previous').isDisabled());
    for (const [name, invalid] of [
      ['empty dataset', { items: [] }],
      ['duplicate IDs', { items: [example.items[0], example.items[0]] }],
      ['invalid meaning', { items: [{ ...example.items[0], meanings: [null] }] }],
      ['blank accepted answer', { items: [{ ...example.items[0], acceptedAnswers: [''] }] }],
      ['invalid synonym', { items: [{ ...example.items[0], synonyms: [null] }] }]
    ]) {
      active = invalid; await page.goto(url);
      await page.locator('#study-card').filter({ hasText: '词库未能加载' }).waitFor();
      check(`${name} shows a loading message without crashing`, true);
    }
    check('no JavaScript runtime errors', errors.length === 0);
    report.cases.push({ channel, transport, status: 'passed', checks });
  } catch (error) {
    report.cases.push({ channel, transport, status: 'failed', checks, error: error.message, runtimeErrors: errors });
    throw error;
  } finally { await context.close(); }
}

(async () => {
  try {
    const url = await startServer();
    for (const channel of ['chrome', 'msedge']) {
      browser = await chromium.launch(auditLaunch(channel));
      for (const [transport, target] of [['http', url], ['file', pathToFileURL(path.join(root, 'index.html')).href]])
        await practiceCase(channel, transport, target);
      await browser.close(); browser = null;
    }
  } catch (error) { report.failure = error.message; process.exitCode = 1; }
  finally {
    if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve));
    report.summary = { passed: report.cases.filter(c => c.status === 'passed').length,
      failed: report.cases.filter(c => c.status === 'failed').length, checks: report.cases.reduce((n, c) => n + c.checks.length, 0) };
    const output = auditOutput(); fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'audit-custom.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report.summary, failure: report.failure }));
  }
})();
