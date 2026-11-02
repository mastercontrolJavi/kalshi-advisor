import {discreteAverageProbability,varianceRatio,volatility,type Sample} from '../model/math';
export const BENCHMARK_MODEL_VERSION='brti-discrete-v1';
export const BENCHMARK_HORIZONS=[600,300,120,60,30,10];
/** An independently recorded challenger. Never substitutes proxy ticks for the settlement index. */
/**
 * The final-minute lock in plain numbers (2026-11-02, DECISIONS 70): how many of the 60 settlement seconds
 * [close − 60 s, close) are already published, their average, and the average the remaining seconds need for YES
 * (Kalshi settles YES at ≥ K). moveSd is the standard deviation of that remaining average under the same Brownian
 * model as the forecast: the mean of M future 1-s values has variance (Sσ)²·M(M+1)(2M+1)/6 / M².
 */
export interface LockReadout {phase:'before'|'locking'|'gap'|'settled';opensIn:number|null;lockedCount:number;lockedAvg:number|null;remaining:number;requiredAvg:number|null;spot:number|null;requiredMove:number|null;moveSd:number|null;z:number|null;settledAvg:number|null;result:'yes'|'no'|null;missing:number}
export function lockReadout(history:Sample[],strike:number,close:number,now:number,sigma:number|null):LockReadout|null{
  if(!Number.isFinite(strike)||strike<=0||!Number.isFinite(close)||close%1000!==0||now>=close+5000)return null;
  const start=close-60000,latest=history.at(-1)??null,empty={opensIn:null,lockedCount:0,lockedAvg:null,remaining:60,requiredAvg:strike,spot:latest?.price??null,requiredMove:null,moveSd:null,z:null,settledAvg:null,result:null,missing:0};
  if(now<start)return {...empty,phase:'before',opensIn:(start-now)/1000};
  if(!latest)return {...empty,phase:'gap'};
  const byTime=new Map(history.map(s=>[s.time,s.price])),locked:number[]=[];let missing=0;
  for(let t=start;t<close&&t<=latest.time;t+=1000){const p=byTime.get(t);if(p===undefined)missing++;else locked.push(p);}
  const n=locked.length,sum=locked.reduce((s,x)=>s+x,0),m=60-n-missing,lockedAvg=n?sum/n:null;
  if(missing)return {...empty,phase:'gap',lockedCount:n,lockedAvg,remaining:m,missing,spot:latest.price};
  if(m<=0){const avg=sum/60;return {...empty,phase:'settled',lockedCount:60,lockedAvg:avg,remaining:0,requiredAvg:null,spot:latest.price,settledAvg:avg,result:avg>=strike?'yes':'no'};}
  const requiredAvg=(60*strike-sum)/m,requiredMove=requiredAvg-latest.price;
  const moveSd=sigma!==null&&sigma>0?latest.price*sigma*Math.sqrt(m*(m+1)*(2*m+1)/6)/m:null;
  return {phase:'locking',opensIn:null,lockedCount:n,lockedAvg,remaining:m,requiredAvg,spot:latest.price,requiredMove,moveSd,z:moveSd?requiredMove/moveSd:null,settledAvg:null,result:null,missing:0};
}
export function benchmarkForecast(history:Sample[],strike:number,close:number,now:number){
  const latest=history.at(-1);
  if(!latest||!Number.isFinite(strike)||strike<=0||!Number.isFinite(close)||close%1000!==0||now>=close||latest.time>now||now-latest.time>2500)return null;
  const contiguous=history.slice(-121);
  if(contiguous.length<121||contiguous.some((s,i)=>!(s.price>0)||!Number.isFinite(s.price)||i>0&&s.time-contiguous[i-1].time!==1000))return null;
  const vol=volatility(history),vr=varianceRatio(history,60,1,60),sigma=vol.sigma1s*Math.sqrt(vr.ratio);
  if(!(sigma>0))return null;
  const byTime=new Map(history.map(s=>[s.time,s.price])),locked:number[]=[],offsets:number[]=[];
  // Kalshi settles on the 60 1Hz values in [close - 60s, close): the close second itself is excluded. Checked against
  // Kalshi's published value on 983 of 983 rounds (within half a cent); (close - 60s, close] was one second late (DECISIONS 69).
  for(let t=close-60000;t<close;t+=1000){
    if(t<=latest.time){const p=byTime.get(t);if(p===undefined)return null;locked.push(p);}
    else offsets.push((t-latest.time)/1000);
  }
  return {...discreteAverageProbability(latest.price,strike,sigma,locked,offsets),sigma,spot:latest.price,
    sourceTime:latest.time,version:BENCHMARK_MODEL_VERSION,source:'BRTI' as const,active:false as const};
}
