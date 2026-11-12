import {parentPort,workerData} from 'node:worker_threads';
import {Journal} from './journal';
import {buildCalibration} from './calibration';
import {fitStack,describe,type StackFit,type StackSample} from './quant/stack';
import {stackSamples,lateSamples} from './quant/samples';
import {autoBasis} from './quant/forecast';
import {benchmarkCalibrationSamples,fitBenchmarkCalibration,type BenchmarkCalibrationRecord,type BenchmarkCalibrationFit} from './quant/benchmark-calibration';
import {executionStudy,executionStudySummary} from './quant/execution-study';
/**
 * Refits and the calibration report, off the engine's 4 Hz loop (2026-10-11). On the live journal a calibration rebuild
 * took 1.4 s, the cold final-minute sample load 2.5 s and the two refits 0.25 s, all synchronous: the loop froze for
 * 2–7 s several times a round and the dashboard went stale. Here they run on their own thread and SQLite connection
 * (WAL, so the engine keeps writing); the engine only swaps in the results.
 */
const journal=new Journal(workerData.path),lateCache=new Map<string,StackSample[]>();
let stackN=-1,lateOutcomes=-1,lateStack:StackFit|null=null,stack:StackFit|null=null,key='';
let benchmarkKey='',benchmarkCalibration:BenchmarkCalibrationFit|undefined;
const basisErrors=()=>(journal.db.prepare('SELECT basis_error FROM outcomes WHERE basis_error IS NOT NULL ORDER BY time').all() as {basis_error:number}[]).map(r=>r.basis_error);
parentPort!.on('message',(message)=>{
  const logs:[string,unknown][]=[];
  try{
    // The engine's own journal caches real trades; this connection must re-read them each pass.
    (journal as any).realCache=undefined;
    const settled=(journal.db.prepare('SELECT count(*) n FROM outcomes').get() as {n:number}).n;let late:StackFit|null=null,changed=false;
    // Final-minute rows of a round are complete once its outcome is recorded, so the late fit only moves with settlements.
    if(settled!==lateOutcomes){lateOutcomes=settled;const s=lateSamples(journal.db,lateCache);if(s.length!==lateStack?.n){lateStack=late=fitStack(s);logs.push(['late-fit',{n:late.n,markets:late.markets,active:late.active,cv:late.cv,weights:describe(late)}]);}}
    const basis=autoBasis(basisErrors()),samples=stackSamples(journal.db);
    if(samples.length!==stackN){stackN=samples.length;stack=fitStack(samples);changed=true;
      const entry={time:Date.now(),n:stack.n,markets:stack.markets,active:stack.active,cv:stack.cv,weights:describe(stack),basis:basis.correction};
      logs.push(['quant-fit',entry]);journal.set('quantHistory',[...journal.get<any[]>('quantHistory',[]),entry].slice(-200));}
    const researchAsOf=Date.now()+(Number.isFinite(message?.clockOffset)?message.clockOffset:0);
    const calibrationRows=journal.db.prepare('SELECT f.*,o.result,o.time settled_time FROM benchmark_forecasts f JOIN outcomes o USING(ticker) WHERE o.time<? ORDER BY f.time').all(researchAsOf-60000) as BenchmarkCalibrationRecord[];
    const newBenchmarkKey=JSON.stringify(calibrationRows.map(r=>[r.ticker,r.horizon,r.settled_time]));
    if(!benchmarkCalibration||benchmarkKey!==newBenchmarkKey){benchmarkKey=newBenchmarkKey;benchmarkCalibration=fitBenchmarkCalibration(benchmarkCalibrationSamples(calibrationRows),researchAsOf);
      logs.push(['benchmark-calibration-fit',{state:benchmarkCalibration.state,markets:benchmarkCalibration.markets,reason:benchmarkCalibration.reason}]);}
    // Rebuild the report only when its inputs change (a settlement, a new call or paper result, a real trade, a refit).
    const inputs=JSON.stringify(journal.db.prepare("SELECT (SELECT count(*) FROM outcomes) o,(SELECT count(*) FROM benchmark_forecasts) bf,(SELECT count(*) FROM research_forecasts) rf,(SELECT count(*) FROM paper_trades INDEXED BY paper_status WHERE status='settled') p,(SELECT count(*) FROM opening_calls) oc,(SELECT count(*) FROM live_calls) lc,(SELECT count(*) FROM next_calls) nc,(SELECT count(*) FROM real_trades) rt").get())+':'+stack?.fitted+':'+benchmarkCalibration.fittedAt;
    const execution=inputs!==key?journal.db.transaction(()=>executionStudySummary(executionStudy(journal.db,Date.now())))():null;
    const calibration=inputs!==key&&stack?buildCalibration(journal,stack,basis,benchmarkCalibration,execution):null;if(calibration)key=inputs;
    parentPort!.postMessage({stack:changed?stack:null,lateStack:late,basis,calibration,benchmarkCalibration,logs});
  }catch(e){parentPort!.postMessage({error:(e as Error).message,logs});}
});
