export interface Sample { time:number; price:number }
export const mean=(a:number[])=>a.reduce((s,x)=>s+x,0)/a.length;
export function normalCDF(x:number):number {
  if(x===0)return .5;
  const t=1/(1+.2316419*Math.abs(x));
  const tail=Math.exp(-x*x/2)/Math.sqrt(2*Math.PI)*t*(.319381530+t*(-.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))));
  return x>0?1-tail:tail;
}
/** Exact conditional Brownian arithmetic-average moments, with diffusion coefficient S*sigma. */
export function averageMoments(spot:number,sigma:number,tau:number,locked:number[]=[]){
  if(![spot,sigma,tau,...locked].every(Number.isFinite)||spot<=0||sigma<0||tau<0)throw new Error('Invalid model inputs');
  if(tau>60) return {expected:spot,variance:(spot*sigma)**2*(tau-60+60/3),lockedCount:0};
  const elapsed=60-tau;
  if(locked.length!==Math.round(elapsed))throw new Error('Incomplete locked average');
  return {expected:(locked.reduce((s,x)=>s+x,0)+tau*spot)/60,variance:(spot*sigma)**2*tau**3/(3*60**2),lockedCount:locked.length};
}
export function probability(spot:number,strike:number,sigma:number,tau:number,locked:number[]=[],basis=0){
  const m=averageMoments(spot,sigma,tau,locked),expected=m.expected+basis;
  if(strike<=0||expected<=0)throw new Error('Invalid strike or corrected average');
  const logSD=Math.sqrt(Math.log1p(m.variance/expected**2));
  // Median-centered approximation preserves S=K symmetry; arithmetic moments above remain exact for diffusion.
  const z=logSD>0?Math.log(expected/strike)/logSD:(expected===strike?0:expected>strike?Infinity:-Infinity);
  return {...m,expected,sd:Math.sqrt(m.variance),z,p:Math.min(.99,Math.max(.01,normalCDF(z)))};
}
export function volatility(samples:Sample[],halfLife=300,blend=.25){
  const recent=samples.slice(-3601),returns:number[]=[];
  for(let i=1;i<recent.length;i++)if(recent[i].time-recent[i-1].time===1000)returns.push(Math.log(recent[i].price/recent[i-1].price));
  if(returns.length<2)return {sigma:0,count:returns.length,regime:'warming' as string,percentile:null as number|null};
  const alpha=1-Math.exp(-Math.LN2/halfLife);let ewma=returns[0]**2;const history:number[]=[];
  for(const r of returns){ewma=(1-alpha)*ewma+alpha*r*r;history.push(Math.sqrt(ewma));}
  const sigma=Math.sqrt((1-blend)*ewma+blend*mean(returns.map(r=>r*r)));
  const percentile=history.filter(v=>v<=sigma).length/history.length;
  return {sigma,count:returns.length,regime:percentile<.25?'calm':percentile>.75?'volatile':'normal',percentile};
}
export function coveredSeconds(samples:Sample[],start:number,end:number):number[]|null {
  const map=new Map(samples.map(s=>[s.time,s.price]));const result:number[]=[];
  for(let t=start;t<end;t+=1000){const p=map.get(t);if(p===undefined)return null;result.push(p);}
  return result;
}
