/*
 * Independent browser audit of the full listening trainer.
 * Run: npm --prefix tools ci, then node tools/audit_flows.cjs
 * Options: --url=http://127.0.0.1:11545/ --only=case-id --transport=http
 * Always headless. Without --url, an isolated random-port server is used.
 * --headed is rejected to avoid interrupting the user's active browser.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium, auditLaunch, auditOutput } = require('./playwright_runtime.cjs');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
if (args.includes('--headed')) throw new Error('Visible browser testing is disabled. Run this audit headlessly, in its isolated browser context.');
const headed = false;
const controlledSpeechCases = new Set(['keyboard-controls', 'space-play-focus', 'enter-context', 'flashcard-enter',
  'repeat-playback', 'repeat-pause', 'repeat-cancellation', 'repeat-error', 'auto-all-modes', 'fullscreen-combined-hints',
  'default-autoplay', 'autoplay-upgrade', 'foldable-controls', 'category-all-modes']);
const explicitUrl = args.find(x => x.startsWith('--url='))?.slice(6);
const only = args.find(x => x.startsWith('--only='))?.slice(7)?.split(',');
const transportOption = args.find(x => x.startsWith('--transport='))?.slice(12);
const key = 'tingjian.full';
const legacyKey = 'tingjian.full.v2';
const label = args.find(x => x.startsWith('--label='))?.slice(8)?.replace(/[^a-z0-9-]/g, '');
const suffix = label ? '-' + label : '';
const reportDir = auditOutput();
const screenshotDir = path.join(reportDir, 'screenshots');
fs.mkdirSync(screenshotDir, { recursive: true });

function readJson(file) { return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, '')); }
if (!fs.existsSync(path.join(root, 'app/data/vocab.json')) || !fs.existsSync(path.join(root, 'app/data/vocab.js')))
  throw new Error('The bundled data/vocab.json and data/vocab.js are required.');
const data = readJson('app/data/vocab.json');
const entries = Array.isArray(data) ? data : data.items;
assert.equal(entries.length, 1533, 'The audit must exercise all 1533 real entries.');
assert.equal(new Set(entries.map(x => x.id)).size, 1533, 'Entry IDs must be unique.');
const byId = new Map(entries.map(x => [x.id, x]));
function evidenceHashes() {
  return Object.fromEntries(['app/app.js', 'index.html', 'app/styles.css', 'app/data/vocab.json', 'app/data/vocab.js'].filter(file =>
    fs.existsSync(path.join(root, file))).map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
}
const report = { audit: 'independent-function-flows', generatedAt: new Date().toISOString(),
  authoritativeDataset: true, entryCount: entries.length,
  transports: transportOption ? [transportOption] : ['http', 'file'],
  controlledSpeechCases: [...controlledSpeechCases],
  speechEvidenceScope: 'Cases listed in controlledSpeechCases simulate utterance lifecycle events for keyboard and repetition behavior. They verify control flow, not audible output. All other scenarios observe the native engine; native events and failures are audited independently by audit_speech.',
  selectedCases: only || 'all', fileHashesAtStart: evidenceHashes(), browser: { channel: 'Chrome', headed }, cases: [], issues: [] };
const logs = [];
let browser, server;

function invariant(actual, expected, label) { assert.deepEqual(actual, expected, label); }
async function state(page) { return page.evaluate(k => JSON.parse(localStorage.getItem(k)), key); }
async function seedStorage(page, values, removeKeys = [], failWrites = false) {
  await page.context().addInitScript(({ values, removeKeys, failWrites, key }) => {
    if (!sessionStorage.getItem('audit-storage-seeded')) {
      for (const name of removeKeys) localStorage.removeItem(name);
      for (const [name, value] of values) localStorage.setItem(name, JSON.stringify(value));
      sessionStorage.setItem('audit-storage-seeded', 'true');
    }
    if (failWrites) {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name, value) {
        if (name === key) throw new DOMException('Storage quota reached', 'QuotaExceededError');
        return setItem.call(this, name, value);
      };
    }
  }, { values, removeKeys, failWrites, key });
  await page.reload();
}
async function currentId(page) { const s = await state(page); return s.session.ids[s.session.cursor]; }
async function currentEntry(page) { return byId.get(await currentId(page)); }
async function submit(page, value) {
  await page.locator('#answer-input').fill(value);
  await page.locator('#answer-input').press('Enter');
}
async function next(page) { await page.locator('#next').click(); }
async function view(page, name) { await page.locator(`[data-view="${name}"]`).click(); }
async function mode(page, name) { await page.locator(`[data-mode="${name}"]`).click(); }
async function openOptions(page, id) {
  if (!await page.locator('#' + id).evaluate(el => el.open))
    await page.locator('#' + id + ' > summary').click();
}
async function exerciseAction(page, id) {
  await page.locator('#' + id).click();
}
async function selectRange(page, id, value) {
  if (id === 'category-select') { await page.locator('#' + id).selectOption(value); return; }
  await openOptions(page, 'practice-options');
  await page.locator('#' + id).selectOption(value);
  await page.locator('#practice-options > summary').click();
}
async function rangeAction(page, id) {
  await openOptions(page, 'practice-options');
  await page.locator('#' + id).click();
}
async function rule(page, target) {
  await page.locator('#open-sound').click();
  await page.locator('#mistake-target').selectOption(String(target));
  await page.locator('#sound-dialog [aria-label="关闭设置"]').click();
}
async function choose(page, item) {
  await view(page, 'library');
  await page.locator('#library-category').selectOption('all');
  await page.locator('#library-search').fill(item.original);
  await page.locator(`[data-action="practice-item"][data-id="${item.id}"]`).click();
  invariant(await currentId(page), item.id, 'The exact selected library entry must open.');
}
async function oneMarked(page) {
  const item = await currentEntry(page);
  await exerciseAction(page, 'bookmark');
  await selectRange(page, 'pool-select', 'marked');
  invariant((await state(page)).session.ids, [item.id], 'Marked practice contains only marked entries.');
  return item;
}
async function importBackup(page, backup, accept = true) {
  await view(page, 'stats');
  await page.locator('#import-file').setInputFiles({ name: 'audit-backup.json', mimeType: 'application/json',
    buffer: Buffer.from(typeof backup === 'string' ? backup : JSON.stringify(backup)) });
  await page.locator('#confirm-dialog').waitFor({ state: 'visible' });
  await page.locator(accept ? '#accept-confirm' : '#cancel-confirm').click();
}
async function rejectBackup(page, backup) {
  await page.locator('#import-file').setInputFiles({ name: 'invalid-audit-backup.json', mimeType: 'application/json',
    buffer: Buffer.from(typeof backup === 'string' ? backup : JSON.stringify(backup)) });
  await page.waitForTimeout(120);
  invariant(await page.locator('#confirm-dialog').isVisible(), false, 'Invalid backup must not be offered for replacement: ' +
    (typeof backup === 'string' ? backup : JSON.stringify(backup).slice(0, 200)));
  assert.match(await page.locator('#toast').innerText(), /导入失败/, 'Invalid backup gives a visible explanation.');
}
async function statValues(page) {
  return page.locator('#stats-grid .stat-card').evaluateAll(cards => Object.fromEntries(cards.map(card =>
    [card.querySelector('span').textContent, { value: card.querySelector('strong').textContent, detail: card.querySelector('p').textContent }])));
}
async function dailyRows(page) {
  return page.locator('#daily-stats tr').evaluateAll(rows => rows.map(row => [...row.querySelectorAll('td')].map(td => td.textContent)));
}
function blankRecord() { return { seen: false, marked: false, inMistakes: false, attempts: 0, correct: 0, wrong: 0,
  streak: 0, corrections: 0, lastPracticed: null }; }
async function syntheticBackup(page) {
  const dateKeys = await page.evaluate(() => {
    const day = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    return Object.fromEntries([0, 1, 2, 4, 6, 9, 15, 29, 34].map(n => [n, day(n)]));
  });
  const regular = entries.filter(x => x.category === '常规');
  const code = entries.find(x => x.type === 'code');
  const number = entries.find(x => x.type === 'number');
  const time = entries.find(x => x.type === 'time');
  const specs = [
    [regular[0], 0, true, false, 'listen', 2000],
    [regular[1], 0, false, false, 'listen', 3000],
    [regular[1], 0, true, true, 'listen', 4000],
    [code, 1, true, false, 'phonetic', 5000],
    [number, 4, true, false, 'chinese', 6000],
    [regular[2], 9, false, false, 'flashcard', 6000],
    [regular[3], 15, true, false, 'chinese', 1000],
    [time, 34, false, false, 'listen', 7000]
  ];
  const history = specs.map(([item, offset, correct, correction, selectedMode, durationMs], i) => ({
    id: item.id, answer: selectedMode === 'flashcard' ? '' : correct ? item.acceptedAnswers[0] : 'audit-invalid',
    correct, correction, mode: selectedMode, at: `${dateKeys[offset]}T12:${String(i).padStart(2, '0')}:00+08:00`, durationMs
  })).sort((a, b) => new Date(b.at) - new Date(a.at));
  const records = {};
  for (const h of history) {
    const r = records[h.id] || (records[h.id] = blankRecord()); r.seen = true; r.lastPracticed ||= h.at;
    if (h.mode !== 'flashcard') {
      if (h.correction) r.corrections++;
      else { r.attempts++; r.correct += Number(h.correct); r.wrong += Number(!h.correct); }
    }
    if (!h.correct && h.mode !== 'flashcard') r.inMistakes = true;
  }
  records[regular[0].id].marked = true;
  return { backup: { version: 2, dataset: '1533', exportedAt: new Date().toISOString(), records, history,
    settings: { voice: 'browser-default', rate: 1.1, pitch: 1.2, volume: 0.6, target: 4, autoSpeak: false } }, dateKeys, regular, code, number, time };
}

const cases = [];
function test(id, title, severity, steps, run, suggestion = '修复该流程后重跑本脚本，并保留原学习记录。') {
  cases.push({ id, title, severity, steps, run, suggestion });
}

test('full-load', '完整词库加载、首页隐藏总数与全新学习状态', 'P1', ['打开网页', '确认练习首页无可见总数', '检查底层词库数量和初始统计'], async page => {
  invariant(await page.evaluate(() => window.LISTENING_DATA.items.length), 1533, 'Rendered app uses all 1533 entries.');
  invariant(await page.locator('#library-count').count(), 0, 'The redundant vocabulary navigation count has been removed.');
  invariant(await page.locator('.intro,.overview-panel,.tip-panel,.under-card,.keyboard-help,.site-footer').count(), 0,
    'The practice home removes repeated intro, progress slogans, speech summary and footer.');
  invariant(await page.locator('#practice-options').evaluate(el => el.open), false, 'Range controls are collapsed by default.');
  for (const id of ['bookmark', 'toggle-mistake', 'previous', 'sound-shortcut', 'open-help'])
    invariant(await page.locator('#' + id).isVisible(), true, 'Practice action is always visible: ' + id);
  assert.doesNotMatch(await page.locator('body').innerText(), /1533|1,533/, 'The practice home page contains no visible 1533 total.');
  const s = await state(page);
  invariant(s.session.ids.length, 1533, 'Full practice begins with 1533 items.');
  invariant(s.history, [], 'Source historical answers are ignored.');
  invariant(Object.values(s.records).some(r => r.attempts || r.inMistakes || r.marked || r.seen), false, 'No old status is imported.');
  invariant(s.settings.target, 3, 'Default removal threshold is three independent answers.');
  invariant(s.settings.autoSpeak, true, 'Advancing automatically reads the next item by default.');
});

test('default-autoplay', '默认下一条朗读、纠错后朗读及手动关闭', 'P1', ['答对后回车切题', '答错并纠错后点击切题', '关闭自动朗读并刷新'], async page => {
  invariant(await page.evaluate(() => window.__auditSpeech.speak.length), 0, 'Initial load does not play without interaction.');
  await submit(page, (await currentEntry(page)).original);
  await page.keyboard.press('Enter');
  invariant(await page.evaluate(() => window.__auditSpeech.speak.map(x => x.text)), [entries[1].speakText], 'Enter advances and reads the new answer once.');
  await submit(page, 'wrong-default-autoplay');
  await submit(page, (await currentEntry(page)).original);
  await next(page);
  invariant(await page.evaluate(() => window.__auditSpeech.speak.at(-1).text), entries[2].speakText, 'Advancing after correction reads the new entry.');
  await page.locator('#sound-shortcut').click(); await page.locator('#auto-speak').uncheck();
  await page.locator('#sound-dialog .close-button').click(); await page.reload();
  invariant((await state(page)).settings.autoSpeak, false, 'A manual opt-out survives reload.');
  await next(page);
  invariant(await page.evaluate(() => window.__auditSpeech.speak.length), 0, 'Disabled automatic reading stays silent after navigation.');
});

test('autoplay-upgrade', '旧记录启用新默认并保留学习记录', 'P1', ['写入旧设置与标记', '刷新', '检查自动朗读及学习记录'], async page => {
  const saved = await state(page);
  saved.settings.autoSpeak = false; delete saved.settings.autoSpeakConfigured;
  saved.records[saved.session.ids[0]].marked = true;
  await seedStorage(page, [[key, saved]]);
  invariant((await state(page)).settings.autoSpeak, true, 'The previous false default migrates to automatic reading.');
  invariant((await state(page)).records[entries[0].id].marked, true, 'Migration preserves bookmarks.');
  await next(page);
  invariant(await page.evaluate(() => window.__auditSpeech.speak.at(-1).text), entries[1].speakText, 'The migrated default actually reads on navigation.');
});

test('storage-migration', '无版本号存储键迁移保留记录及纠错状态', 'P1', ['标记并答错', '以旧键保存', '重新加载后纠错并刷新'], async page => {
  await page.locator('#bookmark').click(); await page.locator('#default-chinese').check();
  await submit(page, 'wrong-before-migration');
  const saved = await state(page);
  saved.settings.autoSpeak = false; saved.settings.autoSpeakConfigured = true;
  await seedStorage(page, [[legacyKey, saved]], [key]);
  const migrated = await state(page);
  invariant(migrated.records, saved.records, 'Bookmarks, mistakes and counters survive the key change.');
  invariant(migrated.history, saved.history, 'Answer history survives the key change.');
  invariant(migrated.session, saved.session, 'Current question, hints and correction state survive the key change.');
  invariant(migrated.settings, saved.settings, 'Explicit playback and other settings survive migration.');
  invariant(await page.evaluate(k => localStorage.getItem(k), legacyKey), null, 'The old key is removed after the new save succeeds.');
  invariant(await page.locator('#next').isDisabled(), true, 'Migration keeps unfinished correction locked.');
  await submit(page, (await currentEntry(page)).original); await page.reload();
  invariant((await state(page)).records[entries[0].id].corrections, 1, 'Later answers keep using the new key after reload.');
  invariant(await page.locator('#next').isDisabled(), false, 'Completed correction remains completed.');
});

test('storage-current-priority', '新旧存储同时存在时保留当前记录', 'P1', ['保存当前练习记录', '同时放入旧键', '重新加载'], async page => {
  await page.locator('#bookmark').click(); await submit(page, 'wrong-current-save');
  const saved = await state(page), stale = { ...saved, records: {}, history: [], session: null };
  await seedStorage(page, [[key, saved], [legacyKey, stale]]);
  const currentSave = await state(page);
  invariant(currentSave.records, saved.records, 'A stale old key cannot overwrite current records.');
  invariant(currentSave.history, saved.history, 'Current answer history wins.');
  invariant(await page.locator('#next').isDisabled(), true, 'Current correction state wins.');
});

test('storage-migration-failure', '迁移写入失败时保留旧记录并提示', 'P1', ['以旧键保存标记', '模拟存储写入失败', '检查记录仍然保留'], async page => {
  await page.locator('#bookmark').click(); const saved = await state(page);
  await seedStorage(page, [[legacyKey, saved]], [key], true);
  invariant(await page.evaluate(k => JSON.parse(localStorage.getItem(k)), legacyKey), saved, 'Failed migration never deletes the original records.');
  invariant(await page.evaluate(k => localStorage.getItem(k), key), null, 'A failed write does not pretend migration succeeded.');
  invariant(await page.locator('#bookmark').getAttribute('aria-pressed'), 'true', 'Old records remain usable in memory.');
  invariant(await page.locator('#save-status').isVisible(), true, 'The user sees the backup reminder when storage fails.');
});

test('foldable-controls', '普通与全屏折叠独立保存，提示和纠错不丢失', 'P1', ['折叠普通操作', '快捷键重听', '进入全屏默认收起', '展开后切换并刷新'], async page => {
  invariant(await page.locator('#practice-controls').isVisible(), true, 'Normal controls start expanded.');
  await page.locator('#default-chinese').check(); await page.locator('#default-phonetic').check();
  await page.locator('#answer-input').fill('partial');
  await page.locator('#toggle-controls').click();
  invariant(await page.locator('#practice-controls').isVisible(), false, 'Normal controls can fold.');
  invariant(await page.locator('#question-hints .question-hint').count(), 2, 'Folding preserves selected hints.');
  await page.locator('#answer-input').press('Alt+r');
  invariant(await page.evaluate(() => window.__auditSpeech.speak.at(-1).text), entries[0].speakText, 'Replay works while controls are folded.');
  await page.locator('#open-fullscreen').click();
  invariant(await page.locator('#practice-controls').isVisible(), false, 'Fullscreen controls start folded.');
  invariant(await page.locator('#answer-input').inputValue(), 'partial', 'Fullscreen folding preserves typed text.');
  await page.locator('#toggle-controls').click();
  await page.locator('#bookmark').click();
  await page.locator('#open-fullscreen').click();
  await page.waitForFunction(() => !document.body.classList.contains('immersive'));
  invariant(await page.locator('#practice-controls').isVisible(), false, 'Normal folded preference is independent of fullscreen.');
  await page.locator('#open-fullscreen').click();
  invariant(await page.locator('#practice-controls').isVisible(), true, 'Fullscreen remembers its expanded preference.');
  await submit(page, 'wrong-folding');
  await page.locator('#toggle-controls').click();
  invariant(await page.locator('#next').isDisabled(), true, 'Correction stays locked with controls hidden.');
  await page.locator('#open-fullscreen').click();
  await page.waitForFunction(() => !document.body.classList.contains('immersive'));
  await page.reload();
  invariant(await page.locator('#practice-controls').isVisible(), false, 'Normal folded preference survives reload.');
  invariant(await page.locator('#next').isDisabled(), true, 'The correction lock survives reload too.');
});

test('category-all-modes', '五个分类均可用四种方式练习', 'P1', ['逐个选择分类', '切换四模式', '检查练习池保持分类'], async page => {
  invariant(await page.locator('#category-select').isVisible(), true, 'Category is directly available without opening the range menu.');
  for (const category of ['常规', '字符串', '数值', '时间', '拼写']) {
    await page.locator('#category-select').selectOption(category);
    const expected = entries.filter(x => x.category === category).map(x => x.id);
    for (const name of ['listen', 'chinese', 'phonetic', 'flashcard']) {
      await mode(page, name); await next(page);
      const saved = await state(page);
      invariant(saved.session.ids, expected, category + ' keeps the full matching practice pool in ' + name);
      invariant((await currentEntry(page)).category, category, 'Navigation stays in the chosen category.');
    }
  }
  await page.reload();
  invariant(await page.locator('#category-select').inputValue(), '拼写', 'The chosen category survives reload.');
});

test('empty-no-score', '空答案不计分、不锁题', 'P2', ['不填写答案', '按 Enter', '检查学习记录'], async page => {
  await page.locator('#answer-input').press('Enter');
  invariant((await state(page)).history.length, 0, 'Empty input creates no answer record.');
  invariant(await page.locator('#next').isDisabled(), false, 'An empty submission does not trap the user.');
});

test('wrong-lock-paths', '答错后的所有页面入口锁定', 'P1', ['输入明显错误答案', '尝试切换题目、模式、范围和页面', '检查锁定状态'], async page => {
  const id = await currentId(page);
  await submit(page, 'audit-wrong-answer');
  const before = await state(page);
  invariant(before.records[id].inMistakes, true, 'Wrong answer is automatically added to mistakes.');
  for (const selector of ['#next', '#previous', '#shuffle', '#pool-select', '#category-select', '#toggle-mistake',
    '[data-view="library"]', '[data-view="mistakes"]', '[data-view="stats"]',
    '[data-mode="listen"]', '[data-mode="chinese"]', '[data-mode="phonetic"]', '[data-mode="flashcard"]'])
    invariant(await page.locator(selector).isDisabled(), true, `${selector} cannot bypass correction.`);
  await page.locator('#home-link').click();
  await exerciseAction(page, 'bookmark');
  await page.locator('#play-main').click();
  await page.locator('#open-sound').click();
  await page.locator('#sound-dialog [aria-label="关闭设置"]').click();
  invariant(await currentId(page), id, 'Allowed settings, bookmark and replay do not leave the locked item.');
  invariant((await state(page)).session.result.correct, false, 'Lock remains until a valid spelling is submitted.');
  assert.match(await page.locator('#result-box').innerText(), /拼写正确/, 'The correction requirement is visible.');
  await submit(page, byId.get(id).acceptedAnswers[0]);
  invariant(await page.locator('#next').isDisabled(), false, 'Valid correction unlocks navigation.');
});

test('refresh-lock', '刷新后保留当前纠错锁', 'P1', ['答错', '刷新网页', '尝试下一条', '完成正确拼写'], async page => {
  const item = await currentEntry(page);
  await submit(page, 'incorrect-before-refresh');
  await page.reload(); await page.locator('#answer-input').waitFor({ state: 'visible' });
  invariant(await currentId(page), item.id, 'Refresh retains the exact locked item.');
  invariant(await page.locator('#next').isDisabled(), true, 'Refresh cannot bypass the lock.');
  invariant((await state(page)).records[item.id].wrong, 1, 'Refresh does not double-count the wrong answer.');
  await submit(page, item.acceptedAnswers[0]);
  invariant((await state(page)).records[item.id].correct, 0, 'Restored correction is not scored as an independent answer.');
});

test('correction-counts', '多次纠错不影响独立正确率和连续次数', 'P1', ['独立答错一次', '纠错再错两次', '正确纠错', '检查记录和统计'], async page => {
  const item = await oneMarked(page);
  await submit(page, 'audit-wrong-1');
  await submit(page, 'audit-wrong-2');
  await submit(page, 'audit-wrong-3');
  await submit(page, item.acceptedAnswers[0]);
  const s = await state(page), r = s.records[item.id];
  invariant([r.attempts, r.correct, r.wrong, r.streak, r.corrections, r.inMistakes], [1, 0, 1, 0, 3, true],
    'Only the initial independent answer affects correctness and streak.');
  invariant(s.history.filter(h => h.correction).length, 3, 'Correction attempts remain available in the backup history.');
  await view(page, 'stats');
  const stats = await statValues(page);
  invariant(stats['独立作答'].value, '1', 'Overview excludes corrections.');
  invariant(stats['正确率'].value, '0%', 'Successful correction does not inflate the correctness rate.');
  const rows = await dailyRows(page);
  invariant(rows[0].slice(1, 7), ['1', '0', '1', '0%', '3', '0'], 'Daily statistics separate corrections.');
});

for (const target of [1, 2, 3, 4, 5, 10]) test(`threshold-${target}`, `连续独立答对 ${target} 次移出`, 'P1',
  [`设置移出次数 ${target}`, '手动加入一条错题', `连续独立答对 ${target} 次`], async page => {
    const item = await oneMarked(page);
    await rule(page, target);
    await exerciseAction(page, 'toggle-mistake');
    for (let count = 1; count <= target; count++) {
      await submit(page, item.acceptedAnswers[0]);
      const r = (await state(page)).records[item.id];
      invariant(r.correct, count, 'Each independent correct answer is scored exactly once.');
      invariant(r.inMistakes, count < target, 'Removal happens at the configured threshold.');
      invariant(r.streak, count < target ? count : 0, 'The streak is retained before removal and reset after removal.');
      if (count < target) await next(page);
    }
    assert.match(await page.locator('#result-box').innerText(), /自动移出/, 'Automatic removal gives explicit feedback.');
  });

test('streak-reset', '连续答对中途答错清零，纠错不补次数', 'P1', ['错题先独立答对一次', '下一次答错', '纠错正确', '再独立答对三次'], async page => {
  const item = await oneMarked(page); await exerciseAction(page, 'toggle-mistake');
  await submit(page, item.acceptedAnswers[0]); await next(page);
  invariant((await state(page)).records[item.id].streak, 1, 'A first independent correct answer advances the streak.');
  await submit(page, 'audit-break-streak');
  invariant((await state(page)).records[item.id].streak, 0, 'Independent wrong answer resets the streak.');
  await submit(page, item.acceptedAnswers[0]);
  invariant((await state(page)).records[item.id].streak, 0, 'Correct spelling during correction leaves streak at zero.');
  for (let n = 1; n <= 3; n++) {
    await next(page); await submit(page, item.acceptedAnswers[0]);
    invariant((await state(page)).records[item.id].inMistakes, n < 3, 'Three new independent correct answers are required.');
  }
});

test('threshold-lower', '调低移出次数从下一次独立作答生效', 'P2', ['设置 5 次', '错题连续正确两次', '将规则降为 1 次', '再独立正确一次'], async page => {
  const item = await oneMarked(page); await rule(page, 5); await exerciseAction(page, 'toggle-mistake');
  await submit(page, item.acceptedAnswers[0]); await next(page); await submit(page, item.acceptedAnswers[0]);
  await rule(page, 1);
  invariant((await state(page)).records[item.id].inMistakes, true, 'Changing the setting alone does not erase the mistake.');
  await next(page); await submit(page, item.acceptedAnswers[0]);
  invariant((await state(page)).records[item.id].inMistakes, false, 'The new threshold applies to the next independent answer.');
});

test('mistake-range-exhaustion', '错题练习自动移出后继续下一错题，全部完成后可恢复', 'P1', ['准备两条真实错题', '设置独立答对1次移出', '进入错题范围', '依次答对', '返回全部词条'], async page => {
  const items = entries.slice(0, 2);
  const backup = { version: 2, dataset: '1533', history: [], settings: { target: 1 },
    records: Object.fromEntries(items.map(item => [item.id, { ...blankRecord(), inMistakes: true }])) };
  await importBackup(page, backup); await view(page, 'mistakes'); await page.locator('#practice-mistakes').click();
  invariant((await state(page)).session.pool, 'mistakes', 'The mistake-practice shortcut chooses the correct range.');
  for (const item of items) {
    invariant(await currentId(page), item.id, 'Each remaining mistake is shown in sequence.');
    await submit(page, item.original);
    invariant((await state(page)).records[item.id].inMistakes, false, 'A correct independent answer removes the item.');
    await next(page);
  }
  invariant(await page.locator('#empty-practice').isVisible(), true, 'The user receives a completion state after clearing the last mistake.');
  assert.match(await page.locator('#empty-title').innerText(), /错题本已经空了/, 'The completed range is explained.');
  await page.locator('#return-all').click(); invariant((await state(page)).session.ids.length, 1533, 'All-word practice can be recovered after finishing a range.');
});

test('unseen-range-exhaustion', '尚未练习范围答题和翻卡后逐项完成', 'P2', ['仅留两条真实词条未练', '进入尚未练习范围', '第一条独立作答', '第二条翻卡', '继续下一条'], async page => {
  const items = entries.slice(0, 2);
  const backup = { version: 2, dataset: '1533', history: [], settings: { target: 3 },
    records: Object.fromEntries(entries.map((item, index) => [item.id, { ...blankRecord(), seen: index > 1 }])) };
  await importBackup(page, backup); await view(page, 'practice'); await selectRange(page, 'pool-select', 'unseen');
  invariant((await state(page)).session.ids, items.map(item => item.id), 'Only two previously unseen entries are selected.');
  await submit(page, items[0].original); await next(page);
  invariant(await currentId(page), items[1].id, 'The seen first entry is skipped.');
  await mode(page, 'flashcard'); await page.locator('#flip-card').click(); await next(page);
  invariant(await page.locator('#empty-practice').isVisible(), true, 'An unseen range finishes once both entries have been answered or flipped.');
});

test('four-modes', '四种练习模式与多义词卡', 'P1', ['切换听音、中文、音标和词卡', '翻卡', '检查多义、同义提示及计分'], async page => {
  const item = entries.find(x => x.meanings.length >= 3 && x.synonyms.length > 0);
  assert.ok(item, 'Real data must include a multi-meaning example with synonym hints.');
  await choose(page, item);
  await mode(page, 'listen'); invariant(await page.locator('#play-main').isVisible(), true, 'Listening mode has a replay control.');
  await mode(page, 'chinese'); assert.ok((await page.locator('#prompt-area').innerText()).includes(item.meanings[0].zh), 'Chinese mode shows the meaning.');
  await mode(page, 'phonetic'); assert.ok((await page.locator('#prompt-area').innerText()).includes(item.phonetic), 'Phonetic mode shows the IPA.');
  await mode(page, 'flashcard');
  invariant(await page.locator('#answer-form').isVisible(), false, 'Flashcards do not show an answer form.');
  await page.locator('#flip-card').click();
  invariant(await page.locator('#prompt-area .synonym-chip').first().isVisible(), true, 'Synonyms are visible without expanding.');
  const prompt = await page.locator('#prompt-area').innerText();
  for (const meaning of item.meanings) assert.ok(prompt.includes(meaning.zh), 'Each meaning is shown on the reverse side.');
  assert.ok(prompt.includes(item.synonyms[0].english), 'Synonyms are shown for learning.');
  const r = (await state(page)).records[item.id];
  invariant([r.attempts, r.correct, r.streak, r.seen], [0, 0, 0, true], 'Flip activity does not count as a correct answer.');
});

test('category-practice-and-shuffle', '分类练习、洗牌完整性和上一条', 'P2', ['选择数值分类', '随机打乱', '下一条后上一条', '设置看音标模式并刷新'], async page => {
  await selectRange(page, 'category-select', '数值');
  const expected = entries.filter(item => item.category === '数值').map(item => item.id).sort();
  const first = (await state(page)).session.ids;
  invariant(first.slice().sort(), expected, 'Category practice includes every matching entry and no others.');
  await rangeAction(page, 'shuffle');
  const s = await state(page); invariant(s.session.ids.slice().sort(), expected, 'Shuffle neither duplicates nor drops entries.');
  const id = await currentId(page); await next(page); await page.locator('#previous').click();
  invariant(await currentId(page), id, 'Previous restores the preceding shuffled entry.');
  await mode(page, 'phonetic'); await page.reload();
  const restored = await state(page);
  invariant([restored.session.category, restored.session.mode], ['数值', 'phonetic'], 'Mode and selected category persist after reload.');
  invariant(restored.session.ids, s.session.ids, 'The shuffled order survives reload.');
});

test('synonym-not-answer', '同义提示默认不算听力正确答案', 'P1', ['选择一个有非答案同义词的词条', '输入其同义词', '查看错误提示和词义', '正确纠错'], async page => {
  const item = entries.find(x => x.synonyms.some(s => !x.acceptedAnswers.map(a => a.toLowerCase()).includes(s.english.toLowerCase())));
  assert.ok(item, 'An independently annotated non-answer synonym is required.');
  const synonym = item.synonyms.find(s => !item.acceptedAnswers.map(a => a.toLowerCase()).includes(s.english.toLowerCase()));
  await choose(page, item); await submit(page, synonym.english);
  invariant((await state(page)).session.result.correct, false, 'Learning hints are not broadly accepted as answers.');
  invariant(await page.locator('#result-box .synonym-chip').first().isVisible(), true, 'Feedback synonyms are always visible.');
  const result = await page.locator('#result-box').innerText();
  assert.ok(result.includes(synonym.english), 'The synonym suggestion is visible after a mistake.');
  for (const meaning of item.meanings) assert.ok(result.includes(meaning.zh), 'All relevant meanings are visible after a mistake.');
  await submit(page, item.acceptedAnswers[0]);
});

test('formal-aliases', '数字、时间、日期和编号的原形式及英文别名', 'P1', ['分别选择 12、7:45、April 9、AF741T', '输入原始形式', '输入所有已标注别名', '输入相近错误答案'], async page => {
  const selections = [['12', '13'], ['7:45', '7:46'], ['April 9', 'April 10'], ['AF741T', 'AF742T']];
  for (const [original, incorrect] of selections) {
    const item = entries.find(x => x.original === original); assert.ok(item, `${original} must exist in the full dataset.`);
    assert.ok(item.acceptedAnswers.includes(item.original), 'Original form is accepted.');
    assert.ok(item.acceptedAnswers.some(a => a.toLowerCase() === item.english.toLowerCase()), 'English reading is accepted.');
    for (const answer of [...new Set([item.original, item.english, ...item.acceptedAnswers])]) {
      await choose(page, item); await submit(page, answer);
      invariant((await state(page)).session.result.correct, true, `The declared alias is accepted: ${original} / ${answer}.`);
    }
    await choose(page, item); await submit(page, incorrect);
    invariant((await state(page)).session.result.correct, false, 'A nearby numeric/date/code value is rejected.');
    await submit(page, item.original);
  }
});

test('plural-strict', '单复数严格判分，大小写可接受', 'P1', ['选择 accidents', '输入 accident', '使用 ACCIDENTS 纠错'], async page => {
  const item = entries.find(x => x.original === 'accidents'); await choose(page, item);
  await submit(page, 'accident'); invariant((await state(page)).session.result.correct, false, 'The singular does not match a plural answer.');
  await submit(page, 'ACCIDENTS'); invariant((await state(page)).session.result.correct, true, 'Case does not change correctness.');
});

test('numeric-sign-strict', '数字负号、数值和日期差异严格判分', 'P1', ['选择正数 12', '分别输入 -12、−12、１３', '检查错误锁定', '输入 twelve 纠错'], async page => {
  const item = entries.find(x => x.original === '12');
  for (const answer of ['-12', '−12', '１３']) {
    await choose(page, item); await submit(page, answer);
    invariant((await state(page)).session.result.correct, false, `A different numeric value is rejected: ${answer}.`);
    invariant(await page.locator('#next').isDisabled(), true, 'Numeric mistakes enter the same compulsory correction flow.');
    await submit(page, item.english);
    invariant((await state(page)).session.result.correct, true, 'The complete correct English reading unlocks the item.');
  }
});

test('library-search-pager', '1533 条分页、中文和同义词搜索', 'P2', ['打开词库并翻页', '检查最后一页', '中文搜索报纸', '搜索同义词', '分类筛选'], async page => {
  await view(page, 'library');
  invariant(await page.locator('#library-list .word-row').count(), 60, 'Library renders one 60-row page.');
  await page.locator('#library-pager [data-page="next"]').click();
  invariant(await page.locator('#library-list [data-action="practice-item"]').first().getAttribute('data-id'), entries[60].id, 'Page two starts at item 61.');
  for (let n = 2; n < Math.ceil(entries.length / 60); n++) await page.locator('#library-pager [data-page="next"]').click();
  invariant(await page.locator('#library-list .word-row').count(), 33, 'Final page contains the remaining 33 entries.');
  invariant(await page.locator('#library-pager [data-page="next"]').isDisabled(), true, 'The pager cannot exceed the final page.');
  await page.locator('#library-search').fill('报纸');
  assert.ok(await page.locator('#library-list [data-id="v0001"][data-action="practice-item"]').count(), 'Chinese search finds newspaper.');
  const item = entries.find(x => x.synonyms.length > 0);
  await page.locator('#library-search').fill(item.synonyms[0].english);
  assert.ok(await page.locator(`#library-list [data-id="${item.id}"][data-action="practice-item"]`).count(), 'Synonym search finds its associated entry.');
  await page.locator('#library-search').fill(''); await page.locator('#library-category').selectOption('数值');
  const ids = await page.locator('#library-list [data-action="practice-item"]').evaluateAll(buttons => buttons.map(b => b.dataset.id));
  assert.ok(ids.every(id => byId.get(id).category === '数值'), 'Category filters apply before pagination.');
});

test('marked-range', '标记范围、切题后跳过取消标记项', 'P2', ['在词库标记前两项', '进入已标记练习', '取消当前标记', '切下一条'], async page => {
  await view(page, 'library');
  for (const item of entries.slice(0, 2)) await page.locator(`#library-list [data-action="mark"][data-id="${item.id}"]`).click();
  await view(page, 'practice'); await selectRange(page, 'pool-select', 'marked');
  invariant((await state(page)).session.ids, entries.slice(0, 2).map(x => x.id), 'Marked range contains both marked entries.');
  const removedId = await currentId(page); await exerciseAction(page, 'bookmark'); await next(page);
  assert.notEqual(await currentId(page), removedId, 'Navigation skips an item removed from the chosen range.');
  await exerciseAction(page, 'bookmark'); await next(page);
  invariant(await page.locator('#empty-practice').isVisible(), true, 'An empty marked range gives a recoverable empty state.');
  await page.locator('#return-all').click(); invariant((await state(page)).session.ids.length, 1533, 'Return to all practice remains available.');
});

test('manual-mistakes-clear', '手动错题操作、一键清空与取消保留记录', 'P2', ['答错并纠错', '手动移出再加入', '进入错题本', '取消清空', '确认清空'], async page => {
  const item = await currentEntry(page); await submit(page, 'audit-wrong'); await submit(page, item.original);
  await exerciseAction(page, 'toggle-mistake'); invariant((await state(page)).records[item.id].inMistakes, false, 'Manual removal works after correction.');
  await exerciseAction(page, 'toggle-mistake'); await view(page, 'mistakes'); await page.locator('#clear-mistakes').click();
  await page.locator('#cancel-confirm').click(); invariant((await state(page)).records[item.id].inMistakes, true, 'Cancel does not remove a mistake.');
  await page.locator('#clear-mistakes').click(); await page.locator('#accept-confirm').click();
  const r = (await state(page)).records[item.id];
  invariant([r.inMistakes, r.attempts, r.wrong, r.corrections], [false, 1, 1, 1], 'Clearing mistakes preserves answer and correction history.');
  invariant(await page.locator('#clear-mistakes').isDisabled(), true, 'Empty mistake collection disables clear.');
});

test('mistake-pager-all-clear', '错题跨页手动移除和一键清空', 'P2', ['导入75条手动错题记录', '翻至第二页', '移除一项', '取消及确认清空所有页'], async page => {
  const markedEntries = entries.slice(0, 75);
  const backup = { version: 2, dataset: '1533', settings: { target: 3 }, history: [],
    records: Object.fromEntries(markedEntries.map(item => [item.id, { ...blankRecord(), inMistakes: true }])) };
  await importBackup(page, backup); await view(page, 'mistakes');
  invariant(await page.locator('#mistake-list .word-row').count(), 60, 'First mistake page contains 60 entries.');
  await page.locator('#mistakes-pager [data-page="next"]').click();
  invariant(await page.locator('#mistake-list .word-row').count(), 15, 'Second mistake page contains the remaining 15 entries.');
  await page.locator(`#mistake-list [data-action="mistake"][data-id="${markedEntries[60].id}"]`).click();
  invariant((await state(page)).records[markedEntries[60].id].inMistakes, false, 'Manual removal works on later pages.');
  invariant(await page.locator('#mistake-list .word-row').count(), 14, 'The current page updates after removal.');
  await page.locator('#clear-mistakes').click(); await page.locator('#cancel-confirm').click();
  invariant(Object.values((await state(page)).records).filter(r => r.inMistakes).length, 74, 'Cancel keeps all pages unchanged.');
  await page.locator('#clear-mistakes').click(); await page.locator('#accept-confirm').click();
  invariant(Object.values((await state(page)).records).filter(r => r.inMistakes).length, 0, 'One click clears mistakes on every page.');
  invariant(await page.locator('#practice-mistakes').isDisabled(), true, 'Practice is disabled for the newly empty mistake collection.');
});

test('enter-context', '空白回车播放、单次提交、纠错与按钮输入保护', 'P1', ['空白回车播放', '提交正确答案后再按回车', '答错后清空重听及纠错', '检查输入法和按钮'], async page => {
  const calls = () => page.evaluate(() => window.__auditSpeech.speak.length);
  const initial = await currentEntry(page);
  await page.locator('#answer-input').press('Enter');
  invariant(await calls(), 1, 'Blank Enter plays once.');
  invariant((await state(page)).history.length, 0, 'Blank Enter creates no score.');
  await page.locator('#answer-input').evaluate(el => el.blur()); await page.keyboard.press('Enter');
  invariant(await calls(), 2, 'Page background Enter also plays a blank question.');
  await page.locator('#bookmark').focus(); await page.keyboard.press('Enter');
  invariant((await state(page)).records[initial.id].marked, true, 'Focused bookmark keeps native Enter activation.');
  invariant(await calls(), 2, 'Bookmark Enter does not also play.');
  await page.locator('#answer-input').fill(initial.original);
  await page.locator('#answer-input').evaluate(el => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, repeat: true }));
  });
  invariant((await state(page)).history.length, 0, 'Composing and repeated Enter do not submit.');
  await page.keyboard.press('Enter');
  invariant((await state(page)).history.length, 1, 'Enter creates exactly one independent answer.');
  assert.match(await page.locator('#next').innerText(), /↵/, 'The advance shortcut is visible after a correct answer.');
  await page.keyboard.press('Enter'); invariant(await currentId(page), entries[1].id, 'The next Enter advances exactly one entry.');
  invariant((await state(page)).history.length, 1, 'Advancing does not also submit the new question.');
  const second = await currentEntry(page); await submit(page, 'audit-enter-wrong');
  await page.locator('#answer-input').fill(''); const count = await calls(); await page.keyboard.press('Enter');
  invariant(await calls(), count + 1, 'Blank Enter replays during correction.');
  invariant((await state(page)).history.length, 2, 'Replay does not add correction attempts.');
  invariant(await page.locator('#next').isDisabled(), true, 'Replay keeps correction locked.');
  await submit(page, second.original); await page.keyboard.press('Enter');
  invariant(await currentId(page), entries[2].id, 'Enter after correction advances once.');
});

test('flashcard-enter', '词卡回车朗读、翻卡与切题焦点', 'P1', ['进入词卡立即按回车', '翻卡后按回车', '下一条后按回车', '聚焦翻卡和设置按回车'], async page => {
  await mode(page, 'flashcard');
  const before = await state(page), count = await page.evaluate(() => window.__auditSpeech.speak.length);
  await page.keyboard.press('Enter');
  invariant(await page.evaluate(() => window.__auditSpeech.speak.length), count + 1, 'Entering flashcard puts Enter on replay.');
  invariant((await state(page)).session.flipped, false, 'Reading a card does not flip it.');
  invariant((await state(page)).history.length, before.history.length, 'Reading alone is not a card review.');
  await page.locator('#flip-card').click(); await page.keyboard.press('Enter');
  invariant(await page.evaluate(() => window.__auditSpeech.speak.length), count + 2, 'Enter after flipping reads again.');
  invariant((await state(page)).session.flipped, true, 'Replay does not hide the revealed card.');
  invariant((await state(page)).history.length, 1, 'Only flipping adds one review.');
  await next(page); await page.keyboard.press('Enter');
  invariant(await currentId(page), entries[1].id, 'Reading after Next stays on the new card.');
  invariant(await page.evaluate(() => window.__auditSpeech.speak.at(-1).text), entries[1].speakText, 'Enter reads the new card.');
  await page.locator('#flip-card').focus(); await page.keyboard.press('Enter');
  invariant((await state(page)).session.flipped, true, 'Focused flip button keeps native Enter behavior.');
  await page.locator('#sound-shortcut').focus(); await page.keyboard.press('Enter');
  invariant(await page.locator('#sound-dialog').isVisible(), true, 'Focused settings button opens the dialog.');
});

async function repetitionSettings(page, repeats = 3, auto = false) {
  await page.locator('#sound-shortcut').click();
  await page.locator('#playback-repeat').selectOption(String(repeats));
  await page.locator('#auto-speak').setChecked(auto);
  await page.locator('#sound-dialog .close-button').click();
}
async function finishUtterance(page) {
  await page.evaluate(() => { const u = window.__auditSpeech.current; window.__auditSpeech.current = null; u?.onend?.(); });
}
async function speechCount(page, expected) {
  await page.waitForFunction(n => window.__auditSpeech.speak.length === n, expected, { timeout: 2500 });
}
test('repeat-playback', '每次播放按设置次数顺序完成', 'P1', ['设置播放3遍', '逐个完成朗读', '检查恰好3遍及同一词条', '重新加载保留次数'], async page => {
  await repetitionSettings(page); await page.locator('#play-main').click();
  await speechCount(page, 1); assert.match(await page.locator('#speech-status').innerText(), /1 \/ 3/);
  await finishUtterance(page); await speechCount(page, 2);
  await finishUtterance(page); await speechCount(page, 3);
  await finishUtterance(page); await page.waitForTimeout(600);
  invariant(await page.evaluate(() => window.__auditSpeech.speak.length), 3, 'No extra fourth utterance is queued.');
  invariant(await page.evaluate(() => window.__auditSpeech.speak.map(x => x.text)), Array(3).fill(entries[0].speakText), 'All repetitions read the same entry.');
  invariant(await page.locator('#speech-status').innerText(), '', 'Status clears after the final repetition.');
  invariant((await state(page)).history.length, 0, 'Repeated audio is not scored.');
  await page.reload(); await page.locator('#sound-shortcut').click();
  invariant(await page.locator('#playback-repeat').inputValue(), '3', 'Repetition count persists.');
});

test('repeat-pause', '两遍之间暂停、继续和取消', 'P2', ['设置播放2遍', '完成首遍后空格暂停', '等待后继续', '检查第二遍'], async page => {
  await repetitionSettings(page, 2); await page.locator('#play-main').click(); await finishUtterance(page);
  await page.keyboard.press('Space'); await page.waitForTimeout(600);
  invariant(await page.evaluate(() => window.__auditSpeech.speak.length), 1, 'Pausing the gap prevents the next repetition.');
  await page.keyboard.press('Space'); await speechCount(page, 2);
  await finishUtterance(page); await page.waitForTimeout(600);
  invariant(await page.evaluate(() => window.__auditSpeech.speak.length), 2, 'Resuming the gap plays exactly one remaining repetition.');
});

test('repeat-cancellation', '重听、换题、模式与弹窗取消剩余遍数', 'P1', ['在重复间隔内操作', '等待剩余遍数', '检查旧语音事件不会恢复队列'], async page => {
  await repetitionSettings(page);
  for (const action of ['next', 'mode', 'settings', 'help', 'view', 'replay']) {
    await view(page, 'practice'); await mode(page, 'listen');
    await page.locator('#play-main').click();
    await page.evaluate(() => { window.__oldUtterance = window.__auditSpeech.current; });
    await finishUtterance(page);
    if (action === 'next') await next(page);
    if (action === 'mode') await mode(page, 'chinese');
    if (action === 'settings') await page.locator('#sound-shortcut').click();
    if (action === 'help') await page.locator('#open-help').click();
    if (action === 'view') await view(page, 'library');
    if (action === 'replay') await page.locator('#play-main').click();
    const count = await page.evaluate(() => window.__auditSpeech.speak.length);
    await page.evaluate(() => { window.__oldUtterance.onend?.(); window.__oldUtterance.onerror?.({ error: 'interrupted' }); });
    await page.waitForTimeout(650);
    invariant(await page.evaluate(() => window.__auditSpeech.speak.length), count, action + ' cancels old repeats even after late callbacks.');
    if (action === 'settings') await page.locator('#sound-dialog .close-button').click();
    if (action === 'help') await page.locator('#help-dialog .close-button').click();
  }
});

test('repeat-error', '朗读错误停止后续遍数并显示反馈', 'P1', ['播放多遍时首遍失败', '等待并检查后续未播放', '重试后忽略旧错误'], async page => {
  await repetitionSettings(page); await page.locator('#play-main').click();
  await page.evaluate(() => {
    window.__oldUtterance = window.__auditSpeech.current;
    window.__auditSpeech.current.onerror({ error: 'synthesis-failed' });
  });
  assert.match(await page.locator('#speech-status').innerText(), /朗读失败/);
  await page.waitForTimeout(650); invariant(await page.evaluate(() => window.__auditSpeech.speak.length), 1, 'Error cancels all remaining repeats.');
  await page.locator('#play-main').click();
  await page.evaluate(() => window.__oldUtterance.onerror({ error: 'synthesis-failed' }));
  assert.match(await page.locator('#speech-status').innerText(), /1 \/ 3/, 'Late errors do not replace new playback status.');
});

test('auto-all-modes', '所有模式自动朗读并使用默认遍数', 'P2', ['设置自动朗读2遍', '逐个模式切下一条', '检查两遍文本和题目不变'], async page => {
  await repetitionSettings(page, 2, true);
  for (const name of ['listen', 'chinese', 'phonetic', 'flashcard']) {
    await mode(page, name); const before = await page.evaluate(() => window.__auditSpeech.speak.length);
    await next(page); const item = await currentEntry(page);
    await speechCount(page, before + 1); await finishUtterance(page); await speechCount(page, before + 2); await finishUtterance(page);
    invariant(await page.evaluate(() => window.__auditSpeech.speak.slice(-2).map(x => x.text)), [item.speakText, item.speakText], name + ' auto reads the next entry twice.');
  }
});

test('combined-hints', '单题与默认提示组合、复位和持久化', 'P1', ['听音单次显示中文和音标', '切下一条', '设置默认提示', '切模式并重载'], async page => {
  invariant(await page.locator('#question-hints').isVisible(), false, 'Hints start hidden.');
  const item = await currentEntry(page); await page.locator('#hint-chinese').click(); await page.locator('#hint-phonetic').click();
  assert.ok((await page.locator('#question-hints').innerText()).includes(item.meanings[0].zh));
  assert.ok((await page.locator('#question-hints').innerText()).includes(item.phonetic));
  invariant((await state(page)).settings.hintChinese, false, 'One-question hints do not alter defaults.');
  await next(page); invariant(await page.locator('#question-hints').isVisible(), false, 'One-question hints reset on navigation.');
  await page.locator('#default-chinese').check(); await page.locator('#default-phonetic').check();
  invariant(await page.locator('#question-hints .question-hint').count(), 2, 'Both defaults display together.');
  await page.locator('#hint-chinese').click(); invariant(await page.locator('#question-hints .question-hint').count(), 1, 'Default hints can be hidden for just this question.');
  await page.reload(); invariant(await page.locator('#question-hints .question-hint').count(), 1, 'A current-question override survives reload.');
  await next(page); invariant(await page.locator('#question-hints .question-hint').count(), 2, 'Next question restores defaults.');
  await mode(page, 'chinese'); invariant(await page.locator('#question-hints .question-hint').count(), 1, 'Chinese primary prompt is not duplicated.');
  assert.ok((await page.locator('#question-hints').innerText()).includes((await currentEntry(page)).phonetic), 'Chinese mode can show IPA.');
  await mode(page, 'phonetic'); invariant(await page.locator('#question-hints .question-hint').count(), 1, 'IPA primary prompt is not duplicated.');
  await mode(page, 'flashcard'); await page.locator('#flip-card').click();
  invariant(await page.locator('#question-hints').isVisible(), false, 'Open card already shows meanings and IPA.');
  invariant((await state(page)).history.filter(h => h.mode !== 'flashcard').length, 0, 'Showing hints does not create answers.');
});

test('extended-settings-backup', '宽语速、播放次数与默认提示备份和边界', 'P2', ['导入新设置', '重载', '检查数值及范围', '输入超限值和空值'], async page => {
  const backup = { version: 2, dataset: '1533', records: {}, history: [], settings: { rate: 8.5, repeats: 7, hintChinese: true, hintPhonetic: true, volume: 2 } };
  await importBackup(page, backup); await view(page, 'practice');
  invariant(await page.locator('#question-hints .question-hint').count(), 2, 'Imported defaults display together.');
  await page.reload(); await page.locator('#sound-shortcut').click();
  invariant(await page.locator('#rate-number').inputValue(), '8.5', 'Rate above the old limit survives reload.');
  invariant(await page.locator('#rate').getAttribute('min'), '0.1', 'Expanded lower limit is visible.');
  invariant(await page.locator('#rate').getAttribute('max'), '10', 'Expanded upper limit is visible.');
  invariant(await page.locator('#playback-repeat').inputValue(), '7', 'Imported repetition count survives reload.');
  invariant(await page.locator('#volume').inputValue(), '1', 'Native volume remains capped at 100%.');
  for (const [value, expected] of [['15', 10], ['0', .1], ['.75', .75], ['', .75]]) {
    await page.locator('#rate-number').fill(value); await page.locator('#rate-number').dispatchEvent('change');
    invariant((await state(page)).settings.rate, expected, 'Numeric rate clamps or retains a valid value: ' + value);
    invariant(Number(await page.locator('#rate').inputValue()), expected, 'Slider agrees with number input.');
  }
  await page.locator('#sound-dialog .close-button').click(); await view(page, 'stats');
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export-progress').click()]);
  const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  invariant([exported.settings.repeats, exported.settings.hintChinese, exported.settings.hintPhonetic], [7, true, true], 'Backup exports all new settings.');
});

test('fullscreen-combined-hints', '全屏直接切模式和组合提示、键盘朗读与标记', 'P1', ['进入全屏', '依次切换四种模式', '加单次和默认提示', '朗读、标记和错题操作'], async page => {
  await page.locator('#open-fullscreen').click();
  invariant(await page.locator('#practice-controls').isVisible(), false, 'Fullscreen starts with folded controls.');
  await page.locator('#toggle-controls').click();
  for (const id of ['bookmark', 'toggle-mistake', 'previous', 'sound-shortcut', 'open-help'])
    invariant(await page.locator('#' + id).isVisible(), true, 'Fullscreen action is visible: ' + id);
  const item = await currentEntry(page);
  await page.locator('#hint-chinese').click(); await page.locator('#hint-phonetic').click();
  invariant(await page.locator('#question-hints .question-hint').count(), 2, 'Fullscreen listening combines both hints.');
  await page.locator('#default-chinese').check(); await page.locator('#default-phonetic').check();
  for (const name of ['chinese', 'phonetic', 'flashcard']) {
    await mode(page, name); invariant((await state(page)).session.mode, name, 'Fullscreen switches to ' + name);
    const count = await page.evaluate(() => window.__auditSpeech.speak.length);
    await page.keyboard.press('Enter');
    invariant(await page.evaluate(() => window.__auditSpeech.speak.length), count + 1, 'Enter reads a blank question or card in ' + name);
    invariant(await currentId(page), item.id, 'Replay keeps the current entry.');
  }
  await page.locator('#bookmark').click(); await page.locator('#toggle-mistake').click();
  invariant([(await state(page)).records[item.id].marked, (await state(page)).records[item.id].inMistakes], [true, true], 'Fullscreen actions work directly.');
  await page.locator('#previous').click();
  invariant(await currentId(page), entries.at(-1).id, 'Visible Previous navigates directly.');
  await page.locator('#open-fullscreen').click();
  invariant((await state(page)).settings.hintChinese, true, 'Defaults survive leaving fullscreen.');
});

test('keyboard-controls', 'R、Alt+R、Space 和 Enter 的输入保护', 'P2', ['在答案输入框输入 r 和空格', 'Alt+R 重听', '在非输入区域按 R 和 Space', 'Enter 提交及进入下一条'], async page => {
  invariant(await page.evaluate(() => window.__auditSpeech.environment), 'controlled-ongoing-utterance', 'Shortcut control evidence is explicitly identified as controlled ongoing speech.');
  const item = await currentEntry(page), callsBefore = await page.evaluate(() => window.__auditSpeech.speak.length);
  await page.locator('#answer-input').fill(''); await page.locator('#answer-input').press('r'); await page.locator('#answer-input').press('Space');
  invariant(await page.locator('#answer-input').inputValue(), 'r ', 'Text entry preserves r and spaces.');
  invariant(await page.evaluate(() => window.__auditSpeech.speak.length), callsBefore, 'Plain R and Space in input do not play audio.');
  await page.locator('#answer-input').press('Alt+r');
  assert.ok(await page.evaluate(() => window.__auditSpeech.speak.length) > callsBefore, 'Alt+R invokes the controlled speech queue while typing.');
  await page.evaluate(() => document.activeElement.blur());
  const count = await page.evaluate(() => window.__auditSpeech.speak.length); await page.keyboard.press('r');
  invariant(await page.evaluate(() => window.__auditSpeech.speak.length), count + 1, 'R outside an editable element replays.');
  const pauses = await page.evaluate(() => window.__auditSpeech.pause); await page.keyboard.press('Space');
  invariant(await page.evaluate(() => window.__auditSpeech.pause), pauses + 1, 'First Space pauses the ongoing utterance.');
  const resumes = await page.evaluate(() => window.__auditSpeech.resume); await page.keyboard.press('Space');
  invariant(await page.evaluate(() => window.__auditSpeech.resume), resumes + 1, 'Second Space resumes the ongoing utterance.');
  await submit(page, item.original); invariant((await state(page)).session.result.correct, true, 'Enter submits the answer.');
  await page.keyboard.press('Enter'); invariant(await currentId(page), entries[1].id, 'Enter after a correct answer advances exactly one item.');
});

test('space-play-focus', '播放按钮获得焦点后 Space 仍可暂停或继续', 'P2', ['点击当前题目播放按钮', '保持按钮焦点并按 Space', '检查是否暂停/继续而非重新开始朗读'], async page => {
  invariant(await page.evaluate(() => window.__auditSpeech.environment), 'controlled-ongoing-utterance', 'Focused-button control evidence is explicitly identified as controlled ongoing speech.');
  await page.locator('#play-main').click();
  const initial = await page.evaluate(() => ({ speaks: window.__auditSpeech.speak.length,
    actions: window.__auditSpeech.pause + window.__auditSpeech.resume }));
  await page.keyboard.press('Space');
  const after = await page.evaluate(() => ({ speaks: window.__auditSpeech.speak.length,
    actions: window.__auditSpeech.pause + window.__auditSpeech.resume }));
  invariant(after.speaks, initial.speaks, 'Space on the focused playback button must not restart the utterance.');
  assert.ok(after.actions > initial.actions, 'Space must pause or resume the current utterance from the focused play control.');
  const resumes = await page.evaluate(() => window.__auditSpeech.resume); await page.keyboard.press('Space');
  invariant(await page.evaluate(() => window.__auditSpeech.resume), resumes + 1, 'Space resumes speech without moving focus away from the play button.');
  invariant(await page.evaluate(() => window.__auditSpeech.speak.length), initial.speaks, 'Resume does not restart the word.');
}, '给当前题目的播放按钮和重听按钮统一 Space 播放/暂停逻辑；保留表单输入的正常空格和其他按钮的原生键盘行为。');

test('fullscreen-escape-state', '沉浸式全屏退出保留练习状态', 'P2', ['填入尚未提交的答案', '进入全屏', '按 Esc', '检查同一题和输入值'], async page => {
  const item = await currentEntry(page); await page.locator('#answer-input').fill('unfinished input');
  await page.locator('#open-fullscreen').click();
  await page.waitForTimeout(120);
  invariant(await page.locator('body').evaluate(el => el.classList.contains('immersive')), true, 'Immersive layout opens.');
  await page.keyboard.press('Escape'); await page.waitForTimeout(500);
  invariant(await page.locator('body').evaluate(el => el.classList.contains('immersive')), false, 'Escape leaves immersive mode.');
  invariant(await currentId(page), item.id, 'Full-screen exit retains the current item.');
  invariant(await page.locator('#answer-input').inputValue(), 'unfinished input', 'Full-screen exit retains unsubmitted input.');
});

test('fullscreen-from-library', '从词库进入全屏后恢复页面位置及纠错锁', 'P2', ['从词库第二页进入全屏', '按 Esc 恢复列表和滚动位置', '答错后再全屏并退出', '检查纠错锁'], async page => {
  await view(page, 'library'); await page.locator('#library-pager [data-page="next"]').click();
  await page.locator('#library-list').evaluate(el => el.scrollIntoView());
  const scrollY = await page.evaluate(() => window.scrollY), item = await currentEntry(page);
  // Focus without scrolling, then use a real keyboard activation so the
  // Fullscreen API receives a gesture while the prior scroll remains intact.
  await page.locator('#open-fullscreen').evaluate(el => el.focus({ preventScroll: true }));
  await page.keyboard.press('Enter'); await page.waitForTimeout(100);
  await page.keyboard.press('Escape'); await page.waitForTimeout(100);
  invariant(await page.locator('#library-view').isVisible(), true, 'Escape restores the view from which fullscreen was opened.');
  invariant(await page.locator('#library-pager').innerText().then(text => /第 2 \/ 26 页/.test(text)), true, 'The library page remains selected.');
  assert.ok(Math.abs(await page.evaluate(() => window.scrollY) - scrollY) <= 2, 'Fullscreen exit restores the previous scroll position.');
  await view(page, 'practice'); await submit(page, 'audit-wrong-fullscreen');
  await page.locator('#open-fullscreen').click(); await page.keyboard.press('Escape'); await page.waitForTimeout(100);
  invariant(await currentId(page), item.id, 'Fullscreen retains the locked item.');
  invariant(await page.locator('#next').isDisabled(), true, 'Fullscreen exit does not bypass correction.');
  await submit(page, item.original);
});

test('stats-days-chart-filters', '每日统计、自然日曲线、空白日期及筛选', 'P1', ['导入基于真实词条的多日测试记录', '核对概览和每天统计', '切换 7 天/30 天/全部', '按模式、分类、日期筛选'], async page => {
  const sample = await syntheticBackup(page); await importBackup(page, sample.backup);
  const stats = await statValues(page);
  invariant(stats['独立作答'].value, '6', 'Synthetic six independent answers exclude one correction and one flip.');
  invariant(stats['独立作答'].detail, '正确 4 次 · 错误 2 次', 'Correct and wrong counts match independently computed totals.');
  invariant(stats['正确率'].value, '67%', 'Overall accuracy uses only independent answers.');
  invariant(stats['连续学习'].value, '2 天', 'Consecutive days stop at the missing date.');
  invariant(stats['练习时长'].value, '34 秒', 'Activity duration includes correction and flashcard activity.');
  const rows = await dailyRows(page);
  invariant(rows.length, 6, 'Only practiced dates appear in the daily table.');
  invariant(rows.find(row => row[0] === sample.dateKeys[0]).slice(1), ['2', '1', '1', '50%', '1', '0', '9 秒', '2'], 'Today separates attempts, correction and distinct entries.');
  invariant(rows.find(row => row[0] === sample.dateKeys[9])[4], '—', 'Flip-only dates have no artificial zero accuracy.');
  assert.match(await page.locator('#chart-summary').innerText(), new RegExp(sample.dateKeys[29] + ' 至 ' + sample.dateKeys[0]), 'Default chart spans the most recent 30 calendar days.');
  invariant(await page.locator('#accuracy-chart .chart-point').count(), 4, 'Thirty-day chart excludes old and non-answer-only days.');
  await page.locator('[data-range="7"]').click();
  assert.match(await page.locator('#chart-summary').innerText(), new RegExp(sample.dateKeys[6] + ' 至 ' + sample.dateKeys[0]), 'Seven-day range uses seven calendar days, not seven active dates.');
  invariant(await page.locator('#accuracy-chart .chart-point').count(), 3, 'Seven-day range retains only its three active answer dates.');
  const labels = await page.locator('#accuracy-chart .chart-point').evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label')));
  assert.ok(labels.every(label => !label.startsWith(sample.dateKeys[2])), 'Missing days produce no data point.');
  const segments = await page.locator('#accuracy-chart .chart-line').evaluateAll(nodes => nodes.map(n => n.getAttribute('points').trim().split(/\s+/).length));
  invariant(segments.sort(), [1, 2], 'Lines do not bridge the no-data gap.');
  await page.locator('[data-range="all"]').click(); invariant(await page.locator('#accuracy-chart .chart-point').count(), 5, 'All-record chart includes the older date.');
  await page.locator('#stats-mode-filter').selectOption('listen'); invariant((await statValues(page))['独立作答'].value, '3', 'Mode filter applies to all totals.');
  await page.locator('#clear-stats-filter').click(); await page.locator('#stats-category-filter').selectOption(sample.number.category);
  invariant((await statValues(page))['独立作答'].value, '1', 'Category filter applies to independent answers.');
  await page.locator('#clear-stats-filter').click(); await page.locator('#stats-date-filter').fill(sample.dateKeys[0]); await page.locator('#stats-date-filter').dispatchEvent('change');
  invariant((await statValues(page))['独立作答'].value, '2', 'Date filter uses local calendar dates.');
  await page.locator('#stats-date-filter').fill(sample.dateKeys[2]); await page.locator('#stats-date-filter').dispatchEvent('change');
  invariant((await statValues(page))['正确率'].value, '—', 'Empty filtered dates remain unscored.');
  invariant(await page.locator('#chart-empty').isVisible(), true, 'Empty chart gives a readable no-data state.');
});

test('actual-activity-duration', '真实练习时长入账并排除设置弹窗时间', 'P2', ['实际在输入框停留约2秒', '打开设置停留约2秒', '提交答案', '核对保存的练习时长'], async page => {
  const item = await currentEntry(page);
  await page.locator('#answer-input').focus(); await page.waitForTimeout(2300);
  await page.locator('#open-sound').click(); await page.waitForTimeout(2200);
  await page.locator('#sound-dialog [aria-label="关闭设置"]').click();
  await submit(page, item.original);
  const h = (await state(page)).history[0];
  assert.ok(h.durationMs >= 1500, `The real active practice time must be recorded (${h.durationMs} ms).`);
  assert.ok(h.durationMs < 4500, `Time in the settings dialog must be excluded (${h.durationMs} ms).`);
  await view(page, 'stats');
  assert.notEqual((await statValues(page))['练习时长'].value, '0 秒', 'The observed time appears in statistics.');
});

test('backup-export-import', '导出/导入、取消及持久化保留设置', 'P1', ['导入真实词条测试备份', '导出 JSON', '尝试替换并取消', '刷新页面', '核对声音、错题和记录'], async page => {
  const sample = await syntheticBackup(page); await importBackup(page, sample.backup);
  const downloadPromise = page.waitForEvent('download'); await page.locator('#export-progress').click();
  const download = await downloadPromise, file = await download.path();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  invariant(saved.dataset, '1533', 'Export identifies the full dataset.');
  invariant(saved.history, sample.backup.history, 'Export preserves complete event history.');
  invariant(saved.settings.target, 4, 'Export preserves the selected removal threshold.');
  invariant(saved.settings.rate, 1.1, 'Export preserves speech rate.');
  const replacement = structuredClone(sample.backup); replacement.history = []; replacement.records = {}; replacement.settings.target = 10;
  await importBackup(page, replacement, false);
  invariant((await state(page)).history.length, sample.backup.history.length, 'Canceling import keeps current records.');
  await page.reload();
  const s = await state(page);
  invariant(s.history.length, sample.backup.history.length, 'History survives browser refresh.');
  invariant([s.settings.rate, s.settings.pitch, s.settings.volume, s.settings.target], [1.1, 1.2, 0.6, 4], 'All speech controls and target are persistent.');
  invariant(s.records[sample.regular[0].id].marked, true, 'Bookmark survives refresh.');
  invariant(s.records[sample.regular[1].id].inMistakes, true, 'Mistake collection survives refresh.');
});

test('invalid-backup-rejected', '损坏、跨词库和非法记录不会覆盖学习数据', 'P2', ['准备一份正常备份', '分别导入坏 JSON、错误版本、未知 ID、负次数和错误字段类型', '检查拒绝提示和数据保留'], async page => {
  const sample = await syntheticBackup(page); await importBackup(page, sample.backup);
  const invalids = ['{not json}', { ...sample.backup, dataset: '10' }, { ...sample.backup, version: 1 },
    { ...sample.backup, history: [...sample.backup.history, { ...sample.backup.history[0], id: 'unknown-id' }] },
    { ...sample.backup, records: { [sample.regular[0].id]: { ...blankRecord(), correct: -1 } } },
    { ...sample.backup, history: [{ ...sample.backup.history[0], durationMs: -1 }] },
    { ...sample.backup, history: [{ ...sample.backup.history[0], correction: 'false' }] }];
  for (const bad of invalids) {
    await rejectBackup(page, bad);
    invariant((await state(page)).history, sample.backup.history, 'Rejected backup leaves current learning history intact.');
  }
}, '导入时校验 correction 布尔字段与其他学习字段，非法类型应拒绝，而不是改变正确率语义。');

test('malformed-records-rejected', '备份 records 结构和标记字段类型校验', 'P2', ['导入 records 为数字的备份', '导入词条记录为数组的备份', '导入标记和错题字段为字符串的备份'], async page => {
  const sample = await syntheticBackup(page); await importBackup(page, sample.backup);
  const bad = [
    { ...sample.backup, records: 123 },
    { ...sample.backup, records: { [sample.regular[0].id]: [] } },
    { ...sample.backup, records: { [sample.regular[0].id]: { ...blankRecord(), marked: 'true' } } },
    { ...sample.backup, records: { [sample.regular[0].id]: { ...blankRecord(), inMistakes: 'false' } } }
  ];
  for (const backup of bad) {
    await rejectBackup(page, backup);
    invariant((await state(page)).history, sample.backup.history, 'Malformed records cannot replace current learning data.');
  }
}, '严格要求 records 是普通对象、每条记录是普通对象，seen/marked/inMistakes 只能使用布尔值；类型损坏时拒绝导入。');

test('reset-cancel-settings', '重置取消、确认重置并保留声音设置', 'P2', ['导入正常备份', '取消重置', '确认重置', '检查全新记录与声音设置'], async page => {
  const sample = await syntheticBackup(page); await importBackup(page, sample.backup);
  await page.locator('#reset-progress').click(); await page.locator('#cancel-confirm').click();
  invariant((await state(page)).history.length, sample.backup.history.length, 'Cancel reset keeps the history.');
  await page.locator('#reset-progress').click(); await page.locator('#accept-confirm').click();
  const s = await state(page);
  invariant(s.history, [], 'Confirmed reset removes history.');
  assert.ok(Object.values(s.records).every(r => !r.seen && !r.marked && !r.inMistakes && !r.attempts), 'Confirmed reset removes progress, bookmarks and mistakes.');
  invariant(s.settings.target, 4, 'Reset retains the target setting.');
  invariant(s.settings.rate, 1.1, 'Reset retains speech settings.');
});

test('offline-practice-chart', '离线启动文件页与离线作答、统计图表', 'P1', ['断开外网连接', '直接文件打开或保留已加载页面', '独立作答一题', '打开统计曲线'], async page => {
  await page.context().setOffline(true);
  const item = await currentEntry(page); await submit(page, item.original);
  invariant((await state(page)).session.result.correct, true, 'Offline answer validation remains local.');
  await view(page, 'stats');
  invariant((await statValues(page))['独立作答'].value, '1', 'Offline statistics read the local learning history.');
  invariant(await page.locator('#accuracy-chart .chart-point').count(), 1, 'Offline chart renders from the local SVG code.');
  invariant(await page.locator('#chart-empty').isVisible(), false, 'The chart does not depend on an external CDN.');
});

async function startServer() {
  server = http.createServer((req, res) => {
    let relative;
    try { relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch (_) { res.writeHead(400); res.end(); return; }
    const target = path.resolve(root, '.' + (relative === '/' ? '/index.html' : relative));
    if (!target.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' }[path.extname(target)] || 'application/octet-stream';
    fs.readFile(target, (error, contents) => {
      if (error) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(contents);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}/`;
}
async function prepareContext(transport, url, auditCase) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1040 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  if (auditCase.id === 'offline-practice-chart' && transport === 'file') await context.setOffline(true);
  await context.addInitScript(({ controlledSpeech }) => {
    window.__auditSpeech = { speak: [], pause: 0, resume: 0, cancel: 0, pausedState: false,
      environment: controlledSpeech ? 'controlled-ongoing-utterance' : 'native-observation' };
    if (!window.speechSynthesis) return;
    if (controlledSpeech) {
      // Clearly bounded control test: the OS voice service can immediately fail
      // in a headless process, which provides no in-progress utterance to pause.
      // Native SpeechSynthesisUtterance objects are retained, but only the queue
      // state and its start event are simulated for these two shortcut tests.
      Object.defineProperty(speechSynthesis, 'paused', { configurable: true, get: () => window.__auditSpeech.pausedState });
      Object.defineProperty(speechSynthesis, 'speaking', { configurable: true, get: () => Boolean(window.__auditSpeech.current) });
      speechSynthesis.cancel = () => {
        window.__auditSpeech.cancel++; window.__auditSpeech.current = null; window.__auditSpeech.pausedState = false;
      };
    }
    for (const name of ['speak', 'pause', 'resume']) {
      const original = speechSynthesis[name].bind(speechSynthesis);
      speechSynthesis[name] = (...values) => {
        if (name === 'speak') window.__auditSpeech.speak.push({ text: values[0].text, lang: values[0].lang,
          rate: values[0].rate, pitch: values[0].pitch, volume: values[0].volume });
        else window.__auditSpeech[name]++;
        if (controlledSpeech) {
          if (name === 'speak') {
            window.__auditSpeech.current = values[0]; window.__auditSpeech.pausedState = false;
            queueMicrotask(() => values[0].onstart?.({ type: 'start' }));
          } else window.__auditSpeech.pausedState = name === 'pause';
          return;
        }
        // All other cases observe and call the original browser method.
        return original(...values);
      };
    }
  }, { controlledSpeech: controlledSpeechCases.has(auditCase.id) });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') logs.push({ transport, text: message.text() }); });
  await page.goto(url, { waitUntil: 'load' });
  await page.locator('#answer-input').waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await page.evaluate(() => window.LISTENING_DATA.items.length), 1533);
  {
    const browserDataHash = await page.evaluate(async () => {
      const bytes = new TextEncoder().encode(JSON.stringify(window.LISTENING_DATA.items));
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
    });
    invariant(browserDataHash, crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
      'Browser-loaded vocabulary and JSON contain identical complete entries.');
  }
  return { context, page, pageErrors };
}
function failureMessage(error) {
  return { message: error.message, actual: error.actual, expected: error.expected, stack: error.stack?.split('\n').slice(0, 5).join('\n') };
}
function writeReports() {
  report.completedAt = new Date().toISOString();
  report.fileHashesAtEnd = evidenceHashes();
  report.filesChangedDuringAudit = JSON.stringify(report.fileHashesAtEnd) !== JSON.stringify(report.fileHashesAtStart);
  report.summary = { passed: report.cases.filter(c => c.status === 'passed').length, failed: report.cases.filter(c => c.status === 'failed').length,
    caseCount: report.cases.length, openIssues: report.issues.length };
  report.consoleErrors = logs;
  fs.writeFileSync(path.join(reportDir, `audit-flows${suffix}.json`), JSON.stringify(report, null, 2) + '\n', 'utf8');
  const body = ['# 功能流程实际浏览器审核', '',
    `运行时间：${report.generatedAt} 至 ${report.completedAt}`, `词库条目：${entries.length}；正式数据：是`,
    `浏览器：Chrome ${report.browser.version || ''}；模式：${headed ? '有窗口' : '无窗口实际浏览器渲染'}；打开方式：http 与 file`,
    `结果：${report.summary.passed} 项通过，${report.summary.failed} 项失败。`, '',
    '文件 SHA-256（本轮审核末尾）：', '',
    ...Object.entries(report.fileHashesAtEnd).map(([file, hash]) => `- ${file}：\`${hash}\``), '',
    `审核期间文件变化：${report.filesChangedDuringAudit ? '有；需结合具体文件变化重新核验' : '无'}`, '',
    '多日统计测试只合成学习记录，使用真实词条 ID；不把测试记录写入网页词库。controlledSpeechCases 明确列出受控语音场景，用于检查快捷键、重复次数和取消流程，不证明实际可听输出；其他场景保留原生语音调用。实际原生声音与失败反馈另见 audit_speech 报告。', '',
    '| 打开方式 | 测试 | 语音环境 | 结果 | 截图 |', '| --- | --- | --- | --- | --- |',
    ...report.cases.map(c => `| ${c.transport} | ${c.title} | ${c.speechEnvironment === 'controlled-ongoing-utterance' ? '受控持续朗读' : '原生语音'} | ${c.status === 'passed' ? '通过' : '失败'} | ${c.screenshot || '无'} |`), '', '## 具体问题', ''];
  if (!report.issues.length) body.push('本轮未发现可复现的功能异常。');
  for (const issue of report.issues) body.push(`### ${issue.severity} · ${issue.title}（${issue.transport}）`, '',
    `复现：${issue.steps.join(' → ')}。`, `预期：${JSON.stringify(issue.failure.expected) || '满足测试中注明的行为。'}`,
    `实际：${JSON.stringify(issue.failure.actual) || issue.failure.message}`, `错误证据：${issue.failure.message}`,
    `建议：${issue.suggestion}`, `截图：${issue.screenshot}`, '');
  fs.writeFileSync(path.join(reportDir, `audit-flows${suffix}.md`), body.join('\n') + '\n', 'utf8');
}

(async () => {
  try {
    const httpUrl = explicitUrl || await startServer();
    browser = await chromium.launch({ ...auditLaunch(), args: ['--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'] });
    report.browser.version = browser.version();
    for (const [transport, url] of [['http', httpUrl], ['file', pathToFileURL(path.join(root, 'index.html')).href]]) {
      if (transportOption && transport !== transportOption) continue;
      for (const c of cases.filter(c => !only || only.includes(c.id))) {
        const result = { id: c.id, title: c.title, transport, url,
          speechEnvironment: controlledSpeechCases.has(c.id) ? 'controlled-ongoing-utterance' : 'native-observation',
          startedAt: new Date().toISOString(), status: 'running' };
        let instance;
        try {
          instance = await prepareContext(transport, url, c);
          await c.run(instance.page);
          invariant(instance.pageErrors, [], 'No JavaScript runtime errors occur in the tested flow.');
          result.status = 'passed';
        } catch (error) {
          result.status = 'failed'; result.failure = failureMessage(error);
        }
        if (instance) {
          result.screenshot = `screenshots/audit-flows${suffix}-${transport}-${c.id}.png`;
          try { await instance.page.screenshot({ path: path.join(reportDir, result.screenshot), fullPage: true }); }
          catch (error) { result.screenshotError = error.message; }
          await instance.context.close();
        }
        result.completedAt = new Date().toISOString(); report.cases.push(result);
        if (result.status === 'failed') report.issues.push({ id: c.id, title: c.title, transport, severity: c.severity,
          steps: c.steps, failure: result.failure, suggestion: c.suggestion, screenshot: result.screenshot });
        writeReports();
        console.log(JSON.stringify({ transport, id: c.id, status: result.status, failure: result.failure?.message }));
      }
    }
  } catch (error) {
    report.fatal = failureMessage(error); process.exitCode = 2;
  } finally {
    writeReports(); if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve));
  }
  if (report.issues.length) process.exitCode = 1;
  console.log(JSON.stringify(report.summary));
})();
