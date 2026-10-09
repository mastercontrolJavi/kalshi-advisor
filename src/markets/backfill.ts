import {isBitcoin,groupOf} from './categories';
/** Hourly Kalshi candle, prices in dollars; an empty side of the book (bid 0 / ask 1) is null. */
export interface Candle {end:number;bid:number|null;ask:number|null;mean:number|null;volume:number}
const num=(v:unknown)=>{const n=Number(v);return v===undefined||v===null||v===''||!Number.isFinite(n)?null:n;};
export function parseCandle(c:any):Candle{
  const bid=num(c?.yes_bid?.close_dollars),ask=num(c?.yes_ask?.close_dollars),mean=num(c?.price?.mean_dollars);
  return {end:Number(c.end_period_ts),bid:bid!==null&&bid>0?bid:null,ask:ask!==null&&ask>0&&ask<1?ask:null,mean,volume:num(c.volume_fp)??0};
}
const secs=(v:unknown)=>{const t=typeof v==='string'?Date.parse(v):NaN;return Number.isFinite(t)?Math.floor(t/1000):null;};
/** When the outcome is decided in practice: a game's start (occurrence) if before settlement, else settlement (or close). */
export function eventTime(m:any):number|null{
  const settle=secs(m.settlement_ts)??secs(m.close_time),occ=secs(m.occurrence_datetime);
  return occ!==null&&settle!==null&&occ<settle?occ:settle;
}
const STALE=2*3600,MAX_SPREAD=.2;
/** YES mid and ask at `ts`: the latest candle ending at or before it, at most 2 h old, with a tradable two-sided book. */
export function priceAt(candles:Candle[],ts:number):{mid:number;ask:number}|null{
  let best:Candle|null=null;for(const c of candles)if(c.end<=ts&&(!best||c.end>best.end))best=c;
  if(!best||ts-best.end>STALE||best.bid===null||best.ask===null||best.ask<best.bid||best.ask-best.bid>MAX_SPREAD)return null;
  return {mid:(best.bid+best.ask)/2,ask:best.ask};
}
/** Volume-weighted mean traded price over (from, to]; null when nothing traded. */
export function vwap(candles:Candle[],from:number,to:number):number|null{
  let s=0,v=0;for(const c of candles)if(c.end>from&&c.end<=to&&c.volume>0&&c.mean!==null){s+=c.mean*c.volume;v+=c.volume;}
  return v>0?s/v:null;
}
/** Top `perGroup` series by lifetime volume in each page group, plus every series the user traded; no Bitcoin, no combos. */
export function pickSeries(series:{ticker:string;category:string|null;volume:number}[],traded:Set<string>,perGroup=20):string[]{
  const ok=(t:string)=>!isBitcoin(t)&&!t.startsWith('KXMVE'),out=new Set<string>();
  for(const g of ['sports','politics','commodities'] as const)
    series.filter(s=>ok(s.ticker)&&groupOf(s.category,false)===g).sort((a,b)=>b.volume-a.volume).slice(0,perGroup).forEach(s=>out.add(s.ticker));
  for(const t of traded)if(ok(t))out.add(t);
  return [...out];
}
/** Batches for /markets/candlesticks: ≤ maxTickers each, and tickers × hours (span + lookback) ≤ maxCandles. */
export function candleGroups<T extends {ticker:string;event:number}>(rows:T[],maxTickers=100,maxCandles=9900,lookbackH=25):T[][]{
  const sorted=[...rows].sort((a,b)=>a.event-b.event||a.ticker.localeCompare(b.ticker)),out:T[][]=[];let g:T[]=[];
  const cost=(x:T[])=>x.length*(Math.ceil((x.at(-1)!.event-x[0].event)/3600)+lookbackH);
  for(const r of sorted){const next=[...g,r];if(g.length&&(next.length>maxTickers||cost(next)>maxCandles)){out.push(g);g=[r];}else g=next;}
  if(g.length)out.push(g);return out;
}
