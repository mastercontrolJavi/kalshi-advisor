import type Database from 'better-sqlite3';
import type {StackSample} from './stack';
/**
 * Final-minute training rows for the late-round forecast: on every settled market, the recorded second nearest each of
 * 50/40/30/20/10 s left (within ±3 s), with the model probability (which already sees the locked part of the average),
 * Kalshi's mid when the spread is ≤ 10¢, and the same microstructure features as the main stack.
 */
export const LATE_HORIZONS=[50,40,30,20,10];
/** `cache` (ticker → its rows) makes repeated calls read only rounds settled since the last call. */
export function lateSamples(db:Database.Database,cache?:Map<string,StackSample[]>):StackSample[]{
  const known=cache??new Map<string,StackSample[]>(),fresh=(db.prepare('SELECT ticker,result FROM outcomes').all() as {ticker:string;result:string}[]).filter(o=>!known.has(o.ticker));
  const ticks=db.prepare(`SELECT tau,p,sigma,json_extract(context,'$.book.yesBid') yb,json_extract(context,'$.book.yesAsk') ya,json_extract(context,'$.features') f
    FROM ticks INDEXED BY ticks_market_tau WHERE ticker=? AND tau BETWEEN 7 AND 53 AND p IS NOT NULL AND sigma>0`);
  for(const o of fresh){
    if(o.result!=='yes'&&o.result!=='no'){known.set(o.ticker,[]);continue;}
    const rows=ticks.all(o.ticker) as {tau:number;p:number;sigma:number;yb:number|null;ya:number|null;f:string|null}[],best=new Map<number,typeof rows[0]>();
    for(const r of rows){const h=LATE_HORIZONS.find(h=>Math.abs(r.tau-h)<=3);if(h===undefined)continue;const b=best.get(h);if(!b||Math.abs(r.tau-h)<Math.abs(b.tau-h))best.set(h,r);}
    known.set(o.ticker,[...best.entries()].map(([h,r])=>{const f=r.f?JSON.parse(r.f):{},mid=r.yb!=null&&r.ya!=null&&r.ya>r.yb&&r.ya-r.yb<=.1?(r.yb+r.ya)/2:null;
      return {modelP:r.p,mid,sigma:r.sigma,momentum30s:f.momentum30s??null,momentum120s:f.momentum120s??null,imbalance:f.imbalance??null,tradeFlow30s:f.tradeFlow30s??null,tradeVolume30s:f.tradeVolume30s??null,y:o.result==='yes'?1:0,ticker:o.ticker,horizon:String(h)} as StackSample;}));
  }
  return [...known.values()].flat();
}
/** Training rows: every frozen opening/live call on a settled market, with its model probability, Kalshi mid and features. */
export function stackSamples(db:Database.Database):StackSample[]{
  const rows=db.prepare(`SELECT c.ticker,'open' AS horizon,c.mid,c.context,r.result FROM opening_calls c JOIN outcomes r USING(ticker)
    UNION ALL SELECT l.ticker,CAST(l.horizon AS TEXT),l.mid,l.context,r.result FROM live_calls l JOIN outcomes r USING(ticker)`).all() as {ticker:string;horizon:string;mid:number|null;context:string;result:string}[];
  const out:StackSample[]=[];
  for(const r of rows){
    if(r.result!=='yes'&&r.result!=='no')continue;
    const inputs=JSON.parse(r.context).inputs;if(!inputs||!Number.isFinite(inputs.modelP)||!(inputs.sigma>0))continue;
    // Preserve the exact feature used live, including an intentional null for a wide/stale book.
    // Older call records did not store inputs.mid, so only those fall back to the display midpoint.
    const mid=Object.hasOwn(inputs,'mid')?inputs.mid:r.mid;
    out.push({modelP:inputs.modelP,mid:Number.isFinite(mid)&&mid>=0&&mid<=1?mid:null,sigma:inputs.sigma,momentum30s:inputs.momentum30s??null,momentum120s:inputs.momentum120s??null,imbalance:inputs.imbalance??null,tradeFlow30s:inputs.tradeFlow30s??null,tradeVolume30s:inputs.tradeVolume30s??null,y:r.result==='yes'?1:0,ticker:r.ticker,horizon:r.horizon});
  }
  return out;
}
