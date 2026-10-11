'use strict';
// Independent SpeechSynthesis-only audit. This always uses invisible browsers.
// Native speech calls/events are kept distinct from deterministic control tests.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {pathToFileURL}=require('url');
const {chromium,auditLaunch,auditOutput}=require('./playwright_runtime.cjs');
const root=path.resolve(__dirname,'..'),reports=auditOutput();fs.mkdirSync(reports,{recursive:true});
const urlArg=process.argv.find(x=>x.startsWith('--url='));
const base=urlArg?urlArg.slice(6):'http://127.0.0.1:11545/';
if(process.argv.includes('--headed'))throw new Error('Visible browser tests are disabled by the user. Run this audit headlessly.');
const data=JSON.parse(fs.readFileSync(path.join(root,'app/data/vocab.json'),'utf8'));
const items=data.items||data;
const tag='final';
const report={audit:'native-speech-and-browser-compatibility',phase:tag,startedAt:new Date().toISOString(),
  base,headless:true,preStoredAudio:false,subjectiveListening:false,
  datasetCount:items.length,checks:[],findings:[],errors:[],nativeCases:[],controlledCases:[],sourceHashes:{},limitations:[]};
const sourceFiles=['index.html','app/app.js','app/styles.css','app/data/vocab.json','app/data/vocab.js'];
for(const filename of sourceFiles){
  const full=path.join(root,filename);if(fs.existsSync(full))report.sourceHashes[filename]=crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
}
function check(name,passed,evidence,severity='P2'){
  report.checks.push({name,status:passed?'pass':'fail',evidence});
  if(!passed)report.findings.push({id:`SPEECH-${report.findings.length+1}`,severity,title:name,evidence});
}
function observeNative(){
  const audit=window.__speechAudit={calls:[],events:[],ops:[],mediaPlays:[]};
  const play=HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play=function(){audit.mediaPlays.push({src:this.src,at:performance.now()});return play.call(this);};
  if(!window.speechSynthesis)return;
  const synth=window.speechSynthesis,speak=synth.speak.bind(synth);
  synth.speak=u=>{
    audit.calls.push({text:u.text,rate:u.rate,pitch:u.pitch,volume:u.volume,voice:u.voice?.name||null,lang:u.lang});
    for(const event of ['start','end','error','pause','resume'])u.addEventListener(event,e=>audit.events.push({event,error:e.error||null,at:performance.now(),text:u.text}));
    return speak(u);
  };
  for(const name of ['pause','resume','cancel']){
    const original=synth[name].bind(synth);
    synth[name]=()=>{audit.ops.push({name,at:performance.now()});return original();};
  }
}
function controlledSpeech({unavailable=false,empty=false}={}){
  const audit=window.__speechAudit={calls:[],events:[],ops:[],mediaPlays:[],controlled:true};
  if(unavailable){
    Object.defineProperty(window,'speechSynthesis',{configurable:true,value:undefined});
    Object.defineProperty(window,'SpeechSynthesisUtterance',{configurable:true,value:undefined});return;
  }
  const voices=empty?[]:[{name:'Audit US',lang:'en-US',voiceURI:'audit-us',localService:true,default:true},
    {name:'Audit British',lang:'en-GB',voiceURI:'audit-uk',localService:true,default:false}];
  const synth={paused:false,pending:false,speaking:false,getVoices:()=>voices,addEventListener(){},
    cancel(){audit.ops.push({name:'cancel'});this.paused=false;this.pending=false;this.speaking=false;},
    pause(){audit.ops.push({name:'pause'});this.paused=true;},
    resume(){audit.ops.push({name:'resume'});this.paused=false;},
    speak(u){
      this.speaking=true;
      audit.calls.push({text:u.text,rate:u.rate,pitch:u.pitch,volume:u.volume,voice:u.voice?.name||null,lang:u.lang});
      u.onstart?.();
    }};
  Object.defineProperty(window,'SpeechSynthesisUtterance',{configurable:true,value:class{constructor(text){this.text=text;}}});
  Object.defineProperty(window,'speechSynthesis',{configurable:true,value:synth});
}
async function newPage(browser,url,controlled=null){
  const context=await browser.newContext({viewport:{width:1280,height:900},locale:'zh-CN',timezoneId:'Asia/Shanghai'});
  if(controlled)await context.addInitScript(controlledSpeech,controlled);else await context.addInitScript(observeNative);
  const page=await context.newPage(),requests=[],errors=[],failedRequests=[];
  page.setDefaultTimeout(7000);
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(r.url()));
  page.on('requestfailed',r=>failedRequests.push({url:r.url(),error:r.failure()?.errorText}));
  page.on('response',r=>{if(r.status()>=400)failedRequests.push({url:r.url(),status:r.status()});});
  await page.goto(url,{waitUntil:'networkidle'});await page.waitForSelector('#play-main');
  return{context,page,requests,errors,failedRequests};
}
async function capture(page){return page.evaluate(()=>({...window.__speechAudit,
  supported:!!window.speechSynthesis,paused:window.speechSynthesis?.paused,
  voices:window.speechSynthesis?.getVoices().map(v=>({name:v.name,lang:v.lang,local:v.localService}))||[],
  voice:document.querySelector('#voice-select').value,
  options:[...document.querySelector('#voice-select').options].map(o=>({value:o.value,text:o.textContent})),
  pitchDisabled:document.querySelector('#pitch').disabled,
  status:document.querySelector('#speech-status').textContent,settingsStatus:document.querySelector('#settings-speech-status').textContent,
  playing:document.querySelector('#study-card').classList.contains('playing'),input:document.querySelector('#answer-input').value,
  voiceNote:document.querySelector('#voice-note').textContent
}));}
async function nativeCase(browser,name,protocol,url){
  const{context,page,requests,errors,failedRequests}=await newPage(browser,url),prefix=name+'-'+protocol;
  try{
    const loaded=await page.evaluate(expected=>{
      const actual=window.LISTENING_DATA?.items;
      return{count:actual?.length,hasExercise:!!document.querySelector('#play-main'),
        exactMatch:Array.isArray(actual)&&actual.length===expected.length&&actual.every((row,index)=>JSON.stringify(row)===JSON.stringify(expected[index]))};
    },items);
    check(prefix+'-loads-exact-frozen-1533',loaded.count===1533&&loaded.hasExercise&&loaded.exactMatch,loaded,'P1');
    check(prefix+'-all-page-resources-load',failedRequests.length===0,{requests,failedRequests},'P1');
    check(prefix+'-listen-single-play-entry',await page.locator('#play-main').isVisible()&&!await page.locator('#replay').isVisible(),{main:await page.locator('#play-main').isVisible(),secondary:await page.locator('#replay').isVisible()});
    check(prefix+'-homepage-has-no-total-word-count',!await page.evaluate(()=>document.body.innerText.includes('1533')),await page.locator('#card-position').innerText());
    await page.waitForTimeout(350);await page.locator('#open-sound').click();
    for(const[id,value]of [['rate',.65],['pitch',1.3],['volume',.35]])await page.locator('#'+id).evaluate((el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));},String(value));
    await page.locator('#test-voice').click();
    await page.waitForFunction(()=>window.__speechAudit.events.some(e=>['start','end','error'].includes(e.event))||!window.speechSynthesis,null,{timeout:10000}).catch(()=>{});
    let s=await capture(page),call=s.calls.at(-1);
    const firstNativeResponse=s;
    check(prefix+'-passes-voice-settings-to-native-utterance',!s.supported||!!call&&Math.abs(call.rate-.65)<1e-6&&Math.abs(call.pitch-1.3)<1e-6&&Math.abs(call.volume-.35)<1e-6,call);
    const outcome=s.events.some(e=>e.event==='error')?'system-error':s.events.some(e=>e.event==='start')?'started':'unavailable-or-no-event';
    if(outcome==='system-error'){
      const status=s.settingsStatus||s.status;
      check(prefix+'-native-synthesis-error-visible',status.length>0&&!s.playing,{events:s.events,status},'P1');
      report.limitations.push({name,protocol,limitation:'The actual Windows speech engine returned an error. Successful audible SpeechSynthesis output is unverified in this environment.',events:s.events});
    }else if(outcome==='started'){
      await page.waitForFunction(()=>window.__speechAudit.events.some(e=>e.event==='end'),null,{timeout:15000}).catch(()=>{});
    }else report.limitations.push({name,protocol,limitation:'No native successful speech event was observed; report does not claim audible output.'});
    check(prefix+'-no-prestored-audio-option',!s.options.some(o=>/local-backup|备用|Sonia/.test(o.value+' '+o.text)),s.options,'P1');
    check(prefix+'-no-Audio-playback',s.mediaPlays.length===0,s.mediaPlays,'P1');
    await page.locator('#sound-dialog .close-button').click();await page.waitForTimeout(100);
    const before=await capture(page);await page.locator('#answer-input').fill('spelling');
    await page.locator('#answer-input').press('r');await page.locator('#answer-input').press('Space');s=await capture(page);
    check(prefix+'-typing-R-Space-preserves-normal-input',s.input==='spellingr '&&s.calls.length===before.calls.length,{input:s.input,callsBefore:before.calls.length,callsAfter:s.calls.length});
    await page.locator('#answer-input').press('Alt+r');s=await capture(page);
    check(prefix+'-AltR-input-native-speak-call',s.calls.length===before.calls.length+1&&s.input==='spellingr ',{input:s.input,call:s.calls.at(-1)});
    await page.locator('#play-main').focus();const rCount=s.calls.length;await page.keyboard.press('r');s=await capture(page);
    check(prefix+'-R-outside-input-native-speak-call',s.calls.length===rCount+1,s.calls.at(-1));
    const cancelBefore=s.ops.filter(o=>o.name==='cancel').length;await page.locator('#next').click();s=await capture(page);
    check(prefix+'-next-cancels-native-speech',s.ops.filter(o=>o.name==='cancel').length>cancelBefore,s.ops.slice(-3));
    const external=requests.filter(u=>/^https?:/.test(u)&&!u.startsWith(base));
    check(prefix+'-no-API-CDN-or-MP3-request',external.length===0&&!requests.some(u=>/\.mp3(?:$|\?)/i.test(u)),{external,mediaRequests:requests.filter(u=>/\.mp3/i.test(u))},'P1');
    check(prefix+'-no-browser-script-errors',errors.length===0,errors,'P1');
    report.nativeCases.push({name,protocol,outcome,firstNativeResponse,evidence:await capture(page),requests,failedRequests,errors});
  }catch(e){report.errors.push({stage:prefix,message:e.stack});}finally{await context.close();}
}
async function controlsCase(browser,name){
  const{context,page,requests,errors}=await newPage(browser,base,{}),prefix=name+'-controlled';
  try{
    let s=await capture(page);
    check(prefix+'-en-GB-prioritized',s.options.find(o=>o.value.includes('audit-uk'))?.value===s.voice&&s.options.findIndex(o=>o.value.includes('audit-uk'))<s.options.findIndex(o=>o.value.includes('audit-us')),s.options);
    await page.locator('#open-sound').click();
    for(const[id,value]of [['rate',1.25],['pitch',1.4],['volume',.6]])await page.locator('#'+id).evaluate((el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));},String(value));
    await page.locator('#sound-dialog .close-button').click();await page.waitForTimeout(80);await page.locator('#play-main').click();s=await capture(page);
    check(prefix+'-play-current-exact-speakText',s.calls.at(-1)?.text===items[0].speakText,s.calls.at(-1));
    check(prefix+'-all-three-settings',s.calls.at(-1)?.rate===1.25&&s.calls.at(-1)?.pitch===1.4&&s.calls.at(-1)?.volume===.6,s.calls.at(-1));
    await page.locator('#play-main').focus();await page.keyboard.press('Space');s=await capture(page);
    check(prefix+'-Space-pauses-focused-play',s.paused&&s.ops.at(-1)?.name==='pause',s.ops.slice(-3));
    await page.keyboard.press('Space');s=await capture(page);
    check(prefix+'-Space-resumes-focused-play',!s.paused&&s.ops.at(-1)?.name==='resume',s.ops.slice(-3));
    await page.locator('#answer-input').fill('typing');let count=s.calls.length;
    await page.locator('#answer-input').press('r');await page.locator('#answer-input').press('Space');s=await capture(page);
    check(prefix+'-input-shortcuts-do-not-interfere',s.calls.length===count&&s.input==='typingr ',s.input);
    await page.locator('#answer-input').press('Alt+r');s=await capture(page);
    check(prefix+'-AltR-replays-and-cancels-old',s.calls.length===count+1&&s.ops.at(-1)?.name==='cancel'&&s.input==='typingr ',{calls:s.calls.slice(-2),ops:s.ops.slice(-2),input:s.input});
    await page.locator('#play-main').focus();count=s.calls.length;await page.keyboard.press('r');s=await capture(page);
    check(prefix+'-R-replays-and-cancels-old',s.calls.length===count+1&&s.ops.at(-1)?.name==='cancel',s.ops.slice(-2));
    count=s.calls.length;
    await page.locator('#next').click();s=await capture(page);check(prefix+'-next-replaces-old-with-default-autoplay',s.calls.length===count+1&&s.calls.at(-1)?.text===items[1].speakText&&s.ops.at(-1)?.name==='cancel',{call:s.calls.at(-1),ops:s.ops.slice(-2)});
    await page.locator('#play-main').click();await page.locator('[data-view=library]').click();s=await capture(page);
    check(prefix+'-view-stops-playing',!s.playing&&s.ops.at(-1)?.name==='cancel',s.ops.slice(-2));
    await page.locator('[data-view=practice]').click();await page.locator('#play-main').click();await page.locator('[data-mode=chinese]').click();s=await capture(page);
    check(prefix+'-mode-stops-playing',!s.playing&&s.ops.at(-1)?.name==='cancel',s.ops.slice(-2));
    for(const mode of ['chinese','phonetic','flashcard']){
      if(mode!=='chinese')await page.locator('[data-mode='+mode+']').click();
      check(prefix+'-'+mode+'-replay-entry-visible',await page.locator('#replay').isVisible()&&await page.locator('#play-main').count()===0,{mode,secondary:await page.locator('#replay').isVisible()});
      count=(await capture(page)).calls.length;await page.locator('#replay').click();s=await capture(page);
      check(prefix+'-'+mode+'-replay-current-word',s.calls.length===count+1&&s.calls.at(-1)?.text===items[1].speakText,{call:s.calls.at(-1),expected:items[1].speakText});
    }
    await page.locator('#sound-shortcut').click();
    check(prefix+'-visible-settings-opens',await page.locator('#sound-dialog').evaluate(el=>el.open),{dialog:await page.locator('#sound-dialog').evaluate(el=>el.open)});
    await page.locator('#auto-speak').check();await page.locator('#sound-dialog .close-button').click();
    await page.locator('[data-mode=listen]').click();count=(await capture(page)).calls.length;
    await page.locator('#next').click();s=await capture(page);
    check(prefix+'-settings-auto-speak-next',s.calls.length===count+1&&s.calls.at(-1)?.text===items[2].speakText,{call:s.calls.at(-1),expected:items[2].speakText});
    await page.reload({waitUntil:'networkidle'});await page.locator('#open-sound').click();s=await capture(page);
    check(prefix+'-settings-persist-after-reload',await page.locator('#auto-speak').isChecked()&&await page.locator('#rate').inputValue()==='1.25'&&await page.locator('#pitch').inputValue()==='1.4'&&await page.locator('#volume').inputValue()==='0.6',{autoSpeak:await page.locator('#auto-speak').isChecked(),rate:await page.locator('#rate').inputValue(),pitch:await page.locator('#pitch').inputValue(),volume:await page.locator('#volume').inputValue()});
    check(prefix+'-no-browser-script-errors',errors.length===0,errors,'P1');
    report.controlledCases.push({name,scenario:'deterministic-controls-only',syntheticAudioOutputClaim:false,evidence:s,requests,errors});
  }catch(e){report.errors.push({stage:prefix,message:e.stack});}finally{await context.close();}
}
async function unavailableCase(browser,name,scenario){
  const{context,page}=await newPage(browser,base,scenario),prefix=name+'-'+(scenario.empty?'empty-voices':'no-synthesis');
  try{
    await page.locator('#play-main').click();let s=await capture(page);
    check(prefix+'-clear-message',Boolean(s.status||s.voiceNote),{status:s.status,note:s.voiceNote});
    check(prefix+'-no-local-audio-option',!s.options.some(o=>/local-backup|备用|Sonia/.test(o.value+' '+o.text)),s.options,'P1');
    report.controlledCases.push({name,scenario,syntheticAudioOutputClaim:false,evidence:s});
  }catch(e){report.errors.push({stage:prefix,message:e.stack});}finally{await context.close();}
}
(async()=>{
  try{
    for(const[name,channel]of [['Chrome','chrome'],['Edge','msedge']]){
      const browser=await chromium.launch(auditLaunch(channel));
      try{
        await nativeCase(browser,name,'file',pathToFileURL(path.join(root,'index.html')).href);
        await nativeCase(browser,name,'localhost',base);
        await controlsCase(browser,name);
        await unavailableCase(browser,name,{unavailable:true});await unavailableCase(browser,name,{empty:true});
      }finally{await browser.close();}
    }
  }catch(e){report.errors.push({stage:'main',message:e.stack});}
  finally{
    report.sourceHashesAfter=Object.fromEntries(sourceFiles.map(filename=>[filename,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,filename))).digest('hex')]));
    report.finalSourceHashes=report.sourceHashesAfter;
    report.sourceHashesStart=report.sourceHashes;
    report.sourceHashesEnd=report.sourceHashesAfter;
    report.sourcesStableThroughoutAudit=JSON.stringify(report.sourceHashes)===JSON.stringify(report.sourceHashesAfter);
    check('final-sources-unchanged-through-audit',report.sourcesStableThroughoutAudit,{before:report.sourceHashes,after:report.sourceHashesAfter},'P1');
    report.finishedAt=new Date().toISOString();report.summary={passed:report.checks.filter(x=>x.status==='pass').length,failed:report.checks.filter(x=>x.status==='fail').length,errors:report.errors.length};
    const filename=`audit-speech-${tag}`;
    fs.writeFileSync(path.join(reports,filename+'.json'),JSON.stringify(report,null,2));
    fs.writeFileSync(path.join(reports,filename+'.md'),[
      `# 独立语音与兼容性审核 (${tag})`,``,
      `Chrome / Edge，file / localhost；全部无界面运行。仅使用浏览器 SpeechSynthesis；未预存音频。`,
      ``, `实际原生语音事件与受控快捷键测试分别记录，模拟测试只证明控制逻辑，不作为声音成功播放的证据。`,
      ``, `- 真实词库：${items.length} 条；检查 ${report.summary.passed} 通过，${report.summary.failed} 失败；脚本错误 ${report.summary.errors}`,
      `- 未作主观人工音色评价。`, ``, `## 环境局限`, ``,...report.limitations.map(e=>`- ${e.name} / ${e.protocol}: ${e.limitation}`),
      ``, `## 问题`, ``,...report.findings.map(f=>`- **${f.severity} ${f.title}**: ${JSON.stringify(f.evidence)}`),...(!report.findings.length?['未发现可执行的 P0/P1/P2 问题。']:[]),
      ``, `## 脚本错误`, ``,...report.errors.map(e=>`- ${e.stage}: ${e.message}`),
      ``, `JSON报告包含数据SHA、真实语音调用/事件、请求记录、受控测试独立证据。`
    ].join('\n'));
    process.stdout.write(JSON.stringify({summary:report.summary,findings:report.findings.map(e=>({title:e.title,severity:e.severity})),errors:report.errors.map(e=>({stage:e.stage,message:e.message})),nativeOutcomes:report.nativeCases.map(x=>({browser:x.name,protocol:x.protocol,outcome:x.outcome})),report:path.join(reports,filename+'.json')},null,2)+'\n');
    process.exitCode=report.summary.failed||report.summary.errors?1:0;
  }
})();
