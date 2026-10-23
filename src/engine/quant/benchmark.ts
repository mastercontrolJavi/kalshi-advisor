import {discreteAverageProbability,varianceRatio,volatility,type Sample} from '../model/math';
export const BENCHMARK_MODEL_VERSION='brti-discrete-v1';
export const BENCHMARK_HORIZONS=[600,300,120,60,30,10];
/** An independently recorded challenger. Never substitutes proxy ticks for the settlement index. */
export function benchmarkForecast(history:Sample[],strike:number,close:number,now:number){
  const latest=history.at(-1);
  if(!latest||!Number.isFinite(strike)||strike<=0||!Number.isFinite(close)||close%1000!==0||now>=close||latest.time>now||now-latest.time>2500)return null;
  const contiguous=history.slice(-121);
  if(contiguous.length<121||contiguous.some((s,i)=>!(s.price>0)||!Number.isFinite(s.price)||i>0&&s.time-contiguous[i-1].time!==1000))return null;
  const vol=volatility(history),vr=varianceRatio(history,60,1,60),sigma=vol.sigma1s*Math.sqrt(vr.ratio);
  if(!(sigma>0))return null;
  const byTime=new Map(history.map(s=>[s.time,s.price])),locked:number[]=[],offsets:number[]=[];
  // Kalshi's documented quarter-hour final minute is (close - 60s, close], exactly 60 1Hz values.
  for(let t=close-59000;t<=close;t+=1000){
    if(t<=latest.time){const p=byTime.get(t);if(p===undefined)return null;locked.push(p);}
    else offsets.push((t-latest.time)/1000);
  }
  return {...discreteAverageProbability(latest.price,strike,sigma,locked,offsets),sigma,spot:latest.price,
    sourceTime:latest.time,version:BENCHMARK_MODEL_VERSION,source:'BRTI' as const,active:false as const};
}
