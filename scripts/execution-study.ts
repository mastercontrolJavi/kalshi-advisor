import Database from 'better-sqlite3';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fee,type FeeSchedule} from '../src/engine/model/fees';
import {replayScenarios,type ExecutionDecision,type ExecutionSnapshot,type ExecutionOutcome,type ExecutionScenario} from '../src/engine/quant/execution-replay';

/** Prespecified shadow protocol. Do not optimize these settings on the resulting P&L. */
export const EXECUTION_PROTOCOL={version:'execution-study-v1',forecastVersion:'btc-research-v1',methods:['brtiP','marketP','quantP','candidateP'],horizons:[60,30,10],minEdge:.04,maxSpread:.06,maxContracts:5,maxCost:5,depthLimit:20} as const;
export const STUDY_SCENARIOS:ExecutionScenario[]=[
  {name:'250ms',latencyMs:250,maxSnapshotWaitMs:1200,maxSnapshotAgeMs:1000,maxFeedDelayMs:2000,maxContractsPerFill:1},
  {name:'1000ms',latencyMs:1000,maxSnapshotWaitMs:1200,maxSnapshotAgeMs:1000,maxFeedDelayMs:2000,maxContractsPerFill:1},
  {name:'3000ms',latencyMs:3000,maxSnapshotWaitMs:1200,maxSnapshotAgeMs:1000,maxFeedDelayMs:2000,maxContractsPerFill:1},
  {name:'1000ms-plus-1cent',latencyMs:1000,maxSnapshotWaitMs:1200,maxSnapshotAgeMs:1000,maxFeedDelayMs:2000,extraCostPerContract:.01,maxContractsPerFill:1},
];
type Method=typeof EXECUTION_PROTOCOL.methods[number];
type Checkpoint={ticker:string;horizon:number;version:string;time:number;context:string};
type Context=Record<string,unknown>;
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

/** Database opened read-only by the CLI. Querying never constructs Journal or applies schema migrations. */
export function executionStudy(db:Database.Database,asOf:number){
  if(!finite(asOf))throw new Error('Invalid --through timestamp');
  const tables=new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(r=>r.name));
  const hasForecasts=tables.has('research_forecasts'),hasBooks=tables.has('research_books'),hasOutcomes=tables.has('outcomes');
  const checkpoints=hasForecasts?db.prepare('SELECT ticker,horizon,version,time,context FROM research_forecasts WHERE version=? AND time<=? ORDER BY time,ticker,horizon DESC').all(EXECUTION_PROTOCOL.forecastVersion,asOf) as Checkpoint[]:[];
  const fetchBooks=hasBooks?db.prepare('SELECT id,ticker,time,context FROM research_books WHERE ticker=? AND time>=? AND time<=? ORDER BY time,id'):null;
  const fetchOutcome=hasOutcomes?db.prepare('SELECT ticker,result,time FROM outcomes WHERE ticker=?'):null;
  const maxLookahead=Math.max(...STUDY_SCENARIOS.map(s=>s.latencyMs+s.maxSnapshotWaitMs));
  const bookCache=new Map<string,ExecutionSnapshot[]>(),rawOutcomes=new Map<string,{ticker:string;result:string;time:number}|null>();
  let snapshotRowsRead=0;
  const methods=EXECUTION_PROTOCOL.methods.map(method=>{
    const checkpointExclusions:Record<string,number>={},decisions:ExecutionDecision[]=[],offsets=new Map<string,number>(),chosen=new Set<string>();
    for(const row of checkpoints){
      if(chosen.has(row.ticker))continue;
      if(!(EXECUTION_PROTOCOL.horizons as readonly number[]).includes(row.horizon)){count(checkpointExclusions,'unsupported-horizon');continue;}
      const context=parse(row.context);if(!context){count(checkpointExclusions,'invalid-checkpoint');continue;}
      const p=context[method],close=context.closeTime,offset=context.clockOffset;
      if(!finite(p)||p<0||p>1){count(checkpointExclusions,'missing-probability');continue;}
      if(!finite(close)||close<=row.time||close-row.time>61000){count(checkpointExclusions,'outside-final-minute');continue;}
      if(!finite(offset)){count(checkpointExclusions,'missing-clock-offset');continue;}
      const fees=schedule(context.fees);if(!fees){count(checkpointExclusions,'unverified-fees');continue;}
      const book=snapshot(context.book,row.ticker,row.time);
      if(!book){count(checkpointExclusions,'missing-decision-book');continue;}
      if(!book.valid||book.time-book.bookUpdated<0||book.time-book.bookUpdated>1000||book.delayMs===null||book.delayMs<0||book.delayMs>2000){count(checkpointExclusions,'unusable-decision-book');continue;}
      const yesBid=book.yes.length?Math.max(...book.yes.map(l=>l[0])):null,noBid=book.no.length?Math.max(...book.no.map(l=>l[0])):null;
      if(yesBid===null||noBid===null){count(checkpointExclusions,'missing-decision-depth');continue;}
      const yesAsk=1-noBid,noAsk=1-yesBid,spread=yesAsk-yesBid;
      if(spread<0||spread>EXECUTION_PROTOCOL.maxSpread+1e-9){count(checkpointExclusions,'decision-spread');continue;}
      const yesEdge=p-yesAsk-fee(yesAsk,1,'taker',fees),noEdge=1-p-noAsk-fee(noAsk,1,'taker',fees),side=yesEdge>=noEdge?'yes':'no',edge=Math.max(yesEdge,noEdge);
      if(edge<EXECUTION_PROTOCOL.minEdge-1e-9){count(checkpointExclusions,'no-qualifying-edge');continue;}
      const fair=side==='yes'?p:1-p;
      decisions.push({id:`${row.ticker}:${row.horizon}:${method}`,ticker:row.ticker,time:row.time,probabilityTime:row.time,closeTime:close,side,probability:p,
        limitPrice:Math.min(.9999,Math.floor((fair-EXECUTION_PROTOCOL.minEdge)*10000)/10000),contracts:EXECUTION_PROTOCOL.maxContracts,maxCost:EXECUTION_PROTOCOL.maxCost,minEdge:EXECUTION_PROTOCOL.minEdge,fees});
      offsets.set(row.ticker,offset);chosen.add(row.ticker);
    }
    // Decisions are frozen above before reading any post-decision books or official results.
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
    return {method:method as Method,checkpoints:checkpoints.length,checkpointExclusions,selected:decisions.length,decisions,...replayScenarios(decisions,snapshots,outcomes,STUDY_SCENARIOS,asOf)};
  });
  const settled=methods.reduce((n,m)=>n+m.results.reduce((sum,r)=>sum+r.summary.settled,0),0);
  return {protocol:EXECUTION_PROTOCOL,asOf:new Date(asOf).toISOString(),status:settled?'shadow-replay':'collecting',tables:{research_forecasts:hasForecasts,research_books:hasBooks,outcomes:hasOutcomes},checkpoints:checkpoints.length,snapshotRowsRead,methods,
    interpretation:'These are conditional shadow execution estimates, not observed fills or proof of profit. Decisions are frozen before replay. Missing records are excluded, never reconstructed from legacy candles or prices.',
    limitations:[...new Set(methods.flatMap(m=>m.limitations)),
      'The first qualifying 60/30/10-second checkpoint is selected separately for each fixed method. Method totals may cover different markets and are not a paired model-performance comparison.',
      'Official outcome timestamps are converted to local time with the recorded checkpoint clock offset. Missing offsets make a checkpoint unusable.',
      'Captured top-20 depth is a lower bound on available depth. No liquidity is invented beyond recorded levels. Stress outcomes depend on assumed latency, not actual order acknowledgements.',
      'One-dollar payout is modeled at official settlement; no early exits, maker fills, reinvestment, overlapping bankroll allocation, or funding/withdrawal costs are simulated.',
    ]};
}

export function executionStudyMarkdown(report:ReturnType<typeof executionStudy>){
  const lines=[`# Execution study — ${report.asOf.slice(0,10)}`,'',`Status: **${report.status}**. ${report.checkpoints} frozen checkpoints; ${report.snapshotRowsRead} depth snapshots read.`,
    '',report.interpretation,'','Protocol: first qualifying checkpoint per market and method in the final minute; edge ≥4¢ after fees; spread ≤6¢; at most 5 contracts and $5 including fees. No live orders.','',
    '| Method | Scenario | Selected | Filled | Partial | Pending | Settled | Excluded | Fees | Settled P&L |','|---|---|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for(const method of report.methods)for(const result of method.results){const s=result.summary;lines.push(`| ${method.method} | ${result.scenario.name} | ${method.selected} | ${s.filled} | ${s.partial} | ${s.pending} | ${s.settled} | ${s.excluded} | $${s.fees.toFixed(4)} | ${s.settled?`$${s.pnl.toFixed(4)}`:'—'} |`);}
  lines.push('','## Coverage and exclusions','');
  for(const method of report.methods){lines.push(`- ${method.method}: checkpoint exclusions ${JSON.stringify(method.checkpointExclusions)}.`);for(const result of method.results)lines.push(`  - ${result.scenario.name}: ${JSON.stringify(result.summary.reasons)}.`);}
  lines.push('','## Paired execution stresses','', '| Method | Scenario vs 250ms | Paired attempts | Unpaired | P&L difference |','|---|---|---:|---:|---:|');
  for(const method of report.methods)for(const pair of method.comparisons)lines.push(`| ${method.method} | ${pair.scenario} | ${pair.paired} | ${pair.unpaired} | ${pair.paired?`$${pair.difference.toFixed(4)}`:'—'} |`);
  lines.push('','## Limits','',...report.limitations.map(l=>`- ${l}`),'');return lines.join('\n');
}

if(process.argv[1]&&resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url))){
  const args=process.argv.slice(2),arg=(name:string)=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
  const dbPath=resolve(arg('--db')??(args[0]&&!args[0].startsWith('--')?args[0]:process.env.ADVISOR_DB??'data/advisor.db'));
  const through=arg('--through'),asOf=through===undefined?Date.now():/^\d+$/.test(through)?Number(through):Date.parse(through);
  const db=new Database(dbPath,{readonly:true,fileMustExist:true});
  try{db.pragma('query_only = ON');db.pragma('busy_timeout = 5000');const report=db.transaction(()=>executionStudy(db,asOf))(),output=resolve('output/EXECUTION-STUDY.json');mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');writeFileSync(resolve('output/EXECUTION-STUDY.md'),executionStudyMarkdown(report));console.log(JSON.stringify({status:report.status,asOf:report.asOf,checkpoints:report.checkpoints,snapshotRowsRead:report.snapshotRowsRead,output},null,2));}finally{db.close();}
}
