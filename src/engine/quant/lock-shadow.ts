import type Database from 'better-sqlite3';
import {fee,type FeeSchedule} from '../model/fees';
/**
 * Shadow log of final-minute lock opportunities (2026-11-02, DECISIONS 70). In the quant/ backtest, buying when the BRTI
 * lock probability beat the ask by ≥ 2¢ after the fee made +6.3¢ a contract with ≤ 15 s left, but on 38 trades (95%
 * −3.8 to +16.7¢), chosen after seeing the data. This records the same rule live, forward, until ~200 trades say whether
 * it holds. It never places an order or changes advice.
 *
 * Per round and bucket (≤ 30 s and ≤ 15 s left), the first second the edge on either side is ≥ LOCK_SHADOW_EDGE, with a
 * fresh book (stale-book breaker clear) and every elapsed settlement second published:
 *   taker — fills at that side's ask one second later (latency), plus the taker fee; dropped if that second is stale;
 *   maker — a resting buy at that side's bid, filled only if its ask later trades strictly through the limit before the
 *           close (a seller had to cross it, so queue position cannot matter), at the maker fee.
 * Both are held to settlement and scored against Kalshi's official result in outcomes.
 */
export const LOCK_SHADOW_VERSION='lock-shadow-v1',LOCK_BUCKETS=[30,15] as const,LOCK_SHADOW_EDGE=.02,LOCK_SHADOW_TARGET=200;
export const LOCK_SHADOW_SCHEMA=`CREATE TABLE IF NOT EXISTS lock_shadow(ticker TEXT NOT NULL,bucket INTEGER NOT NULL,version TEXT NOT NULL,decided INTEGER NOT NULL,tau REAL NOT NULL,side TEXT NOT NULL,p REAL NOT NULL,edge REAL NOT NULL,
  filled INTEGER NOT NULL,taker_price REAL NOT NULL,taker_fee REAL NOT NULL,maker_limit REAL,maker_fee REAL,maker_filled INTEGER,context TEXT NOT NULL,PRIMARY KEY(ticker,bucket,version));`;
export interface LockQuote {yesBid:number|null;yesAsk:number|null;noBid:number|null;noAsk:number|null}
export interface LockObservation {ticker:string;time:number;tau:number;close:number;p:number|null;quote:LockQuote;schedule:FeeSchedule;fresh:boolean;complete:boolean;context?:unknown}
const ok=(x:number|null|undefined):x is number=>x!=null&&x>0&&x<1;
const askOf=(q:LockQuote,side:'yes'|'no')=>side==='yes'?q.yesAsk:q.noAsk,bidOf=(q:LockQuote,side:'yes'|'no')=>side==='yes'?q.yesBid:q.noBid;
interface Pending {ticker:string;bucket:number;decided:number;tau:number;side:'yes'|'no';p:number;edge:number;limit:number|null;context:unknown}
export class LockShadow {
  private pending=new Map<string,Pending>();private resting=new Map<string,{ticker:string;bucket:number;side:'yes'|'no';limit:number;close:number}>();
  private insert:Database.Statement;private exists:Database.Statement;private fill:Database.Statement;
  constructor(db:Database.Database){
    db.exec(LOCK_SHADOW_SCHEMA);
    this.insert=db.prepare('INSERT OR IGNORE INTO lock_shadow VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    this.exists=db.prepare('SELECT 1 FROM lock_shadow WHERE ticker=? AND bucket=? AND version=?');
    this.fill=db.prepare('UPDATE lock_shadow SET maker_filled=? WHERE ticker=? AND bucket=? AND version=? AND maker_filled IS NULL');
  }
  /** Call once per second with the round's state. */
  observe(o:LockObservation){
    const q=o.quote;
    // 1. Last second's decisions fill as a taker at this second's ask; a stale or empty second drops them (they may re-qualify).
    for(const [key,d] of this.pending){if(o.time<=d.decided)continue;this.pending.delete(key);
      const price=askOf(q,d.side);if(d.ticker!==o.ticker||!o.fresh||o.time-d.decided>2000||!ok(price)||price>=.995)continue;
      this.insert.run(d.ticker,d.bucket,LOCK_SHADOW_VERSION,d.decided,d.tau,d.side,d.p,d.edge,o.time,price,fee(price,1,'taker',o.schedule),d.limit,d.limit===null?null:fee(d.limit,1,'maker',o.schedule),null,JSON.stringify(d.context??null));
      if(d.limit!==null)this.resting.set(key,{ticker:d.ticker,bucket:d.bucket,side:d.side,limit:d.limit,close:o.close});}
    // 2. Resting maker bids: filled when that side's ask trades through the limit on a fresh book, before the close.
    for(const [key,r] of this.resting){if(r.ticker!==o.ticker&&o.time<r.close)continue;
      if(o.time>=r.close){this.resting.delete(key);continue;}
      const a=askOf(q,r.side);if(o.fresh&&ok(a)&&a<r.limit-1e-9){this.fill.run(o.time,r.ticker,r.bucket,LOCK_SHADOW_VERSION);this.resting.delete(key);}}
    // 3. New decisions.
    if(!o.fresh||!o.complete||o.p===null||!Number.isFinite(o.p)||o.tau<2)return;
    for(const bucket of LOCK_BUCKETS){const key=`${o.ticker}:${bucket}`;
      if(o.tau>bucket||this.pending.has(key)||this.resting.has(key)||this.exists.get(o.ticker,bucket,LOCK_SHADOW_VERSION))continue;
      const edge=(side:'yes'|'no')=>{const a=askOf(q,side),fair=side==='yes'?o.p!:1-o.p!;return ok(a)&&a<.995?fair-a-fee(a,1,'taker',o.schedule):null;};
      const ey=edge('yes'),en=edge('no'),side:'yes'|'no'|null=ey!==null&&ey>=LOCK_SHADOW_EDGE&&(en===null||ey>=en)?'yes':en!==null&&en>=LOCK_SHADOW_EDGE?'no':null;
      if(!side)continue;const b=bidOf(q,side);
      this.pending.set(key,{ticker:o.ticker,bucket,decided:o.time,tau:o.tau,side,p:o.p,edge:side==='yes'?ey!:en!,limit:ok(b)&&b>=.01&&b<=.99?b:null,context:o.context});}
  }
}
export interface LockBucketScore {bucket:number;trades:number;settled:number;pending:number;takerWins:number;takerAvg:number|null;takerLow:number|null;takerHigh:number|null;makerPosted:number;makerFilled:number;makerAvg:number|null}
/** Per bucket, per contract after fees, on settled rounds. One trade per round, so a plain 95% normal range is fair. */
export function lockShadowScores(db:Database.Database):{target:number;buckets:LockBucketScore[]}{
  const rows=db.prepare(`SELECT s.bucket,s.side,s.taker_price,s.taker_fee,s.maker_limit,s.maker_fee,s.maker_filled,o.result FROM lock_shadow s LEFT JOIN outcomes o USING(ticker) WHERE s.version=?`).all(LOCK_SHADOW_VERSION) as {bucket:number;side:string;taker_price:number;taker_fee:number;maker_limit:number|null;maker_fee:number|null;maker_filled:number|null;result:string|null}[];
  const buckets=LOCK_BUCKETS.map(bucket=>{
    const all=rows.filter(r=>r.bucket===bucket),done=all.filter(r=>r.result==='yes'||r.result==='no'),won=(r:typeof done[number])=>r.result===r.side?1:0;
    const taker=done.map(r=>won(r)-r.taker_price-r.taker_fee),maker=done.filter(r=>r.maker_filled!==null&&r.maker_limit!==null).map(r=>won(r)-r.maker_limit!-(r.maker_fee??0));
    const avg=taker.length?taker.reduce((s,x)=>s+x,0)/taker.length:null,sd=taker.length>1&&avg!==null?Math.sqrt(taker.reduce((s,x)=>s+(x-avg)**2,0)/(taker.length-1)):null,half=sd!==null?1.96*sd/Math.sqrt(taker.length):null;
    return {bucket,trades:all.length,settled:done.length,pending:all.length-done.length,takerWins:done.filter(r=>won(r)).length,takerAvg:avg,takerLow:avg!==null&&half!==null?avg-half:null,takerHigh:avg!==null&&half!==null?avg+half:null,
      makerPosted:done.filter(r=>r.maker_limit!==null).length,makerFilled:maker.length,makerAvg:maker.length?maker.reduce((s,x)=>s+x,0)/maker.length:null};
  });
  return {target:LOCK_SHADOW_TARGET,buckets};
}
