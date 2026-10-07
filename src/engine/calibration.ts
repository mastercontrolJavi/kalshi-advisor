import type {Journal} from './journal';
import {mean} from './model/math';
export function clusterCI(rows:{ticker:string;pnl:number}[]){
  if(!rows.length)return {mean:null,low:null,high:null,markets:0,count:0};
  const clusters=new Map<string,number[]>();for(const r of rows)clusters.set(r.ticker,[...(clusters.get(r.ticker)??[]),r.pnl]);
  const groups=[...clusters.values()];
  if(groups.length<2)return {mean:mean(rows.map(r=>r.pnl)),low:null,high:null,markets:groups.length,count:rows.length};
  let seed=173;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};const samples:number[]=[];
  for(let b=0;b<2000;b++){let sum=0,n=0;for(let i=0;i<groups.length;i++){const g=groups[Math.floor(random()*groups.length)];sum+=g.reduce((s,x)=>s+x,0);n+=g.length;}samples.push(sum/n);}
  samples.sort((a,b)=>a-b);return {mean:mean(rows.map(r=>r.pnl)),low:samples[50],high:samples[1949],markets:groups.length,count:rows.length};
}
export function reliability(rows:{p:number;mid:number;y:number;ticker:string}[]){
  const buckets=Array.from({length:10},(_,i)=>({bucket:`${i*10}–${(i+1)*10}%`,predicted:null as number|null,actual:null as number|null,count:0}));
  for(let i=0;i<10;i++){const group=rows.filter(r=>Math.min(9,Math.floor(r.p*10))===i);buckets[i].count=group.length;if(group.length){buckets[i].predicted=mean(group.map(r=>r.p));buckets[i].actual=mean(group.map(r=>r.y));}}
  return {buckets,count:rows.length,modelBrier:rows.length?mean(rows.map(r=>(r.p-r.y)**2)):null,marketBrier:rows.length?mean(rows.map(r=>(r.mid-r.y)**2)):null};
}
export function buildCalibration(journal:Journal){
  // Fixed-horizon sampling: one paired prediction per settled market, nearest 180s within ±30s.
  const ticks=journal.db.prepare(`SELECT t.ticker,t.p,t.mid,t.tau,o.result FROM ticks t JOIN outcomes o ON t.ticker=o.ticker WHERE t.p IS NOT NULL AND t.mid IS NOT NULL AND t.tau BETWEEN 150 AND 210 ORDER BY ABS(t.tau-180),t.time`).all() as any[];
  const chosen=new Map<string,any>();for(const t of ticks)if(!chosen.has(t.ticker))chosen.set(t.ticker,t);
  const rel=reliability([...chosen.values()].map(t=>({ticker:t.ticker,p:t.p,mid:t.mid,y:t.result==='yes'?1:0})));
  const paper=journal.db.prepare(`SELECT p.*,s.tau,s.regime,s.edge FROM paper_trades p JOIN signals s ON p.signal_id=s.id ORDER BY COALESCE(p.settled_time,p.time),p.id`).all() as any[];
  const settled=paper.filter(t=>t.status==='settled');
  const byKind=(kind:string)=>{const r=settled.filter(t=>t.kind===kind);return {...clusterCI(r),predictedEV:r.length?mean(r.map(t=>t.edge)):null,totalPnl:r.reduce((s,t)=>s+t.pnl,0),resting:paper.filter(t=>t.kind===kind&&t.status==='resting').length,expired:paper.filter(t=>t.kind===kind&&t.status==='expired').length};};
  const curveMap=new Map<number,{time:number;taker:number;maker:number;real:number}>();let taker=0,maker=0,real=0;
  const timeline=[...settled.map(t=>({time:t.settled_time,kind:t.kind,pnl:t.pnl})),...journal.realEvents().filter(e=>e.pnl!==0).map(e=>({time:e.time,kind:'real',pnl:e.pnl}))].sort((a,b)=>a.time-b.time);
  for(const e of timeline){if(e.kind==='taker')taker+=e.pnl;else if(e.kind==='maker')maker+=e.pnl;else real+=e.pnl;curveMap.set(e.time,{time:e.time,taker,maker,real});}
  const breakdown=(dimension:string,key:(r:any)=>string)=>{const groups=new Map<string,any[]>();for(const r of settled){const bucket=key(r)+' · '+r.kind;groups.set(bucket,[...(groups.get(bucket)??[]),r]);}return [...groups].map(([bucket,rows])=>({dimension,bucket,...clusterCI(rows),pnl:rows.reduce((s,r)=>s+r.pnl,0),predictedEV:mean(rows.map(r=>r.edge))}));};
  const outcomes=journal.db.prepare('SELECT * FROM outcomes ORDER BY time').all() as any[];
  const errors=outcomes.map(o=>o.basis_error).filter(x=>x!==null) as number[];
  const hist=new Map<string,number>();for(const error of errors){const bin=Math.floor(error/5)*5,label=`${bin} to ${bin+5}`;hist.set(label,(hist.get(label)??0)+1);}
  return {updated:Date.now(),...rel,taker:byKind('taker'),maker:byKind('maker'),curve:[...curveMap.values()],breakdown:[...breakdown('Time remaining',r=>r.tau<=120?'60–120s':r.tau<=300?'121–300s':'301s+'),...breakdown('Vol regime',r=>r.regime),...breakdown('Net edge',r=>r.edge<.04?'2–4¢':r.edge<.08?'4–8¢':'8¢+')],basis:errors.length?{count:errors.length,mean:mean(errors),histogram:[...hist].map(([bin,count])=>({bin,count}))}:{count:0,mean:null,histogram:[]},outcomes:outcomes.slice(-20).map(o=>({...o,context:undefined})),totalSignals:(journal.db.prepare('SELECT COUNT(*) AS n FROM signals').get() as any).n};
}
