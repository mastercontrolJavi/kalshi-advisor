import type Database from 'better-sqlite3';
import type {FeeSchedule} from '../model/fees';
import type {ExecutionSnapshot} from './execution-replay';

export const RESEARCH_VERSION='btc-research-v1';
export const RESEARCH_HORIZONS=[60,30,10] as const;
export const RESEARCH_SCHEMA=`
 CREATE TABLE IF NOT EXISTS microstructure_events(id INTEGER PRIMARY KEY,session TEXT NOT NULL,ordinal INTEGER NOT NULL,source_time REAL,received_time INTEGER NOT NULL,context TEXT NOT NULL,UNIQUE(session,ordinal));
 CREATE INDEX IF NOT EXISTS microstructure_received ON microstructure_events(received_time);
 CREATE TABLE IF NOT EXISTS microstructure_features(time INTEGER PRIMARY KEY,context TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS research_books(id INTEGER PRIMARY KEY,ticker TEXT NOT NULL,time INTEGER NOT NULL,context TEXT NOT NULL,UNIQUE(ticker,time));
 CREATE INDEX IF NOT EXISTS research_books_market_time ON research_books(ticker,time);
 CREATE INDEX IF NOT EXISTS research_books_time ON research_books(time);
 CREATE TABLE IF NOT EXISTS research_forecasts(ticker TEXT NOT NULL,horizon INTEGER NOT NULL,version TEXT NOT NULL,time INTEGER NOT NULL,context TEXT NOT NULL,PRIMARY KEY(ticker,horizon,version));
 CREATE TABLE IF NOT EXISTS research_gaps(id INTEGER PRIMARY KEY,time INTEGER NOT NULL,reason TEXT NOT NULL,count INTEGER NOT NULL);`;

export interface ResearchForecast {
 brtiP:number;marketP:number|null;quantP:number|null;calibratedP:number|null;candidateP:number|null;
 sourceTime:number;exchangeTime:number;clockOffset:number;closeTime:number;tau:number;
 fees:FeeSchedule;book:ExecutionSnapshot;input:unknown;calibration:unknown;flow:unknown;
}
type PublicEvent={sessionId:string;ordinal:number;sourceTime:number|null;receivedAt:number};
/** Public research only. All timing for replay uses the local capture clock, never rounded tick time. */
export class ResearchJournal {
 private queue:{event:PublicEvent;json:string;bytes:number}[]=[];private bytes=0;private pendingDrops=0;
 private eventInsert:Database.Statement;private bookInsert:Database.Statement;private forecastInsert:Database.Statement;
 private featureInsert:Database.Statement;private gapInsert:Database.Statement;private outcome:Database.Statement;
 readonly stats={events:0,books:0,forecasts:0,droppedEvents:0,lastFlushMs:0};
 constructor(private db:Database.Database,private maxEvents=10000,private maxBytes=16*1024*1024){
  db.exec(RESEARCH_SCHEMA);
  this.eventInsert=db.prepare('INSERT OR IGNORE INTO microstructure_events(session,ordinal,source_time,received_time,context) VALUES(?,?,?,?,?)');
  this.bookInsert=db.prepare('INSERT OR IGNORE INTO research_books(ticker,time,context) VALUES(?,?,?)');
  this.forecastInsert=db.prepare('INSERT OR IGNORE INTO research_forecasts VALUES(?,?,?,?,?)');
  this.featureInsert=db.prepare('INSERT OR IGNORE INTO microstructure_features VALUES(?,?)');
  this.gapInsert=db.prepare('INSERT INTO research_gaps(time,reason,count) VALUES(?,?,?)');
  this.outcome=db.prepare('SELECT 1 FROM outcomes WHERE ticker=?');
 }
 enqueue(event:PublicEvent){
  if(!event.sessionId||!Number.isInteger(event.ordinal)||event.ordinal<0||!Number.isFinite(event.receivedAt)||event.sourceTime!==null&&!Number.isFinite(event.sourceTime))return;
  const json=JSON.stringify(event),bytes=Buffer.byteLength(json);
  if(this.queue.length>=this.maxEvents||this.bytes+bytes>this.maxBytes){this.pendingDrops++;this.stats.droppedEvents++;return;}
  this.queue.push({event,json,bytes});this.bytes+=bytes;
 }
 flush(now=Date.now()){
  if(!this.queue.length&&!this.pendingDrops)return;
  const start=performance.now(),pending=this.queue,dropped=this.pendingDrops;
  let inserted=0;
  this.db.transaction(()=>{
   for(const {event:e,json} of pending)inserted+=this.eventInsert.run(e.sessionId,e.ordinal,e.sourceTime,e.receivedAt,json).changes;
   if(dropped)this.gapInsert.run(now,'public event recorder capacity exceeded',dropped);
  })();
  this.queue=[];this.bytes=0;this.pendingDrops=0;this.stats.events+=inserted;this.stats.lastFlushMs=performance.now()-start;
 }
 features(time:number,features:unknown){if(Number.isFinite(time))this.featureInsert.run(time,JSON.stringify(features));}
 book(snapshot:ExecutionSnapshot,extra:{source:string;clockOffset:number;depthLimit:number}){
  if(!snapshot.ticker||!Number.isFinite(snapshot.time)||!Number.isFinite(snapshot.bookUpdated)||snapshot.bookUpdated>snapshot.time)return;
  this.stats.books+=this.bookInsert.run(snapshot.ticker,snapshot.time,JSON.stringify({...snapshot,...extra})).changes;
 }
 capture(ticker:string,time:number,forecast:ResearchForecast){
  const f=forecast;
  if(!ticker||![time,f.exchangeTime,f.clockOffset,f.closeTime,f.sourceTime,f.tau].every(Number.isFinite)||f.closeTime<=time||f.tau<=0||f.sourceTime>f.exchangeTime||f.exchangeTime-f.sourceTime>2500)return false;
  if(Math.abs(f.exchangeTime-time-f.clockOffset)>1||Math.abs((f.closeTime-time)/1000-f.tau)>.002||f.book.time>time||f.book.ticker!==ticker)return false;
  if([f.brtiP,f.marketP,f.quantP,f.calibratedP,f.candidateP].some(p=>p!==null&&(!Number.isFinite(p)||p<0||p>1))||this.outcome.get(ticker))return false;
  const horizon=RESEARCH_HORIZONS.find(h=>f.tau<=h&&f.tau>h-3);if(horizon===undefined)return false;
  const n=this.forecastInsert.run(ticker,horizon,RESEARCH_VERSION,time,JSON.stringify(f)).changes;this.stats.forecasts+=n;return n>0;
 }
}

/** Prospective scores compare each challenger and market on the exact same resolved checkpoints. */
export function researchScores(db:Database.Database,now=Date.now()){
 const rows=db.prepare(`SELECT f.ticker,f.horizon,f.time,f.context,o.time settledTime,o.result FROM research_forecasts f LEFT JOIN outcomes o USING(ticker) WHERE version=? AND f.time<=? ORDER BY f.time`).all(RESEARCH_VERSION,now) as {ticker:string;horizon:number;time:number;context:string;settledTime:number|null;result:string|null}[];
 const decoded=rows.map(r=>({...r,f:JSON.parse(r.context) as ResearchForecast}));
 return RESEARCH_HORIZONS.map(horizon=>{
  const all=decoded.filter(r=>r.horizon===horizon),resolved=all.filter(r=>(r.result==='yes'||r.result==='no')&&r.settledTime!==null&&r.settledTime-r.f.clockOffset<=now);
  const models=['brtiP','quantP','candidateP'] as const;
  return {horizon,recorded:all.length,pending:all.length-resolved.length,models:models.map(model=>{
   const paired=resolved.filter(r=>r.f[model]!==null&&r.f.marketP!==null);
   const brier=(key:typeof model|'marketP')=>paired.length?paired.reduce((s,r)=>s+(r.f[key]!-(r.result==='yes'?1:0))**2,0)/paired.length:null;
   return {model,n:paired.length,brier:brier(model),marketBrier:brier('marketP')};
  })};
 });
}
