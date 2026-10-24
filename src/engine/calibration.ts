import {benchmarkScores} from './quant/benchmark-journal';
import {researchScores} from './quant/research-journal';
import type {BenchmarkCalibrationFit} from './quant/benchmark-calibration';
import type {executionStudySummary} from './quant/execution-study';
import type {Journal} from './journal';
import {mean} from './model/math';
import {wilson} from './model/opening';
import {LIVE_HORIZONS} from './model/live';
import {NEXT_HORIZONS} from './quant/forecast';
import {buildRounds} from './rounds';
import {describe,effectiveWeights,type StackFit} from './quant/stack';
export function clusterCI(rows:{ticker:string;pnl:number}[]){
  if(!rows.length)return {mean:null,low:null,high:null,markets:0,count:0};
  // Per-market sums are computed once; re-summing every market's trades inside each of the 2,000 resamples made
  // buildCalibration take 0.6–1 s on a day of data and stall the engine loop every 30 s.
  const clusters=new Map<string,{sum:number;n:number}>();for(const r of rows){const c=clusters.get(r.ticker);if(c){c.sum+=r.pnl;c.n++;}else clusters.set(r.ticker,{sum:r.pnl,n:1});}
  const groups=[...clusters.values()];
  if(groups.length<2)return {mean:mean(rows.map(r=>r.pnl)),low:null,high:null,markets:groups.length,count:rows.length};
  let seed=173;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};const samples:number[]=[];
  for(let b=0;b<2000;b++){let sum=0,n=0;for(let i=0;i<groups.length;i++){const g=groups[Math.floor(random()*groups.length)];sum+=g.sum;n+=g.n;}samples.push(sum/n);}
  samples.sort((a,b)=>a-b);return {mean:mean(rows.map(r=>r.pnl)),low:samples[50],high:samples[1949],markets:groups.length,count:rows.length};
}
export function reliability(rows:{p:number;mid:number;y:number;ticker:string}[]){
  const buckets=Array.from({length:10},(_,i)=>({bucket:`${i*10}–${(i+1)*10}%`,predicted:null as number|null,actual:null as number|null,count:0}));
  for(let i=0;i<10;i++){const group=rows.filter(r=>Math.min(9,Math.floor(r.p*10))===i);buckets[i].count=group.length;if(group.length){buckets[i].predicted=mean(group.map(r=>r.p));buckets[i].actual=mean(group.map(r=>r.y));}}
  return {buckets,count:rows.length,modelBrier:rows.length?mean(rows.map(r=>(r.p-r.y)**2)):null,marketBrier:rows.length?mean(rows.map(r=>(r.mid-r.y)**2)):null};
}
export function openingScore(rows:{ticker:string;direction:string;p:number;base_p:number;mid:number|null;result:string|null}[]){
  const settled=rows.filter(r=>r.result==='yes'||r.result==='no'),y=(r:{result:string|null})=>r.result==='yes'?1:0;
  const hits=settled.filter(r=>(r.direction==='UP')===(r.result==='yes')).length,brier=(rs:typeof settled,f:(r:any)=>number)=>rs.length?mean(rs.map(r=>(f(r)-y(r))**2)):null;
  const withMid=settled.filter(r=>r.mid!==null);
  return {count:settled.length,pending:rows.length-settled.length,hits,hitRate:settled.length?hits/settled.length:null,...wilson(hits,settled.length),
    callBrier:brier(settled,r=>r.p),baseBrier:brier(settled,r=>r.base_p),coinBrier:settled.length?.25:null,
    midCount:withMid.length,callBrierMidSubset:brier(withMid,r=>r.p),midBrier:brier(withMid,r=>r.mid),
    recent:rows.slice(-10).reverse().map(r=>({ticker:r.ticker,direction:r.direction,p:r.p,result:r.result}))};
}
const paperCache=new WeakMap<Journal,{key:string;kinds:Record<string,any>;curve:any[];breakdown:any[]}>();
export function buildCalibration(journal:Journal,stack?:StackFit,basis?:{correction:number;n:number},benchmarkCalibration?:BenchmarkCalibrationFit,execution:ReturnType<typeof executionStudySummary>|null=null){
  // Fixed-horizon sampling: one paired prediction per settled market, nearest 180s within ±30s.
  const chosen=new Map<string,any>();
  const saved=journal.db.prepare('SELECT ticker,result,context FROM outcomes').all() as any[];
  const fallback=journal.db.prepare('SELECT p,mid,tau FROM ticks WHERE ticker=? AND p IS NOT NULL AND mid IS NOT NULL AND tau BETWEEN 150 AND 210 ORDER BY ABS(tau-180),time LIMIT 1');
  for(const o of saved){const p=JSON.parse(o.context).pairedPrediction??fallback.get(o.ticker);if(p)chosen.set(o.ticker,{...p,ticker:o.ticker,result:o.result});}
  const rel=reliability([...chosen.values()].map(t=>({ticker:t.ticker,p:t.p,mid:t.mid,y:t.result==='yes'?1:0})));
  // Settled paper trades change only at settlements, but paper rows grow ~5,000 a day (mostly simulated makers): their
  // aggregates are cached per journal and recomputed when the settled set or real P&L changes. Resting/expired counts
  // are cheap and always fresh.
  const counts=new Map((journal.db.prepare('SELECT kind,status,count(*) n FROM paper_trades GROUP BY kind,status').all() as {kind:string;status:string;n:number}[]).map(r=>[r.kind+':'+r.status,r.n]));
  const realEvents=journal.realEvents(),settledKey=JSON.stringify(journal.db.prepare("SELECT count(*) n,max(settled_time) t,sum(pnl) p FROM paper_trades INDEXED BY paper_status WHERE status='settled'").get())+':'+realEvents.length+':'+realEvents.reduce((s,e)=>s+e.pnl,0);
  let heavy=paperCache.get(journal);
  if(heavy?.key!==settledKey){
    const settled=journal.db.prepare(`SELECT p.id,p.time,p.ticker,p.kind,p.side,p.price,p.fee,p.status,p.filled_time,p.settled_time,p.pnl,s.tau,s.regime,s.edge FROM paper_trades p INDEXED BY paper_status JOIN signals s INDEXED BY signals_cover ON p.signal_id=s.id WHERE p.status='settled' ORDER BY COALESCE(p.settled_time,p.time),p.id`).all() as any[];
    const kinds=Object.fromEntries(['scalp','dip','hourly','taker','maker'].map(kind=>{const r=settled.filter(t=>t.kind===kind);return [kind,{...clusterCI(r),predictedEV:r.length?mean(r.map(t=>t.edge)):null,totalPnl:r.reduce((s,t)=>s+t.pnl,0)}];}));
    const curveMap=new Map<number,{time:number;taker:number;maker:number;tactics:number;real:number}>();let taker=0,maker=0,tactics=0,real=0;
    const timeline=[...settled.map(t=>({time:t.settled_time,kind:t.kind,pnl:t.pnl})),...realEvents.filter(e=>e.pnl!==0).map(e=>({time:e.time,kind:'real',pnl:e.pnl}))].sort((a,b)=>a.time-b.time);
    for(const e of timeline){if(e.kind==='taker')taker+=e.pnl;else if(e.kind==='maker')maker+=e.pnl;else if(e.kind==='scalp'||e.kind==='dip')tactics+=e.pnl;else real+=e.pnl;curveMap.set(e.time,{time:e.time,taker,maker,tactics,real});}
    const breakdown=(dimension:string,key:(r:any)=>string)=>{const groups=new Map<string,any[]>();for(const r of settled){const bucket=key(r)+' · '+r.kind,g=groups.get(bucket);if(g)g.push(r);else groups.set(bucket,[r]);}return [...groups].map(([bucket,rows])=>({dimension,bucket,...clusterCI(rows),pnl:rows.reduce((s,r)=>s+r.pnl,0),predictedEV:mean(rows.map(r=>r.edge))}));};
    heavy={key:settledKey,kinds,curve:[...curveMap.values()],breakdown:[...breakdown('Time remaining',r=>r.tau<=120?'60–120s':r.tau<=300?'121–300s':'301s+'),...breakdown('Vol regime',r=>r.regime),...breakdown('Net edge',r=>r.edge<.04?'2–4¢':r.edge<.08?'4–8¢':'8¢+')]};
    paperCache.set(journal,heavy);
  }
  const byKind=(kind:string)=>({...heavy!.kinds[kind],resting:counts.get(kind+':resting')??0,expired:counts.get(kind+':expired')??0});
  const outcomes=journal.db.prepare('SELECT * FROM outcomes ORDER BY time').all() as any[];
  const errors=outcomes.map(o=>o.basis_error).filter(x=>x!==null) as number[];
  const hist=new Map<string,number>();for(const error of errors){const bin=Math.floor(error/5)*5,label=`${bin} to ${bin+5}`;hist.set(label,(hist.get(label)??0)+1);}
  const opening=openingScore(journal.db.prepare('SELECT o.ticker,o.direction,o.p,o.base_p,o.mid,r.result FROM opening_calls o LEFT JOIN outcomes r ON r.ticker=o.ticker ORDER BY o.time').all() as any[]);
  const liveRows=journal.db.prepare('SELECT l.horizon,l.ticker,l.direction,l.p,l.base_p,l.mid,r.result FROM live_calls l LEFT JOIN outcomes r ON r.ticker=l.ticker ORDER BY l.time').all() as any[];
  const live=LIVE_HORIZONS.map(h=>({horizon:h,...openingScore(liveRows.filter(r=>r.horizon===h))}));
  const nextRows=journal.db.prepare('SELECT n.horizon,n.ticker,n.direction,n.p,n.base_p,NULL AS mid,r.result FROM next_calls n LEFT JOIN outcomes r ON r.ticker=n.ticker ORDER BY n.time').all() as any[];
  const next=NEXT_HORIZONS.map(h=>({horizon:h,...openingScore(nextRows.filter(r=>r.horizon===h))}));
  const quant=stack?{active:stack.active,reason:stack.reason,n:stack.n,markets:stack.markets,cv:stack.cv,weights:describe(stack),effective:effectiveWeights(stack),fittedEffective:effectiveWeights(stack,'fittedWeights'),basis,history:journal.get<any[]>('quantHistory',[]).map(h=>({time:h.time,markets:h.markets,method:h.cv?.method??'legacy mixed-time validation',stack:h.cv?.stack,prior:h.cv?.prior,model:h.cv?.model,kalshi:h.cv?.kalshi}))}:null;
  const {rounds,trends}=buildRounds(journal.db);
  return {updated:Date.now(),benchmark:benchmarkScores(journal.db),research:{scores:researchScores(journal.db),fit:benchmarkCalibration??null,execution},rounds,roundTrends:trends,opening,live,next,quant,scalp:byKind('scalp'),dip:byKind('dip'),hourly:byKind('hourly'),...rel,taker:byKind('taker'),maker:byKind('maker'),curve:heavy.curve,breakdown:heavy.breakdown,basis:errors.length?{count:errors.length,mean:mean(errors),histogram:[...hist].map(([bin,count])=>({bin,count}))}:{count:0,mean:null,histogram:[]},outcomes:outcomes.slice(-20).map(o=>({...o,context:undefined})),totalSignals:(journal.db.prepare('SELECT COUNT(*) AS n FROM signals').get() as any).n};
}
