import {probability} from '../engine/model/math';
import {fee} from '../engine/model/fees';
import {predict,priorFit} from '../engine/quant/stack';
import type {MarketRow,CandleRow,SpotRow} from './history';
/**
 * Backtest replay on 1-minute data. Each decision point is the close of a Kalshi 1-minute candle (its last YES bid/ask)
 * with the Coinbase price at that instant. The live engine prices from a 1-s, 4-venue median; here spot is Coinbase
 * corrected by a Coinbase→BRTI basis learned from each round's published opening average, and volatility comes from
 * 1-minute returns (which already carries the multi-second variance the live variance ratio corrects for). The model,
 * fee and quant-blend functions are the app's own.
 */
export interface SpotSeries {start:number;close:Float64Array;typical:Float64Array;var1m:Float64Array}
/** Minute-indexed spot with an EWMA (half-life in minutes) of squared 1-minute log returns, blended with the trailing mean. */
export function spotSeries(rows:SpotRow[],halfLife=30,blend=.25,window=120):SpotSeries{
  if(!rows.length)throw new Error('No spot data');
  const start=rows[0].ts,len=Math.floor((rows[rows.length-1].ts-start)/60)+1;
  const close=new Float64Array(len).fill(NaN),typical=new Float64Array(len).fill(NaN),var1m=new Float64Array(len).fill(NaN);
  for(const r of rows){const i=(r.ts-start)/60;if(Number.isInteger(i)){close[i]=r.close;typical[i]=(r.open+r.high+r.low+r.close)/4;}}
  const alpha=1-Math.exp(-Math.LN2/halfLife),sq=new Float64Array(len).fill(NaN);let ewma=NaN,sum=0,count=0;
  for(let i=1;i<len;i++){
    if(Number.isFinite(close[i])&&Number.isFinite(close[i-1])){const r=Math.log(close[i]/close[i-1]);sq[i]=r*r;ewma=Number.isFinite(ewma)?(1-alpha)*ewma+alpha*r*r:r*r;sum+=r*r;count++;}
    const old=i-window;if(old>=1&&Number.isFinite(sq[old])){sum-=sq[old];count--;}
    if(Number.isFinite(ewma)&&count>=30)var1m[i]=(1-blend)*ewma+blend*sum/count;
  }
  return {start,close,typical,var1m};
}
/** BTC price at instant ts (close of the Coinbase minute ending at ts) and per-√second volatility known then. */
export function spotAt(s:SpotSeries,ts:number){
  const i=(ts-60-s.start)/60;if(!Number.isInteger(i)||i<0||i>=s.close.length)return null;
  const price=s.close[i],v=s.var1m[i];return Number.isFinite(price)&&Number.isFinite(v)?{price,sigma:Math.sqrt(v/60)}:null;
}
/**
 * Coinbase→BRTI basis. Every round publishes K = the BRTI average of the 60 s before it opened, so K minus the
 * Coinbase typical price of that minute is one basis observation known at the open. The correction is the rolling
 * median of the last `window` observations; basisAt(ts) uses only rounds that had opened by ts.
 */
export function basisTrack(markets:MarketRow[],s:SpotSeries,window=96){
  const pts:{ts:number;basis:number;raw:number}[]=[],recent:number[]=[];
  for(const m of [...markets].sort((a,b)=>a.open_ts-b.open_ts)){
    const i=(m.open_ts-60-s.start)/60;if(m.strike===null||!Number.isInteger(i)||!Number.isFinite(s.typical[i]))continue;
    const raw=m.strike-s.typical[i];recent.push(raw);if(recent.length>window)recent.shift();pts.push({ts:m.open_ts,basis:median(recent),raw});
  }
  const at=(ts:number)=>{let lo=0,hi=pts.length-1,best:number|null=null;while(lo<=hi){const mid=(lo+hi)>>1;if(pts[mid].ts<=ts){best=pts[mid].basis;lo=mid+1;}else hi=mid-1;}return best;};
  return {at,points:pts};
}
export function median(a:number[]){if(!a.length)return NaN;const s=[...a].sort((x,y)=>x-y),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;}
export interface Row {cluster:string;ticker:string;time:number;tau:number;y:0|1;strike:number;spot:number;sigma:number;basis:number;model:number;quant:number;bid:number|null;ask:number|null;mid:number|null}
const valid=(x:number|null)=>x!==null&&x>0&&x<1?x:null;
/** Quote at a candle: bid/ask only when two-sided; mid only when the spread is ≤ 10¢ (as the live quant blend requires). */
export function quote(c:Pick<CandleRow,'bid'|'ask'>){
  const bid=valid(c.bid),ask=valid(c.ask),ok=bid!==null&&ask!==null&&ask>bid;
  return {bid:ok?bid:null,ask:ok?ask:null,mid:ok&&ask!-bid!<=.1+1e-9?(bid!+ask!)/2:null};
}
export function modelP(spot:number,strike:number,sigma:number,tau:number,basis:number,varianceScale=1){return probability(spot,strike,sigma*Math.sqrt(varianceScale),tau,[],basis).p;}
export const quantP=(model:number,mid:number|null,sigma:number)=>predict(priorFit(),{modelP:model,mid,sigma,momentum30s:null,momentum120s:null,imbalance:null,tradeFlow30s:null}).p;
/**
 * One row per market per minute with at least 60 s left. `cluster` groups rows that share an outcome driver: the
 * round for 15-minute markets. When `band` is set, strikes are kept only within that many dollars of the
 * corrected spot at that minute (a decision-time filter, so no look-ahead).
 */
export function buildRows(markets:MarketRow[],candles:Map<string,CandleRow[]>,s:SpotSeries,basisAt:(ts:number)=>number|null,opts:{cluster:'ticker'|'event';band?:number;varianceScale?:number}={cluster:'ticker'}):Row[]{
  const rows:Row[]=[];
  for(const m of markets){
    if(m.strike===null||(m.result!=='yes'&&m.result!=='no'))continue;const y=m.result==='yes'?1:0;
    for(const c of candles.get(m.ticker)??[]){
      const tau=m.close_ts-c.ts;if(tau<60||c.ts<=m.open_ts)continue;
      const sp=spotAt(s,c.ts),basis=basisAt(c.ts);if(!sp||basis===null)continue;
      if(opts.band!==undefined&&Math.abs(m.strike-(sp.price+basis))>opts.band)continue;
      const q=quote(c),model=modelP(sp.price,m.strike,sp.sigma,tau,basis,opts.varianceScale);
      rows.push({cluster:opts.cluster==='event'?m.event??m.ticker:m.ticker,ticker:m.ticker,time:c.ts,tau,y,strike:m.strike,spot:sp.price,sigma:sp.sigma,basis,model,quant:quantP(model,q.mid,sp.sigma),...q});
    }
  }
  return rows;
}
/** Deterministic PRNG so reports are reproducible. */
export function rng(seed=1){let a=seed>>>0;return ()=>{a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};}
/** 95% percentile CI of Σvalue/Σweight, resampling whole clusters (markets or hours), never individual rows. */
export function clusterCI(groups:{sum:number;n:number}[],B=1000,seed=1):[number,number]{
  if(groups.length<2)return [NaN,NaN];const r=rng(seed),stats:number[]=[];
  for(let b=0;b<B;b++){let s=0,n=0;for(let i=0;i<groups.length;i++){const g=groups[Math.floor(r()*groups.length)];s+=g.sum;n+=g.n;}stats.push(n?s/n:NaN);}
  stats.sort((x,y)=>x-y);return [stats[Math.floor(B*.025)],stats[Math.min(B-1,Math.floor(B*.975))]];
}
function grouped<T extends {cluster:string}>(items:T[],value:(t:T)=>number){const g=new Map<string,{sum:number;n:number}>();for(const t of items){const x=g.get(t.cluster)??{sum:0,n:0};x.sum+=value(t);x.n++;g.set(t.cluster,x);}return [...g.values()];}
export interface Score {label:string;n:number;clusters:number;model:number;quant:number;kalshi:number;diff:number;diffCI:[number,number]}
/** Brier scores on rows with a usable Kalshi mid; diff = model − Kalshi (negative means the model forecast better). */
export function scoreBy(rows:Row[],bucket:(r:Row)=>string|null,order:string[]):Score[]{
  const by=new Map<string,Row[]>();for(const r of rows){if(r.mid===null)continue;const b=bucket(r);if(b===null)continue;const l=by.get(b);if(l)l.push(r);else by.set(b,[r]);}
  return order.filter(b=>by.has(b)).map(label=>{const l=by.get(label)!,b=(p:number,y:number)=>(p-y)**2,avg=(f:(r:Row)=>number)=>l.reduce((s,r)=>s+f(r),0)/l.length;
    return {label,n:l.length,clusters:new Set(l.map(r=>r.cluster)).size,model:avg(r=>b(r.model,r.y)),quant:avg(r=>b(r.quant,r.y)),kalshi:avg(r=>b(r.mid!,r.y)),diff:avg(r=>b(r.model,r.y)-b(r.mid!,r.y)),diffCI:clusterCI(grouped(l,r=>b(r.model,r.y)-b(r.mid!,r.y)))};});
}
export interface Bucket {lo:number;hi:number;n:number;clusters:number;price:number;win:number;pnl:number;ci:[number,number]}
/** Buy-at-the-ask outcomes by price paid, both sides of every quote: is a P¢ contract really worth P¢ after the fee? */
export function priceBuckets(rows:Row[],edges=[0,.05,.1,.2,.3,.4,.5,.6,.7,.8,.9,.95,1],minTau=60,maxTau=Infinity):Bucket[]{
  const buys:{cluster:string;price:number;win:number;pnl:number}[]=[];
  for(const r of rows){if(r.bid===null||r.ask===null||r.tau<minTau||r.tau>maxTau)continue;
    for(const [price,win] of [[r.ask,r.y],[sideAsk(r,'no')!,1-r.y]] as const)buys.push({cluster:r.cluster,price,win,pnl:win-price-fee(price)});}
  return edges.slice(0,-1).map((lo,i)=>{const hi=edges[i+1],l=buys.filter(b=>b.price>=lo&&(b.price<hi||(hi===1&&b.price<=1)));if(!l.length)return null;
    const avg=(f:(b:typeof l[0])=>number)=>l.reduce((s,b)=>s+f(b),0)/l.length;
    return {lo,hi,n:l.length,clusters:new Set(l.map(b=>b.cluster)).size,price:avg(b=>b.price),win:avg(b=>b.win),pnl:avg(b=>b.pnl),ci:clusterCI(grouped(l,b=>b.pnl))};}).filter((b):b is Bucket=>!!b);
}
export interface Calibration {lo:number;hi:number;n:number;forecast:number;actual:number}
export function calibration(rows:Row[],p:(r:Row)=>number|null,edges=[0,.05,.1,.2,.3,.4,.5,.6,.7,.8,.9,.95,1]):Calibration[]{
  return edges.slice(0,-1).map((lo,i)=>{const hi=edges[i+1],l=rows.filter(r=>{const x=p(r);return x!==null&&x>=lo&&(x<hi||(hi===1&&x<=1));});if(!l.length)return null;
    return {lo,hi,n:l.length,forecast:l.reduce((s,r)=>s+p(r)!,0)/l.length,actual:l.reduce((s,r)=>s+r.y,0)/l.length};}).filter((c):c is Calibration=>!!c);
}
export interface Choice {side:'yes'|'no';price:number;score:number}
export type Picker=(r:Row,prev:Row|undefined)=>Choice|null;
export interface ExitRule {tp?:number;sl?:number;stopWinProb?:number;trail?:{giveback:number;floor:number}}
export interface Trade {cluster:string;ticker:string;time:number;tau:number;side:'yes'|'no';price:number;cost:number;exitTau:number|null;exitReason:string|null;pnl:number;win:boolean}
/** Side prices from a YES quote: NO ask = 1 − YES bid, NO bid = 1 − YES ask. */
const flip=(x:number)=>Math.round((1-x)*1e4)/1e4;
export const sideAsk=(r:Row,side:'yes'|'no')=>side==='yes'?r.ask:r.bid===null?null:flip(r.bid);
export const sideBid=(r:Row,side:'yes'|'no')=>side==='yes'?r.bid:r.ask===null?null:flip(r.ask);
/** Net taker edge for each side under forecast p (the app's BUY arithmetic). */
export function edges(r:Row,p:number){const ya=sideAsk(r,'yes'),na=sideAsk(r,'no');return {yes:ya===null?null:p-ya-fee(ya),no:na===null?null:1-p-na-fee(na)};}
/**
 * One entry per cluster: walk minutes forward, take the best-scoring pick at the first minute that has any, then hold to
 * settlement or until the exit rule fires on a later minute's bid (sold at the bid minus the taker fee).
 */
export function simulate(rows:Row[],pick:Picker,exit?:ExitRule):Trade[]{
  const byCluster=new Map<string,Row[]>();for(const r of rows){const l=byCluster.get(r.cluster);if(l)l.push(r);else byCluster.set(r.cluster,[r]);}
  const trades:Trade[]=[];
  for(const [cluster,list] of byCluster){
    list.sort((a,b)=>a.time-b.time||a.ticker.localeCompare(b.ticker));const prev=new Map<string,Row>();let entry:{r:Row;p:Choice}|null=null;
    for(let i=0;i<list.length&&!entry;){const t=list[i].time;let best:{r:Row;p:Choice}|null=null;
      for(;i<list.length&&list[i].time===t;i++){const r=list[i],p=pick(r,prev.get(r.ticker));prev.set(r.ticker,r);if(p&&(!best||p.score>best.p.score))best={r,p};}
      entry=best;}
    if(!entry)continue;
    const {r,p}=entry,cost=p.price+fee(p.price),win=(p.side==='yes'?r.y:1-r.y)===1;let pnl=(win?1:0)-cost,exitTau:number|null=null,exitReason:string|null=null;
    if(exit){
      // Arm level as in the live exit plan: min(take-profit %, half the gain a 99¢ bid would give); none if no gain is possible.
      const maxGain=(.99-fee(.99)-cost)/cost,arm=exit.tp!==undefined&&maxGain>0?Math.min(exit.tp,maxGain/2):Infinity;let peak=-Infinity;
      for(const later of list){if(later.ticker!==r.ticker||later.time<=r.time)continue;const bid=sideBid(later,p.side);if(bid===null)continue;
        const value=bid-fee(bid),gain=(value-cost)/cost,prob=p.side==='yes'?later.quant:1-later.quant;let reason:string|null=null;
        if(exit.trail&&peak>=arm){peak=Math.max(peak,gain);if(gain<=Math.max(exit.trail.floor,peak*(1-exit.trail.giveback)))reason='trailing take profit';}
        else if(exit.tp!==undefined&&gain>=arm){if(exit.trail)peak=gain;else reason='take profit';}
        if(!reason&&exit.sl!==undefined&&gain<=-exit.sl)reason='cut loss';
        if(!reason&&exit.stopWinProb!==undefined&&prob<exit.stopWinProb&&bid>=.05)reason='win chance low';
        if(reason){pnl=value-cost;exitTau=later.tau;exitReason=reason;break;}}
    }
    trades.push({cluster,ticker:r.ticker,time:r.time,tau:r.tau,side:p.side,price:p.price,cost,exitTau,exitReason,pnl,win});
  }
  return trades.sort((a,b)=>a.time-b.time);
}
export interface Summary {n:number;winRate:number;mean:number;ci:[number,number];total:number;avgPrice:number;early:number;late:number;exited:number}
/** Per-contract results; early/late are the means before and after `split` (a stability check across the period). */
export function summarize(trades:Trade[],split:number,seed=1):Summary{
  const n=trades.length,mean=(l:Trade[])=>l.length?l.reduce((s,t)=>s+t.pnl,0)/l.length:NaN;
  return {n,winRate:n?trades.filter(t=>t.pnl>0).length/n:NaN,mean:mean(trades),ci:clusterCI(trades.map(t=>({sum:t.pnl,n:1})),2000,seed),total:trades.reduce((s,t)=>s+t.pnl,0),
    avgPrice:n?trades.reduce((s,t)=>s+t.price,0)/n:NaN,early:mean(trades.filter(t=>t.time<split)),late:mean(trades.filter(t=>t.time>=split)),exited:trades.filter(t=>t.exitTau!==null).length};
}
/**
 * A holder's question, independent of how the position was entered: on the first second/minute in [minTau, maxTau] where
 * the forecast says one side is worth ≥ gap less than its bid nets after the taker fee (bid ≥ 5¢), what did selling earn
 * versus holding to settlement? One sample per round and side; positive = selling did better.
 */
export function sellVsHold(rows:Row[],p:(r:Row)=>number,gap:number,minTau:number,maxTau:number,split:number,seed=3):Summary{
  const by=new Map<string,Row[]>();for(const r of rows){const l=by.get(r.ticker);if(l)l.push(r);else by.set(r.ticker,[r]);}
  const trades:Trade[]=[];
  for(const [,list] of by){list.sort((a,b)=>a.time-b.time);for(const side of ['yes','no'] as const)for(const r of list){
    if(r.tau<minTau||r.tau>maxTau)continue;const bid=sideBid(r,side);if(bid===null||bid<.05)continue;
    const worth=side==='yes'?p(r):1-p(r),net=bid-fee(bid);if(net-worth<gap)continue;
    const won=(side==='yes'?r.y:1-r.y)===1;trades.push({cluster:r.cluster,ticker:r.ticker,time:r.time,tau:r.tau,side,price:bid,cost:1,exitTau:r.tau,exitReason:'sell',pnl:net-(won?1:0),win:net>(won?1:0)});break;}}
  return summarize(trades,split,seed);
}
/** The app's taker BUY rule: best side with net edge ≥ minEdge, spread ≤ maxSpread, ≥ 60 s left, inside the entry window or edge ≥ earlyEdge. */
export function appRule(p:(r:Row)=>number,o={minEdge:.04,earlyEdge:.08,maxSpread:.06,windowMax:900}):Picker{
  return r=>{if(r.tau<60||r.bid===null||r.ask===null||r.ask-r.bid>o.maxSpread+1e-9)return null;const e=edges(r,p(r));
    const side=(e.yes??-1)>=(e.no??-1)?'yes':'no',edge=(side==='yes'?e.yes:e.no)??-1;
    if(edge<o.minEdge||(r.tau>o.windowMax&&edge<o.earlyEdge))return null;return {side,price:sideAsk(r,side)!,score:edge};};
}
/** Buy whichever side's ask is in [lo, hi) while time left is in [minTau, maxTau]. */
export function priceBand(lo:number,hi:number,minTau:number,maxTau:number,maxSpread=.06):Picker{
  return r=>{if(r.tau<minTau||r.tau>maxTau||r.bid===null||r.ask===null||r.ask-r.bid>maxSpread+1e-9)return null;
    for(const side of ['yes','no'] as const){const a=sideAsk(r,side)!;if(a>=lo&&a<hi)return {side,price:a,score:side==='yes'?r.ask!:1-r.bid!};}return null;};
}
export interface Bankroll {fraction:number;median:number;p10:number;p90:number;ruined:number;halved:number}
/**
 * What bet size does to an account: `runs` random sequences of `length` trades drawn from a strategy's real trades,
 * each staking `fraction` of the current balance (whole-contract rounding ignored). ruined = share of runs that fell
 * below 5% of the start at any point; halved = share that ended below half.
 */
export function bankroll(trades:Trade[],fraction:number,start=40,length=100,runs=2000,seed=7):Bankroll{
  if(!trades.length)return {fraction,median:NaN,p10:NaN,p90:NaN,ruined:NaN,halved:NaN};
  const r=rng(seed),finals:number[]=[];let ruined=0;
  for(let k=0;k<runs;k++){let bal=start,broke=false;
    for(let i=0;i<length;i++){const t=trades[Math.floor(r()*trades.length)];bal+=bal*fraction*t.pnl/t.cost;if(bal<start*.05){broke=true;bal=Math.max(0,bal);break;}}
    if(broke)ruined++;finals.push(bal);}
  finals.sort((a,b)=>a-b);const q=(x:number)=>finals[Math.min(runs-1,Math.floor(runs*x))];
  return {fraction,median:q(.5),p10:q(.1),p90:q(.9),ruined:ruined/runs,halved:finals.filter(f=>f<start/2).length/runs};
}
/** At the first decision minute only, buy the side chosen by `choose`. */
export function atMinute(tau:number,choose:(r:Row)=>'yes'|'no'|null):Picker{
  return r=>{if(r.tau!==tau||r.bid===null||r.ask===null)return null;const side=choose(r);return side?{side,price:sideAsk(r,side)!,score:0}:null;};
}
