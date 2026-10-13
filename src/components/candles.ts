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
