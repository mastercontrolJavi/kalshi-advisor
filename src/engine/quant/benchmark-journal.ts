import type Database from 'better-sqlite3';
import type {BenchmarkTick} from '../feeds/benchmark';
import {BENCHMARK_HORIZONS,BENCHMARK_MODEL_VERSION} from './benchmark';
export const BENCHMARK_SCHEMA=`
  CREATE TABLE IF NOT EXISTS benchmark_ticks(channel TEXT NOT NULL,source_time INTEGER NOT NULL,received_time INTEGER NOT NULL,price REAL NOT NULL,context TEXT NOT NULL,PRIMARY KEY(channel,source_time));
  CREATE TABLE IF NOT EXISTS benchmark_forecasts(ticker TEXT NOT NULL,horizon INTEGER NOT NULL,version TEXT NOT NULL,time INTEGER NOT NULL,source_time INTEGER NOT NULL,p REAL NOT NULL,proxy_p REAL,quant_p REAL,mid REAL,context TEXT NOT NULL,PRIMARY KEY(ticker,horizon,version));`;
export class BenchmarkJournal {
  private insertTick:Database.Statement;private insertForecast:Database.Statement;private outcome:Database.Statement;
  constructor(private db:Database.Database){
    db.exec(BENCHMARK_SCHEMA);
    this.insertTick=db.prepare('INSERT OR IGNORE INTO benchmark_ticks VALUES(?,?,?,?,?)');
    this.insertForecast=db.prepare('INSERT OR IGNORE INTO benchmark_forecasts VALUES(?,?,?,?,?,?,?,?,?,?)');
    this.outcome=db.prepare('SELECT 1 FROM outcomes WHERE ticker=?');
  }
  tick(t:BenchmarkTick){this.insertTick.run(t.channel,t.time,t.received,t.price,t.raw);}
  capture(ticker:string,time:number,tau:number,forecast:{p:number;sourceTime:number},proxyP:number|null,quantP:number|null,mid:number|null,context:unknown){
    if(!Number.isFinite(time)||!Number.isFinite(tau)||tau<=0||!Number.isFinite(forecast.sourceTime)||forecast.sourceTime>time||time-forecast.sourceTime>2500)return;
    if([forecast.p,proxyP,quantP,mid].some(p=>p!==null&&(!Number.isFinite(p)||p<0||p>1)))return;
    if(this.outcome.get(ticker))return;
    for(const h of BENCHMARK_HORIZONS)if(tau<=h&&tau>h-3)this.insertForecast.run(ticker,h,BENCHMARK_MODEL_VERSION,time,forecast.sourceTime,forecast.p,proxyP,quantP,mid,JSON.stringify(context));
  }
}
/** Fixed-horizon, immutable, paired live forecasts; no re-created historical predictions. */
export function benchmarkScores(db:Database.Database){
  const rows=db.prepare(`SELECT f.horizon,f.p,f.proxy_p,f.quant_p,f.mid,o.result FROM benchmark_forecasts f LEFT JOIN outcomes o USING(ticker) WHERE f.version=?`).all(BENCHMARK_MODEL_VERSION) as {horizon:number;p:number;proxy_p:number|null;quant_p:number|null;mid:number|null;result:string|null}[];
  return BENCHMARK_HORIZONS.map(h=>{
    const all=rows.filter(r=>r.horizon===h),resolved=all.filter(r=>r.result==='yes'||r.result==='no');
    const paired=resolved.filter(r=>r.mid!==null&&r.quant_p!==null&&r.proxy_p!==null);
    const score=(key:'p'|'proxy_p'|'quant_p'|'mid')=>paired.length?paired.reduce((s,r)=>s+(r[key]!-(r.result==='yes'?1:0))**2,0)/paired.length:null;
    return {horizon:h,settled:resolved.length,pending:all.length-resolved.length,paired:paired.length,brier:score('p'),proxy:score('proxy_p'),quant:score('quant_p'),market:score('mid')};
  });
}
