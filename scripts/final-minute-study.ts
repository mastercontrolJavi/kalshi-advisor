import Database from 'better-sqlite3';
import {normalCDF} from '../src/engine/model/math';
/**
 * Late-round model study (2026-10-21), on the 1-s live journal: which price is the best forecast of the settlement in
 * the last 5 minutes? `npx tsx scripts/final-minute-study.ts`
 *  - model: the app's averaging model as journaled (settles on the 60-s average; uncertainty from BTC volatility only).
 *  - model + basis b: the same with the app-price → BRTI error (sd b dollars) added to the variance. The app's 4-venue
 *    price misses the settlement average by a median $2.3 (p90 $5.8), so a confident model near the target is overconfident.
 *  - point digital: the textbook binary price N(d2) on spot at expiry — what Leisen-Reimer and Cox-Ross-Rubinstein trees
 *    converge to. It ignores Kalshi's 60-s averaging.
 *  - Kalshi: the journaled mid (when the book was two-sided and tight).
 * One sample per round per 5 s; 95% ranges resample whole rounds. Fit b on the first half of rounds, score the second.
 */
const db=new Database(process.env.ADVISOR_DB??'data/advisor.db',{readonly:true});
const res=new Map((db.prepare("SELECT ticker,result FROM outcomes WHERE ticker LIKE 'KXBTC15M%' AND result IN ('yes','no')").all() as {ticker:string;result:string}[]).map(r=>[r.ticker,r.result==='yes'?1:0]));
type Row={ticker:string;time:number;tau:number;proxy:number;k:number;sigma:number;p:number;mid:number|null;spread:number|null;ex:number;v:number};
const rows=db.prepare(`SELECT ticker,time,tau,proxy,k,sigma,p,json_extract(context,'$.book.yesBid') yb,json_extract(context,'$.book.yesAsk') ya,
  json_extract(context,'$.model.expected') ex,json_extract(context,'$.model.variance') v FROM ticks INDEXED BY ticks_market_tau
  WHERE tau<=300 AND tau>0 AND p IS NOT NULL AND proxy IS NOT NULL AND k IS NOT NULL AND sigma>0`).all() as any[];
const seen=new Set<string>(),samples:(Row&{y:number;basis:number})[]=[],basisOf=new Map<string,number[]>();
for(const r of rows)if(r.tau>60&&r.ex)(basisOf.get(r.ticker)??basisOf.set(r.ticker,[]).get(r.ticker)!).push(r.ex-r.proxy);
const med=(xs:number[])=>{const s=[...xs].sort((a,b)=>a-b);return s[Math.floor(s.length/2)];};
for(const r of rows){
  const y=res.get(r.ticker);if(y===undefined||!r.ex||!(r.v>=0))continue;const key=r.ticker+'|'+Math.floor(r.tau/5);if(seen.has(key))continue;seen.add(key);
  const tight=r.yb!==null&&r.ya!==null&&r.ya-r.yb<=.1;
  samples.push({ticker:r.ticker,time:r.time,tau:r.tau,proxy:r.proxy,k:r.k,sigma:r.sigma,p:r.p,mid:tight?(r.yb+r.ya)/2:null,spread:tight?r.ya-r.yb:null,ex:r.ex,v:r.v,y,basis:med(basisOf.get(r.ticker)??[0])});
}
const clip=(p:number,lo=.01)=>Math.min(1-lo,Math.max(lo,p));
const withBasis=(s:Row,b:number)=>clip(normalCDF(Math.log(s.ex/s.k)/Math.sqrt(Math.log1p((s.v+b*b)/s.ex**2))));
const digital=(s:Row&{basis:number})=>clip(normalCDF(Math.log((s.proxy+s.basis)/s.k)/(s.sigma*Math.sqrt(s.tau))));
const brier=(xs:{p:number;y:number}[])=>xs.reduce((a,x)=>a+(x.p-x.y)**2,0)/xs.length;
const logloss=(xs:{p:number;y:number}[])=>xs.reduce((a,x)=>a-Math.log(x.y?clip(x.p,.001):1-clip(x.p,.001)),0)/xs.length;
/** Paired difference a − b in Brier with a 95% range from resampling rounds. */
function diff(xs:(Row&{y:number})[],a:(s:any)=>number,b:(s:any)=>number){
  const by=new Map<string,number[]>();for(const s of xs)(by.get(s.ticker)??by.set(s.ticker,[]).get(s.ticker)!).push((a(s)-s.y)**2-(b(s)-s.y)**2);
  const groups=[...by.values()],sums=groups.map(g=>[g.reduce((q,x)=>q+x,0),g.length]);const tot=sums.reduce((q,[s,n])=>[q[0]+s,q[1]+n],[0,0]);
  let seed=7;const rnd=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;const boot:number[]=[];
  for(let i=0;i<1000;i++){let s=0,n=0;for(let j=0;j<sums.length;j++){const g=sums[Math.floor(rnd()*sums.length)];s+=g[0];n+=g[1];}boot.push(s/n);}boot.sort((x,y)=>x-y);
  return {d:tot[0]/tot[1],lo:boot[25],hi:boot[974]};
}
const buckets=[[300,121],[120,61],[60,31],[30,11],[10,0]] as const;
const tickers=[...new Set(samples.map(s=>s.ticker))].sort((a,b)=>samples.find(s=>s.ticker===a)!.time-samples.find(s=>s.ticker===b)!.time);
const firstHalf=new Set(tickers.slice(0,Math.floor(tickers.length/2)));
console.log(`${samples.length} samples on ${tickers.length} settled rounds (one per round per 5 s, last 5 min).\n`);
// 1. Fit the basis sd on the first half (Brier, last 2 min where it matters).
const bs=[0,1,2,3,4,5,6,8,10];
const fit=bs.map(b=>({b,brier:brier(samples.filter(s=>firstHalf.has(s.ticker)&&s.tau<=120).map(s=>({p:withBasis(s,b),y:s.y})))}));
console.log('First half, last 2 min — Brier by basis sd: '+fit.map(f=>`$${f.b}: ${f.brier.toFixed(5)}`).join(' · '));
const best=fit.reduce((a,b)=>b.brier<a.brier?b:a).b;console.log(`Best basis sd on the first half: $${best}\n`);
// 2. Score on the second half, by time left.
console.log('Second half (held out). Brier (log loss) — lower is better:');
console.log('time left   n     model            model+basis      point digital    Kalshi mid (n)');
for(const [hi,lo] of buckets){const xs=samples.filter(s=>!firstHalf.has(s.ticker)&&s.tau<=hi&&s.tau>=lo),km=xs.filter(s=>s.mid!==null);
  const f=(g:(s:any)=>number,ys=xs)=>`${brier(ys.map(s=>({p:g(s),y:s.y}))).toFixed(4)} (${logloss(ys.map(s=>({p:g(s),y:s.y}))).toFixed(3)})`;
  console.log(`${String(hi).padStart(3)}–${String(lo).padEnd(3)}s ${String(xs.length).padStart(5)}  ${f(s=>s.p)}  ${f(s=>withBasis(s,best))}  ${f(digital)}  ${km.length?f(s=>s.mid,km):'—'} (${km.length})`);}
console.log('\nPaired Brier differences on the held-out half (negative = first is better), 95% range over rounds:');
const held=samples.filter(s=>!firstHalf.has(s.ticker));
for(const [hi,lo] of buckets){const xs=held.filter(s=>s.tau<=hi&&s.tau>=lo),km=xs.filter(s=>s.mid!==null);
  const a=diff(xs,s=>withBasis(s,best),s=>s.p),b=diff(xs,s=>s.p,digital),c=diff(km,s=>withBasis(s,best),s=>s.mid);
  const t=(x:{d:number;lo:number;hi:number})=>`${x.d>=0?'+':''}${x.d.toFixed(4)} [${x.lo.toFixed(4)} … ${x.hi.toFixed(4)}]`;
  console.log(`${String(hi).padStart(3)}–${String(lo).padEnd(3)}s  model+basis − model ${t(a)} · model − point digital ${t(b)} · model+basis − Kalshi ${t(c)}`);}
// 3. Overconfidence: how often a ≥ 97% (or ≤ 3%) call lost.
for(const [name,g] of [['model',(s:any)=>s.p],['model+basis',(s:any)=>withBasis(s,best)],['Kalshi',(s:any)=>s.mid]] as const){
  const xs=held.filter(s=>s.tau<=60&&(name!=='Kalshi'||s.mid!==null)).map(s=>({p:g(s),y:s.y})).filter(x=>x.p>=.97||x.p<=.03);
  const lost=xs.filter(x=>(x.p>=.5?1:0)!==x.y).length;console.log(`${name}: ${xs.length} calls at ≥97% or ≤3% in the last minute, ${lost} lost (${(lost/xs.length*100).toFixed(1)}%; the calls imply ≤3%)`);}
