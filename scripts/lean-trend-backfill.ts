import Database from 'better-sqlite3';
import {quote} from '../src/backtest/sim';
/**
 * One-off (2026-10-16): fill trend and slope on Bitcoin lean rows recorded before the live feed captured them, so the
 * "trend + sharps agree" rule starts with its past record. Trend = the row's Kalshi YES mid − 50¢; slope = that mid minus
 * the 1-minute Kalshi candle mid from ≥ 3 min earlier (data/history.db). `npx tsx scripts/lean-trend-backfill.ts`
 */
const m=new Database('data/markets.db'),h=new Database('data/history.db',{readonly:true});m.pragma('busy_timeout = 10000');
const cols=(m.prepare('PRAGMA table_info(btc_lean)').all() as {name:string}[]).map(c=>c.name);
if(!cols.includes('trend'))m.exec('ALTER TABLE btc_lean ADD COLUMN trend REAL');if(!cols.includes('slope'))m.exec('ALTER TABLE btc_lean ADD COLUMN slope REAL');
const rows=m.prepare('SELECT round,horizon,time,ticker,yes_bid AS bid,yes_ask AS ask FROM btc_lean WHERE trend IS NULL AND yes_bid IS NOT NULL AND yes_ask IS NOT NULL').all() as {round:number;horizon:number;time:number;ticker:string;bid:number;ask:number}[];
const back=h.prepare('SELECT bid,ask FROM candles WHERE ticker=? AND ts<=? ORDER BY ts DESC LIMIT 1'),put=m.prepare('UPDATE btc_lean SET trend=?,slope=? WHERE round=? AND horizon=?');
let filled=0,noSlope=0;
m.transaction(()=>{for(const r of rows){
  const mid=(r.bid+r.ask)/2,c=back.get(r.ticker,Math.floor(r.time/1000)-180) as {bid:number|null;ask:number|null}|undefined,b=c?quote(c).mid:null;
  if(b===null)noSlope++;put.run(mid-.5,b===null?null:mid-b,r.round,r.horizon);filled++;
}})();
console.log(`filled ${filled} rows (${noSlope} without a 3-min-earlier candle, slope left empty)`);
