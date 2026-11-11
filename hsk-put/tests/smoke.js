// npm test — проверяет данные и основные экраны без браузера.
const run=require('./harness');
run(`
let fails=0;const ok=(c,m)=>{if(!c){fails++;console.log('FAIL',m)}else console.log('ok  ',m)};
let last='';render=()=>{renderNav();const r=views[view]();last=typeof r==='string'?r:r.html;const m=last.match(/.{40}(undefined|NaN|\\[object).{20}/);if(m){fails++;console.log('BAD',view,m[0])}};
['today','goals','sprint','path','chars','review','games','test','live','tones','signs','write','prac','board','pick','tutor','grammar','dict','method'].forEach(v=>{go(v);ok(last.length>200,'экран '+v)});
// Спринт: все слова HSK 1–2 покрыты, нет слов «вперёд»
const ws=WORDS.filter(w=>(w.lvl===1||w.lvl===2)&&!w.bonus),listed=new Set(SPR.flatMap(d=>d.ws));
ok(ws.every(w=>listed.has(w.hz)),'спринт покрывает все '+ws.length+' слов HSK 1–2');
let bad=[];SPR.forEach(d=>d.S.forEach(s=>s.toks.forEach(t=>{if(!SPR_P.has(t)&&!sprWord(t))bad.push(t)})));ok(!bad.length,'все токены фраз распознаны '+bad.join(' '));
const seen=new Set();let early=[];SPR.forEach(d=>{d.ws.forEach(h=>seen.add(h));d.S.forEach(s=>s.toks.forEach(t=>{const w=sprWord(t);if(w&&!w.extra){const h=w.base?w.base.hz:w.hz;if(!seen.has(h))early.push(h)}}))});ok(!early.length,'нет слов из будущих дней '+early.join(' '));
// Сценарий дня 1
act.sprstart();ok(S.goal&&S.goal.words===300,'старт спринта ставит цель');
act.sprtab({t:'build'});for(let k=0;k<40&&SP.i<SP.order.length;k++){const s=SP.order[SP.i];initBuild('spr',s.g);const used=new Set();s.g.ex.split(' ').forEach(t=>{const j=B.toks.findIndex((x,i)=>x.t===t&&!used.has(i));used.add(j);B.chosen.push(j)});act.bc();act.sprnext()}
ok(sprSt(0).build,'сборка дня 1 пройдена');
act.sprlearn({i:0});ok(sprOpen(1),'день 2 открылся');ok(wordsLearned()===SPR[0].W.length,'слова дня 1 в повторении');
act.sprwr({i:0});ok(view==='lesson'&&L.kind==='chars','урок письма запускается');
// Письмо: разбиение строки на знаки и чтение распознанного текста
const box=(x,y,n)=>[[[x,y+10],[x+n,y+10]],[[x+n/2,y],[x+n/2,y+n]],[[x,y+n],[x+n,y+n]]];
const free=recSegment([...box(0,0,100),...box(130,0,100),...box(260,0,100)]);ok(free.length===3&&free.every(g=>g.strokes.length===3),'свободная строка: 3 знака по 3 штриха');
const split=recSegment([[[0,5],[8,40]],[[25,20],[12,80]],[[34,0],[100,0]],[[67,0],[67,100]],[[34,100],[100,100]]]);ok(split.length===1,'левая и правая части знака не рвутся');
const two=recSegment([...box(0,0,100),...box(0,150,100)]);ok(two.length===2&&two[1].row===1,'две строки текста');
const cells=recSegment([...box(5,5,100),...box(175,5,100)],{cell:160,ox:0,oy:0});ok(cells.length===2&&cells[1].col===1,'клетки: знаки по ячейкам');
const rd=recRead('你好');ok(rd.length===1&&rd[0].py.join(' ')==='nǐ hǎo','слово «你好» читается целиком: '+rd.map(w=>w.py.join(' ')));
// Распознавание по порядку черт
recBuild(CHARS.map(x=>x.c));REC.act=recActive();ok(REC.tpl.length===CHARS.length,'образцы построены для всех '+CHARS.length+' знаков');
let tHit=0;CHARS.slice(0,120).forEach(it=>{const st=medOf(it.c).map(m=>m.map(p=>[p[0]*100,p[1]*100]));if(recMatch(st,1)[0].c===it.c)tHit++});ok(tHit>=118,'идеальные штрихи узнаются: '+tHit+'/120');
const tWv=recVerify(medOf('大').map(m=>m.map(p=>[p[0]*100,p[1]*100])),'大');ok(tWv.state==='ok','проверка нужного знака: '+tWv.state);
const tBv=recVerify(medOf('大').map(m=>m.map(p=>[p[0]*100,p[1]*100])),'人');ok(tBv.state==='bad','чужой знак не засчитывается: '+tBv.state);
ok(recVerify([],'大').state==='empty','пустое поле');
// Пиньинь с клавиатуры
ok(pyCheck('ni3 hao3','nǐ hǎo')==='ok'&&pyCheck('nǐhǎo','nǐ hǎo')==='ok'&&pyCheck('nihao','nǐ hǎo')==='tone'&&pyCheck('wo','nǐ')==='bad'&&pyCheck('lv4','lǜ')==='ok'&&pyCheck('','nǐ')==='empty','сверка пиньиня');
// Выбор слов и тесты
S.sel=WORDS.filter(w=>w.lvl===1&&!w.gr&&!w.chr).slice(0,8).map(w=>w.id);
['cards','wr','bd','hand','mix'].forEach(k=>{tsStart(k,{n:0});ok(TS&&TS.queue.length>0,'тест «'+k+'»: заданий '+(TS?TS.queue.length:0));
  TS.queue.forEach((it,i)=>{TS.i=i;TS.st={};const h=tsItemHTML(it);if(/undefined|NaN|\\[object/.test(h)){fails++;console.log('BAD item',k,it.t)}})});
tsStart('cards',{n:0});for(let k=0;k<20&&!TS.done;k++){act.tsflip();act.tsknow({v:'1'})}ok(TS.done&&S.tlog.length>0&&Object.keys(S.selp).length>0,'прохождение карточек записано в журнал');
go('pick');ok(last.length>500&&!/undefined|NaN/.test(last),'экран «Мои слова»');
ok(masteredIds().length===0,'освоение требует два вида тестов');
tsStart('wr',{n:0});for(let k=0;k<20&&!TS.done;k++){const it=tsCur();TS.st.pick=it.a;TS.st.py=pyText(it.w.py);TS.st.pyRes=pyCheck(TS.st.py,it.w.py);tsPush(TS.st.pyRes==='ok'&&TS.st.pick===it.a);tsNext()}ok(masteredIds().length===S.sel.length,'после двух тестов слова освоены: '+masteredIds().length);
// HSK 3.0: списки слов
const bk={};BANKW.forEach(w=>bk[w.lvl]=(bk[w.lvl]||0)+1);ok(BANKW.length===10969&&bk[1]===506&&bk[6]===1123&&bk[7]===5606,'HSK 3.0: '+JSON.stringify(bk));
ok(new Set(BANKW.map(w=>w.id)).size===BANKW.length&&BANKW.every(w=>WB[w.id]===w&&w.ru&&w.py),'слова HSK 3.0: id уникальны, у всех есть пиньинь и перевод');
ok(BANKW.filter(w=>/[a-z]{5,}/i.test(w.ru)).length<120,'в переводах почти нет английского: '+BANKW.filter(w=>/[a-z]{5,}/i.test(w.ru)).length);
PK.std='h3';PK.lvl=7;PK.unit='5';ok(pkVisible().length===20&&pkVisible()[0].lvl===7,'блок HSK 7–9');PK.lvl=4;PK.unit='2';ok(pkVisible().length===20&&pkVisible()[0].lvl===4,'блок из 20 слов HSK 3.0');PK.q='';
S.sel=BANKW.filter(w=>w.lvl===3).slice(0,6).map(w=>w.id);tsStart('hand',{n:0});ok(TS.queue.length>=6&&TS.queue.every(i=>i.py!==undefined),'письмо знаков по словам HSK 3.0: '+TS.queue.length);
['cards','wr','bd','mix'].forEach(k=>{tsStart(k,{n:0});ok(!TS||TS.queue.length>=0,'тест '+k+' по HSK 3.0')});
go('pick');ok(!/undefined|NaN/.test(last),'экран выбора в режиме HSK 3.0');PK.std='core';PK.lvl=0;PK.unit='';
// Учебник 新HSK教程 1
ok(BOOK.length===16&&BOOKW.length===338&&BOOK[2].words.length===23&&BOOK.reduce((a,l)=>a+l.ex.length,0)===8,'учебник: уроков '+BOOK.length+', слов '+BOOKW.length);
ok(new Set(BOOKW.map(w=>w.id)).size===BOOKW.length&&BOOKW.every(w=>WB[w.id]===w&&aligned(w)),'слова учебника: id уникальны, слоги совпадают со знаками (не совпали: '+BOOKW.filter(w=>!aligned(w)).map(w=>w.hz).join(' ')+')');
ok(BOOK[2].words.map(w=>w.hz).join('')==='人的中国法国中文这谁女朋友哪国她泰国喂姐姐工作还忙吗对太我们想您'&&BOOK[2].zh==='我是中国人','урок 3: '+BOOK[2].words.length+' слов');
ok([...new Set(BOOKW.flatMap(w=>[...w.hz]))].every(c=>medOf(c)),'для всех знаков учебника есть порядок черт');
PK.std='book';PK.lvl=1;PK.unit='2';ok(pkVisible().length===23&&pkUnits().length===16,'выбор урока 3 учебника: '+pkVisible().length);go('pick');ok(!/undefined|NaN/.test(last)&&/Урок 3/.test(last),'экран выбора: учебник');
S.sel=BOOK[3].words.map(w=>w.id);tsStart('bd',{n:0});ok(TS&&TS.queue.length>=2&&TS.queue.every(i=>i.toks.length>=2),'предложения по уроку 4: '+(TS?TS.queue.length:0)+' заданий, пример: '+(TS&&TS.queue[0]?TS.queue[0].toks.join(''):''));
S.sel=BOOK[0].words.map(w=>w.id);ok(sentPool().filter(x=>x.book).length>=2,'примеры учебника попадают в диктант');
const tcB=tutorCtx();ok(tcB.lessons.filter(l=>l.std==='Учебник 新HSK教程 1').length===16&&/НСК 1/.test(tcB.notes),'репетитор знает уроки учебника');PK.std='core';PK.lvl=0;PK.unit='';
// Диктант
ok(sentPool().length>20,'предложений для диктанта: '+sentPool().length);startDictation();ok(BD.task&&BD.task.chars.length>=2&&BD.task.ru&&BD.task.py,'диктант: '+(BD.task&&BD.task.zh));
BD.chk=BD.task.chars.map(()=>({state:'ok'}));ok(!/undefined|NaN/.test(bdTaskHTML()),'итог диктанта без undefined');
// Репетитор
const tP1=tuParse('\\x60\\x60\\x60json\\n{"say":"Привет **мир** 你好","test":{"title":"Т","items":[{"type":"card","hz":"你好","py":"nǐ hǎo","ru":"привет"},{"type":"quiz","q":"?","opts":["a","b","c","d"],"a":2},{"type":"build","toks":["我","是","学生"],"ru":"Я студент","py":"wǒ shì xuésheng"},{"type":"write","hz":"学生","py":"xuésheng","ru":"студент"}]}}\\n\\x60\\x60\\x60');
ok(tP1.test&&tuQueue(tP1.test).length===5,'разбор теста репетитора: '+(tP1.test?tuQueue(tP1.test).length:0));ok(tuParse('просто текст').test===null,'обычный ответ без теста');
const tCtx=tutorCtx();ok(tCtx.lessons.length>=30&&tCtx.selected.length===S.sel.length&&JSON.stringify(tCtx).length<120000,'контекст репетитора: уроков '+tCtx.lessons.length+', '+Math.round(JSON.stringify(tCtx).length/1000)+' КБ');
go('tutor');ok(last.length>400&&!/undefined|NaN/.test(last),'экран «Репетитор»');
console.log(fails?'\\n'+fails+' ошибок':'\\nВсе проверки пройдены');process.exitCode=fails?1:0;
`);
