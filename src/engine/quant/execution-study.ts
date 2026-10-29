import type Database from 'better-sqlite3';
import {fee,type FeeSchedule} from '../model/fees';
import {executionLimitPrice,replayScenarios,summarize,type ExecutionDecision,type ExecutionSnapshot,type ExecutionOutcome,type ExecutionScenario} from './execution-replay';
import {bookSides,censoredProbability,PRICE_CEILING,PROBABILITY_CLIP,type BookSides} from './one-sided';

/** Prespecified shadow protocol. Do not optimize these settings on the resulting P&L. */
export const EXECUTION_PROTOCOL={version:'execution-study-v1',forecastVersion:'btc-research-v1',methods:['brtiP','marketP','quantP','candidateP'],horizons:[60,30,10],minEdge:.04,maxSpread:.06,maxContracts:5,maxCost:5,depthLimit:20} as const;
export const STUDY_SCENARIOS:ExecutionScenario[]=[
  {name:'250ms',latencyMs:250,maxSnapshotWaitMs:1200,maxSnapshotAgeMs:1000,maxFeedDelayMs:2000,maxContractsPerFill:1},
  {name:'1000ms',latencyMs:1000,maxSnapshotWaitMs:1200,maxSnapshotAgeMs:1000,maxFeedDelayMs:2000,maxContractsPerFill:1},
  {name:'3000ms',latencyMs:3000,maxSnapshotWaitMs:1200,maxSnapshotAgeMs:1000,maxFeedDelayMs:2000,maxContractsPerFill:1},
  {name:'1000ms-plus-1cent',latencyMs:1000,maxSnapshotWaitMs:1200,maxSnapshotAgeMs:1000,maxFeedDelayMs:2000,extraCostPerContract:.01,maxContractsPerFill:1},
];
/** One-sided shadow arm (docs/ONE-SIDED-BOOK-STUDY-2026-10-28.md). v1 is run unchanged; this arm is a separate causal policy:
 * in time order, the first checkpoint per market and method that qualifies under v1 (two-sided book) or the one-sided rules.
 * Only the side whose ask comes from a recorded ladder can be bought, censored probabilities are excluded, and no spread is
 * imputed. Fixed before any one-sided P&L was seen; do not tune it on the result. */
export const ONE_SIDED_PROTOCOL={version:'execution-study-v1.1-one-sided',base:EXECUTION_PROTOCOL.version,priceCeiling:PRICE_CEILING,probabilityClip:PROBABILITY_CLIP} as const;
const at1000=STUDY_SCENARIOS[1];
export const ONE_SIDED_SCENARIOS:ExecutionScenario[]=[...STUDY_SCENARIOS,
  {...at1000,name:'1000ms-cent-fees',feePrecision:.01},
  {...at1000,name:'1000ms-whole-order',maxContractsPerFill:EXECUTION_PROTOCOL.maxContracts},
  {...at1000,name:'1000ms-half-depth',depthFraction:.5},
];
type Method=typeof EXECUTION_PROTOCOL.methods[number];
type Checkpoint={ticker:string;horizon:number;version:string;time:number;context:string};
type Context=Record<string,unknown>;
type Stratum=BookSides|'invalid';
type Evaluation={decision:ExecutionDecision;offset:number;stratum:BookSides}|{reason:string;stratum:Stratum};
function object(value:unknown):Context|null{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Context:null;}
function parse(value:string):Context|null{try{return object(JSON.parse(value));}catch{return null;}}
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const count=(counts:Record<string,number>,reason:string)=>{counts[reason]=(counts[reason]??0)+1;};
const levels=(value:unknown):value is [number,number][]=>Array.isArray(value)&&value.every(level=>Array.isArray(level)&&level.length===2&&finite(level[0])&&level[0]>0&&level[0]<1&&finite(level[1])&&level[1]>0);
function snapshot(value:unknown,ticker:string,time:number):ExecutionSnapshot|null{
  const s=object(value);if(!s||s.ticker!==ticker||s.time!==time||!finite(s.bookUpdated)||typeof s.valid!=='boolean'||!(s.delayMs===null||finite(s.delayMs))||!levels(s.yes)||!levels(s.no))return null;
  return s as unknown as ExecutionSnapshot;
}
function schedule(value:unknown):FeeSchedule|null{
  const s=object(value);return s&&s.verified===true&&finite(s.takerMultiplier)&&s.takerMultiplier>=0&&finite(s.makerMultiplier)&&s.makerMultiplier>=0&&finite(s.precision)&&s.precision>0&&s.precision<=.01?s as unknown as FeeSchedule:null;
}
const oneSided=(stratum:Stratum)=>stratum==='pinned'||stratum==='one-sided';

/** One checkpoint under the frozen rules. With allowOneSided false this is exactly v1; a book missing a ladder is labelled
 * pinned/one-sided/empty instead of the former single 'missing-decision-depth'. */
function evaluate(row:Checkpoint,method:Method,allowOneSided:boolean):Evaluation{
  if(!(EXECUTION_PROTOCOL.horizons as readonly number[]).includes(row.horizon))return {reason:'unsupported-horizon',stratum:'invalid'};
  const context=parse(row.context);if(!context)return {reason:'invalid-checkpoint',stratum:'invalid'};
  const p=context[method],close=context.closeTime,offset=context.clockOffset,book=snapshot(context.book,row.ticker,row.time);
  const sides=book?bookSides(book):null,stratum:Stratum=sides?.kind??'invalid',arm=allowOneSided&&oneSided(stratum);
  // A one-sided book has no mid, so the market method has no point estimate there; that is structural, not a gap.
  if(!finite(p)||p<0||p>1)return {reason:arm&&method==='marketP'?'market-point-undefined':'missing-probability',stratum};
  if(!finite(close)||close<=row.time||close-row.time>61000)return {reason:'outside-final-minute',stratum};
  if(!finite(offset))return {reason:'missing-clock-offset',stratum};
  const fees=schedule(context.fees);if(!fees)return {reason:'unverified-fees',stratum};
  if(!book||!sides)return {reason:'missing-decision-book',stratum};
  if(!book.valid||book.time-book.bookUpdated<0||book.time-book.bookUpdated>1000||book.delayMs===null||book.delayMs<0||book.delayMs>2000)return {reason:'unusable-decision-book',stratum};
  const decision=(side:'yes'|'no',limitPrice:number):Evaluation=>({decision:{id:`${row.ticker}:${row.horizon}:${method}${sides.kind==='two-sided'?'':':one-sided'}`,ticker:row.ticker,time:row.time,probabilityTime:row.time,closeTime:close,side,probability:p,
    limitPrice,contracts:EXECUTION_PROTOCOL.maxContracts,maxCost:EXECUTION_PROTOCOL.maxCost,minEdge:EXECUTION_PROTOCOL.minEdge,fees},offset,stratum:sides.kind});
  if(sides.kind!=='two-sided'){
    if(!arm)return {reason:sides.kind==='pinned'?'pinned-book':sides.kind==='empty'?'empty-book':'one-sided-book',stratum};
    // On a bound the unclipped value is unknown; 1% against a 0.1¢ ask is an artifact of the clip, not an edge.
    if(censoredProbability(p))return {reason:'censored-probability',stratum};
    const side=sides.executable!,ask=Math.round((1-sides.bestBid!)*1e8)/1e8,edge=(side==='yes'?p:1-p)-ask-fee(ask,1,'taker',fees);
    if(edge<EXECUTION_PROTOCOL.minEdge-1e-9)return {reason:'no-qualifying-edge',stratum};
    const limitPrice=executionLimitPrice(p,side,EXECUTION_PROTOCOL.minEdge,fees);if(limitPrice===null)return {reason:'no-positive-limit',stratum};
    return decision(side,limitPrice);
  }
  const yesBid=Math.max(...book.yes.map(l=>l[0])),noBid=Math.max(...book.no.map(l=>l[0]));
  const yesAsk=1-noBid,noAsk=1-yesBid,spread=yesAsk-yesBid;
  if(spread<0||spread>EXECUTION_PROTOCOL.maxSpread+1e-9)return {reason:'decision-spread',stratum};
  const yesEdge=p-yesAsk-fee(yesAsk,1,'taker',fees),noEdge=1-p-noAsk-fee(noAsk,1,'taker',fees),side=yesEdge>=noEdge?'yes':'no',edge=Math.max(yesEdge,noEdge);
  if(edge<EXECUTION_PROTOCOL.minEdge-1e-9)return {reason:'no-qualifying-edge',stratum};
  const limitPrice=executionLimitPrice(p,side,EXECUTION_PROTOCOL.minEdge,fees);if(limitPrice===null)return {reason:'no-positive-limit',stratum};
  return decision(side,limitPrice);
}
/** First qualifying checkpoint per market, in time order. Exclusions are counted where filter() says so. */
function select(checkpoints:readonly Checkpoint[],method:Method,allowOneSided:boolean,filter:(stratum:Stratum)=>boolean=()=>true){
  const exclusions:Record<string,number>={},decisions:ExecutionDecision[]=[],offsets=new Map<string,number>(),strata=new Map<string,BookSides>(),chosen=new Set<string>();
  for(const row of checkpoints){
    if(chosen.has(row.ticker))continue;
    const result=evaluate(row,method,allowOneSided);
    if('reason' in result){if(filter(result.stratum))count(exclusions,result.reason);continue;}
    decisions.push(result.decision);offsets.set(row.ticker,result.offset);strata.set(result.decision.id,result.stratum);chosen.add(row.ticker);
  }
  return {exclusions,decisions,offsets,strata};
}

/** Database opened read-only by the CLI. Querying never constructs Journal or applies schema migrations.
 * The one-sided arm runs only when asked (the CLI): the engine's calibration worker sends the dashboard v1 alone, so it skips it. */
export function executionStudy(db:Database.Database,asOf:number,{oneSided:withOneSided=false}:{oneSided?:boolean}={}){
  if(!finite(asOf))throw new Error('Invalid --through timestamp');
  const tables=new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(r=>r.name));
  const hasForecasts=tables.has('research_forecasts'),hasBooks=tables.has('research_books'),hasOutcomes=tables.has('outcomes');
  const checkpoints=hasForecasts?db.prepare('SELECT ticker,horizon,version,time,context FROM research_forecasts WHERE version=? AND time<=? ORDER BY time,ticker,horizon DESC').all(EXECUTION_PROTOCOL.forecastVersion,asOf) as Checkpoint[]:[];
  const fetchBooks=hasBooks?db.prepare('SELECT id,ticker,time,context FROM research_books WHERE ticker=? AND time>=? AND time<=? ORDER BY time,id'):null;
  const fetchOutcome=hasOutcomes?db.prepare('SELECT ticker,result,time FROM outcomes WHERE ticker=?'):null;
  const maxLookahead=Math.max(...[...STUDY_SCENARIOS,...ONE_SIDED_SCENARIOS].map(s=>s.latencyMs+s.maxSnapshotWaitMs));
  const bookCache=new Map<string,ExecutionSnapshot[]>(),rawOutcomes=new Map<string,{ticker:string;result:string;time:number}|null>();
  let snapshotRowsRead=0;
  // Decisions are frozen by select() before this reads any post-decision books or official results.
  const replayInputs=(decisions:readonly ExecutionDecision[],offsets:Map<string,number>)=>{
    const snapshots:ExecutionSnapshot[]=[],outcomes:ExecutionOutcome[]=[];
    for(const d of decisions){
      const key=`${d.ticker}:${d.time}`,cached=bookCache.get(key);
      if(cached)snapshots.push(...cached);else{
        const rows=fetchBooks?.all(d.ticker,d.time,Math.min(asOf,d.time+maxLookahead)) as {id:number;ticker:string;time:number;context:string}[]|undefined,books:ExecutionSnapshot[]=[];
        for(const row of rows??[]){snapshotRowsRead++;const context=parse(row.context),book=snapshot(context,row.ticker,row.time);
          // Keep a corrupt first observation as invalid, so a later favorable quote cannot silently replace it.
          books.push(book??{ticker:row.ticker,time:row.time,bookUpdated:row.time,valid:false,delayMs:null,yes:[],no:[]});}
        bookCache.set(key,books);snapshots.push(...books);
      }
      if(!rawOutcomes.has(d.ticker))rawOutcomes.set(d.ticker,(fetchOutcome?.get(d.ticker) as {ticker:string;result:string;time:number}|undefined)??null);
      const official=rawOutcomes.get(d.ticker);
      if(official&&(official.result==='yes'||official.result==='no')&&finite(official.time))outcomes.push({ticker:d.ticker,result:official.result,availableTime:official.time-offsets.get(d.ticker)!});
    }
    return {snapshots,outcomes};
  };
  const methods=EXECUTION_PROTOCOL.methods.map(method=>{
    const {exclusions:checkpointExclusions,decisions,offsets}=select(checkpoints,method,false),{snapshots,outcomes}=replayInputs(decisions,offsets);
    return {method:method as Method,checkpoints:checkpoints.length,checkpointExclusions,selected:decisions.length,decisions,...replayScenarios(decisions,snapshots,outcomes,STUDY_SCENARIOS,asOf)};
  });
  const oneSidedArm=()=>{
  const oneSidedMethods=EXECUTION_PROTOCOL.methods.map(method=>{
    const v1=new Map(methods.find(m=>m.method===method)!.decisions.map(d=>[d.ticker,d.id]));
    const {exclusions,decisions,offsets,strata}=select(checkpoints,method,true,oneSided),{snapshots,outcomes}=replayInputs(decisions,offsets);
    const isOneSided=(id:string)=>oneSided(strata.get(id)!),replay=replayScenarios(decisions,snapshots,outcomes,ONE_SIDED_SCENARIOS,asOf);
    const moved=decisions.filter(d=>v1.has(d.ticker)&&v1.get(d.ticker)!==d.id).map(d=>d.ticker),added=decisions.filter(d=>!v1.has(d.ticker)).map(d=>d.ticker);
    return {method:method as Method,exclusions,selected:decisions.length,oneSidedSelected:decisions.filter(d=>isOneSided(d.id)).length,moved,added,
      decisions:decisions.filter(d=>isOneSided(d.id)),
      results:replay.results.map(r=>({scenario:r.scenario,combined:r.summary,oneSided:summarize(r.attempts.filter(a=>isOneSided(a.id))),attempts:r.attempts.filter(a=>isOneSided(a.id))}))};
  });
  const coverage={checkpoints:checkpoints.length,byKind:{} as Record<string,number>,byHorizon:{} as Record<string,Record<string,number>>,markets:{total:0,anyOneSided:0,allOneSided:0}};
  const marketKinds=new Map<string,Set<string>>();
  for(const row of checkpoints){const context=parse(row.context),book=context?snapshot(context.book,row.ticker,row.time):null,kind=book?bookSides(book).kind:'invalid';
    count(coverage.byKind,kind);count(coverage.byHorizon[row.horizon]??={},kind);const kinds=marketKinds.get(row.ticker)??new Set();kinds.add(kind);marketKinds.set(row.ticker,kinds);}
  coverage.markets={total:marketKinds.size,anyOneSided:[...marketKinds.values()].filter(k=>k.has('pinned')||k.has('one-sided')).length,allOneSided:[...marketKinds.values()].filter(k=>[...k].every(x=>x==='pinned'||x==='one-sided')).length};
  return {protocol:ONE_SIDED_PROTOCOL,coverage,methods:oneSidedMethods,limitations:[
      'A pinned book has the favourite bid at the price ceiling, so nothing can sell the favourite without crossing: it is excluded as unbuyable, never filled at a made-up ask and never counted as a zero-return trade.',
      'Only the side opposite the recorded ladder can be bought. Its own bid is missing, so a filled position has no mark before settlement.',
      'Model probabilities on the 1%/99% bound are censored and excluded. The market has no point estimate on a one-sided book; the calibrated candidate needs one, so neither can decide there.',
      'The arm is a separate causal policy; markets it takes earlier than v1 are listed as moved. Its totals are not paired with v1 and are never pooled into the v1 headline.',
      'The 1000ms-cent-fees scenario recharges the same fills at 1¢ fee rounding; whole-order and half-depth scenarios bound fee fragmentation and disappearing depth. Maker orders on the favourite are not simulated: queue position is not recorded.',
    ]};
  };
  const arm=withOneSided?oneSidedArm():null,settled=methods.reduce((n,m)=>n+m.results.reduce((sum,r)=>sum+r.summary.settled,0),0);
  return {protocol:EXECUTION_PROTOCOL,asOf:new Date(asOf).toISOString(),status:settled?'shadow-replay':'collecting',tables:{research_forecasts:hasForecasts,research_books:hasBooks,outcomes:hasOutcomes},checkpoints:checkpoints.length,snapshotRowsRead,methods,
    interpretation:'These are conditional shadow execution estimates, not observed fills or proof of profit. Decisions are frozen before replay. Missing records are excluded, never reconstructed from legacy candles or prices.',
    limitations:[...new Set(methods.flatMap(m=>m.limitations)),
      'The first qualifying 60/30/10-second checkpoint is selected separately for each fixed method. Method totals may cover different markets and are not a paired model-performance comparison.',
      'Official outcome timestamps are converted to local time with the recorded checkpoint clock offset. Missing offsets make a checkpoint unusable.',
      'Captured top-20 depth is a lower bound on available depth. No liquidity is invented beyond recorded levels. Stress outcomes depend on assumed latency, not actual order acknowledgements.',
      'One-dollar payout is modeled at official settlement; no early exits, maker fills, reinvestment, overlapping bankroll allocation, or funding/withdrawal costs are simulated.',
    ],
    oneSided:arm};
}

/** Keep recorded decisions and detailed fills out of the live dashboard's frequent state messages. */
export function executionStudySummary(report:ReturnType<typeof executionStudy>){
  return {asOf:report.asOf,status:report.status,checkpoints:report.checkpoints,methods:report.methods.map(m=>({method:m.method,selected:m.selected,checkpointExclusions:m.checkpointExclusions,
    results:m.results.map(r=>({scenario:r.scenario.name,summary:r.summary})),comparisons:m.comparisons}))};
}
export function executionStudyMarkdown(report:ReturnType<typeof executionStudy>){
  const lines=[`# Execution study — ${report.asOf.slice(0,10)}`,'',`Status: **${report.status}**. ${report.checkpoints} frozen checkpoints; ${report.snapshotRowsRead} depth snapshots read.`,
    '',report.interpretation,'','Protocol: first qualifying checkpoint per market and method in the final minute; edge ≥4¢ after fees; spread ≤6¢; at most 5 contracts and $5 including fees. No live orders.','',
    '| Method | Scenario | Selected | Filled | Partial | Pending | Settled | Excluded | Fees | Settled P&L |','|---|---|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for(const method of report.methods)for(const result of method.results){const s=result.summary;lines.push(`| ${method.method} | ${result.scenario.name} | ${method.selected} | ${s.filled} | ${s.partial} | ${s.pending} | ${s.settled} | ${s.excluded} | $${s.fees.toFixed(4)} | ${s.settled?`$${s.pnl.toFixed(4)}`:'—'} |`);}
  lines.push('','## Uncertainty and drawdown','','Intervals require at least 20 hourly blocks and are descriptive, without adjustment for repeated model searches. Drawdown follows settled markets in decision order; it does not measure intratrade risk.','','| Method | Scenario | Hour blocks | Mean net / contract | 95% hour-block interval | Settled-sequence drawdown |','|---|---|---:|---:|---|---:|');
  for(const m of report.methods)for(const r of m.results){const e=r.summary.evidence;lines.push(`| ${m.method} | ${r.scenario.name} | ${e.hourBlocks} | ${e.meanNetPerContract===null?'—':`$${e.meanNetPerContract.toFixed(4)}`} | ${e.low===null?'Insufficient blocks':`$${e.low.toFixed(4)} to $${e.high!.toFixed(4)}`} | $${e.settledSequenceDrawdown.toFixed(4)} |`);}
  lines.push('','## Coverage and exclusions','');
  for(const method of report.methods){lines.push(`- ${method.method}: checkpoint exclusions ${JSON.stringify(method.checkpointExclusions)}.`);for(const result of method.results)lines.push(`  - ${result.scenario.name}: ${JSON.stringify(result.summary.reasons)}.`);}
  lines.push('','## Paired execution stresses','', '| Method | Scenario vs 250ms | Paired attempts | Unpaired | P&L difference |','|---|---|---:|---:|---:|');
  for(const method of report.methods)for(const pair of method.comparisons)lines.push(`| ${method.method} | ${pair.scenario} | ${pair.paired} | ${pair.unpaired} | ${pair.paired?`$${pair.difference.toFixed(4)}`:'—'} |`);
  const o=report.oneSided,kinds=['two-sided','pinned','one-sided','empty','invalid'];
  if(o){
  lines.push('','## One-sided books (shadow arm, '+o.protocol.version+')','',`Pinned = one ladder whose best bid is at the ${(o.protocol.priceCeiling*100).toFixed(1)}¢ ceiling; one-sided = one ladder below it. ${o.coverage.markets.anyOneSided} of ${o.coverage.markets.total} markets had a one-sided checkpoint; ${o.coverage.markets.allOneSided} had nothing else.`,'',
    '| Horizon | '+kinds.join(' | ')+' |','|---|'+kinds.map(()=>'---:').join('|')+'|');
  for(const h of Object.keys(o.coverage.byHorizon).sort((a,b)=>Number(b)-Number(a)))lines.push(`| ${h} s | ${kinds.map(k=>o.coverage.byHorizon[h][k]??0).join(' | ')} |`);
  lines.push(`| All | ${kinds.map(k=>o.coverage.byKind[k]??0).join(' | ')} |`,'','| Method | Scenario | One-sided decisions | Filled | Settled | Fees | One-sided P&L | Arm total P&L (all books) |','|---|---|---:|---:|---:|---:|---:|---:|');
  for(const m of o.methods)for(const r of m.results)lines.push(`| ${m.method} | ${r.scenario.name} | ${m.oneSidedSelected} | ${r.oneSided.filled} | ${r.oneSided.settled} | $${r.oneSided.fees.toFixed(4)} | ${r.oneSided.settled?`$${r.oneSided.pnl.toFixed(4)}`:'—'} | ${r.combined.settled?`$${r.combined.pnl.toFixed(4)}`:'—'} |`);
  lines.push('');for(const m of o.methods)lines.push(`- ${m.method}: one-sided exclusions ${JSON.stringify(m.exclusions)}; markets taken earlier than v1 ${m.moved.length}; markets v1 did not trade ${m.added.length}.`);
  lines.push('',...o.limitations.map(l=>`- ${l}`));
  }
  lines.push('','## Limits','',...report.limitations.map(l=>`- ${l}`),'');return lines.join('\n');
}
