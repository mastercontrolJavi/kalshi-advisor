import type Database from 'better-sqlite3';
import type {StackSample} from './stack';
import {usableMid} from './quote';
import {MAX_BOOK_DELAY_MS} from '../feeds/orderbook';
import {defaults} from '../config';
type RecordData=Record<string,unknown>;
function object(value:unknown):RecordData|null{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as RecordData:null;}
function parse(value:string):RecordData|null{try{return object(JSON.parse(value));}catch{return null;}}
const finite=(value:unknown):number|null=>typeof value==='number'&&Number.isFinite(value)?value:null;
const probability=(value:unknown):number|null=>{const n=finite(value);return n!==null&&n>=0&&n<=1?n:null;};
function inputs(features:RecordData,modelP:number,mid:number|null,sigma:number){return {modelP,mid,sigma,momentum30s:finite(features.momentum30s),momentum120s:finite(features.momentum120s),imbalance:finite(features.imbalance),tradeFlow30s:finite(features.tradeFlow30s),tradeVolume30s:finite(features.tradeVolume30s)};}
/** New ticks preserve the exact live input; legacy ticks use all quality metadata that was recorded then. */
function recordedMid(context:RecordData,time:number):number|null{
  const exact=object(context.stackInputs);if(exact&&Object.hasOwn(exact,'mid'))return probability(exact.mid);
  const book=object(context.book);if(!book)return null;
  // REST backup quotes have their own delay, so a delayed websocket must not invalidate a fresh backup.
  const delay=finite(context.bookDelay)??finite(context.kalshiDelay);
  if(delay!==null&&(delay<0||delay>MAX_BOOK_DELAY_MS))return null;
  const bid=probability(book.yesBid),ask=probability(book.yesAsk);
  if(bid===null||ask===null||ask<bid||ask-bid>.1+1e-9||book.valid===false)return null;
  const updated=finite(book.updated);
  if(updated!==null)return usableMid({valid:book.valid!==false,updated,yesBid:bid,yesAsk:ask},finite(context.engineTime)??time,finite(context.bookStaleMs)??defaults.bookStaleMs);
  // Early journals predate validity/age metadata. They cannot certify freshness, but retain their original quote.
  return (bid+ask)/2;
}
/**
 * Final-minute training rows for the late-round forecast: on every settled market, the recorded second nearest each of
 * 50/40/30/20/10 s left (within ±3 s), with the model probability (which already sees the locked part of the average),
 * Kalshi's mid when the spread is ≤ 10¢, and the same microstructure features as the main stack.
 */
export const LATE_HORIZONS=[50,40,30,20,10];
/** `cache` (ticker → its rows) makes repeated calls read only rounds settled since the last call. */
export function lateSamples(db:Database.Database,cache?:Map<string,StackSample[]>):StackSample[]{
  const known=cache??new Map<string,StackSample[]>(),fresh=(db.prepare('SELECT ticker,result,time FROM outcomes ORDER BY time,ticker').all() as {ticker:string;result:string;time:number}[]).filter(o=>!known.has(o.ticker));
  const ticks=db.prepare(`SELECT time,tau,p,sigma,context
    FROM ticks INDEXED BY ticks_market_tau WHERE ticker=? AND tau BETWEEN 7 AND 53 AND p IS NOT NULL AND sigma>0 ORDER BY time`);
  for(const o of fresh){
    if(o.result!=='yes'&&o.result!=='no'){known.set(o.ticker,[]);continue;}
    const rows=ticks.all(o.ticker) as {time:number;tau:number;p:number;sigma:number;context:string}[],best=new Map<number,{row:typeof rows[0];context:RecordData}>();
    for(const r of rows){const context=parse(r.context);if(!context||probability(r.p)===null||finite(r.sigma)===null)continue;const h=LATE_HORIZONS.find(h=>Math.abs(r.tau-h)<=3);if(h===undefined)continue;const b=best.get(h);if(!b||Math.abs(r.tau-h)<Math.abs(b.row.tau-h))best.set(h,{row:r,context});}
    known.set(o.ticker,[...best.entries()].map(([h,{row:r,context}])=>({
      ...inputs(object(context.stackInputs)??object(context.features)??{},r.p,recordedMid(context,r.time),r.sigma),
      y:o.result==='yes'?1:0,ticker:o.ticker,horizon:String(h),time:r.time,settledTime:o.time
    } as StackSample)));
  }
  return [...known.values()].flat().sort((a,b)=>a.time!-b.time!||a.ticker.localeCompare(b.ticker));
}
/** Training rows: every frozen opening/live call on a settled market, with its model probability, Kalshi mid and features. */
export function stackSamples(db:Database.Database):StackSample[]{
  const rows=db.prepare(`SELECT c.ticker AS ticker,'open' AS horizon,c.time AS time,c.mid,c.context,r.result,r.time AS settled_time FROM opening_calls c JOIN outcomes r USING(ticker)
    UNION ALL SELECT l.ticker,CAST(l.horizon AS TEXT),l.time,l.mid,l.context,r.result,r.time FROM live_calls l JOIN outcomes r USING(ticker) ORDER BY time,ticker`).all() as {ticker:string;horizon:string;time:number;settled_time:number;mid:number|null;context:string;result:string}[];
  const out:StackSample[]=[];
  for(const r of rows){
    if(r.result!=='yes'&&r.result!=='no')continue;
    const saved=object(parse(r.context)?.inputs),modelP=probability(saved?.modelP),sigma=finite(saved?.sigma);if(!saved||modelP===null||sigma===null||sigma<=0)continue;
    // Preserve the exact feature used live, including an intentional null for a wide/stale book.
    // Older call records did not store inputs.mid, so only those fall back to the display midpoint.
    const mid=probability(Object.hasOwn(saved,'mid')?saved.mid:r.mid);
    out.push({...inputs(saved,modelP,mid,sigma),y:r.result==='yes'?1:0,ticker:r.ticker,horizon:r.horizon,time:r.time,settledTime:r.settled_time});
  }
  return out;
}
