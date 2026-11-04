/** Candle maths for the price chart (no DOM): per-second samples → OHLC buckets, live updates, and the K step line. */
export interface Candle {time:number;open:number;high:number;low:number;close:number}
export interface Round {ticker:string;open:number;close:number;k:number}
/** Bucket start in seconds (what the chart library calls UTCTimestamp) for a time in ms. */
export const bucketOf=(ms:number,tf:number)=>Math.floor(ms/1000/tf)*tf;
/** Merge refreshed history with ticks received while it was in flight, retaining two hours. */
export function mergeSamples(history:[number,number][],live:[number,number][],since:number):[number,number][]{
  const points=new Map<number,number>();
  for(const [t,p] of [...history,...live])if(Number.isFinite(t)&&Number.isFinite(p)&&p>0&&t>=since)points.set(t,p);
  return [...points].sort((a,b)=>a[0]-b[0]);
}
export function aggregate(samples:[number,number][],tf:number):Candle[]{
  if(!Number.isFinite(tf)||tf<=0)return [];
  const out:Candle[]=[];
  for(const [t,p] of [...samples].sort((a,b)=>a[0]-b[0])){if(!Number.isFinite(t)||!Number.isFinite(p)||p<0)continue;const b=bucketOf(t,tf),last=out.at(-1);
    if(last&&last.time===b){last.high=Math.max(last.high,p);last.low=Math.min(last.low,p);last.close=p;}
    else if(!last||b>last.time)out.push({time:b,open:p,high:p,low:p,close:p});}
  return out;
}
/** Adds one live price; returns the candle to draw (the updated last one, or a new one). Older times are ignored. */
export function addPrice(candles:Candle[],ms:number,p:number,tf:number):Candle|null{
  if(!Number.isFinite(ms)||!Number.isFinite(tf)||tf<=0||!Number.isFinite(p)||p<0)return null;const b=bucketOf(ms,tf),last=candles.at(-1);
  if(last&&last.time===b){last.high=Math.max(last.high,p);last.low=Math.min(last.low,p);last.close=p;return last;}
  if(last&&b<last.time)return null;const open=last&&b-last.time===tf?last.close:p,c={time:b,open,high:Math.max(p,open),low:Math.min(p,open),close:p};candles.push(c);return c;
}
/** K as a step line: one point per candle inside each round, a gap (whitespace) between rounds so K never bridges two rounds. */
export function kPoints(rounds:Round[],candles:Candle[]):({time:number;value:number}|{time:number})[]{
  return candles.map(c=>{const r=rounds.find(x=>c.time*1000>=x.open&&c.time*1000<x.close);return r?{time:c.time,value:r.k}:{time:c.time};});
}
/** A fill to mark on the chart: price is what was paid (buy) or received (sell) per contract of that side. */
export interface ChartMark {time:number;price:number;side:'yes'|'no';action:'buy'|'sell';contracts?:number}
/** One real Kalshi fill as the engine sends it (journal RealEvent): side is the direction acquired (yes = buy YES or
 *  sell NO), price is that side's price, and closedContracts is how much of it netted away a position on the other side. */
export interface RoundFill {time:number;side:string;price:number;contracts:number;closedContracts?:number}
const other=(s:'yes'|'no')=>s==='yes'?'no':'yes';
/** Real fills as buys and sells the way you placed them: acquiring NO while holding YES is selling YES at 1 − the NO price. */
export function fillMarks(fills:RoundFill[]):ChartMark[]{
  const out:ChartMark[]=[];
  for(const f of fills){if(f.side!=='yes'&&f.side!=='no'||!Number.isFinite(f.time)||!Number.isFinite(f.price)||!(f.contracts>0))continue;
    const closed=Math.min(f.contracts,Math.max(0,f.closedContracts??0)),opened=f.contracts-closed;
    if(closed>1e-8)out.push({time:f.time,side:other(f.side),action:'sell',price:1-f.price,contracts:closed});
    if(opened>1e-8)out.push({time:f.time,side:f.side,action:'buy',price:f.price,contracts:opened});}
  return out;
}
/** Marks that fall in the same candle with the same side and action become one (an order often fills in pieces):
 *  contracts add up and the price is their contract-weighted average. Sorted by time, as the chart requires. */
export function groupMarks(marks:ChartMark[],tf:number):(ChartMark&{bucket:number})[]{
  const groups=new Map<string,ChartMark&{bucket:number;w:number;sum:number}>();
  for(const m of marks){if(!Number.isFinite(m.time)||!Number.isFinite(m.price))continue;const bucket=bucketOf(m.time,tf),key=`${bucket}:${m.action}:${m.side}`,w=m.contracts!=null&&m.contracts>0?m.contracts:1,g=groups.get(key);
    if(!g){groups.set(key,{...m,bucket,w,sum:m.price*w});continue;}
    g.w+=w;g.sum+=m.price*w;g.price=g.sum/g.w;g.contracts=g.contracts!=null&&m.contracts!=null?g.contracts+m.contracts:undefined;}
  return [...groups.values()].map(({w:_w,sum:_s,...m})=>m).sort((a,b)=>a.bucket-b.bucket||a.time-b.time);
}
/** "Buy YES 45¢ ×10": the marker text. */
export function markText(m:ChartMark):string{
  const n=m.contracts!=null?` ×${Number.isInteger(m.contracts)?m.contracts:+m.contracts.toFixed(2)}`:'';
  return `${m.action==='buy'?'Buy':'Sell'} ${m.side.toUpperCase()} ${Math.round(m.price*100)}¢${n}`;
}
