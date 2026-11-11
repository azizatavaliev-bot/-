// npm run ui — рисует мышью по-настоящему: тетрадь, «По памяти», диктант на доске, тесты, выбор слов, репетитор (нужен Playwright + Chromium).
const {chromium}=require('playwright'),path=require('path'),fs=require('fs');
const out=path.join(__dirname,'..','screens');fs.mkdirSync(out,{recursive:true});
const CHROME=process.env.CHROME||undefined;
let seed=11;const rn=()=>(seed=(seed*16807)%2147483647)/2147483647,gs=()=>(rn()+rn()+rn()-1.5)*1.6;
const http=require('http');let URL='',lastUpstream=null;
const REPLY=JSON.stringify({say:'Вот тест из **3 слов**.',test:{title:'Карточки: мои слова',items:[{type:'card',hz:'你好',py:'nǐ hǎo',ru:'привет'},{type:'quiz',q:'Как сказать «спасибо»?',opts:['谢谢','再见','对不起','没关系'],a:0,why:'谢谢 xièxie'},{type:'write',hz:'大人',py:'dàrén',ru:'взрослый'}]}});
function startServers(){return new Promise(res=>{ // «Claude» подставной; наш настоящий api/chat.js ходит к нему
  const up=http.createServer((rq,rs)=>{let d='';rq.on('data',c=>d+=c);rq.on('end',()=>{lastUpstream={headers:rq.headers,body:JSON.parse(d)};rs.setHeader('content-type','application/json');rs.end(JSON.stringify({content:[{type:'text',text:REPLY}]}))})}).listen(0,()=>{
    process.env.ANTHROPIC_API_KEY='test-key';process.env.ANTHROPIC_API_URL='http://127.0.0.1:'+up.address().port+'/v1/messages';
    const handler=require('../api/chat.js');
    const app=http.createServer((rq,rs)=>{if(rq.url==='/api/chat'){let d='';rq.on('data',c=>d+=c);rq.on('end',()=>{let body=null;try{body=JSON.parse(d)}catch(e){}const resp={status(c){rs.statusCode=c;return resp},json(o){rs.setHeader('content-type','application/json');rs.end(JSON.stringify(o))},setHeader(k,v){rs.setHeader(k,v)}};handler({method:rq.method,headers:rq.headers,body},resp)})}
      else{rs.setHeader('content-type','text/html; charset=utf-8');rs.end(fs.readFileSync(path.join(__dirname,'..','index.html')))}}).listen(0,()=>{URL='http://127.0.0.1:'+app.address().port+'/';res([up,app])})})})}
// штрихи знака из данных порядка черт, со «школьным» разбросом, в прямоугольник box
async function draw(page,ch,box,jit=1){const m=await page.evaluate(c=>medOf(c),ch);const th=(rn()-.5)*.12*jit,sx=1+(rn()-.5)*.14*jit,sy=1+(rn()-.5)*.14*jit,pad=.14;
  for(const s of m){const P=s.map(([x,y])=>{let px=x-.5,py=y-.5;const qx=(px*Math.cos(th)-py*Math.sin(th))*sx,qy=(px*Math.sin(th)+py*Math.cos(th))*sy;return[box.x+box.w*(pad+(.5+qx+gs()*.008*jit)*(1-2*pad)),box.y+box.h*(pad+(.5+qy+gs()*.008*jit)*(1-2*pad))]});
    await page.mouse.move(...P[0]);await page.mouse.down();for(let i=1;i<P.length;i++){const a=P[i-1],b=P[i];for(let k=1;k<=5;k++)await page.mouse.move(a[0]+(b[0]-a[0])*k/5,a[1]+(b[1]-a[1])*k/5)}await page.mouse.up()}}
const rect=(page,sel)=>page.evaluate(s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}},sel);
(async()=>{const servers=await startServers();const b=await chromium.launch({executablePath:CHROME}),errs=[],fails=[];const ok=(c,m)=>{console.log(c?'ok  ':'FAIL',m);if(!c)fails.push(m)};
for(const [w,h] of [[1280,900],[390,844]]){const p=await b.newPage({viewport:{width:w,height:h}});p.on('pageerror',e=>errs.push(w+': '+e.message));
  await p.goto(URL);await p.waitForTimeout(500);
  const noX=async(m)=>{const sw=await p.evaluate(()=>document.documentElement.scrollWidth);ok(sw<=w,'нет горизонтального скролла: '+m+' @'+w)};
  // --- тетрадь для прописи
  await p.evaluate("W.mode='trace';W.set=false;go('write')");await p.waitForTimeout(300);
  let box=await rect(p,'#wb');await draw(p,'一',{x:box.x,y:box.y,w:box.w/(w<560?4:6),h:box.h/2});
  await p.click('[data-a=wanim]');await p.waitForTimeout(900);ok(await p.evaluate(()=>!!document.querySelector('#wanim .animc')),'анимация порядка черт открывается @'+w);
  await p.screenshot({path:`${out}/trace-${w}.png`});await noX('пропись');
  // --- по памяти: знак
  await p.evaluate("W.mode='recall';W.rmode='char';render()");await p.waitForTimeout(300);
  let good=0,tot=0;
  for(const ch of ['大','人','十','日','水','你','我','好','学','生','是','国']){await p.evaluate(c=>{const l=writeChars(W.lvl).concat(writeChars(1),writeChars(2));let found=false;for(const lv of [1,2,3,4,5,6]){const L=writeChars(lv);const i=L.findIndex(x=>x.c===c);if(i>=0){W.lvl=lv;W.i=i;found=true;break}}render()},ch);await p.waitForTimeout(120);
    const has=await p.evaluate(c=>{const ch=wInit().ch;return ch&&ch.c===c},ch);if(!has)continue;
    box=await rect(p,'#sq');await draw(p,ch,box);await p.click('[data-a=wcheck]');await p.waitForTimeout(200);tot++;const txt=await p.innerText('#wver');if(/Верно|Засчитано/.test(txt))good++;else console.log('   промах',ch,txt.slice(0,80))}
  ok(tot>=8&&good/tot>=.85,`по памяти: засчитано ${good} из ${tot} @${w}`);
  // неверный знак → «Не то» и анимация
  await p.evaluate("W.set=false;W.lvl=1;W.i=0;render()");const tgt=await p.evaluate(()=>wInit().ch.c);const wrong=tgt==='大'?'人':'大';
  box=await rect(p,'#sq');await draw(p,wrong,box);await p.click('[data-a=wcheck]');await p.waitForTimeout(300);
  ok(/Не то/.test(await p.innerText('#wver')),'чужой знак не засчитан ('+wrong+' вместо '+tgt+')');ok(await p.evaluate(()=>!!document.querySelector('#wanim2 .animc, #wver .animc')),'после ошибки показана анимация');
  await p.screenshot({path:`${out}/recall-${w}.png`});await noX('по памяти');
  // --- диктант целого предложения
  await p.evaluate("startDictation()");await p.waitForTimeout(400);
  const task=await p.evaluate(()=>BD.task);ok(task&&task.chars.length>=2,'диктант: '+task.zh+' / '+task.ru);
  box=await rect(p,'#bd');const [DW,DH]=await p.evaluate(()=>bdDim()),g=await p.evaluate(()=>bdGeo());
  for(let i=0;i<task.chars.length;i++){const r=Math.floor(i/g.cols),c=i%g.cols;const cb={x:box.x+(g.ox+c*g.cell)*box.w/DW,y:box.y+(g.oy+r*g.rh+g.ph)*box.h/DH,w:g.cell*box.w/DW,h:g.cell*box.h/DH};await draw(p,task.chars[i],cb)}
  await p.fill('#bdpy',task.py);await p.click('[data-a=bdcheck]');await p.waitForTimeout(400);
  const okN=await p.evaluate(()=>BD.chk.filter(c=>c.state==='ok'||c.state==='close').length);ok(okN>=task.chars.length-1,`диктант: верно ${okN} из ${task.chars.length} @${w}`);
  ok(await p.evaluate(()=>BD.task.pyRes)==='ok','диктант: пиньинь предложения принят');
  await p.screenshot({path:`${out}/dictation-${w}.png`});
  await p.evaluate("act.bdfull()");await p.waitForTimeout(400);await noX('диктант на весь экран');await p.screenshot({path:`${out}/dictation-full-${w}.png`});
  await p.keyboard.press('Escape');await p.waitForTimeout(200);
  // --- свободная доска
  await p.evaluate("act.bdfree()");await p.waitForTimeout(300);
  box=await rect(p,'#bd');const g2=await p.evaluate(()=>bdGeo());
  const text='大人十日';for(let i=0;i<4;i++){const cb={x:box.x+(g2.ox+i*g2.cell)*box.w/DW,y:box.y+(g2.oy+g2.ph)*box.h/DH,w:g2.cell*box.w/DW,h:g2.cell*box.h/DH};await draw(p,text[i],cb)}
  await p.waitForTimeout(1700);ok(await p.evaluate(()=>bdText())==='大人十日','доска: '+await p.evaluate(()=>bdText()));await p.screenshot({path:`${out}/board-${w}.png`});
  // --- тренировка
  await p.evaluate("go('prac')");await p.waitForTimeout(300);box=await rect(p,'#sq');await draw(p,'水',box);await p.click('[data-a=prrec]');await p.waitForTimeout(500);
  ok(await p.evaluate(()=>PR.res&&PR.res[0]&&PR.res[0].c)==='水','тренировка: 水');
  // --- мои слова и тесты
  await p.evaluate("S.sel=[];go('pick')");await p.waitForTimeout(300);await p.fill('#pkq','dà');await p.waitForTimeout(200);
  const firstRow=await p.$('.pkrow input');await firstRow.check();ok(await p.evaluate(()=>S.sel.length)===1,'выбор слова отмечается');
  await p.click('[data-a=pall]');ok(await p.evaluate(()=>S.sel.length)>=1,'выбрать всё в списке');
  await p.fill('#pkq','');await p.evaluate("PK.lvl=1;PK.unit='';render()");await p.click('[data-a=plearned]');
  await p.evaluate("S.sel=WORDS.filter(w=>w.lvl===1&&!w.gr&&!w.chr).slice(0,3).map(w=>w.id);render()");await p.screenshot({path:`${out}/pick-${w}.png`});await noX('мои слова');
  await p.evaluate("tsStart('hand',{n:0})");await p.waitForTimeout(300);
  const hc=await p.evaluate(()=>tsCur().c),hpy=await p.evaluate(()=>tsCur().py);box=await rect(p,'#sq');await draw(p,hc,box);await p.fill('#tspy',hpy);await p.click('[data-a=tshcheck]');await p.waitForTimeout(300);
  ok(await p.evaluate(()=>TS.res[0]&&TS.res[0].ok),'тест «прописать»: знак '+hc+' + пиньинь засчитаны');await p.screenshot({path:`${out}/test-hand-${w}.png`});await noX('тест');
  // --- репетитор с подставным сервером
  await p.evaluate("go('tutor')");await p.waitForTimeout(300);await p.fill('#tuin','сделай тест');await p.click('.tuform button');await p.waitForTimeout(600);
  ok(await p.evaluate(()=>!!document.querySelector('[data-a=tutest]')),'репетитор: пришёл тест с кнопкой запуска @'+w);ok(lastUpstream&&lastUpstream.headers['x-api-key']==='test-key'&&/Контекст ученика/.test(lastUpstream.body.system)&&lastUpstream.body.system.includes('selected')&&lastUpstream.body.messages.at(-1).content==='сделай тест','сервер передал ключ, контекст и вопрос в Claude');await p.screenshot({path:`${out}/tutor-${w}.png`});await noX('репетитор');
  await p.click('[data-a=tutest]');await p.waitForTimeout(300);ok(await p.evaluate(()=>TS&&TS.ai&&TS.queue.length>=4),'тест репетитора запускается: '+await p.evaluate(()=>TS.queue.length)+' заданий');
  await p.close()}
console.log(errs.length?errs:'ошибок в консоли нет');process.exitCode=fails.length||errs.length?1:0;await b.close();servers.forEach(x=>x.close());process.exit(process.exitCode||0)})();
function innerWidthOf(w){return 1}
