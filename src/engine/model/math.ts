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
/**
 * Multi-scale variance correction. The 4-venue median proxy is smoother second-to-second than BTC really is, and
 * minute-scale returns trend a little, so √t-scaling 1-s variance understates the variance over the horizons that
 * settle a market. Measured on 9.9 h of recorded proxy (2026-10-07): Var(r_h)/(h·Var(r_1)) ≈ 1.3–1.6 from 5 s to
 * 15 min; scaling the model's variance by 1.5 improved settled-window Brier from 0.1593 to 0.1581 (Kalshi 0.1590 on the
 * same samples). The live ratio from the last hour's 60-s returns updates a prior of 1.5 worth PRIOR_WEIGHT samples.
 */
export const VR_PRIOR=1.5,VR_PRIOR_WEIGHT=60,VR_SCALE=60;
export function varianceRatio(samples:Sample[],scale=VR_SCALE,prior=VR_PRIOR,priorWeight=VR_PRIOR_WEIGHT){
  const recent=samples.slice(-3601);let s1=0,n1=0,sh=0,nh=0;
  for(let i=1;i<recent.length;i++)if(recent[i].time-recent[i-1].time===1000){const r=Math.log(recent[i].price/recent[i-1].price);s1+=r*r;n1++;}
  for(let i=recent.length-1;i-scale>=0;i-=scale)if(recent[i].time-recent[i-scale].time===scale*1000){const r=Math.log(recent[i].price/recent[i-scale].price);sh+=r*r;nh++;}
  const live=n1>scale&&nh>0&&s1>0?(sh/nh)/(scale*s1/n1):null;
  const ratio=live===null?prior:(prior*priorWeight+live*nh)/(priorWeight+nh);
  return {ratio:Math.min(2.5,Math.max(1,ratio)),live,samples:nh};
}
export function volatility(samples:Sample[],halfLife=300,blend=.25){
  const recent=samples.slice(-3601),returns:number[]=[];
  for(let i=1;i<recent.length;i++)if(recent[i].time-recent[i-1].time===1000)returns.push(Math.log(recent[i].price/recent[i-1].price));
  if(returns.length<2)return {sigma:0,sigma1s:0,varianceRatio:VR_PRIOR,varianceRatioLive:null as number|null,count:returns.length,regime:'warming' as string,percentile:null as number|null};
  const alpha=1-Math.exp(-Math.LN2/halfLife);let ewma=returns[0]**2;const history:number[]=[];
  for(const r of returns){ewma=(1-alpha)*ewma+alpha*r*r;history.push(Math.sqrt(ewma));}
  const sigma1s=Math.sqrt((1-blend)*ewma+blend*mean(returns.map(r=>r*r)));
  const percentile=history.filter(v=>v<=sigma1s).length/history.length,vr=varianceRatio(samples);
  // sigma is the per-√second volatility the model should use: 1-s volatility scaled to settlement horizons.
  return {sigma:sigma1s*Math.sqrt(vr.ratio),sigma1s,varianceRatio:vr.ratio,varianceRatioLive:vr.live,count:returns.length,regime:percentile<.25?'calm':percentile>.75?'volatile':'normal',percentile};
}
/**
 * Warm start: while fewer than `needed` contiguous returns exist (e.g. after a restart), blend the saved σ from the last
 * session (if under maxAgeMs old) with what has been observed so far, weighting by the fraction of the warm-up done.
 * Volatility persists over hours far more than prices do, so this is far better than no model for two minutes.
 */
export function warmVolatility<T extends {sigma:number;count:number;regime:string}>(vol:T,saved:{sigma:number;time:number}|null,needed:number,now:number,maxAgeMs=12*3600000):T&{source:'live'|'carried over'|'warming'}{
  if(vol.count>=needed&&vol.sigma>0)return {...vol,source:'live'};
  if(!saved||!(saved.sigma>0)||now-saved.time>maxAgeMs)return {...vol,source:'warming'};
  const w=Math.min(1,vol.count/needed),sigma=Math.sqrt(w*(vol.sigma>0?vol.sigma**2:saved.sigma**2)+(1-w)*saved.sigma**2);
  return {...vol,sigma,count:needed,regime:vol.regime==='warming'?'carried over':vol.regime,source:'carried over'};
}
export function coveredSeconds(samples:Sample[],start:number,end:number):number[]|null {
  const map=new Map(samples.map(s=>[s.time,s.price]));const result:number[]=[];
  for(let t=start;t<end;t+=1000){const p=map.get(t);if(p===undefined)return null;result.push(p);}
  return result;
}
/**
 * Like coveredSeconds, but bridges short gaps (≤ maxGap seconds) by linear interpolation between the observed
 * neighbours (or the nearest observation at an edge). A one-second engine stall previously blanked the final-minute
 * model until close (5 of 28 windows); interpolating 1–2 s of BTC costs cents against a σ-of-average of tens of dollars.
 * Longer gaps still return null so the model pauses rather than guess.
 */
export function filledSeconds(samples:Sample[],start:number,end:number,maxGap=5):{values:number[];imputed:number}|null {
  const map=new Map(samples.map(s=>[s.time,s.price]));const slots:(number|undefined)[]=[];
  for(let t=start;t<end;t+=1000)slots.push(map.get(t));
  if(!slots.length)return {values:[],imputed:0};
  let imputed=0;const values:number[]=new Array(slots.length);
  for(let i=0;i<slots.length;){
    if(slots[i]!==undefined){values[i]=slots[i]!;i++;continue;}
    let j=i;while(j<slots.length&&slots[j]===undefined)j++;
    const gap=j-i,before=i>0?values[i-1]:map.get(start-1000),after=j<slots.length?slots[j]:undefined;
    if(gap>maxGap||(before===undefined&&after===undefined))return null;
    for(let k=i;k<j;k++){const w=(k-i+1)/(gap+1);values[k]=before!==undefined&&after!==undefined?before+(after-before)*w:(before??after)!;}
    imputed+=gap;i=j;
  }
  return {values,imputed};
}
