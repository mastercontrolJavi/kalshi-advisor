/**
 * Read-only, reproducible evidence audit. No trading clients, fetches, journal writes or verdict promotion.
 * npx tsx scripts/quant-research.ts --through 2026-10-23T07:20:00Z
 * Optional --db, --history, --out. Outputs Markdown and JSON; source databases are opened readonly/query_only.
 */
import Database from 'better-sqlite3';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {dirname} from 'node:path';
import {fitStack,predict,priorFit,type StackSample} from '../src/engine/quant/stack';
import {fee} from '../src/engine/model/fees';

const arg=(key:string,fallback:string)=>{const i=process.argv.indexOf(`--${key}`);return i<0?fallback:process.argv[i+1]??fallback;};
const through=Date.parse(arg('through',new Date().toISOString()));
if(!Number.isFinite(through))throw new Error('Invalid --through timestamp');
const out=arg('out','docs/QUANT-RESEARCH-2026-10-23.md');
const db=new Database(arg('db','data/advisor.db'),{readonly:true,fileMustExist:true});db.pragma('query_only = ON');db.pragma('busy_timeout = 5000');
const history=new Database(arg('history','data/history.db'),{readonly:true,fileMustExist:true});history.pragma('query_only = ON');
type Call={ticker:string;horizon:string;time:number;tau:number;p:number;mid:number|null;context:string;result:string;settledTime:number};
type Sample=StackSample&{time:number;settledTime:number;tau:number;frozen:number;ask:number|null;noAsk:number|null;bookFresh:boolean};
type Scored={ticker:string;time:number;y:number;p:number;baseline:number};
const avg=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
const clip=(p:number)=>Math.max(.000001,Math.min(.999999,p));
const loss=(p:number,y:number)=>-(y*Math.log(clip(p))+(1-y)*Math.log(1-clip(p)));
const group=<T>(rows:T[],key:(r:T)=>string)=>{const map=new Map<string,T[]>();for(const r of rows){const k=key(r),a=map.get(k)??[];a.push(r);map.set(k,a);}return [...map.values()];};
/** Bootstrap whole adjacent time blocks, retaining equal weight per market within each selected block. */
function interval(values:{time:number;value:number}[],blockMs:number):[number,number]|null{
  const blocks=group(values,r=>String(Math.floor(r.time/blockMs))).map(g=>({sum:g.reduce((s,r)=>s+r.value,0),n:g.length}));
  if(blocks.length<8)return null;let seed=12345;const draws:number[]=[];
  for(let b=0;b<2000;b++){let s=0,n=0;for(let k=0;k<blocks.length;k++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const x=blocks[Math.floor(seed/4294967296*blocks.length)];s+=x.sum;n+=x.n;}draws.push(s/n);}
  draws.sort((a,b)=>a-b);return [draws[50],draws[1949]];
}
function score(rows:Scored[]){
  const byMarket=group(rows,r=>r.ticker).map(g=>({time:g[0].time,brier:avg(g.map(r=>(r.p-r.y)**2))!,baseline:avg(g.map(r=>(r.baseline-r.y)**2))!,logloss:avg(g.map(r=>loss(r.p,r.y)))!,accuracy:avg(g.map(r=>r.p===.5?.5:Number((r.p>.5)===(r.y===1))))!}));
  const delta=byMarket.map(r=>({time:r.time,value:r.baseline-r.brier}));
  return {rows:rows.length,markets:byMarket.length,hourBlocks:new Set(byMarket.map(r=>Math.floor(r.time/3600000))).size,dayBlocks:new Set(byMarket.map(r=>Math.floor(r.time/86400000))).size,
    brier:avg(byMarket.map(r=>r.brier)),logloss:avg(byMarket.map(r=>r.logloss)),accuracy:avg(byMarket.map(r=>r.accuracy)),baselineBrier:avg(byMarket.map(r=>r.baseline)),brierGain:avg(delta.map(r=>r.value)),gainHourCI:interval(delta,3600000),gainDayCI:interval(delta,86400000)};
}
function compare(rows:Sample[],prob:(r:Sample)=>number,baseline:(r:Sample)=>number=r=>r.mid??.5){return score(rows.map(r=>({ticker:r.ticker,time:r.time,y:r.y,p:prob(r),baseline:baseline(r)})));}
/** Fixed beforehand: first eligible checkpoint; best side; >=4 cents after fee and stress; <=6c spread. */
function trade(rows:Sample[],prob:(r:Sample)=>number,slippage=0){
  const taken=new Set<string>(),trades:{time:number;value:number;paid:number}[]=[];
  for(const r of [...rows].sort((a,b)=>a.time-b.time)){if(taken.has(r.ticker)||!r.bookFresh||r.ask===null||r.noAsk===null||r.tau<60||r.ask+r.noAsk-1>.06+1e-9)continue;
    const p=prob(r),yesCost=r.ask+slippage,noCost=r.noAsk+slippage;if(yesCost>=1||noCost>=1)continue;
    const yes=p-yesCost-fee(yesCost),no=1-p-noCost-fee(noCost);if(Math.max(yes,no)<.04)continue;
    const side=yes>=no,paid=(side?yesCost:noCost)+fee(side?yesCost:noCost);taken.add(r.ticker);trades.push({time:r.time,value:(side?r.y:1-r.y)-paid,paid});
  }
  const total=trades.reduce((s,r)=>s+r.value,0),cost=trades.reduce((s,r)=>s+r.paid,0);
  return {n:trades.length,mean:avg(trades.map(t=>t.value)),total,cost,roi:cost?total/cost:null,hourCI:interval(trades,3600000),dayCI:interval(trades,86400000)};
}
const snapshot=db.transaction(()=>{
  const calls=db.prepare(`SELECT c.ticker,'open' horizon,c.time,c.tau,c.p,c.mid,c.context,o.result,o.time settledTime FROM opening_calls c JOIN outcomes o USING(ticker) WHERE o.time<=? AND c.time<=?
    UNION ALL SELECT c.ticker,CAST(c.horizon AS TEXT),c.time,c.tau,c.p,c.mid,c.context,o.result,o.time FROM live_calls c JOIN outcomes o USING(ticker) WHERE o.time<=? AND c.time<=? ORDER BY 3,1,2`).all(through,through,through,through) as Call[];
  const tick=db.prepare(`SELECT json_extract(context,'$.book.yesAsk') ask,json_extract(context,'$.book.noAsk') noAsk,json_extract(context,'$.book.valid') valid,COALESCE(json_extract(context,'$.bookDelay'),json_extract(context,'$.kalshiDelay')) delay,json_extract(context,'$.book.updated') updated,json_extract(context,'$.engineTime') engineTime FROM ticks WHERE time=? AND ticker=?`);
  const counts=['ticks','outcomes','opening_calls','live_calls','next_calls','price_forecasts'].map(table=>({table,...db.prepare(`SELECT COUNT(*) n,MIN(time) first,MAX(time) last FROM ${table} WHERE time<=?`).get(through) as {n:number;first:number;last:number}}));
  const outcomes=db.prepare('SELECT ticker,time,basis_error,proxy_result,result,context FROM outcomes WHERE time<=? ORDER BY time').all(through) as {ticker:string;time:number;basis_error:number|null;proxy_result:string|null;result:string;context:string}[];
  let invalidInputs=0,missingQuote=0;const rows:Sample[]=[];
  for(const c of calls){if(c.result!=='yes'&&c.result!=='no')continue;const x=JSON.parse(c.context).inputs;
    if(!x||!Number.isFinite(x.modelP)||x.modelP<0||x.modelP>1||!(x.sigma>0)){invalidInputs++;continue;}
    const mid=Object.hasOwn(x,'mid')?x.mid:c.mid,book=tick.get(c.time,c.ticker) as {ask:number|null;noAsk:number|null;valid:number|null;delay:number|null;updated:number|null;engineTime:number|null}|undefined;
    // Legacy journal time is server-corrected and rounded to seconds. Require known transport delay;
    // quote-age checks allow up to two seconds of clock/rounding ambiguity only for those legacy rows.
    const age=book?.updated!=null?(book.engineTime??c.time)-book.updated:Infinity;
    const fresh=!!book&&book.valid===1&&book.delay!==null&&book.delay>=0&&book.delay<=2000&&age>=(book.engineTime===null?-2000:0)&&age<=3000;if(!fresh)missingQuote++;
    rows.push({...x,modelP:x.modelP,mid:Number.isFinite(mid)&&mid>=0&&mid<=1?mid:null,momentum30s:x.momentum30s??null,momentum120s:x.momentum120s??null,imbalance:x.imbalance??null,tradeFlow30s:x.tradeFlow30s??null,tradeVolume30s:x.tradeVolume30s??null,
      ticker:c.ticker,horizon:c.horizon,time:c.time,settledTime:c.settledTime,tau:c.tau,y:c.result==='yes'?1:0,frozen:c.p,ask:book?.ask??null,noAsk:book?.noAsk??null,bookFresh:fresh});
  }
  return {rows,counts,outcomes,invalidInputs,missingQuote};
})();db.close();
const archive=history.transaction(()=>({markets:history.prepare('SELECT series,COUNT(*) n,MIN(open_ts)*1000 first,MAX(close_ts)*1000 last,SUM(candles>0) withCandles FROM markets GROUP BY series').all(),spot:history.prepare('SELECT COUNT(*) n,MIN(ts)*1000 first,MAX(ts)*1000 last FROM spot').get()}))();history.close();
console.log(`Read ${snapshot.rows.length} settled forecast checkpoints; source databases closed.`);
const rows=snapshot.rows,paired=rows.filter(r=>r.mid!==null),prior=priorFit();
const frozen=['open','600','300','120','60'].map(horizon=>{const r=paired.filter(r=>r.horizon===horizon);return {horizon,quant:compare(r,x=>x.frozen),model:compare(r,x=>x.modelP),market:compare(r,x=>x.mid!),coin:compare(r,()=>.5)};});
const marketGroups=group(rows,r=>r.ticker).sort((a,b)=>a[0].time-b[0].time),cut=Math.floor(marketGroups.length*.7),testTickers=new Set(marketGroups.slice(cut).map(g=>g[0].ticker)),testFrom=marketGroups[cut]?.[0].time;
if(testFrom===undefined)throw new Error('Not enough settled market groups');
const train=rows.filter(r=>!testTickers.has(r.ticker)&&r.settledTime<testFrom-60000),test=paired.filter(r=>testTickers.has(r.ticker));
const fit=fitStack(train,testFrom-60000),candidate={...fit,weights:fit.fittedWeights};
const predictors:[string,(r:Sample)=>number][]=[['Frozen live forecast',r=>r.frozen],['Raw diffusion',r=>r.modelP],['Kalshi midpoint',r=>r.mid!],['Default blend',r=>predict(prior,r).p],['Validated engine',r=>predict(fit,r).p],['Fitted challenger (shadow)',r=>predict(candidate,r).p],['Coin flip',()=>.5]];
const holdout=predictors.map(([name,p])=>({name,score:compare(test,p),execution:trade(test,p),slippageOneCent:trade(test,p,.01)}));
// Past settlement residuals only. This describes the available uncertainty calibration, not a promoted model.
const residuals=snapshot.outcomes.filter(o=>o.basis_error!==null),errors=residuals.map(o=>o.basis_error!).sort((a,b)=>a-b);
const quantile=(p:number)=>errors.length?errors[Math.min(errors.length-1,Math.floor(errors.length*p))]:null;
const mismatches=snapshot.outcomes.filter(o=>o.proxy_result!==null&&o.proxy_result!==o.result).length;
const oldVerdict=existsSync('data/backtest-verdict.json')?JSON.parse(readFileSync('data/backtest-verdict.json','utf8')):null;
const report={generated:new Date().toISOString(),through:new Date(through).toISOString(),method:{marketWeight:'Each market has total weight one in aggregate probability metrics; each horizon has one checkpoint per market.',split:'Earliest 70% of markets train; latest 30% are a fixed outer holdout; exclude training outcomes unavailable 60 seconds before holdout starts.',uncertainty:'2,000 deterministic bootstrap resamples of complete UTC hour/day blocks, after averaging within market. Intervals are null below eight observed blocks.',execution:'One hypothetical contract per market, first eligible checkpoint, >=4 cents expected edge after fee, <=6 cents spread, fresh exact-time book, hold to official settlement. 1-cent stress applies to entry and decision. No depth/latency/fill simulation.',limitations:['The fixed holdout is retrospective; earlier repository changes may already have inspected these dates. It is not untouched prospective evidence.','Frozen calls span older software versions. Aggregate metrics are market weighted; horizon metrics should be preferred.','Minute archive cannot establish subsecond latency, BRTI availability, final-minute precision or executable fills.','One-hour/day blocks reduce serial-dependence inflation but do not make 17 calendar days equivalent to years of regimes.','No hyperparameter or edge-threshold search is performed. No source database or production verdict is modified.']},coverage:{live:snapshot.counts,independentMarketGroups:marketGroups.length,invalidInputs:snapshot.invalidInputs,unusableExactBook:snapshot.missingQuote,archive},frozen,split:{trainMarkets:new Set(train.map(r=>r.ticker)).size,trainRows:train.length,testMarkets:testTickers.size,testPairedRows:test.length,testFrom:new Date(testFrom).toISOString(),trainLastOutcome:new Date(Math.max(...train.map(r=>r.settledTime))).toISOString()},fit,holdout,basis:{n:errors.length,mean:avg(errors),rms:errors.length?Math.sqrt(errors.reduce((s,x)=>s+x*x,0)/errors.length):null,p05:quantile(.05),median:quantile(.5),p95:quantile(.95),proxyOfficialDisagreements:mismatches,pairedOutcomes:snapshot.outcomes.filter(o=>o.proxy_result!==null).length},existingArchiveVerdict:oldVerdict?{generated:oldVerdict.generated,rounds:oldVerdict.rounds,buy15Model:oldVerdict.buy15Model,kalshiBetter:oldVerdict.kalshiBetter,profitable:oldVerdict.profitable}:null};
const num=(x:number|null|undefined,d=4)=>x===null||x===undefined?'—':x.toFixed(d),pct=(x:number|null|undefined)=>x===null||x===undefined?'—':`${(100*x).toFixed(1)}%`,cents=(x:number|null|undefined)=>x===null||x===undefined?'—':`${(100*x).toFixed(2)}¢`,ci=(x:[number,number]|null,fmt=num)=>x?`${fmt(x[0])} to ${fmt(x[1])}`:'insufficient blocks',date=(x:number)=>new Date(x).toISOString();
const lines=[`# Bitcoin 15-minute quantitative evidence audit`, '',`Generated ${report.generated}. Data cutoff: **${report.through}** (October 23, 2026, 12:20 AM America/Los_Angeles for the reference run).`, '',
  'Reproduce with `npx tsx scripts/quant-research.ts --through 2026-10-23T07:20:00Z`. The companion JSON contains all metrics and fitted weights. Databases are opened read-only and are closed before fitting; this command never promotes a strategy or edits the trading verdict.', '',
  '## What was actually recorded', '', '| Source | Rows | First observation UTC | Last observation UTC |','|---|---:|---|---|',...snapshot.counts.map(c=>`| Live ${c.table} | ${c.n.toLocaleString()} | ${date(c.first)} | ${date(c.last)} |`),'',
  `The eligible frozen forecasts contain **${marketGroups.length} distinct settled market groups**. Thousands of checkpoints and hundreds of thousands of ticks are repeated observations of these outcomes, not independent trials. ${snapshot.invalidInputs} records lacked usable model inputs; ${snapshot.missingQuote} checkpoints lacked a fresh exact-time book for the execution diagnostic.`, '',
  'The separate historical archive contains:', '', '```json',JSON.stringify(archive,null,2),'```','',
  '## Frozen forecasts: what the user actually saw', '', 'All methods use exactly the same paired rows, with a usable decision-time Kalshi midpoint. Brier and log loss are proper probability scores: lower is better. Accuracy alone cannot establish profitable entries. Positive gain means the frozen quant forecast beat Kalshi. Confidence intervals resample entire one-hour blocks.', '',
  '| Time left | Markets | Quant hit rate | Quant Brier | Raw model Brier | Kalshi Brier | Quant gain vs Kalshi | Gain 95% interval |','|---|---:|---:|---:|---:|---:|---:|---|',
  ...frozen.map(r=>`| ${r.horizon==='open'?'Opening':`${Number(r.horizon)/60} min`} | ${r.quant.markets} | ${pct(r.quant.accuracy)} | ${num(r.quant.brier)} | ${num(r.model.brier)} | ${num(r.market.brier)} | ${num(r.quant.brierGain)} | ${ci(r.quant.gainHourCI)} |`),'',
  '## Fixed chronological holdout for the current engine', '',
  `${report.split.trainMarkets} training markets (${train.length} checkpoints); ${report.split.testMarkets} held-out markets, ${test.length} paired checkpoints. Holdout starts ${report.split.testFrom}. Last eligible training outcome: ${report.split.trainLastOutcome}. Each market has total weight one in aggregate probability scoring. The engine performs its own chronological validation inside training; its returned mode is **${fit.active}**. The fitted challenger is reported even when rejected, so a candidate cannot hide behind the safer deployed fallback.`, '',
  '| Method | Brier | Log loss | Hit rate | Gain vs Kalshi | Hour-block gain 95% | Day-block gain 95% |','|---|---:|---:|---:|---:|---|---|',
  ...holdout.map(r=>`| ${r.name} | ${num(r.score.brier)} | ${num(r.score.logloss)} | ${pct(r.score.accuracy)} | ${num(r.score.brierGain)} | ${ci(r.score.gainHourCI)} | ${ci(r.score.gainDayCI)} |`),'',
  '## Ask-based execution diagnostic', '',
  'A fixed 4¢ minimum predicted edge after the app fee, spread no wider than 6¢, at least 60 seconds left, exact-time book with measured transport delay ≤2 seconds and recorded quote age ≤3 seconds, and first qualifying checkpoint per market. Legacy timestamps allow up to two seconds of clock/rounding ambiguity; absent delay metadata is excluded. Hold one contract to the official outcome. The 1¢ stress is added to entry price before deciding and calculating fees. These are hypothetical quote-based fills; order depth, queue position, network latency and adverse selection are not replayed. These filters are deliberately fixed, with no parameter search.', '',
  '| Method | Entries | Mean net P&L | Hour-block 95% | Net total | Entries with 1¢ stress | Mean with 1¢ stress |','|---|---:|---:|---|---:|---:|---:|',
  ...holdout.map(r=>`| ${r.name} | ${r.execution.n} | ${cents(r.execution.mean)} | ${ci(r.execution.hourCI,cents)} | $${num(r.execution.total,2)} | ${r.slippageOneCent.n} | ${cents(r.slippageOneCent.mean)} |`),'',
  '## Settlement-source uncertainty', '',
  `${errors.length} recorded proxy-minus-official settlement averages: mean $${num(report.basis.mean,2)}, RMS $${num(report.basis.rms,2)}, median $${num(report.basis.median,2)}, 5th–95th percentiles $${num(report.basis.p05,2)} to $${num(report.basis.p95,2)}. Proxy and official outcome disagreed on ${mismatches}/${report.basis.pairedOutcomes} paired outcomes. A proxy is therefore not an exact substitute for BRTI, especially near the strike in the final seconds. Any residual-uncertainty adjustment must be fit using earlier outcomes and then tested on later ones.`, '',
  '## What the broader archived test already found', '',
  oldVerdict?`The existing ${oldVerdict.generated} verdict covered ${oldVerdict.rounds.toLocaleString()} historical 15-minute rounds. Its raw diffusion ≥4¢-edge rule averaged ${cents(oldVerdict.buy15Model.mean)} per contract after fees (95% interval ${ci(oldVerdict.buy15Model.ci,cents)}); Kalshi beat the model at ${oldVerdict.kalshiBetter.fifteen}/${oldVerdict.kalshiBetter.fifteenOf} evaluated horizons. ${oldVerdict.profitable.length} strategies passed its positive-profit confidence test. This audit reads that existing result; it does not rerun or relabel it as an untouched holdout.`:'No previous archive verdict found.','',
  '## Interpretation and limits', '',...report.method.limitations.map(s=>`- ${s}`),
  '- A more accurate high-probability direction is not automatically an edge: a 90% favorite bought above its fair probability plus costs can still lose money on average.',
  '- Formula correctness and chronological validation improve reliability. Positive expected returns require independent, forward-recorded evidence after fees and executable prices; none is inferred from a promising retrospective point estimate.',
  '- The frozen holdout and fitted shadow comparison are evidence for accepting or rejecting a change, not a guarantee of future profits. Continue immutable forward recording and require positive paired probability improvement and positive net trading evidence before treating a challenger as an established advantage.',''];
mkdirSync(dirname(out),{recursive:true});writeFileSync(out,lines.join('\n'));writeFileSync(out.replace(/\.md$/i,'')+'.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({out,split:report.split,frozen:frozen.map(r=>({horizon:r.horizon,n:r.quant.markets,accuracy:r.quant.accuracy,brier:r.quant.brier,market:r.market.brier})),holdout:holdout.map(r=>({name:r.name,brier:r.score.brier,gain:r.score.brierGain,ci:r.score.gainHourCI,trades:r.execution.n,pnl:r.execution.mean})),basis:report.basis},null,2));
