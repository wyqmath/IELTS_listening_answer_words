(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const vocabulary = window.LISTENING_DATA;
  const entries = vocabulary?.items;
  if (!Array.isArray(entries) || !entries.length || entries.some(item =>
    !item || ['id', 'original', 'english', 'phonetic', 'category', 'type'].some(key => typeof item[key] !== 'string' || !item[key].trim()) ||
    ['__proto__', 'constructor', 'prototype'].includes(item.id) || !Array.isArray(item.meanings) ||
    item.meanings.some(meaning => !meaning || typeof meaning.pos !== 'string' || typeof meaning.zh !== 'string') ||
    !Array.isArray(item.acceptedAnswers) || !item.acceptedAnswers.length || item.acceptedAnswers.some(answer => typeof answer !== 'string' || !answer.trim()) ||
    !Array.isArray(item.synonyms) || item.synonyms.some(synonym => !synonym || typeof synonym.english !== 'string')) || new Set(entries.map(item => item.id)).size !== entries.length) {
    $('study-card').textContent = '词库未能加载，请将整个文件夹保留在一起后重新打开。';
    return;
  }
  const byId = new Map(entries.map(item => [item.id, item]));
  // A separate identity prevents records from being mixed when a user replaces the word list.
  const identityText = JSON.stringify(entries.map(item => [item.id, item.original]));
  let identityHash = 2166136261;
  for (let i = 0; i < identityText.length; i++) identityHash = Math.imul(identityHash ^ identityText.charCodeAt(i), 16777619);
  const datasetId = typeof vocabulary.datasetId === 'string' && vocabulary.datasetId.trim() ? vocabulary.datasetId :
    `vocab-${(identityHash >>> 0).toString(16)}`;
  const storageKey = datasetId === '1533' ? 'tingjian.full.v2' : `tingjian.v2.${datasetId}`;
  const defaults = { voice: '', rate: 0.85, pitch: 1, volume: 1, target: 3, autoSpeak: false,
    repeats: 1, hintChinese: false, hintPhonetic: false };
  function readSettings(value, base = defaults) {
    const s = value && typeof value === 'object' ? value : {}, next = { ...base };
    if (typeof s.voice === 'string') next.voice = s.voice;
    for (const [name, min, max] of [['rate', .1, 10], ['pitch', .5, 1.5], ['volume', 0, 1]]) {
      if (Number.isFinite(s[name])) next[name] = Math.min(max, Math.max(min, s[name]));
    }
    if ([1, 2, 3, 4, 5, 10].includes(s.target)) next.target = s.target;
    if (Number.isInteger(s.repeats)) next.repeats = Math.max(1, Math.min(10, s.repeats));
    for (const name of ['autoSpeak', 'hintChinese', 'hintPhonetic']) next[name] = s[name] === true;
    return next;
  }
  const blankRecord = () => ({ seen: false, marked: false, inMistakes: false, attempts: 0,
    correct: 0, wrong: 0, streak: 0, corrections: 0, lastPracticed: null });
  let settings = { ...defaults }, records = {}, history = [], persistenceOK = true, savedSession = null;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (saved && typeof saved === 'object') {
      settings = readSettings(saved.settings);
      savedSession = saved.session;
      for (const item of entries) {
        const r = saved.records?.[item.id];
        if (!r || typeof r !== 'object') continue;
        const record = blankRecord();
        for (const key of ['seen', 'marked', 'inMistakes']) record[key] = r[key] === true;
        for (const key of ['attempts', 'correct', 'wrong', 'streak', 'corrections']) {
          record[key] = Number.isSafeInteger(r[key]) && r[key] >= 0 ? r[key] : 0;
        }
        record.lastPracticed = typeof r.lastPracticed === 'string' ? r.lastPracticed : null;
        record.attempts = record.correct + record.wrong;
        records[item.id] = record;
      }
      if (Array.isArray(saved.history)) history = saved.history.filter(h =>
        h && byId.has(h.id) && typeof h.correct === 'boolean' && Number.isFinite(new Date(h.at).getTime()));
    }
  } catch (_) { /* If an old save is unreadable, start a fresh in-memory session. */ }
  const recordFor = id => records[id] || (records[id] = blankRecord());
  const current = { view: 'practice', mode: 'listen', pool: 'all', category: 'all',
    ids: [], cursor: 0, result: null, flipped: false, hints: { chinese: null, phonetic: null },
    activeMs: 0, lastActivityAt: Date.now() };
  let statsRange = '30', libraryPage = 0, mistakesPage = 0;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const typeNames = { word: '单词', phrase: '短语', name: '专名', code: '编号',
    number: '数字', time: '时间', date: '日期' };
  const categories = [...new Set(entries.map(x => x.category))];
  let toastTimer, voices = [], utterance, speechGeneration = 0, speechTimer, repeatTimer, speechSequence,
    confirmAction, immersiveReturn = null;
  const synthesis = window.speechSynthesis;
  const speechAvailable = Boolean(synthesis && window.SpeechSynthesisUtterance);
  if (settings.voice === 'local-backup') settings.voice = '';
  const correctionLocked = () => Boolean(current.result && !current.result.correct);
  const editableTarget = target => target && (target.matches?.('input, textarea, select') || target.isContentEditable);

  function save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ version: 2, dataset: datasetId, settings, records, history,
        session: { mode: current.mode, pool: current.pool, category: current.category, ids: current.ids,
          cursor: current.cursor, result: current.result, flipped: current.flipped, hints: current.hints } }));
      persistenceOK = true;
    } catch (_) { persistenceOK = false; }
    $('save-status').textContent = persistenceOK ? '' : '本次记录未能保存，请在统计页导出备份';
    $('save-status').hidden = persistenceOK;
  }
  function toast(message) {
    clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2700);
  }
  function totals() {
    return entries.reduce((a, item) => {
      const r = recordFor(item.id);
      a.seen += Number(r.seen); a.attempts += r.attempts; a.correct += r.correct;
      a.wrong += r.wrong; a.mistakes += Number(r.inMistakes);
      return a;
    }, { seen: 0, attempts: 0, correct: 0, wrong: 0, mistakes: 0 });
  }
  function inPool(item) {
    const r = recordFor(item.id);
    if (current.category !== 'all' && item.category !== current.category) return false;
    return current.pool === 'all' || (current.pool === 'mistakes' && r.inMistakes) ||
      (current.pool === 'marked' && r.marked) || (current.pool === 'unseen' && !r.seen);
  }
  function startSession(options = {}) {
    if (correctionLocked()) { toast('请先把当前答案拼写正确'); return; }
    stopSpeech();
    current.ids = entries.filter(inPool).map(x => x.id);
    if (options.shuffle) {
      for (let i = current.ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [current.ids[i], current.ids[j]] = [current.ids[j], current.ids[i]];
      }
    }
    current.cursor = options.id ? Math.max(0, current.ids.indexOf(options.id)) : 0;
    current.result = null; current.flipped = false; resetHints(); current.activeMs = 0; current.lastActivityAt = Date.now();
    $('answer-input').value = '';
    render(); save();
  }
  function currentItem() { return byId.get(current.ids[current.cursor]); }
  function changeView(view) {
    if (correctionLocked() && view !== 'practice') { toast('请先完成当前题的纠错'); return; }
    closeOptions(); stopSpeech(); current.view = view;
    current.lastActivityAt = Date.now(); render();
  }
  function jumpToItem(id) {
    if (correctionLocked()) { toast('请先完成当前题的纠错'); return; }
    current.pool = 'all'; current.category = 'all'; current.view = 'practice';
    $('pool-select').value = 'all'; $('category-select').value = 'all';
    startSession({ id });
    $('study-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function navigate(delta) {
    if (correctionLocked()) { toast('请先把当前答案拼写正确'); return; }
    closeOptions(); stopSpeech();
    const n = current.ids.length;
    let next = null;
    for (let step = 1; step <= n; step++) {
      const index = (current.cursor + delta * step + n * 2) % n;
      const item = byId.get(current.ids[index]);
      if (item && inPool(item)) { next = index; break; }
    }
    if (next === null) {
      startSession();
      return;
    }
    const wrapped = delta > 0 && next <= current.cursor;
    current.cursor = next; current.result = null; current.flipped = false; resetHints(); current.activeMs = 0; current.lastActivityAt = Date.now();
    $('answer-input').value = ''; render(); save();
    if (wrapped) toast('本轮已过完，继续巩固一轮');
    $(current.mode === 'flashcard' ? 'replay' : 'answer-input').focus({ preventScroll: true });
    if (settings.autoSpeak) speakCurrent();
  }
  function resetHints() { current.hints = { chinese: null, phonetic: null }; }
  function hintShown(kind) {
    return current.hints[kind] ?? settings[kind === 'chinese' ? 'hintChinese' : 'hintPhonetic'];
  }
  function renderHints(item) {
    const hints = [];
    for (const kind of ['chinese', 'phonetic']) {
      const primary = current.mode === kind || (current.mode === 'flashcard' && current.flipped);
      const shown = primary || hintShown(kind), button = $('hint-' + kind);
      button.disabled = !item || primary;
      button.setAttribute('aria-pressed', String(Boolean(item && shown)));
      button.classList.toggle('selected', Boolean(item && shown));
      button.title = primary ? '当前模式已经显示此提示' : '只切换本题提示，下一题恢复默认设置';
      if (item && shown && !primary) {
        const text = kind === 'chinese' ? (meaningText(item) || item.english || item.original) : item.phonetic;
        hints.push(`<div class="question-hint ${kind === 'phonetic' ? 'hint-ipa' : ''}"><span>${kind === 'chinese' ? (meaningText(item) ? '中文' : '英文读法') : '音标'}</span><div>${esc(text)}</div></div>`);
      }
    }
    $('default-chinese').checked = settings.hintChinese;
    $('default-phonetic').checked = settings.hintPhonetic;
    $('question-hints').innerHTML = hints.join(''); $('question-hints').hidden = !hints.length;
  }

  function normalize(answer, item) {
    let value = String(answer).normalize('NFKC').toLowerCase().trim()
      .replace(/[’‘]/g, "'").replace(/[‐‑‒–—]/g, '-').replace(/([a-z])-(?=[a-z])/g, '$1 ').replace(/\s+/g, ' ')
      .replace(/\s*%\s*/g, '%');
    if (item.type === 'code') value = value.replace(/\s/g, '');
    return value;
  }
  function meaningText(item) {
    if (Array.isArray(item.meanings) && item.meanings.length) {
      return item.meanings.map(entry => `${entry.pos ? entry.pos + ' ' : ''}${entry.zh || ''}`).filter(Boolean).join('；');
    }
    return item.chinese || '';
  }
  function detailsHtml(item) {
    const meanings = (item.meanings || []).map(m => `<li>${m.pos ? `<span class="meaning-pos">${esc(m.pos)}</span>` : ''}${esc(m.zh)}</li>`).join('');
    const synonyms = Array.isArray(item.synonyms) ? item.synonyms.filter(s => s && s.english).map(s =>
      `<div class="synonym-chip"><b>${esc(s.english)}</b>${s.chinese ? ` · ${esc(s.chinese)}` : ''}${s.sense || s.note ? `<small>${esc([s.sense, s.note].filter(Boolean).join(' · '))}</small>` : ''}</div>`).join('') : '';
    const aliases = (item.acceptedAnswers || []).filter(a => a !== item.original);
    return `${meanings ? `<ul class="meaning-list">${meanings}</ul>` : ''}${item.pronunciationNote ? `<p class="pronunciation-note">读音提示：${esc(item.pronunciationNote)}</p>` : ''}${synonyms ? `<section class="synonym-details"><h3>同义替换</h3><div class="synonym-line">${synonyms}<p>学习提示，不计为本题答案。</p></div></section>` : ''}${aliases.length ? `<p>也接受：${aliases.map(esc).join(' / ')}</p>` : ''}`;
  }
  function submitAnswer(event) {
    event?.preventDefault();
    const item = currentItem();
    if (!item || current.mode === 'flashcard') return;
    if (current.result?.correct) return;
    const answer = $('answer-input').value.trim();
    if (!answer) { speakCurrent(); $('answer-input').focus({ preventScroll: true }); return; }
    const correction = correctionLocked();
    const correct = item.acceptedAnswers.some(a => normalize(a, item) === normalize(answer, item));
    const record = recordFor(item.id);
    const now = Date.now();
    const activityMs = current.activeMs;
    current.activeMs = 0;
    current.lastActivityAt = now;
    record.seen = true; record.lastPracticed = new Date(now).toISOString();
    if (correction) record.corrections++; else record.attempts++;
    let removed = false;
    if (correct && !correction) {
      record.correct++;
      if (record.inMistakes) {
        record.streak++;
        if (record.streak >= settings.target) {
          record.inMistakes = false; record.streak = 0; removed = true;
        }
      }
    } else if (!correct && !correction) {
      record.wrong++; record.inMistakes = true; record.streak = 0;
    }
    history.unshift({ id: item.id, answer, correct, correction, mode: current.mode, at: record.lastPracticed, durationMs: activityMs });
    current.result = { answer, correct, removed, correction };
    save(); render();
    if (current.result.correct) $('next').focus({ preventScroll: true });
    else { $('answer-input').focus({ preventScroll: true }); $('answer-input').select(); }
  }
  function toggleMistake(id) {
    if (correctionLocked() && currentItem()?.id === id) { toast('纠错完成后可以手动移出'); return; }
    const record = recordFor(id);
    record.inMistakes = !record.inMistakes; record.streak = 0;
    save(); render(); toast(record.inMistakes ? '已加入错题本' : '已移出错题本，作答记录保留');
  }
  function toggleBookmark(id) {
    const r = recordFor(id); r.marked = !r.marked; save(); render();
    toast(r.marked ? '已标记，可在“已标记”范围中练习' : '已取消标记');
  }

  function render() {
    document.body.dataset.currentView = current.view;
    for (const view of ['practice', 'library', 'mistakes', 'stats']) $(view + '-view').hidden = current.view !== view;
    document.querySelectorAll('[data-view]').forEach(button => {
      const active = button.dataset.view === current.view;
      button.classList.toggle('active', active);
      button.disabled = correctionLocked() && button.dataset.view !== 'practice';
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    const all = totals();
    $('mistake-count').textContent = all.mistakes;
    $('mistake-count').hidden = all.mistakes === 0;
    const poolNames = { all: '全部', mistakes: '错题', marked: '标记', unseen: '未练' };
    $('range-label').textContent = current.pool === 'all' && current.category === 'all' ? '范围' :
      [current.pool !== 'all' ? poolNames[current.pool] : '', current.category !== 'all' ? current.category : ''].filter(Boolean).join(' · ');
    $('mistake-description').textContent = `连续答对 ${settings.target} 次自动移出，也可以手动移除。`;
    $('clear-mistakes').disabled = all.mistakes === 0;
    $('practice-mistakes').disabled = all.mistakes === 0;
    if (current.view === 'practice') renderStudy();
    if (current.view === 'library') renderList('library');
    if (current.view === 'mistakes') renderList('mistakes');
    if (current.view === 'stats') renderStats();
  }
  function renderStudy() {
    const item = currentItem();
    for (const id of ['pool-select', 'category-select', 'shuffle']) $(id).disabled = correctionLocked();
    $('toggle-mistake').disabled = !item || correctionLocked(); $('bookmark').disabled = !item;
    $('previous').disabled = !item || current.ids.length < 2 || correctionLocked();
    renderHints(item);
    $('exercise-area').hidden = !item; $('empty-practice').hidden = Boolean(item);
    document.querySelectorAll('[data-mode]').forEach(button => {
      const active = button.dataset.mode === current.mode;
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
      button.disabled = correctionLocked();
    });
    if (!item) {
      $('card-category').textContent = '练习完成'; $('card-position').textContent = '0 条';
      $('empty-title').textContent = current.pool === 'mistakes' ? '错题本已经空了' : '这个范围暂时没有词条';
      $('empty-description').textContent = '可以切换练习范围。';
      return;
    }
    const record = recordFor(item.id);
    $('card-category').textContent = `${item.category} · ${typeNames[item.type]}`;
    $('card-position').textContent = `第 ${String(current.cursor + 1).padStart(2, '0')} 条`;
    const formal = ['number', 'time', 'date', 'code'].includes(item.type) && !meaningText(item);
    let prompt;
    if (current.mode === 'listen') {
      prompt = '<button type="button" class="play-orb" id="play-main" title="播放 / 重听（Alt+R）" aria-label="朗读当前词条（Alt+R）"><svg viewBox="0 0 40 40" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M8 17v6M16 11v18M24 7v26M32 14v12"/></svg></button>';
    } else if (current.mode === 'chinese') {
      prompt = `<div class="prompt-main ${formal ? '' : 'chinese-prompt'}">${esc(formal ? (item.english || item.original) : meaningText(item))}</div>`;
    } else if (current.mode === 'phonetic') {
      prompt = `<div class="prompt-main ipa">${esc(item.phonetic)}</div>`;
    } else {
      prompt = `<div class="prompt-main">${esc(item.original)}</div>`;
      if (current.flipped) prompt += `<div class="prompt-secondary">${item.english && item.english !== item.original ? esc(item.english) + ' · ' : ''}${esc(item.phonetic)}</div><div class="flashcard-details">${detailsHtml(item)}</div>`;
    }
    $('prompt-area').innerHTML = prompt;
    $('play-main')?.addEventListener('click', speakCurrent);
    const isFlashcard = current.mode === 'flashcard';
    $('study-card').classList.toggle('flashcard-open', isFlashcard && current.flipped);
    $('answer-form').hidden = isFlashcard; $('flashcard-actions').hidden = !isFlashcard;
    $('flip-card').textContent = current.flipped ? '收起答案' : '翻开词卡';
    $('bookmark').classList.toggle('selected', record.marked);
    $('bookmark').setAttribute('aria-pressed', String(record.marked));
    $('bookmark').textContent = record.marked ? '★ 已标记' : '☆ 标记';
    $('toggle-mistake').textContent = record.inMistakes ? '－ 移出错题' : '＋ 加入错题';
    $('toggle-mistake').classList.toggle('selected', record.inMistakes);
    $('replay').hidden = current.mode === 'listen';
    $('answer-input').placeholder = formal ? '输入数字、日期、编号或英文读法…' : '输入英文答案…';
    $('answer-input').disabled = Boolean(current.result?.correct);
    $('check-answer').disabled = Boolean(current.result?.correct);
    $('check-answer').textContent = correctionLocked() ? '纠错 ↵' : '提交 ↵';
    $('next').textContent = current.result?.correct ? '下一条 ↵' : '下一条 →';
    if (current.result?.correct) $('next').setAttribute('aria-keyshortcuts', 'Enter');
    else $('next').removeAttribute('aria-keyshortcuts');
    $('replay').textContent = isFlashcard ? '朗读 ↵' : '朗读';
    $('replay').setAttribute('aria-keyshortcuts', isFlashcard ? 'Enter Alt+R R' : 'Alt+R R');
    $('enter-help').innerHTML = isFlashcard ? '<kbd>Enter</kbd> 朗读当前词卡' : current.result?.correct ?
      '<kbd>Enter</kbd> 下一条' : '<kbd>Enter</kbd> 空白时播放，填好后提交';
    $('input-help').textContent = formal ? '原数字和英文读法均可；例如 12 与 twelve 都正确。' : '冠词、单复数和时态要准确；大小写不影响判分。';
    $('next').disabled = correctionLocked();
    $('result-box').hidden = !current.result || isFlashcard;
    if (current.result && !isFlashcard) {
      const result = current.result;
      let note = result.correct ? (result.correction ? '纠错不计入正确率和连续次数。' : '') : '已加入错题本。';
      if (result.removed) note = `已连续答对 ${settings.target} 次，自动移出错题本。`;
      else if (result.correct && !result.correction && record.inMistakes) note = `错题巩固：已连续答对 ${record.streak}/${settings.target} 次。`;
      $('result-box').classList.toggle('wrong', !result.correct);
      $('result-box').innerHTML = `<div class="result-heading">${result.correct ? (result.correction ? '✓ 纠错完成' : '✓ 正确') : '请拼写正确后继续'}</div><div class="result-answer">${esc(item.original)}<span class="result-ipa">${esc(item.phonetic)}</span></div>${item.english !== item.original ? `<p>英文读法：${esc(item.english)}</p>` : ''}${detailsHtml(item)}${result.correct ? '' : `<p>你的答案：${esc(result.answer)}</p>`}${note ? `<p>${esc(note)}</p>` : ''}`;
    }
  }

  function renderList(kind) {
    let items = kind === 'mistakes' ? entries.filter(item => recordFor(item.id).inMistakes) : entries;
    if (kind === 'library') {
      const query = $('library-search').value.trim().toLowerCase();
      const category = $('library-category').value;
      if (category !== 'all') items = items.filter(item => item.category === category);
      if (query) items = items.filter(item => [item.original, item.english, meaningText(item), item.category, ...(item.synonyms || []).map(s => s.english + ' ' + s.chinese)]
        .some(value => String(value || '').toLowerCase().includes(query)));
    }
    const pages = Math.ceil(items.length / 60);
    const page = Math.min(kind === 'library' ? libraryPage : mistakesPage, Math.max(0, pages - 1));
    if (kind === 'library') libraryPage = page; else mistakesPage = page;
    $(kind + '-pager').innerHTML = `<span>${items.length} 条${pages ? ` · 第 ${page + 1} / ${pages} 页` : ''}</span><div class="button-group"><button class="button outlined" type="button" data-page="previous" ${page === 0 ? 'disabled' : ''}>上一页</button><button class="button outlined" type="button" data-page="next" ${page >= pages - 1 ? 'disabled' : ''}>下一页</button></div>`;
    const container = $(kind === 'library' ? 'library-list' : 'mistake-list');
    if (!items.length) {
      container.innerHTML = `<div class="empty-state"><div class="empty-symbol">${kind === 'mistakes' ? '✓' : '⌕'}</div><h2>${kind === 'mistakes' ? '暂时没有错题' : '没有找到对应词条'}</h2><p>${kind === 'mistakes' ? '答错或手动标记的词，会收在这里。' : '换个关键词试试。'}</p></div>`;
      return;
    }
    container.innerHTML = items.slice(page * 60, (page + 1) * 60).map(item => {
      const r = recordFor(item.id);
      return `<article class="word-row"><div class="word-info"><button class="term-link" data-action="practice-item" data-id="${esc(item.id)}">${esc(item.original)}</button><span class="phonetic">${esc(item.phonetic)}</span><div class="word-meta"><span>${esc(meaningText(item) || item.english)}</span><span>${esc(item.category)} · ${r.attempts ? '作答 ' + r.attempts + ' 次 / 错 ' + r.wrong + ' 次' : '尚未作答'}</span></div>${item.synonyms?.length ? `<div class="list-synonyms">同义：${item.synonyms.slice(0, 3).map(s => esc(s.english)).join(' · ')}</div>` : ''}</div><div class="word-controls">${kind === 'mistakes' ? `<span class="streak-badge">连续答对 ${r.streak}/${settings.target}</span>` : `<button class="text-button ${r.marked ? 'selected' : ''}" data-action="mark" data-id="${esc(item.id)}" aria-label="${r.marked ? '取消标记' : '标记'} ${esc(item.original)}">${r.marked ? '★' : '☆'}</button>`}<button class="text-button" data-action="speak" data-id="${esc(item.id)}" aria-label="朗读 ${esc(item.original)}">朗读</button><button class="button outlined" data-action="mistake" data-id="${esc(item.id)}">${r.inMistakes ? '移出错题' : '加入错题'}</button></div></article>`;
    }).join('');
  }
  function dayKey(value) {
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return '';
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function filteredHistory() {
    const mode = $('stats-mode-filter')?.value || 'all';
    const category = $('stats-category-filter')?.value || 'all';
    const date = $('stats-date-filter')?.value || '';
    return history.filter(h => {
      const item = byId.get(h.id);
      return item && (mode === 'all' || h.mode === mode) && (category === 'all' || item.category === category) && (!date || dayKey(h.at) === date);
    });
  }
  function dailyMap(list) {
    const map = new Map();
    list.forEach(h => {
      const date = dayKey(h.at); if (!date) return;
      const row = map.get(date) || { date, attempts: 0, correct: 0, wrong: 0, corrections: 0, flips: 0, durationMs: 0, ids: new Set() };
      if (h.mode === 'flashcard') row.flips++;
      else if (h.correction) row.corrections++;
      else { row.attempts++; row.correct += Number(h.correct); row.wrong += Number(!h.correct); }
      row.durationMs += Math.max(0, Number(h.durationMs) || 0); row.ids.add(h.id); map.set(date, row);
    });
    return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  }
  function formatDuration(ms) {
    const seconds = Math.round((ms || 0) / 1000);
    return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分${seconds % 60 ? ` ${seconds % 60} 秒` : ''}`;
  }
  function renderChart(rows) {
    const svg = $('accuracy-chart'), empty = $('chart-empty');
    const end = new Date(($('stats-date-filter').value || dayKey(new Date())) + 'T12:00:00');
    const first = new Date(end);
    if (statsRange === 'all' && rows.length) first.setTime(new Date(rows[0].date + 'T12:00:00').getTime());
    else first.setDate(first.getDate() - Number(statsRange === 'all' ? 30 : statsRange) + 1);
    const map = new Map(rows.map(row => [row.date, row])), selected = [];
    for (const date = new Date(first); date <= end; date.setDate(date.getDate() + 1))
      selected.push(map.get(dayKey(date)) || { date: dayKey(date), attempts: 0 });
    const points = selected.map((row, index) => ({ row, index })).filter(x => x.row.attempts);
    svg.innerHTML = '';
    if (!points.length) { empty.hidden = false; $('chart-summary').textContent = '当前时间范围没有独立答题记录。'; return; }
    empty.hidden = true;
    const width = Math.max(300, Math.round(svg.parentElement.clientWidth)), height = width < 600 ? 220 : 260, left = 44, right = 30, top = 18, bottom = 38;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const x = index => selected.length <= 1 ? width / 2 : left + index * (width - left - right) / (selected.length - 1);
    const y = percent => top + (100 - percent) * (height - top - bottom) / 100;
    const ns = 'http://www.w3.org/2000/svg';
    const line = (x1, y1, x2, y2, cls) => { const el = document.createElementNS(ns, 'line'); el.setAttribute('x1', x1); el.setAttribute('y1', y1); el.setAttribute('x2', x2); el.setAttribute('y2', y2); el.setAttribute('class', cls); svg.append(el); };
    [0, 25, 50, 75, 100].forEach(value => { line(left, y(value), width - right, y(value), 'chart-grid'); const label = document.createElementNS(ns, 'text'); label.setAttribute('x', 7); label.setAttribute('y', y(value) + 4); label.setAttribute('class', 'chart-axis'); label.textContent = `${value}%`; svg.append(label); });
    let segment = [];
    const drawSegment = values => {
      if (!values.length) return;
      const poly = document.createElementNS(ns, 'polyline'); poly.setAttribute('points', values.map(p => `${x(p.index)},${y(p.percent)}`).join(' ')); poly.setAttribute('class', 'chart-line'); svg.append(poly);
      values.forEach(p => {
        const circle = document.createElementNS(ns, 'circle'), description = `${p.row.date} · 正确率 ${p.percent}% · ${p.row.correct}/${p.row.attempts} 题`;
        circle.setAttribute('cx', x(p.index)); circle.setAttribute('cy', y(p.percent)); circle.setAttribute('r', 5); circle.setAttribute('class', 'chart-point'); circle.setAttribute('tabindex', '0'); circle.setAttribute('aria-label', description);
        const title = document.createElementNS(ns, 'title'); title.textContent = description; circle.append(title);
        for (const name of ['focus', 'pointerenter', 'click']) circle.addEventListener(name, () => { $('chart-summary').textContent = description; });
        svg.append(circle);
      });
    };
    points.forEach(point => { const percent = Math.round(point.row.correct / point.row.attempts * 100); if (segment.length && point.index !== segment[segment.length - 1].index + 1) { drawSegment(segment); segment = []; } segment.push({ ...point, percent }); }); drawSegment(segment);
    selected.forEach((row, index) => { if (index % Math.max(1, Math.ceil(selected.length / (width < 500 ? 3 : 6))) !== 0 && index !== selected.length - 1) return; const label = document.createElementNS(ns, 'text'); label.setAttribute('x', x(index)); label.setAttribute('y', height - 10); label.setAttribute('class', 'chart-axis chart-date'); label.setAttribute('text-anchor', 'middle'); label.textContent = row.date.slice(5); svg.append(label); });
    $('chart-summary').textContent = `${dayKey(first)} 至 ${dayKey(end)} · 每个点代表当天正确率；空白表示当天没有答题。`;
  }
  function learningStreak(list) {
    const dates = new Set(list.map(h => dayKey(h.at))), date = new Date(); date.setHours(12, 0, 0, 0);
    if (!dates.has(dayKey(date))) date.setDate(date.getDate() - 1);
    let result = 0;
    while (dates.has(dayKey(date))) { result++; date.setDate(date.getDate() - 1); }
    return result;
  }
  function renderStats() {
    const list = filteredHistory(), unique = new Set(list.map(h => h.id));
    const answers = list.filter(h => !h.correction && h.mode !== 'flashcard');
    const attempts = answers.length, correct = answers.filter(h => h.correct).length, wrong = attempts - correct;
    const all = totals(), accuracy = attempts ? Math.round(correct / attempts * 100) + '%' : '—';
    $('stats-grid').innerHTML = [
      ['已练词条', `${unique.size} / ${entries.length}`, '当前筛选范围内出现过的词条'],
      ['独立作答', attempts, `正确 ${correct} 次 · 错误 ${wrong} 次`],
      ['正确率', accuracy, '纠错和翻卡不计入正确率'],
      ['错题待练', all.mistakes, `全词库 · 连续答对 ${settings.target} 次移出`],
      ['连续学习', `${learningStreak(list)} 天`, `筛选内累计学习 ${new Set(list.map(h => dayKey(h.at)).filter(Boolean)).size} 天`],
      ['练习时长', formatDuration(list.reduce((a, h) => a + Math.max(0, Number(h.durationMs) || 0), 0)), '仅统计活跃练习；后台和闲置时间不计']
    ].map(([title, value, detail]) => `<div class="stat-card"><span>${esc(title)}</span><strong>${esc(value)}</strong><p>${esc(detail)}</p></div>`).join('');
    const categoryRows = categories.map(category => {
      const subset = answers.filter(h => byId.get(h.id)?.category === category), n = subset.length, c = subset.filter(h => h.correct).length, percent = n ? Math.round(c / n * 100) : 0;
      return `<div class="category-row"><span>${esc(category)}</span><div class="bar"><span style="width:${percent}%"></span></div><span>${n ? percent + '%' : '未作答'}</span></div>`;
    }).join('');
    $('category-stats').innerHTML = categoryRows;
    const rows = dailyMap(list);
    $('daily-stats').innerHTML = rows.length ? rows.slice().reverse().map(row => `<tr><td>${esc(row.date)}</td><td>${row.attempts}</td><td>${row.correct}</td><td>${row.wrong}</td><td>${row.attempts ? Math.round(row.correct / row.attempts * 100) + '%' : '—'}</td><td>${row.corrections}</td><td>${row.flips}</td><td>${esc(formatDuration(row.durationMs))}</td><td>${row.ids.size}</td></tr>`).join('') : '<tr><td colspan="9" class="small-empty">当前筛选没有记录。</td></tr>';
    $('recent-history').innerHTML = list.length ? list.slice(0, 8).map(h => { const d = new Date(h.at); return `<div class="history-row ${!h.correct && h.mode !== 'flashcard' ? 'wrong' : ''}"><span>${h.mode === 'flashcard' ? '▧' : h.correct ? '✓' : '×'}</span><span>${esc(byId.get(h.id).original)}${h.mode === 'flashcard' ? ' · 翻卡' : h.correction ? ' · 纠错' : ''}</span><time>${esc(Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')}</time></div>`; }).join('') : '<p class="small-empty">提交第一份答案或翻开词卡，这里就会有记录。</p>';
    renderChart(rows);
    document.querySelectorAll('[data-range]').forEach(button => button.classList.toggle('active', button.dataset.range === statsRange));
  }

  function setSpeechStatus(message) {
    $('speech-status').textContent = message; $('settings-speech-status').textContent = message;
  }
  function stopSpeech() {
    speechGeneration++; clearTimeout(speechTimer); clearTimeout(repeatTimer); speechSequence = null;
    if (synthesis) synthesis.cancel();
    utterance = null; $('study-card').classList.remove('playing'); setSpeechStatus('');
  }
  const voiceKey = voice => [voice.name, voice.lang, voice.voiceURI].join('|');
  function selectedVoice() { return voices.find(voice => voiceKey(voice) === settings.voice); }
  function speak(text, repetitions = settings.repeats) {
    stopSpeech();
    current.lastActivityAt = Date.now();
    if (!speechAvailable) { setSpeechStatus('当前浏览器不支持朗读。请用 Chrome 或 Edge 打开。'); return; }
    // Refresh voices here too: some browsers only expose them after a user gesture.
    refreshVoices();
    const generation = speechGeneration, voice = selectedVoice(), sound = { ...settings };
    const count = Math.max(1, Math.min(10, Number.isInteger(repetitions) ? repetitions : 1));
    const sequence = speechSequence = { paused: false, resume: null };
    const play = index => {
      if (generation !== speechGeneration) return;
      if (sequence.paused) { sequence.resume = () => play(index); return; }
      const u = new SpeechSynthesisUtterance(text);
      if (voice) u.voice = voice;
      u.lang = voice?.lang || 'en-GB'; u.rate = sound.rate; u.pitch = sound.pitch; u.volume = sound.volume;
      utterance = u;
      let finished = false;
      const finish = () => {
        if (generation !== speechGeneration || finished) return false;
        finished = true; clearTimeout(speechTimer); $('study-card').classList.remove('playing'); utterance = null;
        return true;
      };
      const fail = message => {
        if (!finish()) return;
        speechSequence = null; clearTimeout(repeatTimer); synthesis.cancel(); setSpeechStatus(message);
      };
      u.onstart = () => {
        if (generation !== speechGeneration || finished) return;
        setSpeechStatus(count > 1 ? `正在播放 ${index + 1} / ${count} 遍` : '');
        $('study-card').classList.add('playing');
      };
      u.onend = () => {
        if (!finish()) return;
        if (index + 1 < count) repeatTimer = setTimeout(() => play(index + 1), 450);
        else { speechSequence = null; setSpeechStatus(''); }
      };
      u.onerror = event => fail(['canceled', 'interrupted'].includes(event.error) ? '' : event.error === 'not-allowed' ?
        '请点击播放按钮，再试一次。' : '浏览器朗读失败，请在声音设置中换一个音色后重试。');
      const checkTimeout = () => {
        if (generation !== speechGeneration || finished) return;
        if (sequence.paused || synthesis.paused) { speechTimer = setTimeout(checkTimeout, 10000); return; }
        fail('浏览器朗读没有响应，请选择其他音色后重试。');
      };
      speechTimer = setTimeout(checkTimeout, Math.max(30000, String(text).length * 500 / sound.rate));
      try { synthesis.speak(u); } catch (_) { fail('浏览器朗读失败，请选择其他音色后重试。'); }
    };
    play(0);
  }
  function toggleSpeechPause() {
    if (!speechSequence) { speakCurrent(); return; }
    if (speechSequence.paused || synthesis.paused) {
      speechSequence.paused = false; synthesis.resume();
      const resume = speechSequence.resume; speechSequence.resume = null; resume?.();
    } else { speechSequence.paused = true; if (utterance) synthesis.pause(); }
  }
  function speakCurrent() { const item = currentItem(); if (item) speak(item.speakText || item.english); }
  function refreshVoices() {
    if (!speechAvailable) {
      $('voice-select').innerHTML = '<option value="">当前浏览器不支持朗读</option>';
      $('voice-select').disabled = true; $('test-voice').disabled = true;
      $('voice-note').textContent = '当前浏览器语音不可用，请用 Chrome 或 Edge 打开。';
      return;
    }
    const available = synthesis.getVoices();
    const english = available.filter(voice => /^en(?:-|_|$)/i.test(voice.lang));
    voices = (english.length ? english : available).slice().sort((a, b) =>
      Number(/^en-GB$/i.test(b.lang)) - Number(/^en-GB$/i.test(a.lang)) || a.name.localeCompare(b.name));
    if (!settings.voice && voices.length) {
      const preferred = voices.find(v => /^en-GB$/i.test(v.lang) && /google/i.test(v.name)) ||
        voices.find(v => /^en-GB$/i.test(v.lang)) || voices.find(v => v.default) || voices[0];
      settings.voice = voiceKey(preferred); save();
    }
    $('voice-select').innerHTML = '<option value="browser-default">浏览器默认英语声音</option>' + voices.map(v =>
      `<option value="${esc(voiceKey(v))}">${esc(v.name)} · ${esc(v.lang)}${v.localService ? ' · 本机' : ''}</option>`).join('');
    $('voice-select').value = selectedVoice() ? settings.voice : 'browser-default';
    $('voice-note').textContent = voices.length ? `找到 ${voices.length} 个浏览器声音。en-GB 为英式口音；部分声音需要联网。可调整语速、音高和音量。` : '暂未读取到浏览器音色，请稍后再打开设置；仍可尝试默认英语声音。';
  }
  function syncSettings() {
    for (const field of ['rate', 'pitch', 'volume']) $(field).value = settings[field];
    $('rate-value').textContent = settings.rate.toFixed(2) + '×';
    $('pitch-value').textContent = settings.pitch.toFixed(1);
    $('volume-value').textContent = Math.round(settings.volume * 100) + '%';
    $('rate-number').value = settings.rate;
    $('playback-repeat').value = settings.repeats;
    $('mistake-target').value = settings.target; $('auto-speak').checked = settings.autoSpeak;
    refreshVoices();
  }
  function closeOptions() {
    for (const id of ['practice-options']) {
      const options = $(id), hadFocus = options.open && options.contains(document.activeElement);
      options.open = false;
      if (hadFocus) options.querySelector('summary').focus({ preventScroll: true });
    }
  }
  function openSettings() { closeOptions(); stopSpeech(); syncSettings(); $('sound-dialog').showModal(); }
  function confirm(title, description, action) {
    confirmAction = action; $('confirm-title').textContent = title;
    $('confirm-text').textContent = description; $('confirm-dialog').showModal();
  }

  for (const category of categories) {
    const option = document.createElement('option'); option.value = category; option.textContent = category;
    $('category-select').append(option);
    const statsOption = option.cloneNode(true); $('stats-category-filter').append(statsOption);
    $('library-category').append(option.cloneNode(true));
  }
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => changeView(button.dataset.view)));
  document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
    if (correctionLocked()) { toast('请先完成当前题的纠错'); return; }
    stopSpeech(); current.mode = button.dataset.mode; current.result = null; current.flipped = false; resetHints();
    current.activeMs = 0; current.lastActivityAt = Date.now();
    $('answer-input').value = ''; render(); save();
    $(current.mode === 'flashcard' ? 'replay' : 'answer-input').focus({ preventScroll: true });
  }));
  $('home-link').addEventListener('click', event => { event.preventDefault(); changeView('practice'); });
  $('answer-form').addEventListener('submit', submitAnswer);
  $('next').addEventListener('click', () => navigate(1));
  $('previous').addEventListener('click', () => navigate(-1));
  $('shuffle').addEventListener('click', () => { startSession({ shuffle: true }); toast('本轮词条已重新排列'); });
  $('replay').addEventListener('click', speakCurrent);
  $('bookmark').addEventListener('click', () => { const item = currentItem(); if (item) toggleBookmark(item.id); closeOptions(); });
  $('toggle-mistake').addEventListener('click', () => { const item = currentItem(); if (item) toggleMistake(item.id); closeOptions(); });
  $('flip-card').addEventListener('click', () => {
    const item = currentItem(); if (!item) return;
    current.flipped = !current.flipped;
    if (current.flipped) {
      const r = recordFor(item.id); r.seen = true; r.lastPracticed = new Date().toISOString();
      history.unshift({ id: item.id, answer: '', correct: false, correction: false, mode: 'flashcard', at: r.lastPracticed, durationMs: current.activeMs });
      current.activeMs = 0;
    }
    render(); save(); $('replay').focus({ preventScroll: true });
  });
  $('pool-select').addEventListener('change', () => { if (correctionLocked()) { toast('请先完成当前题的纠错'); return; } current.pool = $('pool-select').value; startSession(); });
  $('category-select').addEventListener('change', () => { if (correctionLocked()) { toast('请先完成当前题的纠错'); return; } current.category = $('category-select').value; startSession(); });
  $('auto-speak').addEventListener('change', () => { settings.autoSpeak = $('auto-speak').checked; save(); });
  for (const kind of ['chinese', 'phonetic']) {
    $('hint-' + kind).addEventListener('click', () => {
      current.hints[kind] = !hintShown(kind); renderHints(currentItem()); save();
    });
    $('default-' + kind).addEventListener('change', () => {
      settings[kind === 'chinese' ? 'hintChinese' : 'hintPhonetic'] = $('default-' + kind).checked;
      current.hints[kind] = null; renderHints(currentItem()); save();
    });
  }
  $('open-help').addEventListener('click', () => { closeOptions(); stopSpeech(); $('help-dialog').showModal(); });
  $('library-search').addEventListener('input', () => { libraryPage = 0; renderList('library'); });
  $('library-category').addEventListener('change', () => { libraryPage = 0; renderList('library'); });
  for (const kind of ['library', 'mistakes']) $(kind + '-pager').addEventListener('click', event => {
    const button = event.target.closest('[data-page]'); if (!button || button.disabled) return;
    const delta = button.dataset.page === 'next' ? 1 : -1;
    if (kind === 'library') libraryPage += delta; else mistakesPage += delta;
    renderList(kind); $(kind === 'library' ? 'library-list' : 'mistake-list').scrollIntoView({ block: 'start' });
  });
  for (const id of ['library-list', 'mistake-list']) $(id).addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const item = byId.get(button.dataset.id); if (!item) return;
    if (button.dataset.action === 'practice-item') jumpToItem(item.id);
    if (button.dataset.action === 'speak') speak(item.speakText || item.english);
    if (button.dataset.action === 'mistake') toggleMistake(item.id);
    if (button.dataset.action === 'mark') toggleBookmark(item.id);
  });
  $('practice-mistakes').addEventListener('click', () => {
    current.pool = 'mistakes'; current.category = 'all'; current.view = 'practice';
    $('pool-select').value = 'mistakes'; $('category-select').value = 'all'; startSession();
  });
  $('return-all').addEventListener('click', () => {
    current.pool = 'all'; current.category = 'all'; $('pool-select').value = 'all'; $('category-select').value = 'all'; startSession();
  });
  $('clear-mistakes').addEventListener('click', () => confirm('清空当前错题本？', '所有词条与历史作答都会保留，只移除当前的错题标记。', () => {
    entries.forEach(item => { const r = recordFor(item.id); r.inMistakes = false; r.streak = 0; });
    save(); render(); toast('错题本已清空，历史记录保留');
  }));
  $('reset-progress').addEventListener('click', () => confirm('重新开始学习？', '将清除完整词库的作答、标记和错题记录。声音与移出规则保留。', () => {
    records = {}; history = []; current.result = null; save(); startSession(); toast('学习记录已重置');
  }));
  $('cancel-confirm').addEventListener('click', () => { confirmAction = null; $('confirm-dialog').close(); });
  $('accept-confirm').addEventListener('click', () => {
    const action = confirmAction; confirmAction = null; $('confirm-dialog').close(); action?.();
  });
  $('confirm-dialog').addEventListener('cancel', () => { confirmAction = null; });
  $('export-progress').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ version: 2, dataset: datasetId, exportedAt: new Date().toISOString(), settings, records, history }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `听见-${entries.length}词-学习记录.json`; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('import-progress').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', () => {
    const file = $('import-file').files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (!data || data.dataset !== datasetId || data.version !== 2 || !data.records || typeof data.records !== 'object' || Array.isArray(data.records) || !Array.isArray(data.history)) throw new Error('请选择当前词库的学习备份');
        if (Object.keys(data.records).some(id => !byId.has(id)) || data.history.some(h => !h || !byId.has(h.id) || typeof h.correct !== 'boolean' || (h.correction !== undefined && typeof h.correction !== 'boolean') || (h.answer !== undefined && typeof h.answer !== 'string') || !['listen', 'chinese', 'phonetic', 'flashcard'].includes(h.mode) || !Number.isFinite(new Date(h.at).getTime()) || (h.durationMs !== undefined && (!Number.isFinite(h.durationMs) || h.durationMs < 0)))) throw new Error('备份含无效记录');
        const nextRecords = {};
        entries.forEach(item => {
          const saved = data.records[item.id]; if (saved === undefined) return;
          if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('词条记录无效');
          const r = blankRecord(); ['seen', 'marked', 'inMistakes'].forEach(k => {
            if (saved[k] !== undefined && typeof saved[k] !== 'boolean') throw new Error('标记格式无效');
            r[k] = saved[k] === true;
          });
          ['attempts', 'correct', 'wrong', 'streak', 'corrections'].forEach(k => {
            if (saved[k] !== undefined && (!Number.isSafeInteger(saved[k]) || saved[k] < 0)) throw new Error('作答次数无效');
            r[k] = saved[k] || 0;
          });
          r.attempts = r.correct + r.wrong;
          r.lastPracticed = Number.isFinite(new Date(saved.lastPracticed).getTime()) ? saved.lastPracticed : null; nextRecords[item.id] = r;
        });
        const nextHistory = data.history.slice().sort((a, b) => new Date(b.at) - new Date(a.at));
        confirm('导入这份备份？', '将替换当前浏览器的学习记录和设置。可以先取消，再导出当前记录。', () => {
          records = nextRecords; history = nextHistory;
          if (data.settings && typeof data.settings === 'object') {
            settings = readSettings(data.settings, settings);
          }
          current.result = null; current.pool = 'all'; current.category = 'all';
          $('pool-select').value = 'all'; $('category-select').value = 'all'; syncSettings(); startSession(); toast('学习记录已导入');
        });
      } catch (error) { toast(`导入失败：${error.message || '文件格式不正确'}`); }
      $('import-file').value = '';
    };
    reader.readAsText(file, 'utf-8');
  });
  document.querySelectorAll('[data-range]').forEach(button => button.addEventListener('click', () => { statsRange = button.dataset.range; renderStats(); }));
  for (const id of ['stats-mode-filter', 'stats-category-filter', 'stats-date-filter']) $(id).addEventListener('change', renderStats);
  $('clear-stats-filter').addEventListener('click', () => { $('stats-mode-filter').value = 'all'; $('stats-category-filter').value = 'all'; $('stats-date-filter').value = ''; renderStats(); });
  for (const id of ['open-sound', 'sound-shortcut']) $(id).addEventListener('click', openSettings);
  for (const field of ['rate', 'pitch', 'volume']) $(field).addEventListener('input', () => {
    stopSpeech(); settings[field] = Number($(field).value); save(); syncSettings();
  });
  $('rate-number').addEventListener('change', () => {
    const value = Number($('rate-number').value);
    if ($('rate-number').value.trim() && Number.isFinite(value)) {
      stopSpeech(); settings.rate = Math.round(Math.min(10, Math.max(.1, value)) * 20) / 20; save();
    }
    syncSettings();
  });
  $('playback-repeat').addEventListener('change', () => {
    stopSpeech(); settings.repeats = Math.max(1, Math.min(10, Number($('playback-repeat').value) || 1)); save();
  });
  $('voice-select').addEventListener('change', () => { stopSpeech(); settings.voice = $('voice-select').value; save(); refreshVoices(); });
  $('mistake-target').addEventListener('change', () => { settings.target = Number($('mistake-target').value); save(); render(); });
  $('test-voice').addEventListener('click', () => speak('Welcome. Battery. Twelve. Seven forty-five.', 1));
  $('sound-dialog').addEventListener('close', stopSpeech);
  async function toggleFullscreen() {
    if (document.body.classList.contains('immersive')) {
      if (document.fullscreenElement) await document.exitFullscreen(); else finishImmersive();
      return;
    }
    immersiveReturn = { view: current.view, y: window.scrollY }; closeOptions();
    changeView('practice'); document.body.classList.add('immersive'); updateFullscreenButton(); window.scrollTo(0, 0);
    try { await document.documentElement.requestFullscreen(); }
    catch (_) { toast('已进入沉浸布局；当前浏览器未开放系统全屏。'); }
  }
  function updateFullscreenButton() {
    const active = document.body.classList.contains('immersive');
    $('open-fullscreen').textContent = active ? '退出全屏 ⛶' : '全屏 ⛶';
    $('open-fullscreen').setAttribute('aria-pressed', String(active));
  }
  function finishImmersive() {
    closeOptions();
    document.body.classList.remove('immersive'); updateFullscreenButton();
    if (immersiveReturn) {
      const previous = immersiveReturn; immersiveReturn = null;
      if (!correctionLocked()) changeView(previous.view);
      requestAnimationFrame(() => window.scrollTo(0, previous.y));
    }
  }
  $('open-fullscreen').addEventListener('click', toggleFullscreen);
  document.addEventListener('pointerdown', event => {
    for (const id of ['practice-options']) {
      const options = $(id); if (options.open && !options.contains(event.target)) options.open = false;
    }
  });
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) finishImmersive(); });
  document.addEventListener('keydown', event => {
    current.lastActivityAt = Date.now();
    if (event.isComposing || event.keyCode === 229 || document.querySelector('dialog[open]')) return;
    if (event.repeat) {
      if (event.key === 'Enter' && current.view === 'practice') event.preventDefault();
      return;
    }
    if (event.key === 'Escape' && $('practice-options').open) {
      const options = $('practice-options');
      closeOptions(); options.querySelector('summary').focus(); event.preventDefault(); return;
    }
    if (event.key === 'Escape' && document.body.classList.contains('immersive')) {
      event.preventDefault();
      if (document.fullscreenElement) document.exitFullscreen().catch(finishImmersive);
      else finishImmersive();
      return;
    }
    if (current.view !== 'practice' || event.ctrlKey || event.metaKey) return;
    if (event.key.toLowerCase() === 'r' && (event.altKey || (!editableTarget(event.target) && !event.shiftKey))) { event.preventDefault(); speakCurrent(); return; }
    if (event.altKey) return;
    if (event.code === 'Space' && !editableTarget(event.target) && (!event.target.closest?.('button,a,summary,label') || event.target.matches?.('#play-main,#replay'))) { event.preventDefault(); toggleSpeechPause(); return; }
    if (event.key !== 'Enter' || event.shiftKey || !currentItem()) return;
    // Focused controls keep their native Enter behavior; only the answer and page background use practice shortcuts.
    const practiceTarget = event.target === $('answer-input') ||
      (!editableTarget(event.target) && !event.target.closest?.('button,a,summary,label'));
    if (!practiceTarget) return;
    event.preventDefault();
    if (current.mode === 'flashcard') speakCurrent();
    else if (current.result?.correct) navigate(1);
    else submitAnswer();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopSpeech(); });
  window.addEventListener('pagehide', () => { stopSpeech(); save(); });
  document.addEventListener('pointerdown', () => { current.lastActivityAt = Date.now(); }, { passive: true });
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now(), elapsed = Math.max(0, Math.min(2000, now - lastTick)); lastTick = now;
    if (!document.hidden && document.hasFocus() && current.view === 'practice' && currentItem() && !current.result?.correct &&
      now - current.lastActivityAt < 60000 && !document.querySelector('dialog[open]')) current.activeMs += elapsed;
  }, 1000);
  if (window.ResizeObserver) new ResizeObserver(() => { if (current.view === 'stats') renderChart(dailyMap(filteredHistory())); }).observe($('accuracy-chart').parentElement);
  if (speechAvailable) {
    if (synthesis.addEventListener) synthesis.addEventListener('voiceschanged', refreshVoices);
    else synthesis.onvoiceschanged = refreshVoices;
    setTimeout(refreshVoices, 300); setTimeout(refreshVoices, 1200);
  }
  if (savedSession && typeof savedSession === 'object') {
    if (['listen', 'chinese', 'phonetic', 'flashcard'].includes(savedSession.mode)) current.mode = savedSession.mode;
    if (['all', 'mistakes', 'marked', 'unseen'].includes(savedSession.pool)) current.pool = savedSession.pool;
    if (categories.includes(savedSession.category)) current.category = savedSession.category;
    if (Array.isArray(savedSession.ids)) current.ids = [...new Set(savedSession.ids.filter(id => byId.has(id)))];
    if (Number.isInteger(savedSession.cursor) && savedSession.cursor >= 0 && savedSession.cursor < current.ids.length) current.cursor = savedSession.cursor;
    if (currentItem() && savedSession.result && typeof savedSession.result.correct === 'boolean') {
      current.result = { correct: savedSession.result.correct, answer: String(savedSession.result.answer || ''), correction: savedSession.result.correction === true, removed: false };
      $('answer-input').value = current.result.answer;
      if (!current.result.correct) recordFor(currentItem().id).inMistakes = true;
    }
    current.flipped = current.mode === 'flashcard' && savedSession.flipped === true;
    for (const kind of ['chinese', 'phonetic']) {
      if (typeof savedSession.hints?.[kind] === 'boolean') current.hints[kind] = savedSession.hints[kind];
    }
    $('pool-select').value = current.pool; $('category-select').value = current.category;
  }
  syncSettings();
  if (current.ids.length) { render(); save(); } else startSession();
})();
