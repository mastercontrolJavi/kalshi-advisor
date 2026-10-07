/**
 * Quant stack: a Bayesian (ridge-penalised) logistic blend of the diffusion model, the Kalshi midpoint and
 * microstructure features, refit from settled windows.
 *
 *   logit q = b + a·logit(p_model) + c·(logit(p_mid) − logit(p_model)) + Σ β_i·feature_i
 *
 * a is overall confidence (prior 1, tightly held: shrinking every forecast toward 50% hurt out of sample on the
 * first 20 windows); c is how far to move from the model toward Kalshi (prior ½ = equal logit blend).
 *
 * Why: on the first 30 settled windows the Kalshi mid beat the raw model at every horizon, and the fixed
 * momentum/flow lean slightly hurt. A practitioner does not discard either source; they let out-of-sample
 * evidence decide the weights. With no data the prior is an equal logit-average of model and market with zero
 * feature weights; each settled window moves the weights only as far as the data justifies.
 */
export const FEATURE_NAMES=['bias','confidence','kalshiShift','momentum2m','momentum30s','bookImbalance','tradeFlow'] as const;
const PRIOR_MEAN=[0,1,.5,0,0,0,0];
// Prior precision: confidence and bias need strong evidence to move; features need real evidence before they count.
// Bias is held at 0: fitting it learned the recent YES base rate and was the main source of out-of-sample loss
// (LOMO Brier 0.1651 with bias vs 0.1607 without, 42 markets).
const PRIOR_PRECISION=[1e6,30,4,24,24,24,24];
const CLIP=4.59512; // logit(0.99)
export const logit=(p:number)=>{const q=Math.min(.99,Math.max(.01,p));return Math.log(q/(1-q));};
export const sigmoid=(x:number)=>1/(1+Math.exp(-x));
export interface StackInputs {modelP:number;mid:number|null;sigma:number;momentum30s:number|null;momentum120s:number|null;imbalance:number|null;tradeFlow30s:number|null;tradeVolume30s?:number|null}
export interface StackSample extends StackInputs {y:0|1;ticker:string;horizon:string}
/**
 * `weights` are what predict() uses. The fitted weights are adopted only when they beat the prior blend out of sample
 * (leave-one-market-out) by a margin with ≥ MIN_MARKETS markets; until then the prior blend is used. On the first
 * 20 windows the prior blend (0.1865 Brier) beat both the raw model (0.1912) and the fitted weights (0.1939).
 */
export const MIN_MARKETS=30,ADOPT_MARGIN=.002;
export interface StackFit {weights:number[];fittedWeights:number[];active:'prior'|'fitted';n:number;markets:number;cv:{stack:number|null;prior:number|null;model:number|null;kalshi:number|null;markets:number};fitted:number}
export const priorFit=():StackFit=>({weights:[...PRIOR_MEAN],fittedWeights:[...PRIOR_MEAN],active:'prior',n:0,markets:0,cv:{stack:null,prior:null,model:null,kalshi:null,markets:0},fitted:0});
const squash=(v:number|null)=>v===null||!Number.isFinite(v)?0:Math.tanh(v);
/** Feature vector; a missing Kalshi mid falls back to the model so the market weight is not lost. */
export function features(i:StackInputs):number[]{
  const z=(r:number|null,s:number)=>r===null||!(i.sigma>0)?null:r/(i.sigma*Math.sqrt(s));
  const flow=i.tradeFlow30s===null?null:i.tradeVolume30s?i.tradeFlow30s/i.tradeVolume30s:Math.tanh(i.tradeFlow30s/100);
  const lm=logit(i.modelP),lk=i.mid===null||!Number.isFinite(i.mid)?lm:logit(i.mid);
  return [1,lm,lk-lm,squash(z(i.momentum120s,120)),squash(z(i.momentum30s,30)),Math.max(-1,Math.min(1,i.imbalance??0)),Math.max(-1,Math.min(1,flow??0))];
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
export function fitWeights(samples:StackSample[],iterations=25):number[]{
  let w=[...PRIOR_MEAN];const X=samples.map(features),d=w.length;
  for(let it=0;it<iterations;it++){
    const g=w.map((wk,k)=>PRIOR_PRECISION[k]*(wk-PRIOR_MEAN[k])),H=Array.from({length:d},(_,i)=>Array.from({length:d},(_,j)=>i===j?PRIOR_PRECISION[i]:0));
    X.forEach((x,n)=>{const p=sigmoid(x.reduce((s,v,k)=>s+v*w[k],0)),r=p-samples[n].y,v=Math.max(p*(1-p),1e-6);
      for(let i=0;i<d;i++){g[i]+=r*x[i];for(let j=0;j<d;j++)H[i][j]+=v*x[i]*x[j];}});
    const step=solve(H,g);w=w.map((wk,k)=>wk-step[k]);if(Math.max(...step.map(Math.abs))<1e-8)break;
  }
  return w;
}
const brier=(ps:number[],ys:number[])=>ps.length?ps.reduce((s,p,i)=>s+(p-ys[i])**2,0)/ps.length:null;
/** Fit on all samples and score honestly with leave-one-market-out cross-validation. */
export function fitStack(samples:StackSample[],now=Date.now()):StackFit{
  if(!samples.length)return {...priorFit(),fitted:now};
  const tickers=[...new Set(samples.map(s=>s.ticker))],weights=fitWeights(samples);
  const cvP:number[]=[],priorP:number[]=[],ys:number[]=[],modelP:number[]=[],kalshiP:number[]=[],kalshiY:number[]=[];
  if(tickers.length>=3)for(const t of tickers){
    const held=samples.filter(s=>s.ticker===t),w=fitWeights(samples.filter(s=>s.ticker!==t));
    for(const s of held){cvP.push(predict({...priorFit(),weights:w},s).p);priorP.push(predict(priorFit(),s).p);ys.push(s.y);modelP.push(s.modelP);if(s.mid!==null){kalshiP.push(s.mid);kalshiY.push(s.y);}}
  }
  const cv={stack:brier(cvP,ys),prior:brier(priorP,ys),model:brier(modelP,ys),kalshi:brier(kalshiP,kalshiY),markets:tickers.length>=3?tickers.length:0};
  const adopt=tickers.length>=MIN_MARKETS&&cv.stack!==null&&cv.prior!==null&&cv.stack<cv.prior-ADOPT_MARGIN;
  return {weights:adopt?weights:[...PRIOR_MEAN],fittedWeights:weights,active:adopt?'fitted':'prior',n:samples.length,markets:tickers.length,cv,fitted:now};
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
