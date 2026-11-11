// Загружает скрипт из index.html в Node с заглушками DOM, звука и платформы Claude.
const fs=require('fs'),path=require('path');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const js=html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\nbuildChars\(\);\s*render\(\);\s*cloudInit\(\);\s*$/,'\nbuildChars();\n');
const store={};global.localStorage={getItem:k=>store[k]||null,setItem:(k,v)=>store[k]=v};
global.speechSynthesis={cancel(){},speak(){},getVoices(){return[]}};global.SpeechSynthesisUtterance=function(){};global.performance={now:()=>Date.now()};
const el={set innerHTML(v){},hidden:true,click(){},value:'',focus(){},classList:{add(){},remove(){}},offsetWidth:0,textContent:'',scrollTop:0,scrollHeight:0};
global.document={addEventListener(){},querySelector(){return el},documentElement:{}};global.window={addEventListener(){},scrollTo(){}};global.innerWidth=1280;global.innerHeight=900;
module.exports=body=>eval(js+'\n'+body);
