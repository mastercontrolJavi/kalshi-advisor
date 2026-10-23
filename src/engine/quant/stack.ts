/**
 * Quant stack: a Bayesian (ridge-penalised) logistic blend of the diffusion model, the Kalshi midpoint and
 * microstructure features, refit from settled windows.
 *
 *   logit q = b + a·logit(p_model) + c·(logit(p_mid) − logit(p_model)) + Σ β_i·feature_i
 *
 * a is overall confidence (prior 1, tightly held: shrinking every forecast toward 50% hurt out of sample on the
 * first 20 windows); c is how far to move from the model toward Kalshi (prior 0.9: mostly Kalshi, see PRIOR_MEAN).
 *
 * Why: on the first 30 settled windows the Kalshi mid beat the raw model at every horizon, and the fixed
 * momentum/flow lean slightly hurt. A practitioner does not discard either source; they let out-of-sample
 * evidence decide the weights. With no data the prior is a logit blend weighted 90% to the market with zero
 * feature weights; each settled window moves the weights only as far as the data justifies.
 */
export const FEATURE_NAMES=['bias','confidence','kalshiShift','momentum2m','momentum30s','bookImbalance','tradeFlow'] as const;
// kalshiShift prior 0.9 (was 0.5, an equal blend): fitted on 5,513 rounds of 1-minute history (Jul 10 – Sep 6) it came
// out 0.91, and on the 3,675 later rounds it cut held-out Brier from 0.1576 (½) to 0.1570; Kalshi alone scored 0.1569
// (scripts/blend-study.ts, DECISIONS 56). The diffusion model adds little that Kalshi's price does not already know.
const PRIOR_MEAN=[0,1,.9,0,0,0,0];
// Prior precision: confidence and bias need strong evidence to move; features need real evidence before they count.
// Bias is held at 0: fitting it learned the recent YES base rate and was the main source of out-of-sample loss
// (LOMO Brier 0.1651 with bias vs 0.1607 without, 42 markets).
const PRIOR_PRECISION=[1e6,30,4,24,24,24,24];
const CLIP=4.59512; // logit(0.99)
export const logit=(p:number)=>{const q=Math.min(.99,Math.max(.01,p));return Math.log(q/(1-q));};
export const sigmoid=(x:number)=>1/(1+Math.exp(-x));
export interface StackInputs {modelP:number;mid:number|null;sigma:number;momentum30s:number|null;momentum120s:number|null;imbalance:number|null;tradeFlow30s:number|null;tradeVolume30s?:number|null}
export interface StackSample extends StackInputs {y:0|1;ticker:string;horizon:string;time?:number;settledTime?:number}
/**
 * `weights` are what predict() uses. The fitted weights are adopted only when they beat the prior blend out of sample
 * on later markets, with confidence bounds against both the prior and the available market quote. On the first
 * 20 windows the prior blend (0.1865 Brier) beat both the raw model (0.1912) and the fitted weights (0.1939).
 */
export const MIN_MARKETS=60,ADOPT_MARGIN=.002,CV_FOLDS=4,STACK_EMBARGO_MS=60000;
export interface StackFold {trainMarkets:number;testMarkets:number;trainThrough:number;testFrom:number;testThrough:number;gain:number;marketGain:number}
export interface StackValidation {
  method:'purged-walk-forward';stack:number|null;prior:number|null;model:number|null;kalshi:number|null;markets:number;
  baseline:number|null;gain:number|null;gainLow:number|null;gainHigh:number|null;marketGain:number|null;marketGainLow:number|null;marketGainHigh:number|null;
  blocks:number;logLoss:number|null;baselineLogLoss:number|null;priorLogLoss:number|null;folds:StackFold[];
}
export interface StackFit {weights:number[];fittedWeights:number[];active:'prior'|'fitted';n:number;markets:number;cv:StackValidation;fitted:number;reason:string}
const emptyValidation=():StackValidation=>({method:'purged-walk-forward',stack:null,prior:null,model:null,kalshi:null,markets:0,baseline:null,gain:null,gainLow:null,gainHigh:null,marketGain:null,marketGainLow:null,marketGainHigh:null,blocks:0,logLoss:null,baselineLogLoss:null,priorLogLoss:null,folds:[]});
export const priorFit=():StackFit=>({weights:[...PRIOR_MEAN],fittedWeights:[...PRIOR_MEAN],active:'prior',n:0,markets:0,cv:emptyValidation(),fitted:0,reason:'Needs timestamped, settled markets for forward validation'});
const squash=(v:number|null)=>v===null||!Number.isFinite(v)?0:Math.tanh(v);
/** Feature vector; a missing Kalshi mid falls back to the model so the market weight is not lost. */
export function features(i:StackInputs):number[]{
  const z=(r:number|null,s:number)=>r===null||!(i.sigma>0)?null:r/(i.sigma*Math.sqrt(s));
  const flow=i.tradeFlow30s===null?null:i.tradeVolume30s?i.tradeFlow30s/i.tradeVolume30s:Math.tanh(i.tradeFlow30s/100);
  const lm=logit(i.modelP),lk=i.mid===null||!Number.isFinite(i.mid)?lm:logit(i.mid);
  const bounded=(v:number|null|undefined)=>Number.isFinite(v)?Math.max(-1,Math.min(1,v!)):0;
  return [1,lm,lk-lm,squash(z(i.momentum120s,120)),squash(z(i.momentum30s,30)),bounded(i.imbalance),bounded(flow)];
}
export function predict(fit:StackFit,i:StackInputs){
  const x=features(i),terms=x.map((v,k)=>v*fit.weights[k]),s=terms.reduce((a,b)=>a+b,0);
  return {p:Math.min(.99,Math.max(.01,sigmoid(Math.max(-CLIP,Math.min(CLIP,s))))),terms};
}
function solve(A:number[][],b:number[]):number[]{
  const n=b.length,M=A.map((r,i)=>[...r,b[i]]);
  for(let c=0;c<n;c++){let p=c;for(let r=c+1;r<n;r++)if(Math.abs(M[r][c])>Math.abs(M[p][c]))p=r;[M[c],M[p]]=[M[p],M[c]];
    const d=M[c][c];if(Math.abs(d)<1e-12)throw new Error('Singular system');for(let k=c;k<=n;k++)M[c][k]/=d;
    for(let r=0;r<n;r++)if(r!==c){const f=M[r][c];if(f)for(let k=c;k<=n;k++)M[r][k]-=f*M[c][k];}}
  return M.map(r=>r[n]);
}
/** MAP logistic regression by Newton–Raphson with a Gaussian prior (ridge toward PRIOR_MEAN). */
/** `start` warm-starts Newton (the problem is convex, so the optimum is the same; it just converges in fewer steps). */
export function fitWeights(samples:StackSample[],iterations=25,start:number[]=PRIOR_MEAN):number[]{
  let w=[...start];const X=samples.map(features),d=w.length,counts=new Map<string,number>();
  for(const s of samples)counts.set(s.ticker,(counts.get(s.ticker)??0)+1);
  for(let it=0;it<iterations;it++){
    const g=w.map((wk,k)=>PRIOR_PRECISION[k]*(wk-PRIOR_MEAN[k])),H=Array.from({length:d},(_,i)=>Array.from({length:d},(_,j)=>i===j?PRIOR_PRECISION[i]:0));
    // All snapshots of a settlement share one outcome: one market contributes one unit of evidence.
    X.forEach((x,n)=>{const weight=1/counts.get(samples[n].ticker)!,p=sigmoid(x.reduce((s,v,k)=>s+v*w[k],0)),r=(p-samples[n].y)*weight,v=Math.max(p*(1-p),1e-6)*weight;
      for(let i=0;i<d;i++){g[i]+=r*x[i];for(let j=0;j<d;j++)H[i][j]+=v*x[i]*x[j];}});
    const step=solve(H,g);w=w.map((wk,k)=>wk-step[k]);if(Math.max(...step.map(Math.abs))<1e-8)break;
  }
  return w;
}
const average=(xs:number[])=>xs.length?xs.reduce((s,v)=>s+v,0)/xs.length:null;
const loss=(p:number,y:number)=>-Math.log(Math.max(1e-6,Math.min(1-1e-6,y?p:1-p)));
type MarketRows={ticker:string;rows:StackSample[];from:number;settled:number};
type MarketScore={time:number;stack:number;prior:number;model:number;kalshi:number|null;baseline:number;logLoss:number;baselineLogLoss:number;priorLogLoss:number};
function scoreMarket(group:MarketRows,weights:number[]):MarketScore{
  const fit={...priorFit(),weights},prior=priorFit(),scores=group.rows.map(s=>{const p=predict(fit,s).p,b=predict(prior,s).p,m=s.mid??s.modelP;
    return {stack:(p-s.y)**2,prior:(b-s.y)**2,model:(s.modelP-s.y)**2,kalshi:s.mid===null?null:(s.mid-s.y)**2,baseline:(m-s.y)**2,logLoss:loss(p,s.y),baselineLogLoss:loss(m,s.y),priorLogLoss:loss(b,s.y)};});
  return {time:group.from,stack:average(scores.map(s=>s.stack))!,prior:average(scores.map(s=>s.prior))!,model:average(scores.map(s=>s.model))!,kalshi:average(scores.flatMap(s=>s.kalshi===null?[]:[s.kalshi])),baseline:average(scores.map(s=>s.baseline))!,logLoss:average(scores.map(s=>s.logLoss))!,baselineLogLoss:average(scores.map(s=>s.baselineLogLoss))!,priorLogLoss:average(scores.map(s=>s.priorLogLoss))!};
}
/** Paired, whole-hour resampling retains the dependence among adjacent 15-minute settlements. */
function gainBounds(scores:MarketScore[]){
  const grouped=new Map<number,MarketScore[]>();for(const score of scores){const key=Math.floor(score.time/3600000);grouped.set(key,[...(grouped.get(key)??[]),score]);}
  const blocks=[...grouped.values()],prior:number[]=[],market:number[]=[];let seed=9173;
  if(blocks.length>=20)for(let b=0;b<600;b++){let pg=0,mg=0,n=0;for(let i=0;i<blocks.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;for(const s of blocks[Math.floor(seed/4294967296*blocks.length)]){pg+=s.prior-s.stack;mg+=s.baseline-s.stack;n++;}}prior.push(pg/n);market.push(mg/n);}
  prior.sort((a,b)=>a-b);market.sort((a,b)=>a-b);
  return {blocks:blocks.length,gainLow:prior.length?prior[Math.floor(prior.length*.025)]:null,gainHigh:prior.length?prior[Math.floor(prior.length*.975)]:null,marketGainLow:market.length?market[Math.floor(market.length*.025)]:null,marketGainHigh:market.length?market[Math.floor(market.length*.975)]:null};
}
/** Expanding chronological folds. An outcome must have been observed before the held-out block, plus an embargo.
 * Legacy rows without timestamps can still be inspected with fitWeights, but cannot authorize live adoption.
 * Folds start from the prior, never from an optimizer fitted using future outcomes. */
export function fitStack(samples:StackSample[],now=Date.now()):StackFit{
  const valid=samples.filter(s=>Number.isFinite(s.modelP)&&s.modelP>=0&&s.modelP<=1&&Number.isFinite(s.sigma)&&s.sigma>0&&(s.y===0||s.y===1)&&(s.mid===null||Number.isFinite(s.mid)&&s.mid>=0&&s.mid<=1)&&(s.settledTime===undefined||s.settledTime<=now));
  if(!valid.length)return {...priorFit(),fitted:now};
  const grouped=new Map<string,StackSample[]>();for(const s of valid)grouped.set(s.ticker,[...(grouped.get(s.ticker)??[]),s]);
  const groups:MarketRows[]=[];
  for(const [ticker,rows] of grouped){
    if(rows.some(s=>!Number.isFinite(s.time)||!Number.isFinite(s.settledTime)||s.time!>=s.settledTime!||s.y!==rows[0].y))continue;
    groups.push({ticker,rows,from:Math.min(...rows.map(s=>s.time!)),settled:Math.max(...rows.map(s=>s.settledTime!))});
  }
  groups.sort((a,b)=>a.from-b.from||a.ticker.localeCompare(b.ticker));
  const weights=fitWeights(valid),held:MarketScore[]=[],folds:StackFold[]=[];
  const initial=Math.max(30,Math.floor(groups.length*.4)),remaining=groups.length-initial;
  if(remaining>=CV_FOLDS)for(let f=0;f<CV_FOLDS;f++){
    const start=initial+Math.floor(remaining*f/CV_FOLDS),end=initial+Math.floor(remaining*(f+1)/CV_FOLDS),test=groups.slice(start,end),from=test[0].from;
    const train=groups.slice(0,start).filter(g=>g.settled<from-STACK_EMBARGO_MS);if(train.length<20)continue;
    const w=fitWeights(train.flatMap(g=>g.rows)),scores=test.map(g=>scoreMarket(g,w));held.push(...scores);
    folds.push({trainMarkets:train.length,testMarkets:test.length,trainThrough:Math.max(...train.map(g=>g.settled)),testFrom:from,testThrough:Math.max(...test.map(g=>g.settled)),gain:average(scores.map(s=>s.prior-s.stack))!,marketGain:average(scores.map(s=>s.baseline-s.stack))!});
  }
  const cv:StackValidation={...emptyValidation(),...gainBounds(held),stack:average(held.map(s=>s.stack)),prior:average(held.map(s=>s.prior)),model:average(held.map(s=>s.model)),kalshi:average(held.flatMap(s=>s.kalshi===null?[]:[s.kalshi])),baseline:average(held.map(s=>s.baseline)),gain:average(held.map(s=>s.prior-s.stack)),marketGain:average(held.map(s=>s.baseline-s.stack)),logLoss:average(held.map(s=>s.logLoss)),baselineLogLoss:average(held.map(s=>s.baselineLogLoss)),priorLogLoss:average(held.map(s=>s.priorLogLoss)),markets:held.length,folds};
  const enough=cv.markets>=MIN_MARKETS&&cv.blocks>=20&&folds.length===CV_FOLDS&&groups.length===grouped.size;
  const stable=folds.filter(f=>f.gain>0&&f.marketGain>0).length>=3&&folds.slice(-2).every(f=>f.gain>0&&f.marketGain>0);
  const adopt=enough&&stable&&(cv.gain??0)>=ADOPT_MARGIN&&(cv.marketGain??0)>=ADOPT_MARGIN&&(cv.gainLow??0)>0&&(cv.marketGainLow??0)>0&&cv.logLoss!==null&&cv.logLoss<=cv.baselineLogLoss!&&cv.logLoss<=cv.priorLogLoss!;
  const reason=adopt?'Beat prior and market baselines on later markets with positive block confidence bounds':!enough?'Needs more timestamped later-market tests and independent hourly blocks':!stable?'Advantage is not stable across later time periods':'No reliable improvement over prior and market baselines';
  return {weights:adopt?weights:[...PRIOR_MEAN],fittedWeights:weights,active:adopt?'fitted':'prior',n:valid.length,markets:grouped.size,cv,fitted:now,reason};
}
export function describe(fit:StackFit){return FEATURE_NAMES.map((name,k)=>({name,weight:fit.weights[k],fitted:fit.fittedWeights[k],prior:PRIOR_MEAN[k]}));}
/** Effective logit weights on the model and on Kalshi (they need not sum to 1). */
export const effectiveWeights=(fit:StackFit,which:'weights'|'fittedWeights'='weights')=>({model:fit[which][1]-fit[which][2],kalshi:fit[which][2]});
const pct=(x:number)=>`${(x*100).toFixed(1)}%`;
/** Human-readable decomposition of a quant forecast: the blend, then each feature's marginal effect in points. */
export function explain(fit:StackFit,i:StackInputs):string[]{
  const {p,terms}=predict(fit,i),total=terms.reduce((a,b)=>a+b,0),x=features(i);
  const out=[`Model ${pct(i.modelP)}${i.mid!==null&&Number.isFinite(i.mid)?` · Kalshi ${pct(i.mid)}`:' · no Kalshi quote'} → quant ${pct(p)} (${fit.active==='fitted'?`learned weights, ${fit.markets} markets`:'default blend until the fit proves itself'})`];
  const labels=['','','','BTC 2-min momentum','BTC 30-s momentum','Kalshi book imbalance','Kalshi trade flow'];
  let silent=true;
  for(let k=3;k<x.length;k++){if(Math.abs(fit.weights[k])<.005)continue;silent=false;const without=sigmoid(Math.max(-CLIP,Math.min(CLIP,total-terms[k])));const pp=(p-without)*100;
    out.push(`${labels[k]} ${x[k]>=0?'+':''}${x[k].toFixed(2)} → ${pp>=0?'UP':'DOWN'} ${Math.abs(pp).toFixed(1)} pts`);}
  if(silent)out.push('Momentum and order-flow signals carry no weight until settled windows show they predict outcomes');
  return out;
}
