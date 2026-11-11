// npm run screens — скриншоты ключевых экранов (нужен Playwright + Chromium).
const {chromium}=require('playwright'),path=require('path'),fs=require('fs');
(async()=>{const b=await chromium.launch(),errs=[],out=path.join(__dirname,'..','screens');fs.mkdirSync(out,{recursive:true});
const cases=[['today',"go('today')"],['sprint',"go('sprint')"],['day1',"act.sprstart()"],['families',"act.sprstart();act.sprtab({t:'fam'})"],['write',"go('write')"],['chars',"go('chars')"]];
for(const w of [1280,390])for(const [n,c] of cases){const p=await b.newPage({viewport:{width:w,height:1000}});p.on('pageerror',e=>errs.push(n+': '+e.message));
 await p.goto('file://'+path.join(__dirname,'..','index.html'));await p.waitForTimeout(800);await p.evaluate(c);await p.waitForTimeout(600);
 const sw=await p.evaluate(()=>document.documentElement.scrollWidth);if(sw>w)errs.push(`${n}@${w}: горизонтальный скролл ${sw}px`);await p.screenshot({path:`${out}/${n}-${w}.png`})}
console.log(errs.length?errs:'Скриншоты в папке screens/, ошибок нет');await b.close()})();
