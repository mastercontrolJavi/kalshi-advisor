import {BENCHMARK_MODEL_VERSION} from './benchmark';
import {logit,sigmoid} from './stack';

/** Fixed specification: changing features, priors, eligibility or scoring requires a new version. */
export const BENCHMARK_CALIBRATION_VERSION='brti-market-calibration-v1';
export const CALIBRATION_HORIZONS=[60,30,10] as const;
export const CALIBRATION_EMBARGO_MS=60000;
export const CALIBRATION_MIN_TRAIN_MARKETS=30;
export const CALIBRATION_MIN_TEST_MARKETS=60;
export const CALIBRATION_MIN_BLOCKS=20;
export const CALIBRATION_FOLDS=4;
export const CALIBRATION_FEATURE_NAMES=['brtiDisagreement','marketConfidence','lateDisagreement','volatilityDisagreement'] as const;
const PRECISION=[40,120,120,120];
const MIN_GAIN=.002;

export interface BenchmarkCalibrationInput {
  brtiP:number;marketP:number|null;quantP:number|null;tau:number;sigma:number;
}
export interface BenchmarkCalibrationSample extends BenchmarkCalibrationInput {
  ticker:string;horizon:number;time:number;sourceTime:number;settledTime:number;y:0|1;version:string;
}
/** A read-only SELECT of benchmark_forecasts joined to outcomes, aliasing outcomes.time as settled_time. */
export interface BenchmarkCalibrationRecord {
  ticker:string;horizon:number;version:string;time:number;source_time:number;p:number;quant_p:number|null;mid:number|null;
  context:string;result:string|null;settled_time:number|null;
}
export function benchmarkCalibrationSamples(records:BenchmarkCalibrationRecord[]):BenchmarkCalibrationSample[]{
  const samples:BenchmarkCalibrationSample[]=[];
  for(const r of records){
    if((r.result!=='yes'&&r.result!=='no')||r.settled_time===null)continue;
    let context:any;try{context=JSON.parse(r.context);}catch{continue;}
    // Historical immutable checkpoints did not store exact tau. Their named horizon is the only supported proxy.
    const tau=context?.tau===undefined?r.horizon:context.tau;
    samples.push({ticker:r.ticker,horizon:r.horizon,version:r.version,time:r.time,sourceTime:r.source_time,
      settledTime:r.settled_time,y:r.result==='yes'?1:0,brtiP:r.p,marketP:r.mid,quantP:r.quant_p,tau,sigma:context?.model?.sigma});
  }
  return samples;
}

export interface CalibrationParameters {weights:number[];referenceSigma:number}
export interface ProperScore {brier:number|null;logLoss:number|null}
export interface CalibrationScores {candidate:ProperScore;brti:ProperScore;market:ProperScore;quant:ProperScore}
export interface CalibrationGain {mean:number|null;low:number|null;high:number|null}
export interface CalibrationGains {brti:CalibrationGain;market:CalibrationGain;quant:CalibrationGain}
export interface CalibrationFold {
  trainMarkets:number;testMarkets:number;pairedMarkets:number;trainThrough:number;testFrom:number;testThrough:number;
  scores:CalibrationScores;
}
export interface CalibrationValidation {
  method:'purged-walk-forward';markets:number;rows:number;blocks:number;folds:CalibrationFold[];
  scores:CalibrationScores;gains:CalibrationGains;
  byHorizon:{horizon:number;markets:number;scores:CalibrationScores}[];
}
export interface BenchmarkCalibrationFit {
  version:typeof BENCHMARK_CALIBRATION_VERSION;sourceVersion:typeof BENCHMARK_MODEL_VERSION;active:false;
  fittedAt:number;trainThrough:number|null;rows:number;markets:number;parameters:CalibrationParameters|null;
  state:'insufficient-data'|'unproven'|'supported';reason:string;
  excluded:{invalid:number;notYetKnown:number;duplicates:number;conflictingMarkets:number};
  validation:CalibrationValidation;
}
type Market={ticker:string;rows:BenchmarkCalibrationSample[];from:number;settled:number};
type RowScore={ticker:string;horizon:number;time:number;scores:Record<keyof CalibrationScores,{brier:number;logLoss:number}>};
type MarketScore={time:number;rows:RowScore[];scores:CalibrationScores};
const probability=(p:unknown):p is number=>typeof p==='number'&&Number.isFinite(p)&&p>=0&&p<=1;
const average=(a:number[])=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
const median=(a:number[])=>{const s=[...a].sort((x,y)=>x-y),n=s.length;return n%2?s[(n-1)/2]:(s[n/2-1]+s[n/2])/2;};
const validInput=(s:BenchmarkCalibrationInput)=>probability(s.brtiP)&&probability(s.marketP)&&
  (s.quantP===null||probability(s.quantP))&&Number.isFinite(s.tau)&&s.tau>0&&s.tau<=60&&Number.isFinite(s.sigma)&&s.sigma>0;
const emptyScores=():CalibrationScores=>({candidate:{brier:null,logLoss:null},brti:{brier:null,logLoss:null},market:{brier:null,logLoss:null},quant:{brier:null,logLoss:null}});
const emptyGains=():CalibrationGains=>({brti:{mean:null,low:null,high:null},market:{mean:null,low:null,high:null},quant:{mean:null,low:null,high:null}});

function prepare(samples:BenchmarkCalibrationSample[],asOf:number){
  const excluded={invalid:0,notYetKnown:0,duplicates:0,conflictingMarkets:0},byMarket=new Map<string,Map<number,BenchmarkCalibrationSample>>(),conflicts=new Set<string>();
  for(const s of samples){
    // A later row or later label cannot alter an earlier fit, including its duplicate/conflict filtering.
    if(Number.isFinite(s.time)&&s.time>=asOf||Number.isFinite(s.settledTime)&&s.settledTime>=asOf-CALIBRATION_EMBARGO_MS){excluded.notYetKnown++;continue;}
    if(!s.ticker||s.version!==BENCHMARK_MODEL_VERSION||!CALIBRATION_HORIZONS.some(h=>h===s.horizon)||!validInput(s)||
      ![s.time,s.sourceTime,s.settledTime].every(t=>Number.isFinite(t)&&t>0)||s.sourceTime>s.time||s.time-s.sourceTime>2500||
      s.time>=s.settledTime||(s.y!==0&&s.y!==1)||s.tau>s.horizon||s.tau<=s.horizon-3){excluded.invalid++;continue;}
    const horizons=byMarket.get(s.ticker)??new Map<number,BenchmarkCalibrationSample>(),prior=horizons.get(s.horizon);
    if(prior){
      excluded.duplicates++;
      if(['time','sourceTime','settledTime','y','brtiP','marketP','quantP','tau','sigma','version'].some(k=>prior[k as keyof BenchmarkCalibrationSample]!==s[k as keyof BenchmarkCalibrationSample]))conflicts.add(s.ticker);
    }else horizons.set(s.horizon,s);
    byMarket.set(s.ticker,horizons);
  }
  const groups:Market[]=[];
  for(const [ticker,horizons] of byMarket){
    const rows=[...horizons.values()].sort((a,b)=>a.time-b.time||b.horizon-a.horizon);
    if(conflicts.has(ticker)||rows.some(r=>r.y!==rows[0].y)){excluded.conflictingMarkets++;continue;}
    groups.push({ticker,rows,from:rows[0].time,settled:Math.max(...rows.map(r=>r.settledTime))});
  }
  groups.sort((a,b)=>a.from-b.from||a.ticker.localeCompare(b.ticker));
  return {groups,excluded};
}

/** No directional intercept. Features reverse sign when YES/NO are swapped. Volatility scaling uses training only. */
export function benchmarkCalibrationFeatures(input:BenchmarkCalibrationInput,referenceSigma:number):number[]{
  if(!validInput(input)||!(referenceSigma>0)||!Number.isFinite(referenceSigma))throw new Error('Invalid benchmark calibration inputs');
  const market=logit(input.marketP!),difference=Math.max(-4,Math.min(4,logit(input.brtiP)-market));
  const late=(30-input.tau)/30,volatility=Math.tanh(Math.log(input.sigma/referenceSigma));
  return [difference,market,difference*late,difference*volatility];
}
const candidate=(parameters:CalibrationParameters,input:BenchmarkCalibrationInput)=>{
  const x=benchmarkCalibrationFeatures(input,parameters.referenceSigma);
  return Math.max(.01,Math.min(.99,sigmoid(logit(input.marketP!)+x.reduce((s,v,k)=>s+v*parameters.weights[k],0))));
};
function solve(A:number[][],b:number[]){
  const M=A.map((row,i)=>[...row,b[i]]),n=b.length;
  for(let c=0;c<n;c++){
    let pivot=c;for(let r=c+1;r<n;r++)if(Math.abs(M[r][c])>Math.abs(M[pivot][c]))pivot=r;
    [M[c],M[pivot]]=[M[pivot],M[c]];const d=M[c][c];
    if(!Number.isFinite(d)||Math.abs(d)<1e-12)throw new Error('Singular calibration fit');
    for(let k=c;k<=n;k++)M[c][k]/=d;
    for(let r=0;r<n;r++)if(r!==c){const scale=M[r][c];for(let k=c;k<=n;k++)M[r][k]-=scale*M[c][k];}
  }
  return M.map(row=>row[n]);
}
function fitParameters(groups:Market[]):CalibrationParameters {
  // Median within market, then across markets: recording more checkpoints cannot change a market's total weight.
  const referenceSigma=Math.exp(median(groups.map(g=>median(g.rows.map(r=>Math.log(r.sigma))))));
  const rows=groups.flatMap(g=>g.rows.map(r=>({x:benchmarkCalibrationFeatures(r,referenceSigma),offset:logit(r.marketP!),y:r.y,weight:1/g.rows.length})));
  const objective=(weights:number[])=>weights.reduce((sum,w,k)=>sum+.5*PRECISION[k]*w*w,0)+rows.reduce((sum,r)=>{
    const z=r.offset+r.x.reduce((s,v,k)=>s+v*weights[k],0);
    return sum+r.weight*(Math.max(z,0)-r.y*z+Math.log1p(Math.exp(-Math.abs(z))));
  },0);
  let weights=[0,0,0,0];
  for(let iteration=0;iteration<40;iteration++){
    const gradient=weights.map((w,k)=>PRECISION[k]*w),hessian=weights.map((_,i)=>weights.map((_,j)=>i===j?PRECISION[i]:0));
    for(const r of rows){
      const p=sigmoid(r.offset+r.x.reduce((s,v,k)=>s+v*weights[k],0)),error=(p-r.y)*r.weight,curvature=p*(1-p)*r.weight;
      for(let i=0;i<weights.length;i++){gradient[i]+=error*r.x[i];for(let j=0;j<weights.length;j++)hessian[i][j]+=curvature*r.x[i]*r.x[j];}
    }
    const step=solve(hessian,gradient),before=objective(weights);let scale=1,next=weights;
    while(scale>=1/1024){next=weights.map((w,k)=>w-scale*step[k]);if(objective(next)<=before+1e-12)break;scale/=2;}
    if(scale<1/1024)break;
    weights=next;if(Math.max(...step.map(s=>Math.abs(s*scale)))<1e-8)break;
  }
  return {weights,referenceSigma};
}
function score(p:number,y:0|1){return {brier:(p-y)**2,logLoss:-Math.log(Math.max(1e-6,Math.min(1-1e-6,y?p:1-p)))};}
function aggregate(scores:CalibrationScores[]):CalibrationScores {
  const result=emptyScores();
  for(const key of ['candidate','brti','market','quant'] as const){
    result[key]={brier:average(scores.flatMap(s=>s[key].brier===null?[]:[s[key].brier!])),logLoss:average(scores.flatMap(s=>s[key].logLoss===null?[]:[s[key].logLoss!]))};
  }
  return result;
}
function scoreMarket(group:Market,parameters:CalibrationParameters):MarketScore|null {
  // All four methods are compared on exactly the same immutable checkpoints.
  const rows=group.rows.filter(r=>r.quantP!==null).map(r=>({ticker:r.ticker,horizon:r.horizon,time:r.time,scores:{
    candidate:score(candidate(parameters,r),r.y),brti:score(r.brtiP,r.y),market:score(r.marketP!,r.y),quant:score(r.quantP!,r.y)}}));
  return rows.length?{time:group.from,rows,scores:aggregate(rows.map(r=>r.scores))}:null;
}
/** Whole-hour resampling preserves dependence between the three checkpoints and adjacent BTC markets. */
function confidenceBounds(markets:MarketScore[]){
  const grouped=new Map<number,MarketScore[]>();
  for(const market of markets){const hour=Math.floor(market.time/3600000),group=grouped.get(hour)??[];group.push(market);grouped.set(hour,group);}
  const blocks=[...grouped.values()],gains=emptyGains(),boot:{brti:number[];market:number[];quant:number[]}={brti:[],market:[],quant:[]};
  for(const key of ['brti','market','quant'] as const)gains[key].mean=average(markets.map(m=>m.scores[key].brier!-m.scores.candidate.brier!));
  let seed=19057;
  if(blocks.length>=CALIBRATION_MIN_BLOCKS)for(let iteration=0;iteration<600;iteration++){
    const total={brti:0,market:0,quant:0};let count=0;
    for(let i=0;i<blocks.length;i++){
      seed=(Math.imul(seed,1664525)+1013904223)>>>0;
      for(const m of blocks[Math.floor(seed/4294967296*blocks.length)]){
        for(const key of ['brti','market','quant'] as const)total[key]+=m.scores[key].brier!-m.scores.candidate.brier!;
        count++;
      }
    }
    for(const key of ['brti','market','quant'] as const)boot[key].push(total[key]/count);
  }
  for(const key of ['brti','market','quant'] as const)if(boot[key].length){
    const sorted=boot[key].sort((a,b)=>a-b);gains[key].low=sorted[Math.floor(sorted.length*.025)];gains[key].high=sorted[Math.floor(sorted.length*.975)];
  }
  return {blocks:blocks.length,gains};
}
function validation(markets:MarketScore[],folds:CalibrationFold[]):CalibrationValidation {
  const rows=markets.flatMap(m=>m.rows);
  return {method:'purged-walk-forward',markets:markets.length,rows:rows.length,...confidenceBounds(markets),folds,
    scores:aggregate(markets.map(m=>m.scores)),byHorizon:CALIBRATION_HORIZONS.map(h=>{
      const selected=rows.filter(r=>r.horizon===h);return {horizon:h,markets:selected.length,scores:aggregate(selected.map(r=>r.scores))};
    })};
}

/**
 * Small ridge correction to the market logit. Every market supplies one unit of training/validation weight.
 * Folds fit from scratch using only labels observed before the first held decision, with a one-minute embargo.
 * Final coefficients use only labels known before asOf minus that same embargo. No database is modified.
 */
export function fitBenchmarkCalibration(samples:BenchmarkCalibrationSample[],asOf:number):BenchmarkCalibrationFit {
  if(!Number.isFinite(asOf)||asOf<=0)throw new Error('Invalid calibration decision time');
  const {groups,excluded}=prepare(samples,asOf),rows=groups.reduce((n,g)=>n+g.rows.length,0),held:MarketScore[]=[],folds:CalibrationFold[]=[];
  const initial=Math.max(CALIBRATION_MIN_TRAIN_MARKETS,Math.floor(groups.length*.4)),remaining=groups.length-initial;
  if(remaining>=CALIBRATION_FOLDS)for(let f=0;f<CALIBRATION_FOLDS;f++){
    const start=initial+Math.floor(remaining*f/CALIBRATION_FOLDS),end=initial+Math.floor(remaining*(f+1)/CALIBRATION_FOLDS),test=groups.slice(start,end),testFrom=test[0].from;
    const train=groups.slice(0,start).filter(g=>g.settled<testFrom-CALIBRATION_EMBARGO_MS);
    if(train.length<CALIBRATION_MIN_TRAIN_MARKETS)continue;
    const parameters=fitParameters(train),scores=test.map(g=>scoreMarket(g,parameters)).filter((s):s is MarketScore=>s!==null);
    held.push(...scores);folds.push({trainMarkets:train.length,testMarkets:test.length,pairedMarkets:scores.length,
      trainThrough:Math.max(...train.map(g=>g.settled)),testFrom,testThrough:Math.max(...test.flatMap(g=>g.rows.map(r=>r.time))),scores:aggregate(scores.map(s=>s.scores))});
  }
  const evidence=validation(held,folds),enough=groups.length>=CALIBRATION_MIN_TRAIN_MARKETS,
    parameters=enough?fitParameters(groups):null,baselines=['brti','market','quant'] as const;
  const adequate=evidence.markets>=CALIBRATION_MIN_TEST_MARKETS&&evidence.blocks>=CALIBRATION_MIN_BLOCKS&&folds.length===CALIBRATION_FOLDS;
  const positive=(f:CalibrationFold)=>baselines.every(key=>f.scores.candidate.brier!==null&&f.scores[key].brier!==null&&f.scores.candidate.brier<f.scores[key].brier);
  const stable=folds.filter(positive).length>=3&&folds.slice(-2).every(positive);
  const supported=adequate&&stable&&baselines.every(key=>(evidence.gains[key].mean??0)>=MIN_GAIN&&(evidence.gains[key].low??0)>0&&
    evidence.scores.candidate.logLoss!==null&&evidence.scores[key].logLoss!==null&&evidence.scores.candidate.logLoss<=evidence.scores[key].logLoss);
  const state=!enough?'insufficient-data':supported?'supported':'unproven';
  const reason=!enough?`Needs ${CALIBRATION_MIN_TRAIN_MARKETS} earlier settled BRTI markets; ${groups.length} eligible`:
    !adequate?'Raw shadow candidate fitted; needs more paired later-market tests and independent hourly blocks':
    !supported?'Raw shadow candidate has not shown a stable proper-score improvement over BRTI, market, and quant':
    'Shadow candidate improved paired later-market Brier scores with positive block bounds and no log-loss regression';
  return {version:BENCHMARK_CALIBRATION_VERSION,sourceVersion:BENCHMARK_MODEL_VERSION,active:false,fittedAt:asOf,
    trainThrough:groups.length?Math.max(...groups.map(g=>g.settled)):null,rows,markets:groups.length,parameters,state,reason,excluded,validation:evidence};
}

export interface BenchmarkCalibrationPrediction {
  version:typeof BENCHMARK_CALIBRATION_VERSION;active:false;rawP:number|null;p:number|null;fallbackP:number|null;
  source:'candidate'|'market-fallback'|'abstain';fittedAt:number;trainThrough:number|null;reason:string;
}
/** Return values are prospective snapshots: the journal must insert once, never recompute them after settlement. */
export function predictBenchmarkCalibration(fit:BenchmarkCalibrationFit,input:BenchmarkCalibrationInput,decisionTime:number):BenchmarkCalibrationPrediction {
  const fallbackP=probability(input.marketP)?input.marketP:null;
  const result:BenchmarkCalibrationPrediction={version:BENCHMARK_CALIBRATION_VERSION,active:false,rawP:null,p:fallbackP,fallbackP,
    source:fallbackP===null?'abstain':'market-fallback',fittedAt:fit.fittedAt,trainThrough:fit.trainThrough,reason:fit.reason};
  if(!Number.isFinite(decisionTime)||input.tau<=0||input.tau>60||!Number.isFinite(input.tau))return {...result,p:null,source:'abstain',reason:'Outside the final-minute calibration scope'};
  if(fallbackP===null)return {...result,reason:'A usable current market quote is required'};
  if(!validInput(input))return {...result,reason:'Complete finite benchmark inputs are required for the candidate'};
  if(fit.version!==BENCHMARK_CALIBRATION_VERSION||fit.sourceVersion!==BENCHMARK_MODEL_VERSION||fit.fittedAt>decisionTime||
    !Number.isFinite(fit.fittedAt)||fit.trainThrough!==null&&(!Number.isFinite(fit.trainThrough)||fit.trainThrough>=decisionTime-CALIBRATION_EMBARGO_MS)){
    return {...result,reason:'This fit was not available with embargoed labels at the decision time'};
  }
  if(!fit.parameters)return result;
  if(fit.trainThrough===null)return {...result,reason:'Calibration training timestamps are unavailable'};
  if(fit.parameters.weights.length!==4||!fit.parameters.weights.every(Number.isFinite)||!(fit.parameters.referenceSigma>0)||!Number.isFinite(fit.parameters.referenceSigma))return {...result,reason:'Calibration parameters are invalid'};
  const rawP=candidate(fit.parameters,input);
  return {...result,rawP,p:fit.state==='supported'?rawP:fallbackP,source:fit.state==='supported'?'candidate':'market-fallback'};
}

/** Already frozen predictions only. This does not fit, choose, or regenerate any probability. */
export interface BenchmarkCalibrationProspectiveSample {
  ticker:string;horizon:number;time:number;settledTime:number;y:0|1;version:string;
  rawP:number|null;brtiP:number;marketP:number|null;quantP:number|null;
}
export function scoreBenchmarkCalibrationProspective(samples:BenchmarkCalibrationProspectiveSample[],asOf:number){
  if(!Number.isFinite(asOf)||asOf<=0)throw new Error('Invalid prospective score time');
  const byMarket=new Map<string,Map<number,BenchmarkCalibrationProspectiveSample>>(),conflicts=new Set<string>();
  for(const s of samples){
    if(s.version!==BENCHMARK_CALIBRATION_VERSION||!s.ticker||!CALIBRATION_HORIZONS.some(h=>h===s.horizon)||
      ![s.time,s.settledTime].every(Number.isFinite)||s.time>=s.settledTime||s.settledTime>asOf||(s.y!==0&&s.y!==1)||
      !probability(s.rawP)||!probability(s.brtiP)||!probability(s.marketP)||!probability(s.quantP))continue;
    const rows=byMarket.get(s.ticker)??new Map<number,BenchmarkCalibrationProspectiveSample>(),prior=rows.get(s.horizon);
    if(prior&&['time','settledTime','y','rawP','brtiP','marketP','quantP'].some(k=>prior[k as keyof BenchmarkCalibrationProspectiveSample]!==s[k as keyof BenchmarkCalibrationProspectiveSample]))conflicts.add(s.ticker);
    rows.set(s.horizon,s);byMarket.set(s.ticker,rows);
  }
  const markets:MarketScore[]=[];
  for(const [ticker,checkpoints] of byMarket){
    const records=[...checkpoints.values()];if(conflicts.has(ticker)||records.some(s=>s.y!==records[0].y))continue;
    const rows=records.map(s=>({ticker,horizon:s.horizon,time:s.time,scores:{candidate:score(s.rawP!,s.y),brti:score(s.brtiP,s.y),market:score(s.marketP!,s.y),quant:score(s.quantP!,s.y)}}));
    markets.push({time:Math.min(...records.map(s=>s.time)),rows,scores:aggregate(rows.map(s=>s.scores))});
  }
  markets.sort((a,b)=>a.time-b.time);
  const result=validation(markets,[]);
  return {...result,method:'immutable-prospective' as const};
}
