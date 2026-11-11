// npm run rec [шум] [знаков] — точность распознавания на «рукописных» штрихах, собранных из осевых линий черт с искажениями
// (наклон, растяжение, дрожание, слитные и разорванные штрихи). Шум 1 — обычный, 1.5 — неряшливый. Браузер не нужен.
const run=require('./harness'),LEVEL=+process.argv[2]||1,N=+process.argv[3]||400;
run(`
const LEVEL=${LEVEL},NN=${N};let seed=7;const rn=()=>(seed=(seed*16807)%2147483647)/2147483647,gs=()=>(rn()+rn()+rn()-1.5)*1.6;
function sim(c){const m=medOf(c).map(s=>s.map(p=>[p[0]*100,p[1]*100]));
  const th=(rn()-.5)*.30*LEVEL,sh=(rn()-.5)*.26*LEVEL,sx=1+(rn()-.5)*.30*LEVEL,sy=1+(rn()-.5)*.30*LEVEL,ax=rn()*2.2*LEVEL,ph=rn()*6;
  let st=m.map(s=>{const a=s[0],b=s[s.length-1],ex=(rn()-.5)*.10*LEVEL;const o=s.map((p,i)=>{const u=i/(s.length-1);return[p[0]+(b[0]-a[0])*ex*(u-.5)*2,p[1]+(b[1]-a[1])*ex*(u-.5)*2]});const ox=gs()*1.6*LEVEL,oy=gs()*1.6*LEVEL;return o.map(p=>[p[0]+ox+gs()*.5*LEVEL,p[1]+oy+gs()*.5*LEVEL])});
  if(st.length>2&&rn()<.12*LEVEL){const i=Math.floor(rn()*(st.length-1));st.splice(i,2,st[i].concat(st[i+1]))}
  if(rn()<.06*LEVEL){const i=Math.floor(rn()*st.length),s=st[i];if(s.length>4){const k=Math.floor(s.length/2);st.splice(i,1,s.slice(0,k+1),s.slice(k+1))}}
  return st.map(s=>s.map(([x,y])=>{let px=x-50,py=y-50;px+=sh*py;const qx=(px*Math.cos(th)-py*Math.sin(th))*sx,qy=(px*Math.sin(th)+py*Math.cos(th))*sy;return[qx+ax*Math.sin(py/18+ph)+gs()*.4*LEVEL,qy+ax*Math.sin(px/22+ph)+gs()*.4*LEVEL]}))}
recBuild(CHARS.map(x=>x.c));REC.act=recActive();const cs=REC.tpl.map(t=>t.c);let t1=0,t3=0,okV=0,fa=0,n=0;const bad=[];
// ближайший по форме «двойник» каждого знака — им проверяем, не засчитывается ли чужой
const twin={};REC.tpl.forEach(t=>{twin[t.c]=REC.tpl.filter(x=>x!==t).map(x=>({c:x.c,s:recDist(t,x)})).sort((a,b)=>a.s-b.s)[0].c});
for(let i=0;i<NN;i++){const c=cs[Math.floor(rn()*cs.length)],st=sim(c);if(!recPrep(st))continue;n++;
  const r=recMatch(st,3);if(r[0].c===c)t1++;else if(bad.length<10)bad.push(c+'→'+r[0].c);if(r.some(x=>x.c===c))t3++;
  const v=recVerify(st,c);if(v.state==='ok'||v.state==='close')okV++;const w=recVerify(st,twin[c]);if(w.state==='ok'||w.state==='close')fa++}
console.log('шум',LEVEL,'знаков',n);
console.log('узнан первым',(100*t1/n).toFixed(1)+'%','в тройке',(100*t3/n).toFixed(1)+'%');
console.log('проверка нужного знака: засчитано',(100*okV/n).toFixed(1)+'%','| ближайший двойник ошибочно засчитан',(100*fa/n).toFixed(1)+'%');
console.log('промахи:',bad.join(' '));
process.exitCode=(LEVEL<=1&&(t1/n<.95||okV/n<.97))?1:0;`)
