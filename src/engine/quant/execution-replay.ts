import {fee,type FeeSchedule} from '../model/fees';
import type {Level} from '../feeds/orderbook';

/** Captured locally, with the selected feed's own quality metadata. Prices are dollars; time is epoch ms.
 * Kalshi publishes YES and NO bid ladders: buying YES consumes 1 - NO bid, and conversely for NO.
 * Depth can be truncated, but absent levels must never be extrapolated into additional liquidity. */
export interface ExecutionSnapshot {
  ticker:string;time:number;bookUpdated:number;valid:boolean;delayMs:number|null;yes:Level[];no:Level[];
}
/** Freeze this before observing the execution snapshot or settlement. probability always means P(YES).
 * maxCost includes fees. minEdge is the minimum expected profit per contract after fees and stress costs. */
export interface ExecutionDecision {
  id:string;ticker:string;time:number;probabilityTime:number;closeTime:number;side:'yes'|'no';probability:number;
  limitPrice:number;contracts:number;maxCost:number;minEdge:number;fees:FeeSchedule;
}
export interface ExecutionOutcome {ticker:string;result:'yes'|'no';availableTime:number}
/** The first capture at or after arrival is the only permissible snapshot, even if it is unusable.
 * depthFraction models disappearing displayed liquidity; extraCostPerContract models additional adverse costs.
 * maxContractsPerFill is a fee-fragmentation assumption, because aggregated depth does not identify resting orders.
 * feePrecision recharges the same fills at another fee rounding; the frozen limit keeps the captured schedule. */
export interface ExecutionScenario {
  name:string;latencyMs:number;maxSnapshotWaitMs:number;maxSnapshotAgeMs:number;maxFeedDelayMs:number;
  depthFraction?:number;extraCostPerContract?:number;quantityStep?:number;maxContractsPerFill?:number;feePrecision?:number;
}
export const EXECUTION_SCENARIOS:ExecutionScenario[]=[
  {name:'base',latencyMs:500,maxSnapshotWaitMs:1200,maxSnapshotAgeMs:1000,maxFeedDelayMs:2000,depthFraction:1,maxContractsPerFill:1},
  {name:'latency-and-depth-stress',latencyMs:1500,maxSnapshotWaitMs:1200,maxSnapshotAgeMs:1000,maxFeedDelayMs:2000,depthFraction:.5,extraCostPerContract:.01,maxContractsPerFill:1},
];
export type ReplayReason='invalid-decision'|'invalid-scenario'|'duplicate-market'|'future-decision'|'future-probability'|'closed-before-arrival'|'awaiting-arrival'|'missing-snapshot'|'snapshot-too-late'|'invalid-book'|'stale-book'|'unknown-delay'|'delayed-book'|'invalid-depth'|'crossed-book'|'unverified-fees'|'no-recorded-depth'|'limit-price'|'insufficient-edge'|'cost-cap'|'quantity-cap'|'partial-depth';
export interface ExecutionFill {price:number;contracts:number;premium:number;fee:number;extraCost:number;cost:number;expectedProfit:number}
export interface ExecutionAttempt {
  id:string;ticker:string;side:'yes'|'no';decisionTime:number;arrivalTime:number;snapshotTime:number|null;
  status:'excluded'|'unfilled'|'partial'|'filled';reason:ReplayReason|null;settlement:'pending'|'settled'|'not-applicable';
  requested:number;contracts:number;premium:number;fees:number;extraCost:number;cost:number;expectedProfit:number;
  outcome:'yes'|'no'|null;payout:number|null;pnl:number|null;fills:ExecutionFill[];
}
export interface ExecutionSummary {
  decisions:number;eligible:number;filled:number;partial:number;unfilled:number;excluded:number;pending:number;settled:number;
  contracts:number;cost:number;fees:number;extraCost:number;settledCost:number;pnl:number;returnOnSettledCost:number|null;
  reasons:Partial<Record<ReplayReason,number>>;
  evidence:ReturnType<typeof executionEvidence>;
}
export interface ExecutionScenarioResult {scenario:ExecutionScenario;attempts:ExecutionAttempt[];summary:ExecutionSummary}
export interface ExecutionComparison {scenario:string;baseline:string;paired:number;baselinePnl:number;scenarioPnl:number;difference:number;unpaired:number}
export interface ExecutionReplay {asOf:number;results:ExecutionScenarioResult[];comparisons:ExecutionComparison[];limitations:string[]}

const finite=(value:number)=>Number.isFinite(value);
const round=(value:number)=>Math.round(value*1e8)/1e8;
const defaults=(s:ExecutionScenario)=>({depthFraction:1,extraCostPerContract:0,quantityStep:1,maxContractsPerFill:1,...s});
function validScenario(s:ReturnType<typeof defaults>){
  return !!s.name&&[s.latencyMs,s.maxSnapshotWaitMs,s.maxSnapshotAgeMs,s.maxFeedDelayMs,s.extraCostPerContract].every(n=>finite(n)&&n>=0)&&finite(s.depthFraction)&&s.depthFraction>0&&s.depthFraction<=1&&finite(s.quantityStep)&&s.quantityStep>0&&s.quantityStep<=1&&finite(s.maxContractsPerFill)&&s.maxContractsPerFill>=s.quantityStep&&(s.feePrecision===undefined||finite(s.feePrecision)&&s.feePrecision>0&&s.feePrecision<=.01);
}
function validDecision(d:ExecutionDecision){
  return !!d.id&&!!d.ticker&&(d.side==='yes'||d.side==='no')&&[d.time,d.probabilityTime,d.closeTime,d.probability,d.limitPrice,d.contracts,d.maxCost,d.minEdge].every(finite)&&d.closeTime>d.time&&d.probability>=0&&d.probability<=1&&d.limitPrice>0&&d.limitPrice<1&&d.contracts>0&&d.maxCost>0&&d.minEdge>=0;
}
function validFees(s:FeeSchedule){return s?.verified===true&&finite(s.takerMultiplier)&&s.takerMultiplier>=0&&finite(s.precision)&&s.precision>0&&s.precision<=.01;}
/** Freeze the submitted limit at decision time, including the per-contract fee assumption. */
export function executionLimitPrice(probability:number,side:'yes'|'no',minEdge:number,fees:FeeSchedule):number|null{
  if(!finite(probability)||probability<0||probability>1||!finite(minEdge)||minEdge<0||!validFees(fees))return null;
  const fair=side==='yes'?probability:1-probability;let low=0,high=9999;
  while(low<high){const tick=Math.ceil((low+high)/2),p=tick/10000;if(p+fee(p,1,'taker',fees)<=fair-minEdge+1e-9)low=tick;else high=tick-1;}
  return low>0?low/10000:null;
}
function validLevels(levels:Level[]){
  if(!Array.isArray(levels))return false;
  const prices=new Set<number>();
  for(const level of levels){if(!Array.isArray(level)||level.length!==2)return false;const [p,q]=level;
    if(!finite(p)||!finite(q)||p<=0||p>=1||q<=0||prices.has(p))return false;prices.add(p);}
  return true;
}
function empty(d:ExecutionDecision,arrival:number):ExecutionAttempt{return {id:d.id,ticker:d.ticker,side:d.side,decisionTime:d.time,arrivalTime:arrival,snapshotTime:null,status:'excluded',reason:null,settlement:'not-applicable',requested:d.contracts,contracts:0,premium:0,fees:0,extraCost:0,cost:0,expectedProfit:0,outcome:null,payout:null,pnl:null,fills:[]};}

/** Deterministic taker IOC shadow replay. This function has no network, database or order-execution side effects.
 * Snapshots after assumed arrival are execution observations, never inputs for revising the frozen decision.
 * No future capture, outcome, or later favorable quote can rescue an otherwise excluded attempt. */
export function replayOrder(decision:ExecutionDecision,snapshots:readonly ExecutionSnapshot[],outcome:ExecutionOutcome|null,scenario:ExecutionScenario,asOf:number):ExecutionAttempt{
  const s=defaults(scenario),arrival=decision.time+s.latencyMs,result=empty(decision,arrival);
  const exclude=(reason:ReplayReason)=>({...result,reason});
  if(!validScenario(s)||!finite(asOf))return exclude('invalid-scenario');
  if(!validDecision(decision))return exclude('invalid-decision');
  if(decision.probabilityTime>decision.time)return exclude('future-probability');
  if(decision.time>asOf)return exclude('future-decision');
  if(arrival>=decision.closeTime)return exclude('closed-before-arrival');
  if(arrival>asOf)return exclude('awaiting-arrival');
  if(!validFees(decision.fees))return exclude('unverified-fees');
  // Never skip an invalid first observation to select a later, fillable or more profitable observation.
  let snapshot:ExecutionSnapshot|undefined;
  for(const candidate of snapshots)if(candidate.ticker===decision.ticker&&finite(candidate.time)&&candidate.time>=arrival&&candidate.time<=asOf&&(!snapshot||candidate.time<snapshot.time))snapshot=candidate;
  if(!snapshot)return exclude('missing-snapshot');
  result.snapshotTime=snapshot.time;
  if(snapshot.time-arrival>s.maxSnapshotWaitMs||snapshot.time>=decision.closeTime)return exclude('snapshot-too-late');
  if(snapshot.valid!==true)return exclude('invalid-book');
  const age=snapshot.time-snapshot.bookUpdated;
  if(!finite(age)||age<0||age>s.maxSnapshotAgeMs)return exclude('stale-book');
  if(snapshot.delayMs===null||!finite(snapshot.delayMs)||snapshot.delayMs<0)return exclude('unknown-delay');
  if(snapshot.delayMs>s.maxFeedDelayMs)return exclude('delayed-book');
  if(!validLevels(snapshot.yes)||!validLevels(snapshot.no))return exclude('invalid-depth');
  const yesTop=Math.max(0,...snapshot.yes.map(l=>l[0])),noTop=Math.max(0,...snapshot.no.map(l=>l[0]));
  if(yesTop+noTop>1+1e-9)return exclude('crossed-book');
  const opposite=decision.side==='yes'?snapshot.no:snapshot.yes;
  if(!opposite.length)return exclude('no-recorded-depth');
  const asks=opposite.map(([p,q])=>[round(1-p),q] as Level).sort((a,b)=>a[0]-b[0]);
  const quantum=s.quantityStep,floorQuantity=(q:number)=>round(Math.floor((q+1e-9)/quantum)*quantum),wanted=floorQuantity(decision.contracts),fair=decision.side==='yes'?decision.probability:1-decision.probability;
  if(wanted<=0)return exclude('quantity-cap');
  result.status='unfilled';result.reason='partial-depth';
  const fragment=floorQuantity(s.maxContractsPerFill),charged=s.feePrecision===undefined?decision.fees:{...decision.fees,precision:s.feePrecision};
  for(const [price,visible] of asks){
    if(result.contracts>=wanted-1e-9)break;
    if(price>decision.limitPrice+1e-9){result.reason='limit-price';break;}
    let available=floorQuantity(visible*s.depthFraction);
    while(available>=quantum-1e-9&&result.contracts<wanted-1e-9){
      const cap=floorQuantity(Math.min(available,wanted-result.contracts,fragment));
      // Monotone all-in cost permits exact search over contract increments; no fractional hidden depth.
      let lo=0,hi=Math.round(cap/quantum);
      const quote=(units:number)=>{const contracts=round(units*quantum),premium=round(price*contracts),fees=fee(price,contracts,'taker',charged),extraCost=round(s.extraCostPerContract*contracts);return {contracts,premium,fee:fees,extraCost,cost:round(premium+fees+extraCost)};};
      while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(result.cost+quote(mid).cost<=decision.maxCost+1e-9)lo=mid;else hi=mid-1;}
      if(!lo){result.reason='cost-cap';break;}
      const q=quote(lo),expectedProfit=round(fair*q.contracts-q.cost);
      // The submitted limit is frozen. A delayed quote or stress charge cannot retroactively cancel a fill
      // merely because its expected edge deteriorated; that loss of edge is precisely what replay measures.
      result.fills.push({price,...q,expectedProfit});
      result.contracts=round(result.contracts+q.contracts);result.premium=round(result.premium+q.premium);result.fees=round(result.fees+q.fee);result.extraCost=round(result.extraCost+q.extraCost);result.cost=round(result.cost+q.cost);result.expectedProfit=round(result.expectedProfit+expectedProfit);
      available=round(available-q.contracts);
    }
    if(result.reason==='cost-cap')break;
  }
  if(!result.contracts)return result;
  result.status=result.contracts>=wanted-1e-9?'filled':'partial';result.reason=result.status==='filled'?null:result.reason;result.settlement='pending';
  // Unknown or not-yet-published results leave an open exposure. They are never silently dropped from coverage.
  if(outcome?.ticker===decision.ticker&&(outcome.result==='yes'||outcome.result==='no')&&finite(outcome.availableTime)&&outcome.availableTime>=decision.closeTime&&outcome.availableTime<=asOf){
    result.settlement='settled';result.outcome=outcome.result;result.payout=outcome.result===decision.side?result.contracts:0;result.pnl=round(result.payout-result.cost);
  }
  return result;
}

/** Descriptive uncertainty only; whole hours remain together and no interval is shown before 20 blocks. */
export function executionEvidence(attempts:readonly ExecutionAttempt[]){
  const settled=attempts.filter(a=>a.settlement==='settled'&&a.pnl!==null&&a.contracts>0).sort((a,b)=>a.decisionTime-b.decisionTime);
  const blocks=new Map<number,{pnl:number;contracts:number}>();let pnl=0,contracts=0,peak=0,drawdown=0;
  for(const a of settled){pnl+=a.pnl!;contracts+=a.contracts;peak=Math.max(peak,pnl);drawdown=Math.max(drawdown,peak-pnl);
    const hour=Math.floor(a.decisionTime/3600000),b=blocks.get(hour)??{pnl:0,contracts:0};b.pnl+=a.pnl!;b.contracts+=a.contracts;blocks.set(hour,b);}
  let low:number|null=null,high:number|null=null;const values=[...blocks.values()];
  if(values.length>=20){let seed=77123;const boot:number[]=[];for(let n=0;n<1000;n++){let total=0,size=0;for(let i=0;i<values.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const b=values[Math.floor(seed/4294967296*values.length)];total+=b.pnl;size+=b.contracts;}boot.push(total/size);}boot.sort((a,b)=>a-b);low=boot[25];high=boot[974];}
  return {settledMarkets:settled.length,hourBlocks:values.length,meanNetPerContract:contracts?pnl/contracts:null,low,high,settledSequenceDrawdown:drawdown};
}
export function summarize(attempts:ExecutionAttempt[]):ExecutionSummary{
  const summary:ExecutionSummary={decisions:attempts.length,eligible:0,filled:0,partial:0,unfilled:0,excluded:0,pending:0,settled:0,contracts:0,cost:0,fees:0,extraCost:0,settledCost:0,pnl:0,returnOnSettledCost:null,reasons:{},evidence:executionEvidence(attempts)};
  for(const r of attempts){
    if(r.reason)summary.reasons[r.reason]=(summary.reasons[r.reason]??0)+1;
    if(r.status==='excluded')summary.excluded++;else summary.eligible++;
    if(r.status==='partial')summary.partial++;
    if(r.status==='unfilled')summary.unfilled++;
    if(r.contracts>0)summary.filled++;
    if(r.settlement==='pending')summary.pending++;
    if(r.settlement==='settled'){summary.settled++;summary.settledCost+=r.cost;summary.pnl+=r.pnl!;}
    summary.contracts+=r.contracts;summary.cost+=r.cost;summary.fees+=r.fees;summary.extraCost+=r.extraCost;
  }
  for(const field of ['contracts','cost','fees','extraCost','settledCost','pnl'] as const)summary[field]=round(summary[field]);
  summary.returnOnSettledCost=summary.settledCost?summary.pnl/summary.settledCost:null;
  return summary;
}

/** Replay identical frozen decisions under several explicit execution assumptions. Only the first decision for a
 * ticker is eligible, even when it cannot fill, to avoid outcome-dependent retries or scenario-dependent entries.
 * Paired results include zero-fill eligible attempts as zero P&L; missing data and pending exposures remain unpaired. */
export function replayScenarios(decisions:readonly ExecutionDecision[],snapshots:readonly ExecutionSnapshot[],outcomes:readonly ExecutionOutcome[],scenarios:readonly ExecutionScenario[]=EXECUTION_SCENARIOS,asOf=Date.now()):ExecutionReplay{
  const ordered=[...decisions].sort((a,b)=>a.time-b.time||a.id.localeCompare(b.id)),books=new Map<string,ExecutionSnapshot[]>(),official=new Map<string,ExecutionOutcome>();
  for(const s of snapshots){const rows=books.get(s.ticker)??[];rows.push(s);books.set(s.ticker,rows);}
  for(const o of outcomes)if(o.availableTime<=asOf&&(!official.has(o.ticker)||o.availableTime<official.get(o.ticker)!.availableTime))official.set(o.ticker,o);
  const results=scenarios.map(scenario=>{const used=new Set<string>(),attempts=ordered.map(d=>{
    if(used.has(d.ticker))return {...empty(d,d.time+scenario.latencyMs),reason:'duplicate-market' as const};used.add(d.ticker);
    return replayOrder(d,books.get(d.ticker)??[],official.get(d.ticker)??null,scenario,asOf);
  });return {scenario,attempts,summary:summarize(attempts)};});
  const comparisons:ExecutionComparison[]=[];
  const baseline=results[0],knownPnl=(r:ExecutionAttempt)=>r.status==='unfilled'?0:r.settlement==='settled'?r.pnl:null;
  if(baseline)for(const scenario of results.slice(1)){
    let paired=0,baselinePnl=0,scenarioPnl=0,unpaired=0;
    scenario.attempts.forEach((attempt,i)=>{if(attempt.reason==='duplicate-market')return;const a=knownPnl(baseline.attempts[i]),b=knownPnl(attempt);if(a===null||b===null){unpaired++;return;}paired++;baselinePnl+=a;scenarioPnl+=b;});
    comparisons.push({scenario:scenario.scenario.name,baseline:baseline.scenario.name,paired,baselinePnl:round(baselinePnl),scenarioPnl:round(scenarioPnl),difference:round(scenarioPnl-baselinePnl),unpaired});
  }
  return {asOf,results,comparisons,limitations:[
    'Shadow IOC replay uses the first recorded book after assumed arrival; it cannot establish that a live order would have filled.',
    'Displayed depth may disappear before execution. Snapshot wait, latency, depth haircut, fee fragmentation and extra costs are explicit assumptions.',
    'Aggregated depth does not reveal individual resting orders or exact fill fragmentation. Fees use the captured schedule and are rounded separately for each simulated fill.',
    'Only recorded levels are consumed. Missing, invalid, stale, delayed, crossed or unavailable quotes are excluded and reported.',
    'Paired comparisons use identical first decisions per market. Excluded observations and unresolved exposures are not treated as zero-return trades.',
    'These execution results do not correct model-selection bias or establish a prospective trading edge.',
  ]};
}
