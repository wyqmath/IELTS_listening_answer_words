/* Independent browser visual / UX audit. Never writes vocabulary or app files. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium, auditLaunch, auditOutput } = require('./playwright_runtime.cjs');
const root = path.resolve(__dirname, '..');
const reportDir = auditOutput();
fs.mkdirSync(reportDir, { recursive: true });
const headed = process.argv.includes('--headed');
const nativeOnly = process.argv.includes('--native-only');
if (headed || nativeOnly) throw new Error('Visible browser tests are disabled by the user. Use the headless visual audit.');
const baseArg = process.argv.find(x => x.startsWith('--url='));
const base = baseArg ? baseArg.slice(6) : 'http://127.0.0.1:11545/';
const tag = 'final';
const report = { audit: 'visual-and-ux', phase: tag, startedAt: new Date().toISOString(), base,
  browser: 'Installed Chrome', headless: !headed, datasetCount: 0, sourceHashes: {},
  checks: [], findings: [], screenshots: [], errors: [], observations: [] };
const sourceFiles = ['index.html', 'app.js', 'styles.css', 'data/vocab.js', 'data/vocab.json'];
for (const filename of sourceFiles) {
  const full = path.join(root, filename);
  if (fs.existsSync(full)) report.sourceHashes[filename] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
}
const data = JSON.parse(fs.readFileSync(path.join(root, 'data/vocab.json'), 'utf8'));
const items = data.items || data;
report.datasetCount = items.length;
const longItem = [...items].sort((a, b) => JSON.stringify({m:b.meanings,s:b.synonyms}).length - JSON.stringify({m:a.meanings,s:a.synonyms}).length)[0];
const longOriginal = [...items].sort((a,b) => b.original.length - a.original.length)[0];
const longIPA = [...items].sort((a,b) => b.phonetic.length - a.phonetic.length)[0];
report.longDetailItem = { id: longItem.id, original: longItem.original, meanings: longItem.meanings?.length, synonyms: longItem.synonyms?.length };
report.longOriginalItem = { id: longOriginal.id, original: longOriginal.original, length: longOriginal.original.length };
report.longIPAItem = {id:longIPA.id,original:longIPA.original,phonetic:longIPA.phonetic,length:longIPA.phonetic.length};
function check(name, passed, evidence, severity = 'P2') {
  report.checks.push({ name, status: passed ? 'pass' : 'fail', evidence });
  if (!passed) report.findings.push({ id: `VIS-${report.findings.length+1}`, severity, title: name, evidence });
}
async function snap(page, name, fullPage = false) {
  const filename = `visual-${tag}-${name}.png`;
  await page.screenshot({ path: path.join(reportDir, filename), fullPage, animations: 'disabled' });
  report.screenshots.push({ name, path: path.join(reportDir, filename), viewport: page.viewportSize(), scroll: await page.evaluate(() => ({x:scrollX,y:scrollY})) });
}
async function snapElement(page,selector,name){
  const filename=`visual-${tag}-${name}.png`;
  await page.locator(selector).screenshot({path:path.join(reportDir,filename),animations:'disabled'});
  report.screenshots.push({name,path:path.join(reportDir,filename),viewport:page.viewportSize(),selector});
}
async function metrics(page) {
  return page.evaluate(() => {
    const visible = el => {
      const s = getComputedStyle(el), b = el.getBoundingClientRect();
      if(s.display==='none'||s.visibility==='hidden'||!b.width||!b.height)return false;
      for(let ancestor=el.parentElement;ancestor;ancestor=ancestor.parentElement)if(ancestor.tagName==='DETAILS'&&!ancestor.open){
        const summary=ancestor.querySelector(':scope>summary');if(el!==summary&&!summary?.contains(el))return false;
      }
      return true;
    };
    return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
      overflow: [...document.querySelectorAll('body *')].filter(visible).map(el => ({
        id:el.id, tag:el.tagName, cls:el.className?.baseVal ?? el.className, text:el.textContent?.trim().slice(0,90),
        left:el.getBoundingClientRect().left, right:el.getBoundingClientRect().right, width:el.getBoundingClientRect().width,
        scrollWidth:el.scrollWidth, clientWidth:el.clientWidth, overflowX:getComputedStyle(el).overflowX
      })).filter(el => el.left < -2 || el.right > innerWidth+2).slice(0,15),
      tinyTargets: [...document.querySelectorAll('button,select,input:not([type=hidden]),a')].filter(visible).filter(el => {
        const b=el.getBoundingClientRect(); return b.height<24 || b.width<24;
      }).map(el => ({id:el.id,text:el.textContent.trim().slice(0,50),width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height})).slice(0,30) };
  });
}
function savedState({mode='listen',id=items[0].id,flipped=false,mistakes=0,stats=false}={}) {
  const records = {}, history = [], now = new Date();
  for (let i=0; i<mistakes; i++) records[items[i].id] = {seen:false,marked:false,inMistakes:true,attempts:0,correct:0,wrong:0,streak:0,corrections:0,lastPracticed:null};
  if (stats) for (let day=0; day<40; day++) {
    if ([3,9,17,23,28].includes(day)) continue;
    const date = new Date(now); date.setDate(now.getDate()-day); date.setHours(12,0,0,0);
    for (let n=0;n<6;n++) {
      const item = items[(day*13+n) % items.length], correct = (n+day)%5 !== 0;
      const record=records[item.id] ||= {seen:true,marked:false,inMistakes:!correct,attempts:0,correct:0,wrong:0,streak:0,corrections:0,lastPracticed:null};
      record.attempts++; record.correct+=Number(correct); record.wrong+=Number(!correct); record.lastPracticed=date.toISOString();
      history.push({id:item.id,answer:correct?item.original:'wrong',correct,correction:false,mode:n%3===0?'chinese':n%3===1?'phonetic':'listen',at:date.toISOString(),durationMs:3800+900*n});
    }
  }
  return {version:2,dataset:'1533',settings:{voice:'',rate:.85,pitch:1,volume:1,target:3,autoSpeak:false},records,history,
    session:{mode,pool:'all',category:'all',ids:items.map(x=>x.id),cursor:Math.max(0,items.findIndex(x=>x.id===id)),result:null,flipped}};
}
let browser;
async function makePage(viewport, seed = {}) {
  const context = await browser.newContext({ viewport, locale:'zh-CN', timezoneId:'Asia/Shanghai', reducedMotion:'reduce' });
  await context.addInitScript(seed => { localStorage.setItem('tingjian.full.v2',JSON.stringify(seed)); }, savedState(seed));
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const failures=[],requests=[];
  page.on('pageerror', e => report.errors.push({viewport,message:e.message}));
  page.on('request',r=>requests.push(r.url()));
  page.on('requestfailed',r=>failures.push({url:r.url(),error:r.failure()?.errorText}));
  page.on('response',r=>{if(r.status()>=400)failures.push({url:r.url(),status:r.status()});});
  await page.goto(base,{waitUntil:'networkidle'});
  await page.locator('#card-position').waitFor();
  const loaded=await page.evaluate(expected=>{
    const actual=window.LISTENING_DATA?.items;
    return{count:actual?.length,hasExercise:!!document.querySelector('#play-main'),
      exactMatch:Array.isArray(actual)&&actual.length===expected.length&&actual.every((row,index)=>JSON.stringify(row)===JSON.stringify(expected[index]))};
  },items);
  check(`dataset-load-exact-frozen-${viewport.width}`,loaded.count===1533&&loaded.hasExercise&&loaded.exactMatch,loaded,'P1');
  check(`page-resources-load-${viewport.width}`,failures.length===0,{requests,failures},'P1');
  return {context,page};
}
async function responsive(width,height) {
  const {context,page}=await makePage({width,height},{id:longItem.id,mistakes:65,stats:true});
  try {
    await snap(page,`${width}-practice-top`);
    check(`homepage-has-no-total-count-${width}`,!await page.evaluate(()=>document.body.innerText.includes('1533')),await page.locator('#card-position').innerText());
    check(`range-closed-by-default-${width}`,!await page.locator('#practice-options').evaluate(el=>el.open)&&!await page.locator('#replay').isVisible(),{range:await page.locator('#practice-options').evaluate(el=>el.open)});
    for(const id of ['bookmark','toggle-mistake','previous','sound-shortcut','open-help']) check(`action-always-visible-${width}-${id}`,await page.locator('#'+id).isVisible(),{id});
    let m=await metrics(page); check(`no-horizontal-overflow-${width}-practice`,m.documentWidth<=m.width+2,m);
    await page.locator('#practice-options>summary').click();
    const rangeRect=await page.locator('.practice-sidebar').boundingBox();
    check(`range-dropdown-fits-width-${width}`,rangeRect.x>=0&&rangeRect.x+rangeRect.width<=width+2,rangeRect);
    check(`range-all-controls-reachable-${width}`,await page.locator('#pool-select').isVisible()&&await page.locator('#category-select').isVisible()&&await page.locator('#shuffle').isVisible(),{pool:await page.locator('#pool-select').isVisible(),category:await page.locator('#category-select').isVisible(),shuffle:await page.locator('#shuffle').isVisible()});
    await snap(page,`${width}-range-menu`);
    await page.locator('#answer-input').click();
    check(`range-menu-closes-outside-${width}`,!await page.locator('#practice-options').evaluate(el=>el.open),await page.locator('#practice-options').evaluate(el=>el.open));
    await page.locator('#open-help').click();
    check(`shortcut-help-opens-${width}`,await page.locator('#input-help').isVisible()&&await page.locator('#input-help').innerText()!=='',{help:await page.locator('.practice-help').innerText()});
    await snap(page,`${width}-shortcut-help`);
    await page.keyboard.press('Escape');
    check(`help-Escape-restores-button-focus-${width}`,!await page.locator('#help-dialog').evaluate(el=>el.open)&&await page.locator('#open-help').evaluate(el=>el===document.activeElement),{focused:await page.evaluate(()=>document.activeElement.id)});
    const form=await page.locator('#answer-input').boundingBox(), button=await page.locator('#check-answer').boundingBox();
    check(`answer-controls-do-not-overlap-${width}`,form.x+form.width<=button.x+1,{form,button});
    await page.locator('#study-card').scrollIntoViewIfNeeded();
    await page.locator('#answer-input').fill('wrong');
    await page.locator('#answer-input').press('Enter');
    const result=await page.locator('#result-box').innerText();
    check(`long-wrong-analysis-${width}`,result.includes(longItem.original) && await page.locator('#next').isDisabled(),{resultLength:result.length,longItem:longItem.original});
    const resultSynonyms=page.locator('#result-box .synonym-details');
    check(`wrong-analysis-synonyms-visible-${width}`,await resultSynonyms.locator('.synonym-chip').first().isVisible()&&await resultSynonyms.locator('summary').count()===0&&await resultSynonyms.locator('.synonym-chip').count()===longItem.synonyms.length,{chips:await resultSynonyms.locator('.synonym-chip').count(),expected:longItem.synonyms.length});
    m=await metrics(page); check(`no-horizontal-overflow-${width}-long-result`,m.documentWidth<=m.width+2,m);
    await snap(page,`${width}-long-wrong`,width>=768);
    await snapElement(page,'#result-box',`${width}-long-analysis-details`);
    await page.locator('#answer-input').fill(longItem.acceptedAnswers[0]); await page.locator('#answer-input').press('Enter');
    await page.locator('[data-view=library]').click();
    m=await metrics(page);check(`no-horizontal-overflow-${width}-library`,m.documentWidth<=m.width+2,m);
    await snap(page,`${width}-library`);
    const before=await page.locator('#library-list .term-link').first().innerText();
    await page.locator('#library-pager [data-page=next]').click();
    const after=await page.locator('#library-list .term-link').first().innerText();
    check(`library-pagination-${width}`,before!==after && (await page.locator('#library-pager').innerText()).includes('第 2'),{before,after,pager:await page.locator('#library-pager').innerText()});
    await page.waitForTimeout(300);
    const firstRow=await page.locator('#library-list .word-row').first().boundingBox();
    check(`library-next-page-start-visible-${width}`,firstRow.y>=-2&&firstRow.y<height,{firstRow,viewportHeight:height,firstTerm:after,scrollY:await page.evaluate(()=>scrollY)});
    if(firstRow.y<-2) Object.assign(report.findings.at(-1),{reproduction:'Open vocabulary; scroll down all 60 rows to the pager; click Next page.',expected:'New page begins at its first word row.',actual:'New page remains scrolled far below its first row.',recommendation:'After renderList on pagination, scroll the corresponding list start into view (honor reduced motion).'});
    await snap(page,`${width}-library-pager`);
    await page.locator('#library-search').fill(longOriginal.original);
    const count=await page.locator('#library-list .term-link').count();
    check(`long-title-search-${width}`,count>0,{original:longOriginal.original,count});
    m=await metrics(page);check(`no-horizontal-overflow-${width}-long-title`,m.documentWidth<=m.width+2,m);
    await page.locator('[data-view=mistakes]').click();
    await page.locator('#mistakes-pager [data-page=next]').click();
    check(`mistakes-pagination-${width}`,(await page.locator('#mistakes-pager').innerText()).includes('第 2'),{pager:await page.locator('#mistakes-pager').innerText(),visibleRows:await page.locator('#mistake-list .word-row').count()});
    await page.waitForTimeout(300);
    const firstMistake=await page.locator('#mistake-list .word-row').first().boundingBox();
    check(`mistakes-next-page-start-visible-${width}`,firstMistake.y>=-2&&firstMistake.y<height,{firstRow:firstMistake,viewportHeight:height,scrollY:await page.evaluate(()=>scrollY)});
    if(firstMistake.y<-2) Object.assign(report.findings.at(-1),{reproduction:'Have more than 60 mistakes; open mistake list; scroll to pager; click Next page.',expected:'New page begins at its first mistake row.',actual:'New page stays near its bottom.',recommendation:'Scroll mistake-list start into view after changing page.'});
    m=await metrics(page);check(`no-horizontal-overflow-${width}-mistakes`,m.documentWidth<=m.width+2,m);
    await snap(page,`${width}-mistakes`);
    await page.locator('[data-view=stats]').click();
    await page.locator('#accuracy-chart').scrollIntoViewIfNeeded();
    m=await metrics(page);check(`no-horizontal-overflow-${width}-stats`,m.documentWidth<=m.width+2,m);
    const chart=await page.locator('#accuracy-chart').evaluate(el=>({points:el.querySelectorAll('circle').length,width:el.clientWidth,viewBox:el.getAttribute('viewBox'),dates:[...el.querySelectorAll('.chart-date')].map(x=>({text:x.textContent,x:x.getBBox().x,right:x.getBBox().x+x.getBBox().width}))}));
    check(`chart-data-readable-${width}`,chart.points>0 && chart.dates.length>1,chart);
    await snap(page,`${width}-statistics`,width>=768);
    await page.locator('#accuracy-chart circle').first().focus();
    check(`chart-keyboard-description-${width}`,(await page.locator('#chart-summary').innerText()).includes('正确率'),await page.locator('#chart-summary').innerText());
    const table=await page.locator('.daily-table-wrap').evaluate(el=>({outerWidth:el.clientWidth,tableWidth:el.scrollWidth}));
    report.observations.push({width,dailyTable:table,narrowScreenTableUsesOwnScroll:table.tableWidth>table.outerWidth});
    if (width<768) { await page.locator('.daily-table-wrap').scrollIntoViewIfNeeded(); await snap(page,`${width}-daily-table`); }
    await page.locator('#open-sound').click();
    const dialog=await page.locator('#sound-dialog').boundingBox();
    check(`settings-fit-width-${width}`,dialog.x>=0 && dialog.x+dialog.width<=width+1,{dialog});
    await snap(page,`${width}-settings`);
    await page.locator('#mistake-target').scrollIntoViewIfNeeded();
    check(`settings-final-control-reachable-${width}`,await page.locator('#mistake-target').isVisible(),await page.locator('#mistake-target').boundingBox());
    await page.locator('#sound-dialog .close-button').focus();
    const modalFocus=[];
    for(let i=0;i<4;i++) {
      await page.keyboard.press('Shift+Tab');
      modalFocus.push(await page.evaluate(()=>({id:document.activeElement.id,tag:document.activeElement.tagName,
        inDialog:document.querySelector('#sound-dialog').contains(document.activeElement),browserChrome:document.activeElement===document.body})));
    }
    // Native dialog permits a browser toolbar focus stop, represented by BODY.
    // The requirement is that keyboard focus never enters underlying page controls.
    check(`settings-keyboard-no-background-controls-${width}`,modalFocus.every(x=>x.inDialog||x.browserChrome),modalFocus);
    await page.keyboard.press('Escape');
    check(`settings-escape-${width}`,!(await page.locator('#sound-dialog').evaluate(el=>el.open)),await page.locator('#sound-dialog').evaluate(el=>el.open));
    await page.locator('[data-view=practice]').click();
    await page.locator('[data-mode=flashcard]').click();
    await page.locator('#flip-card').click();
    const cardSynonyms=page.locator('.flashcard-details .synonym-details');
    check(`flashcard-synonyms-visible-${width}`,await cardSynonyms.locator('.synonym-chip').first().isVisible()&&await cardSynonyms.locator('summary').count()===0&&await cardSynonyms.locator('.synonym-chip').count()===longItem.synonyms.length,{chips:await cardSynonyms.locator('.synonym-chip').count(),expected:longItem.synonyms.length});
    m=await metrics(page);check(`no-horizontal-overflow-${width}-long-flashcard`,m.documentWidth<=m.width+2,m);
    await page.locator('#study-card').scrollIntoViewIfNeeded();
    await snap(page,`${width}-long-flashcard`,width>=768);
    await snapElement(page,'.flashcard-details',`${width}-long-flashcard-details`);
    await page.locator('[data-mode=chinese]').click();
    m=await metrics(page);check(`no-horizontal-overflow-${width}-long-chinese`,m.documentWidth<=m.width+2,m);
    const bounds=await page.locator('#prompt-area').evaluate(el=>({area:el.getBoundingClientRect().toJSON(),text:el.querySelector('.prompt-main').getBoundingClientRect().toJSON(),next:document.querySelector('.auxiliary-controls').getBoundingClientRect().toJSON()}));
    check(`long-chinese-does-not-overlap-controls-${width}`,bounds.text.bottom<=bounds.area.bottom+2 && bounds.area.bottom<=bounds.next.top+2,bounds);
    await page.locator('[data-view=library]').click();await page.locator('#library-search').fill(longIPA.original);
    await page.locator('#library-list .term-link').filter({hasText:longIPA.original}).first().click();
    await page.locator('[data-mode=phonetic]').click();
    m=await metrics(page);check(`no-horizontal-overflow-${width}-longest-IPA`,m.documentWidth<=m.width+2,m);
    await page.locator('#study-card').scrollIntoViewIfNeeded();await snap(page,`${width}-longest-IPA`);
    report.observations.push({width,smallTouchTargets:m.tinyTargets});
  } catch(e) {report.errors.push({stage:`responsive-${width}`,message:e.stack});}
  finally {await context.close();}
}
async function fullscreen(width,height) {
  const {context,page}=await makePage({width,height},{id:items[1].id,mistakes:2});
  try {
    await page.locator('#answer-input').fill('partial answer');
    await page.evaluate(()=>scrollTo(0,12));
    const before=await page.evaluate(()=>({y:scrollY,input:document.querySelector('#answer-input').value,position:document.querySelector('#card-position').textContent}));
    await page.locator('#open-fullscreen').click();
    await page.waitForTimeout(250);
    const active=await page.evaluate(()=>{const side=document.querySelector('.practice-sidebar'),b=side.getBoundingClientRect(),visible=!!(b.width&&b.height)&&!side.closest('details:not([open])');return {active:!!document.fullscreenElement,immersive:document.body.classList.contains('immersive'),element:document.fullscreenElement?.tagName,input:document.querySelector('#answer-input').value,position:document.querySelector('#card-position').textContent,sidebarVisible:visible,sidebar:{display:getComputedStyle(side).display,open:!!side.closest('details[open]')}};});
    check(`native-fullscreen-${width}`,active.active && active.immersive,active,'P1');
    check(`fullscreen-practice-state-${width}`,active.input===before.input && active.position===before.position && !active.sidebarVisible,{before,active});
    const simplified=await page.evaluate(()=>({brand:getComputedStyle(document.querySelector('.brand')).display,
      settings:getComputedStyle(document.querySelector('#open-sound')).display,
      previous:getComputedStyle(document.querySelector('#previous')).display,
      visibleControls:[...document.querySelectorAll('button,input,select,summary')].filter(el=>{
        const b=el.getBoundingClientRect(),s=getComputedStyle(el);
        if(!b.width||!b.height||s.display==='none'||s.visibility==='hidden')return false;
        for(let ancestor=el.parentElement;ancestor;ancestor=ancestor.parentElement)if(ancestor.tagName==='DETAILS'&&!ancestor.open){
          const summary=ancestor.querySelector(':scope>summary');if(el!==summary&&!summary?.contains(el))return false;
        }
        return true;
      }).map(el=>el.id||el.getAttribute('aria-label')||el.textContent.trim()),
      pageHeight:document.documentElement.scrollHeight,viewport:innerHeight,scrollY}));
    check(`fullscreen-no-brand-or-extra-settings-${width}`,simplified.brand==='none'&&simplified.settings==='none',simplified);
    for(const selector of ['#bookmark','#toggle-mistake','#previous','#sound-shortcut','#open-help','[data-mode=listen]','[data-mode=chinese]','[data-mode=phonetic]','[data-mode=flashcard]','#hint-chinese','#hint-phonetic','#default-chinese','#default-phonetic']) check(`fullscreen-requested-control-visible-${width}-${selector}`,await page.locator(selector).isVisible(),{selector});
    check(`fullscreen-short-question-no-blank-scroll-${width}`,simplified.pageHeight<=simplified.viewport+2,simplified);
    await snap(page,`${width}-fullscreen`);
    const m=await metrics(page);check(`no-horizontal-overflow-${width}-fullscreen`,m.documentWidth<=m.width+2,m);
    await page.locator('#practice-options>summary').click();
    const menuBounds=await page.locator('.practice-sidebar').boundingBox();
    check(`fullscreen-range-fits-${width}`,menuBounds.x>=0&&menuBounds.x+menuBounds.width<=width+2&&menuBounds.y>=0&&menuBounds.y+menuBounds.height<=height+2,menuBounds);
    await snap(page,`${width}-fullscreen-range`);
    await page.keyboard.press('Escape');await page.waitForTimeout(120);
    const closedMenu=await page.evaluate(()=>({native:!!document.fullscreenElement,immersive:document.body.classList.contains('immersive'),menu:document.querySelector('#practice-options').open,focus:document.activeElement===document.querySelector('#practice-options>summary')}));
    check(`fullscreen-first-Escape-closes-range-${width}`,closedMenu.native&&closedMenu.immersive&&!closedMenu.menu&&closedMenu.focus,closedMenu,'P1');
    await page.keyboard.press('Escape');await page.waitForTimeout(250);
    const escaped=await page.evaluate(()=>({native:!!document.fullscreenElement,immersive:document.body.classList.contains('immersive')}));
    check(`fullscreen-Escape-exits-${width}`,!escaped.native&&!escaped.immersive,escaped,'P1');
    report.observations.push({name:`fullscreen-Escape-${width}`,escaped,automation:'Headless Playwright keyboard triggers the page Escape handler; before/after document.fullscreenElement is recorded.'});
    if(escaped.native||escaped.immersive) await page.locator('#open-fullscreen').click();
    await page.waitForTimeout(250);
    const after=await page.evaluate(()=>({y:scrollY,input:document.querySelector('#answer-input').value,position:document.querySelector('#card-position').textContent,immersive:document.body.classList.contains('immersive'),native:!!document.fullscreenElement}));
    check(`fullscreen-exit-restores-${width}`,!after.immersive && !after.native && after.input===before.input && after.position===before.position && Math.abs(after.y-before.y)<=2,{before,after});
    await page.locator('#open-fullscreen').click();
    await page.locator('#previous').click();
    check(`fullscreen-visible-previous-navigates-${width}`,await page.locator('#card-position').innerText()!==before.position,{position:await page.locator('#card-position').innerText()});
    await page.locator('#answer-input').fill('wrong');await page.locator('#answer-input').press('Enter');
    check(`fullscreen-actions-honor-correction-lock-${width}`,await page.locator('#previous').isDisabled()&&await page.locator('#toggle-mistake').isDisabled()&&await page.locator('#next').isDisabled(),{previous:await page.locator('#previous').isDisabled(),remove:await page.locator('#toggle-mistake').isDisabled(),next:await page.locator('#next').isDisabled()},'P1');
    await page.locator('#answer-input').fill(items[0].acceptedAnswers[0]);await page.locator('#answer-input').press('Enter');
    await page.locator('#open-fullscreen').click();
    await page.locator('[data-view=library]').click();
    await page.evaluate(()=>scrollTo(0,12));
    await page.locator('#open-fullscreen').click();await page.waitForTimeout(150);
    check(`fullscreen-from-library-shows-practice-${width}`,await page.locator('#practice-view').isVisible() && !(await page.locator('#library-view').isVisible()),await page.evaluate(()=>({practice:!document.querySelector('#practice-view').hidden,library:!document.querySelector('#library-view').hidden})));
    await page.locator('#open-fullscreen').click();await page.waitForTimeout(150);
    check(`fullscreen-exit-restores-library-${width}`,await page.locator('#library-view').isVisible(),await page.locator('#library-view').isVisible());
    await page.locator('#library-search').fill(longItem.original);await page.locator('#library-list .term-link').filter({hasText:longItem.original}).first().click();
    await page.locator('[data-mode=flashcard]').click();await page.locator('#flip-card').click();await page.locator('#open-fullscreen').click();
    const longMetrics=await metrics(page);
    check(`fullscreen-long-details-no-horizontal-overflow-${width}`,longMetrics.documentWidth<=longMetrics.width+2,longMetrics);
    await page.locator('#next').scrollIntoViewIfNeeded();
    check(`fullscreen-long-card-next-reachable-${width}`,await page.locator('#next').isVisible(),await page.locator('#next').boundingBox());
    await page.evaluate(()=>scrollTo(0,0));
    await snap(page,`${width}-fullscreen-long-card`,true);
  }catch(e){report.errors.push({stage:`fullscreen-${width}`,message:e.stack});}
  finally{await context.close();}
}
(async()=>{
  try {
    {
      browser=await chromium.launch({...auditLaunch(),args:['--no-first-run']});
      for(const [width,height] of [[1440,1000],[1280,900],[768,1024],[390,844],[360,800],[320,568]]) await responsive(width,height);
      await fullscreen(1280,900);await fullscreen(390,844);await fullscreen(320,568);
    }
  }catch(e){report.errors.push({stage:'launch',message:e.stack});}
  finally {
    if(browser) await browser.close();
    report.sourceHashesAfter=Object.fromEntries(sourceFiles.map(filename=>[filename,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,filename))).digest('hex')]));
    report.finalSourceHashes=report.sourceHashesAfter;
    report.sourceHashesStart=report.sourceHashes;
    report.sourceHashesEnd=report.sourceHashesAfter;
    report.sourcesStableThroughoutAudit=JSON.stringify(report.sourceHashes)===JSON.stringify(report.sourceHashesAfter);
    for(const screenshot of report.screenshots)screenshot.sha256=crypto.createHash('sha256').update(fs.readFileSync(screenshot.path)).digest('hex');
    report.screenshotHashes=Object.fromEntries(report.screenshots.map(s=>[path.basename(s.path),s.sha256]));
    check('final-sources-unchanged-through-audit',report.sourcesStableThroughoutAudit,{before:report.sourceHashes,after:report.sourceHashesAfter},'P1');
    report.finishedAt=new Date().toISOString();
    report.summary={passed:report.checks.filter(x=>x.status==='pass').length,failed:report.checks.filter(x=>x.status==='fail').length,errors:report.errors.length};
    const filename=`audit-visual-${tag}`;
    fs.writeFileSync(path.join(reportDir,filename+'.json'),JSON.stringify(report,null,2));
    fs.writeFileSync(path.join(reportDir,filename+'.md'),[
      `# Visual / UX audit (${tag})`, ``, `- Browser: ${report.browser}; headed: ${headed}; URL: ${base}`,
      `- Dataset: ${items.length}; vocabulary response overridden: false`,
      `- Checks: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.errors} harness errors`,
      `- Long details: ${longItem.original} (${longItem.id})`, ``, `## Findings`, ``,
      ...report.findings.map(x=>`- **${x.severity} ${x.id} ${x.title}**: ${JSON.stringify(x.evidence)}`),
      ...(report.findings.length?[]:['No failing automated visual checks. Screenshots still require human visual inspection.']),
      ``, `## Harness errors`, ``,...report.errors.map(x=>`- ${x.stage||JSON.stringify(x.viewport)}: ${x.message}`),
      ``, `## Evidence`, ``,...report.screenshots.map(x=>`- ${x.name}: ${x.path}`)
    ].join('\n'));
    process.stdout.write(JSON.stringify({summary:report.summary,longItem:report.longDetailItem,findings:report.findings,errors:report.errors,report:path.join(reportDir,filename+'.json')},null,2)+'\n');
    process.exitCode=report.summary.failed||report.summary.errors?1:0;
  }
})();
