/* Actual Chrome/Edge opening and speech integration checks. Run with Node + Playwright. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { chromium, auditLaunch, auditOutput } = require('./playwright_runtime.cjs');
const root = path.resolve(__dirname, '..');
const reportDir = auditOutput(); fs.mkdirSync(reportDir, { recursive: true });
const base = process.argv.find(arg => arg.startsWith('--url='))?.slice(6) || 'http://127.0.0.1:11545/';
const data = JSON.parse(fs.readFileSync(path.join(root, 'data/vocab.json'), 'utf8'));
assert.equal(data.items.length, 1533);
const speechMock = () => {
  const available = [
    { name: 'Test UK', lang: 'en-GB', voiceURI: 'uk', localService: true, default: false },
    { name: 'Test US', lang: 'en-US', voiceURI: 'us', localService: true, default: true }
  ];
  window.__spoken = []; window.__speechOps = [];
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: class { constructor(text) { this.text = text; } } });
  const synth = { paused: false, getVoices: () => available, addEventListener() {},
    cancel() { this.paused = false; window.__speechOps.push('cancel'); },
    pause() { this.paused = true; window.__speechOps.push('pause'); },
    resume() { this.paused = false; window.__speechOps.push('resume'); },
    speak(u) { window.__spoken.push({ text: u.text, rate: u.rate, pitch: u.pitch, volume: u.volume, voice: u.voice?.name, lang: u.lang }); u.onstart?.(); }
  };
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth });
};
(async () => {
  const sourceHashes = {};
  for (const file of ['app.js', 'index.html', 'styles.css', 'data/vocab.json', 'data/vocab.js']) {
    const full = path.join(root, file);
    if (fs.existsSync(full)) sourceHashes[file] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  }
  const result = { dataCount: data.items.length, sourceHashes, browsers: [], checks: [] };
  for (const [name, channel] of [['Chrome', 'chrome'], ['Edge', 'msedge']]) {
    const browser = await chromium.launch(auditLaunch(channel));
    try {
      for (const [protocol, url] of [['file', pathToFileURL(path.join(root, 'index.html')).href], ['localhost', base]]) {
        const context = await browser.newContext({ viewport: { width: 1360, height: 940 }, acceptDownloads: true });

        await context.addInitScript(() => {
          window.__nativeSpeechEvents = []; window.__nativeSpeechCalls = []; window.__audioEvents = [];
          const mediaPlay = HTMLMediaElement.prototype.play;
          HTMLMediaElement.prototype.play = function () {
            for (const event of ['playing', 'ended', 'error']) this.addEventListener(event, () => window.__audioEvents.push({ event, src: this.currentSrc, duration: this.duration, error: this.error?.code || null }), { once: true });
            return mediaPlay.call(this);
          };
          if (window.speechSynthesis) {
            const synth = window.speechSynthesis, original = synth.speak.bind(synth);
            synth.speak = u => {
              window.__nativeSpeechCalls.push({ text: u.text, voice: u.voice?.name, lang: u.lang, rate: u.rate, pitch: u.pitch, volume: u.volume });
              for (const event of ['start', 'end', 'error']) u.addEventListener(event, e => window.__nativeSpeechEvents.push({ event, error: e.error || null }));
              return original(u);
            };
          }
        });
        const page = await context.newPage(), errors = [], external = [];
        page.on('pageerror', e => errors.push(e.message));
        page.on('request', r => { if (/^https?:/.test(r.url()) && !r.url().startsWith(base)) external.push(r.url()); });
        await page.goto(url); await page.waitForSelector('#play-main');
        assert.deepEqual(await page.evaluate(() => window.LISTENING_DATA.items), data.items, 'Browser vocabulary must match the complete JSON');
        assert.equal(await page.locator('#library-count').count(), 0);
        assert.equal(await page.locator('.intro,.site-footer,.overview-panel,.tip-panel,.keyboard-help,.under-card').count(), 0, 'Home decorative sections should be removed');
        assert.equal(await page.locator('#replay').isVisible(), false, 'Listening uses one playback control');
        for (const id of ['bookmark', 'toggle-mistake', 'previous', 'sound-shortcut', 'open-help']) assert.equal(await page.locator('#' + id).isVisible(), true);
        assert.equal((await page.locator('body').innerText()).includes('1533'), false, 'Home should not show the total vocabulary count');
        await page.locator('#open-sound').click();
        await page.waitForFunction(() => !window.speechSynthesis || speechSynthesis.getVoices().length > 0, null, { timeout: 5000 }).catch(() => {});
        const voiceInfo = await page.evaluate(() => ({ supported: Boolean(window.speechSynthesis), voices: speechSynthesis?.getVoices().map(v => ({ name: v.name, lang: v.lang, local: v.localService })) || [] }));
        await page.locator('#test-voice').click();
        await page.waitForFunction(() => window.__nativeSpeechEvents.length > 0, null, { timeout: 10000 }).catch(() => {});
        const nativeEvents = await page.evaluate(() => window.__nativeSpeechEvents);
        const nativeCalls = await page.evaluate(() => window.__nativeSpeechCalls);
        assert.ok(!voiceInfo.supported || nativeCalls.length > 0);
        if (nativeEvents.some(e => e.event === 'error')) assert.match(await page.locator('#settings-speech-status').innerText(), /朗读失败|点击播放/);
        const audioEvents = await page.evaluate(() => window.__audioEvents);
        assert.deepEqual(audioEvents, [], 'Speech must use the browser engine without prerecorded audio');
        await page.locator('#sound-dialog .close-button').click();
        await page.locator('#open-fullscreen').click();
        const fullscreen = await page.evaluate(() => ({ native: Boolean(document.fullscreenElement), immersive: document.body.classList.contains('immersive') }));
        assert.ok(fullscreen.immersive);
        for (const selector of ['.brand', '#open-sound', '#card-category', '#card-position']) assert.equal(await page.locator(selector).isVisible(), false, 'Fullscreen should hide secondary elements: ' + selector);
        const visibleControls = await page.evaluate(() => [...document.querySelectorAll('button,input,summary,a,select')].filter(el => el.checkVisibility() && el.getBoundingClientRect().height > 0).length);
        for (const selector of ['#bookmark', '#toggle-mistake', '#previous', '#sound-shortcut', '#open-help', '[data-mode=listen]', '[data-mode=chinese]', '[data-mode=phonetic]', '[data-mode=flashcard]', '#hint-chinese', '#hint-phonetic', '#default-chinese', '#default-phonetic']) assert.equal(await page.locator(selector).isVisible(), true, 'Fullscreen keeps requested controls visible: ' + selector);
        assert.equal(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight + 1), false, 'Short fullscreen exercises need no empty scrolling');
        fullscreen.visibleControls = visibleControls;
        await page.locator('#open-fullscreen').click();
        await page.waitForFunction(() => !document.body.classList.contains('immersive'));
        assert.equal(await page.evaluate(() => document.body.classList.contains('immersive')), false);
        assert.deepEqual(errors, []); assert.deepEqual(external, [], 'Page must not request annotation API or CDN');
        result.browsers.push({ name, protocol, voiceInfo, nativeEvents, nativeCalls, audioEvents, fullscreen, browserErrors: errors, externalRequests: external });
        if (name === 'Chrome' && protocol === 'localhost') {
          await page.screenshot({ path: path.join(reportDir, 'preview-desktop.png'), fullPage: true });
          await page.setViewportSize({ width: 390, height: 844 });
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Phone horizontal overflow');
          await page.screenshot({ path: path.join(reportDir, 'preview-mobile.png'), fullPage: true });
        }
        await context.close();
      }
    } finally { await browser.close(); }
  }
  const browser = await chromium.launch(auditLaunch());
  try {
    const context = await browser.newContext(); await context.addInitScript(speechMock);

    const page = await context.newPage(); await page.goto(base); await page.waitForSelector('#play-main');
    const speakCount = () => page.evaluate(() => window.__spoken.length);
    await page.locator('#play-main').click();
    assert.equal((await page.evaluate(() => window.__spoken)).at(-1).voice, 'Test UK');
    await page.locator('#answer-input').fill('r'); await page.locator('#answer-input').press('r');
    assert.equal(await page.locator('#answer-input').inputValue(), 'rr');
    const before = await speakCount(); await page.locator('#answer-input').press('Alt+r');
    assert.equal(await speakCount(), before + 1); assert.equal(await page.locator('#answer-input').inputValue(), 'rr');
    await page.locator('#answer-input').press('Space'); assert.equal(await page.locator('#answer-input').inputValue(), 'rr ');
    await page.locator('#answer-input').evaluate(el => el.blur()); await page.keyboard.press('r');
    assert.equal(await speakCount(), before + 2);
    await page.keyboard.press('Space'); assert.equal((await page.evaluate(() => window.__speechOps)).at(-1), 'pause');
    await page.keyboard.press('Space'); assert.equal((await page.evaluate(() => window.__speechOps)).at(-1), 'resume');
    await page.locator('#open-sound').click();
    await page.locator('#voice-select').selectOption('Test US|en-US|us');
    for (const [id, value] of [['rate', '.7'], ['pitch', '1.2'], ['volume', '.6']]) await page.locator('#' + id).evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
    await page.locator('#test-voice').click();
    const spoken = (await page.evaluate(() => window.__spoken)).at(-1);
    assert.equal(spoken.voice, 'Test US'); assert.equal(spoken.rate, .7); assert.equal(spoken.pitch, 1.2); assert.equal(spoken.volume, .6);
    await page.locator('#sound-dialog .close-button').click(); await page.reload(); await page.locator('#open-sound').click();
    assert.equal(await page.locator('#rate').inputValue(), '0.7'); assert.equal(await page.locator('#voice-select').inputValue(), 'Test US|en-US|us');
    result.checks.push('native speech events recorded', 'file + localhost Chrome + Edge', 'no page API/CDN requests', 'native/fallback fullscreen', 'Alt+R during typing', 'R away from input', 'space pause/resume', 'normal r/space typing', 'voice/rate/pitch/volume', 'settings persist');
    // Speech feature unavailable and initially empty voice list are real UI branches.
    const missing = await browser.newContext();
    await missing.addInitScript(() => Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: undefined }));

    const p = await missing.newPage(); await p.goto(base); await p.locator('#open-sound').click();
    assert.equal(await p.locator('#test-voice').isDisabled(), true); assert.match(await p.locator('#voice-note').innerText(), /浏览器语音不可用/);
    await p.locator('#sound-dialog .close-button').click(); await p.locator('#play-main').click();
    assert.match(await p.locator('#speech-status').innerText(), /浏览器不支持朗读/);
    result.checks.push('speech unsupported gives a visible explanation', 'no prerecorded audio', 'home omits total vocabulary count', 'home removes decorative sections', 'fullscreen visible actions, modes, hints and no empty scrolling');
    await missing.close();
    // Check the user's reported repeated refresh in one isolated background tab.
    const idleContext = await browser.newContext(); await idleContext.addInitScript(speechMock);

    const idle = await idleContext.newPage(), idleErrors = []; let navigations = 0;
    idle.on('framenavigated', frame => { if (frame === idle.mainFrame()) navigations++; });
    idle.on('pageerror', error => idleErrors.push(error.message));
    await idle.goto(base); await idle.waitForSelector('#answer-input');
    await idle.locator('#answer-input').fill('idle input stays here');
    const startOrigin = await idle.evaluate(() => performance.timeOrigin), startNavigations = navigations;
    await idle.waitForTimeout(31000);
    assert.equal(await idle.evaluate(() => performance.timeOrigin), startOrigin, 'The app must not reload while idle');
    assert.equal(navigations, startNavigations); assert.equal(await idle.locator('#answer-input').inputValue(), 'idle input stays here');
    assert.deepEqual(idleErrors, []);
    result.idleRefreshCheck = { url: base, observationMs: 31000, reloads: navigations - startNavigations, inputPreserved: true, browserErrors: idleErrors };
    result.checks.push('31 second idle tab does not refresh'); await idleContext.close();
  } finally { await browser.close(); }
  result.passed = true; result.testedAt = new Date().toISOString();
  fs.writeFileSync(path.join(reportDir, 'browser-verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: true, browsers: result.browsers.map(x => ({ name: x.name, protocol: x.protocol, voices: x.voiceInfo.voices.length, events: x.nativeEvents, fullscreen: x.fullscreen })), checks: result.checks }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
