import {normalCDF,type Sample} from '../model/math';

export const PRICE_HORIZONS=[30,60,180] as const;
export const PRICE_FEATURES=['baseline','30s momentum','2m momentum','candle body','wick pressure','range position','range expansion','momentum change'];
export const PRICE_VERSION=1,LOOKBACK=300,PRICE_FIT_MAX_AGE=30*60000;
const clamp=(x:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,x));
export type PriceDirection='UP'|'DOWN'|'UNCLEAR';
export interface PriceInputs {time:number;spot:number;sigma:number;x:number[]}
export interface PriceTraining extends PriceInputs {horizon:number;targetTime:number;z:number}
export interface PriceScore {n:number;brier:number|null;baseline:number|null;improvement:number|null;improvementLow:number|null;improvementHigh:number|null;blocks:number;calls:number;hits:number;hitRate:number|null;coverage:number|null;calibration:{low:number;high:number;n:number;predicted:number;observed:number}[]}
export interface PriceFit {version:number;horizon:number;fitted:number;through:number;n:number;active:boolean;weights:number[];noise:number;band?:number;validation:PriceScore;folds:{n:number;improvement:number|null;trainThrough:number;testFrom:number}[];reason:string}
export interface PricePrediction {time:number;targetTime:number;horizon:number;spot:number;pUp:number;direction:PriceDirection;expected:number;low:number;high:number;logMove:number;logSD:number;active:boolean;reason:string;drivers:{name:string;effect:number}[];validation:PriceScore;training:number;fitted:number}
const emptyScore=():PriceScore=>({n:0,brier:null,baseline:null,improvement:null,improvementLow:null,improvementHigh:null,blocks:0,calls:0,hits:0,hitRate:null,coverage:null,calibration:[]});
export function emptyPriceFit(horizon:number):PriceFit{return {version:PRICE_VERSION,horizon,fitted:0,through:0,n:0,active:false,weights:Array(PRICE_FEATURES.length).fill(0),noise:1,validation:emptyScore(),folds:[],reason:'Collecting price history'};}

/** Only prices available at `time` enter features. Require a complete five-minute window; never fill gaps. */
export function priceInputs(samples:Sample[],time:number):PriceInputs|null{
  const map=new Map<number,number>();for(const s of samples)if(s.time>=time-LOOKBACK*1000&&s.time<=time&&s.price>0&&Number.isFinite(s.price))map.set(s.time,s.price);
  const p:number[]=[];for(let t=time-LOOKBACK*1000;t<=time;t+=1000){const v=map.get(t);if(v===undefined)return null;p.push(v);}
  let v=0;for(let j=1;j<p.length;j++)v+=Math.log(p[j]/p[j-1])**2;
  const sigma=Math.max(1e-6,Math.sqrt(v/LOOKBACK)),spot=p.at(-1)!;
  const momentum=(seconds:number,end=LOOKBACK)=>Math.log(p[end]/p[end-seconds])/(sigma*Math.sqrt(seconds));
  // Use the last fully closed, clock-aligned 15-second candle. Partial candles cannot rewrite training features.
  const close=Math.floor(time/15000)*15000-1000,candle:number[]=[];
  for(let t=close-14000;t<=close;t+=1000)candle.push(map.get(t)!);
  const o=candle[0],c=candle.at(-1)!,hi=Math.max(...candle),lo=Math.min(...candle),range=Math.max(hi-lo,spot*sigma);
  const recent=p.slice(-61),h=Math.max(...recent),l=Math.min(...recent),r30=p.slice(-31);
  return {time,spot,sigma,x:[1,Math.tanh(momentum(30)),Math.tanh(momentum(120)),Math.tanh(Math.log(c/o)/(sigma*Math.sqrt(15))),
    ((Math.min(o,c)-lo)-(hi-Math.max(o,c)))/range,h>l?2*(spot-l)/(h-l)-1:0,
    Math.tanh(Math.log(Math.max(1e-6,(Math.max(...r30)-Math.min(...r30))/(spot*sigma*Math.sqrt(30))))),Math.tanh(momentum(30)-momentum(30,LOOKBACK-30))]};
}
/** Non-overlapping targets within each horizon. Labels are available only after their actual deadline price exists. */
export function priceTraining(samples:Sample[],horizon:number):PriceTraining[]{
  const sorted=[...new Map(samples.filter(s=>Number.isFinite(s.time)&&s.price>0&&Number.isFinite(s.price)).map(s=>[s.time,s])).values()].sort((a,b)=>a.time-b.time),map=new Map(sorted.map(s=>[s.time,s.price]));
  const out:PriceTraining[]=[];let first=0;
  for(let i=0;i<sorted.length;i++){const s=sorted[i];if(s.time%(horizon*1000)!==0)continue;const future=map.get(s.time+horizon*1000);if(future===undefined)continue;
    while(first<i&&sorted[first].time<s.time-LOOKBACK*1000)first++;
    const inputs=priceInputs(sorted.slice(first,i+1),s.time);if(inputs)out.push({...inputs,horizon,targetTime:s.time+horizon*1000,z:Math.log(future/s.price)/(inputs.sigma*Math.sqrt(horizon))});
  }return out;
}
function regression(rows:PriceTraining[]){
  const n=PRICE_FEATURES.length,A=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===j?(i===0?100:40):0)),b=Array(n).fill(0);
  for(const r of rows){const z=clamp(r.z,-6,6);for(let i=0;i<n;i++){b[i]+=r.x[i]*z;for(let j=0;j<n;j++)A[i][j]+=r.x[i]*r.x[j];}}
  const M=A.map((a,i)=>[...a,b[i]]);
  for(let k=0;k<n;k++){const d=M[k][k];for(let j=k;j<=n;j++)M[k][j]/=d;for(let i=0;i<n;i++)if(i!==k){const f=M[i][k];for(let j=k;j<=n;j++)M[i][j]-=f*M[k][j];}}
  const weights=M.map(r=>r[n]),residuals=rows.map(r=>Math.abs(r.z-meanZ(weights,r.x))).sort((a,b)=>a-b);
  const noise=clamp(Math.sqrt(residuals.reduce((s,e)=>s+e*e,0)/Math.max(1,rows.length)),.5,3);
  // The 80% range uses the empirical 80th percentile of |residual|: fat-tailed jumps inflate the RMS (noise), which made the
  // band cover ~91% of outcomes instead of 80%. Probabilities keep the conservative RMS scale.
  const band=residuals.length?clamp(residuals[Math.min(residuals.length-1,Math.floor(residuals.length*.8))]/Z80,.3,3):noise;
  return {weights,noise,band};
}
const Z80=1.281551565545;
const meanZ=(w:number[],x:number[])=>clamp(w.reduce((s,v,i)=>s+v*x[i],0),-2,2);
export const priceProbability=(mean:number,noise:number)=>clamp(normalCDF(mean/noise),.05,.95);
export const priceDirection=(p:number,active=true):PriceDirection=>!active?'UNCLEAR':p>=.58?'UP':p<=.42?'DOWN':'UNCLEAR';
export function priceScores(rows:{time?:number;p:number;z:number;mean:number;noise:number;direction?:PriceDirection}[]):PriceScore{
  const directional=rows.filter(r=>Math.abs(r.z)>1e-10),n=directional.length,brier=n?directional.reduce((s,r)=>s+(r.p-(r.z>0?1:0))**2,0)/n:null;
  const called=directional.filter(r=>(r.direction??priceDirection(r.p))!=='UNCLEAR'),hits=called.filter(r=>((r.direction??priceDirection(r.p))==='UP')===(r.z>0)).length;
  const calibration=Array.from({length:5},(_,i)=>{const low=i*.2,high=(i+1)*.2,group=directional.filter(r=>r.p>=low&&(r.p<high||i===4&&r.p<=high));return {low,high,n:group.length,predicted:group.length?group.reduce((s,r)=>s+r.p,0)/group.length:0,observed:group.length?group.filter(r=>r.z>0).length/group.length:0};}).filter(b=>b.n);
  // Resample whole 15-minute blocks so adjacent candles are not treated as independent evidence.
  const groups=new Map<number,{n:number;gain:number}>();for(const r of directional)if(r.time!==undefined){const key=Math.floor(r.time/900000),g=groups.get(key)??{n:0,gain:0};g.n++;g.gain+=.25-(r.p-(r.z>0?1:0))**2;groups.set(key,g);}
  const blocks=[...groups.values()],boot:number[]=[];let seed=12345;
  if(blocks.length>=20)for(let j=0;j<400;j++){let gain=0,count=0;for(let k=0;k<blocks.length;k++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const b=blocks[Math.floor(seed/4294967296*blocks.length)];gain+=b.gain;count+=b.n;}boot.push(gain/count);}boot.sort((a,b)=>a-b);
  return {n,brier,baseline:n ? .25 : null,improvement:brier===null?null:.25-brier,improvementLow:boot.length?boot[Math.floor(boot.length*.025)]:null,improvementHigh:boot.length?boot[Math.floor(boot.length*.975)]:null,blocks:blocks.length,calls:called.length,hits,hitRate:called.length?hits/called.length:null,
    coverage:rows.length?rows.filter(r=>Math.abs(r.z-r.mean)<=1.281551565545*r.noise).length/rows.length:null,calibration};
}
/** Expanding chronological validation, with labels purged for three minutes before every test block. */
export function fitPrice(rows:PriceTraining[],horizon:number,now=Date.now()):PriceFit{
  const sorted=rows.filter(r=>r.horizon===horizon&&r.targetTime<=now).sort((a,b)=>a.time-b.time),base=emptyPriceFit(horizon);
  if(sorted.length<120)return {...base,fitted:now,n:sorted.length,through:sorted.at(-1)?.targetTime??0,reason:'Needs more complete price observations'};
  const folds:PriceFit['folds']=[],held:{time:number;p:number;z:number;mean:number;noise:number}[]=[];
  for(let f=0;f<3;f++){const start=Math.floor(sorted.length*(.5+f/6)),end=f===2?sorted.length:Math.floor(sorted.length*(.5+(f+1)/6)),test=sorted.slice(start,end),from=test[0]?.time;
    if(from===undefined)continue;const train=sorted.slice(0,start).filter(r=>r.targetTime<from-180000);if(train.length<40)continue;
    const fit=regression(train),predictions=test.map(r=>{const mean=meanZ(fit.weights,r.x);return {time:r.time,p:priceProbability(mean,fit.noise),z:r.z,mean,noise:fit.band};}),score=priceScores(predictions);
    held.push(...predictions);folds.push({n:score.n,improvement:score.improvement,trainThrough:train.at(-1)!.targetTime,testFrom:from});
  }
  const validation=priceScores(held),span=sorted.at(-1)!.targetTime-sorted[0].time,calibrated=validation.calibration.filter(b=>b.n>=30).every(b=>Math.abs(b.predicted-b.observed)<=.12);
  const active=sorted.length>=300&&span>=6*3600000&&validation.n>=120&&folds.length===3&&folds.filter(f=>(f.improvement??0)>0).length>=2&&(folds.at(-1)?.improvement??0)>0&&(validation.improvement??0)>=.005&&(validation.improvementLow??0)>0&&calibrated;
  const final=regression(sorted);
  return {...base,...final,active,n:sorted.length,fitted:now,through:sorted.at(-1)!.targetTime,validation,folds,reason:active?'Beat the coin-flip baseline on later data':validation.n<120?'Needs more later-data tests':'No reliable directional advantage yet'};
}
export function forecastPrice(input:PriceInputs,fit:PriceFit,now=input.time):PricePrediction{
  const active=fit.active&&now-fit.fitted>=0&&now-fit.fitted<PRICE_FIT_MAX_AGE,weights=active?fit.weights:fit.weights.map(()=>0),mu=meanZ(weights,input.x),noise=fit.fitted?fit.noise:1,logSD=(fit.fitted?fit.band??fit.noise:1)*input.sigma*Math.sqrt(fit.horizon),logMove=mu*input.sigma*Math.sqrt(fit.horizon),pUp=priceProbability(mu,noise);
  return {time:input.time,targetTime:input.time+fit.horizon*1000,horizon:fit.horizon,spot:input.spot,pUp,direction:priceDirection(pUp,active),expected:input.spot*Math.exp(logMove+.5*logSD**2),low:input.spot*Math.exp(logMove-1.281551565545*logSD),high:input.spot*Math.exp(logMove+1.281551565545*logSD),logMove,logSD,active,
    reason:fit.active&&!active?'Fit expired; waiting for refresh':fit.reason,drivers:active?weights.map((w,i)=>({name:PRICE_FEATURES[i],effect:w*input.x[i]})).filter(d=>d.name!=='baseline'&&Math.abs(d.effect)>.01).sort((a,b)=>Math.abs(b.effect)-Math.abs(a.effect)).slice(0,3):[],validation:fit.validation,training:fit.n,fitted:fit.fitted};
}
/** Smooth conditional log-price envelope used by the chart. These are projections, never observed candles. */
export function priceProjection(p:PricePrediction,intervalSeconds=15){const steps=Math.max(1,Math.ceil(p.horizon/Math.max(1,intervalSeconds)));return Array.from({length:steps+1},(_,i)=>{const f=i/steps,mean=p.logMove*f,sd=p.logSD*Math.sqrt(f),time=Math.floor(p.time/1000+p.horizon*f);return {time,expected:p.spot*Math.exp(mean+.5*sd**2),low:p.spot*Math.exp(mean-1.281551565545*sd),high:p.spot*Math.exp(mean+1.281551565545*sd)};});}
