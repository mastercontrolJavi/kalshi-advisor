/** Official BRTI research replay. Source journal readonly; downloaded history is isolated and never promoted. */
import dotenv from 'dotenv';dotenv.config({path:'.env.local',quiet:true});
import Database from 'better-sqlite3';
import {mkdirSync,writeFileSync} from 'node:fs';
import {KalshiClient} from '../src/engine/feeds/kalshi';
import {benchmarkForecast} from '../src/engine/quant/benchmark';
import {lateSamples} from '../src/engine/quant/samples';
const arg=(key:string,fallback:string)=>{const i=process.argv.indexOf('--'+key);return i<0?fallback:process.argv[i+1]??fallback;};
const through=Date.parse(arg('through','2026-10-23T07:20:00Z'));
if(!Number.isFinite(through))throw new Error('Invalid cutoff');
const db=new Database(arg('db','data/advisor.db'),{readonly:true,fileMustExist:true});db.pragma('query_only=ON');
type Row={ticker:string;horizon:string;time:number;close:number;k:number;p:number;mid:number|null;y:number;actual:number|null};
const rows=db.transaction(()=>{
  const main=db.prepare(`SELECT c.ticker,'open' horizon,c.time,c.time+c.tau*1000 close,json_extract(c.context,'$.inputs.K') k,json_extract(c.context,'$.inputs.modelP') p,CASE WHEN json_type(c.context,'$.inputs.mid') IS NULL THEN c.mid ELSE json_extract(c.context,'$.inputs.mid') END mid,CASE o.result WHEN 'yes' THEN 1 ELSE 0 END y,o.actual_average actual FROM opening_calls c JOIN outcomes o USING(ticker) WHERE o.result IN ('yes','no') AND o.time<=?
    UNION ALL SELECT c.ticker,CAST(c.horizon AS TEXT),c.time,c.time+c.tau*1000,json_extract(c.context,'$.inputs.K'),json_extract(c.context,'$.inputs.modelP'),CASE WHEN json_type(c.context,'$.inputs.mid') IS NULL THEN c.mid ELSE json_extract(c.context,'$.inputs.mid') END,CASE o.result WHEN 'yes' THEN 1 ELSE 0 END,o.actual_average FROM live_calls c JOIN outcomes o USING(ticker) WHERE o.result IN ('yes','no') AND o.time<=?`).all(through,through) as Row[];
  const late=lateSamples(db).filter(r=>r.settledTime!<=through),tick=db.prepare('SELECT k,time+tau*1000 close FROM ticks WHERE ticker=? AND time=?');
  for(const s of late){const t=tick.get(s.ticker,s.time) as {k:number;close:number}|undefined;if(t)main.push({ticker:s.ticker,horizon:s.horizon,time:s.time!,close:t.close,k:t.k,p:s.modelP,mid:s.mid,y:s.y,actual:null});}
  return main.filter(r=>[r.time,r.close,r.k,r.p].every(Number.isFinite)&&r.k>0).sort((a,b)=>a.time-b.time);
})();db.close();
mkdirSync('data',{recursive:true});mkdirSync('output',{recursive:true});
const cache=new Database('data/benchmark-history.db');cache.pragma('journal_mode=WAL');
cache.exec(`CREATE TABLE IF NOT EXISTS values_1s(time INTEGER PRIMARY KEY,price REAL NOT NULL,amended INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS hours(time INTEGER PRIMARY KEY,fetched INTEGER NOT NULL,points INTEGER NOT NULL);`);
// Each decision uses at most one trailing hour; fetch the two UTC hours that can intersect it.
const hours=[...new Set(rows.flatMap(r=>{const end=r.time-1000;return [Math.floor((end-3600000)/3600000)*3600000,Math.floor(end/3600000)*3600000];}))].sort((a,b)=>a-b);
const needed=hours.filter(h=>!cache.prepare('SELECT 1 FROM hours WHERE time=?').get(h));
console.log(JSON.stringify({checkpoints:rows.length,hours:hours.length,missingHours:needed.length}));
if(!process.argv.includes('--skip-fetch')&&needed.length){
  const c=new KalshiClient();if(!c.authenticated)throw new Error('Kalshi credentials required for benchmark history');await c.get('/exchange/status');
  const insert=cache.prepare('INSERT OR IGNORE INTO values_1s VALUES(?,?,?)');
  for(let i=0;i<needed.length;i++){
    const h=needed[i],response=await c.get('/cfbenchmarks/history/values?id=BRTI&timespan=HOUR&timestamp='+encodeURIComponent(new Date(h).toISOString()),true),payload=response?.data?.payload;
    if(!Array.isArray(payload))throw new Error('Unexpected CF Benchmarks history payload');
    const points=payload.filter((r:any)=>Number.isSafeInteger(r.time)&&r.time%1000===0&&r.time>=h&&r.time<h+3600000&&Number.isFinite(Number(r.value))&&Number(r.value)>0);
    cache.transaction(()=>{for(const p of points)insert.run(p.time,Number(p.value),p.amendTime!=null?1:0);cache.prepare('INSERT OR REPLACE INTO hours VALUES(?,?,?)').run(h,Date.now(),points.length);})();
    if(i%10===0||i===needed.length-1)console.log(JSON.stringify({fetched:i+1,total:needed.length,hour:new Date(h).toISOString(),points:points.length}));
  }
}
const read=cache.prepare('SELECT time,price,amended FROM values_1s WHERE time BETWEEN ? AND ? ORDER BY time');
type Scored=Row&{benchmark:number};const scored:Scored[]=[];let skipped=0;
for(const r of rows){
  const end=r.time-1000,history=read.all(end-3600000,end) as {time:number;price:number;amended:number}[];
  // Hold back one full second for publication/transport. Historical availability/revisions remain a replay limitation.
  if(history.at(-1)?.time!==end||history.some(p=>p.amended)){skipped++;continue;}
  const forecast=benchmarkForecast(history,r.k,r.close,r.time);if(!forecast||r.mid===null){skipped++;continue;}
  scored.push({...r,benchmark:forecast.p});
}
cache.close();
const avg=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
function bounds(rs:Scored[],against:'p'|'mid'){
  const blocks=new Map<number,number[]>();for(const r of rs){const key=Math.floor(r.time/3600000),g=blocks.get(key)??[];g.push((r[against]!-r.y)**2-(r.benchmark-r.y)**2);blocks.set(key,g);}
  if(blocks.size<8)return null;const groups=[...blocks.values()],draws:number[]=[];let seed=19;
  for(let n=0;n<2000;n++){let sum=0,count=0;for(let k=0;k<groups.length;k++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const g=groups[Math.floor(seed/4294967296*groups.length)];for(const v of g){sum+=v;count++;}}draws.push(sum/count);}
  draws.sort((a,b)=>a-b);return [draws[50],draws[1949]];
}
const groups=['open','600','300','120','60','50','40','30','20','10'].map(h=>{const rs=scored.filter(r=>r.horizon===h),brier=(key:'benchmark'|'p'|'mid')=>avg(rs.map(r=>(r[key]!-r.y)**2));return {horizon:h,n:rs.length,benchmark:brier('benchmark'),proxy:brier('p'),market:brier('mid'),gainVsProxy:avg(rs.map(r=>(r.p-r.y)**2-(r.benchmark-r.y)**2)),gainVsMarket:avg(rs.map(r=>(r.mid!-r.y)**2-(r.benchmark-r.y)**2)),proxyCI:bounds(rs,'p'),marketCI:bounds(rs,'mid')};});
const report={generated:new Date().toISOString(),through:new Date(through).toISOString(),checkpoints:rows.length,paired:scored.length,skipped,hours:hours.length,groups,limits:['Historical data fetched after the outcome may differ from what was available live. Explicit amendments excluded; unknown historical latency/revisions cannot be excluded.','One-second artificial publication delay; no actual live fills, book depth or latency replay.','No tuning or promotion: exact discrete Brownian model and volatility settings fixed before this replay.','Each horizon has at most one checkpoint per market. Hour-block 95% intervals; multiple horizon comparisons remain exploratory.','One-hour trailing volatility includes only source observations before the decision. Missing recent seconds pause the forecast.']};
writeFileSync('output/benchmark-study.json',JSON.stringify(report,null,2)+'\n');
const f=(v:number|null)=>v===null?'—':v.toFixed(4),ci=(v:number[]|null)=>v?v.map(f).join(' to '):'insufficient blocks';
writeFileSync('docs/BRTI-STUDY-2026-10-23.md',['# Official BRTI historical challenger study','',`Generated ${report.generated}; cutoff ${report.through}. ${report.paired}/${report.checkpoints} paired checkpoints across ${hours.length} requested UTC hours.`, '',
'Reproduce with `npm run benchmark:study`; cached rerun: `npm run benchmark:study -- --skip-fetch`. The production journal is read-only; reference history lives in `data/benchmark-history.db`. These retrospective source-level results do not enable trading.', '',
'| Time left | Paired rounds | BRTI Brier | Proxy Brier | Market Brier | BRTI gain vs proxy · 95% | BRTI gain vs market · 95% |','|---|---:|---:|---:|---:|---|---|',...groups.map(r=>`| ${r.horizon==='open'?'Opening':r.horizon+'s'} | ${r.n} | ${f(r.benchmark)} | ${f(r.proxy)} | ${f(r.market)} | ${ci(r.proxyCI)} | ${ci(r.marketCI)} |`),'','Positive gain favours BRTI; lower Brier is better. A better model forecast still needs to exceed the executable ask plus fees to support a trade.','',...report.limits.map(x=>'- '+x),'',
'Sources: [Kalshi BRTI feed](https://docs.kalshi.com/websockets/cfbenchmarks-value), [history passthrough](https://docs.kalshi.com/cfbenchmarks/rest-passthrough).',''].join('\n'));
console.log(JSON.stringify(report,null,2));
