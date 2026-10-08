import {writeFileSync,mkdirSync,existsSync} from 'node:fs';
import Database from 'better-sqlite3';
import {dirname} from 'node:path';
import {HistoryStore,SERIES15,SERIES_HOURLY} from './history';
import {finalMinuteStudy} from './live';
import {VERDICT_PATH,type Verdict,type RuleResult} from './verdict';
import {spotSeries,basisTrack,buildRows,scoreBy,priceBuckets,calibration,simulate,summarize,appRule,priceBand,atMinute,modelP,median,bankroll,clusterCI,type Row,type Picker,type ExitRule,type Score,type Bucket,type Summary,type Trade} from './sim';
const c=(x:number)=>Number.isFinite(x)?`${x>=0?'+':''}${(x*100).toFixed(1)}¢`:'—';
const p=(x:number)=>Number.isFinite(x)?`${(x*100).toFixed(1)}%`:'—';
const b4=(x:number)=>Number.isFinite(x)?x.toFixed(4):'—';
const ci=(x:[number,number],f=c)=>`${f(x[0])} … ${f(x[1])}`;
const day=(ts:number)=>new Date(ts*1000).toISOString().slice(0,10);
const sig=(x:[number,number])=>x[0]>0?'above 0':x[1]<0?'below 0':'includes 0';
export const FIXED_EXIT:ExitRule={tp:.25,sl:.5,stopWinProb:.25};
export const TRAIL_EXIT:ExitRule={tp:.25,sl:.5,stopWinProb:.25,trail:{giveback:.5,floor:.05}};
interface Line {name:string;s:Summary;trades:Trade[]}
const FRACTIONS=[1,.5,.25,.1,.02];
function bankrollTable(lines:Line[]){
  const money=(x:number)=>Number.isFinite(x)?'$'+x.toFixed(2):'—';
  return ['| Strategy | Stake per trade | Median after 100 trades | Bad case (10th pct) | Good case (90th pct) | Fell below $2 at some point | Ended below $20 |','|---|---:|---:|---:|---:|---:|---:|',
    ...lines.flatMap(l=>FRACTIONS.map(f=>{const b=bankroll(l.trades,f);return `| ${l.name} | ${f===1?'**all of it**':Math.round(f*100)+'% of balance'} | ${money(b.median)} | ${money(b.p10)} | ${money(b.p90)} | ${p(b.ruined)} | ${p(b.halved)} |`;}))].join('\n');
}
function strategyTable(lines:Line[]){
  return ['| Strategy (1 contract, taker fees both ways) | Trades | Win rate | Avg P&L per contract | 95% range | Total per contract | First half | Second half |','|---|---:|---:|---:|---|---:|---:|---:|',
    ...lines.map(({name,s})=>`| ${name} | ${s.n} | ${p(s.winRate)} | **${c(s.mean)}** | ${ci(s.ci)} | ${s.n?(s.total<0?'−$':'$')+Math.abs(s.total).toFixed(2):'—'} | ${c(s.early)} | ${c(s.late)} |`)].join('\n');
}
function scoreTable(rows:Score[],head:string){
  return [`| ${head} | Samples | App model | App quant blend | Kalshi price | Model − Kalshi | 95% range | Better |`,'|---|---:|---:|---:|---:|---:|---|---|',
    ...rows.map(s=>`| ${s.label} | ${s.clusters} | ${b4(s.model)} | ${b4(s.quant)} | ${b4(s.kalshi)} | ${s.diff>=0?'+':''}${s.diff.toFixed(4)} | ${s.diffCI[0].toFixed(4)} … ${s.diffCI[1].toFixed(4)} | ${s.diffCI[1]<0?'**model**':s.diffCI[0]>0?'**Kalshi**':'tie'} |`)].join('\n');
}
function bucketTable(rows:Bucket[]){
  return ['| Price paid | Buys | Avg price | Won | P&L per contract after fee | 95% range | Return on money spent |','|---|---:|---:|---:|---:|---|---:|',
    ...rows.map(b=>`| ${Math.round(b.lo*100)}–${Math.round(b.hi*100)}¢ | ${b.n} | ${(b.price*100).toFixed(1)}¢ | ${p(b.win)} | **${c(b.pnl)}** | ${ci(b.ci)} | ${b.pnl>=0?'+':''}${(b.pnl/b.price*100).toFixed(0)}% |`)].join('\n');
}
export interface BacktestResult {markdown:string;summary:string;json:unknown;verdict:Verdict}
export function analyze(store:HistoryStore,log:(m:string)=>void=()=>{},journal:Database.Database|null=null):BacktestResult{
  const m15=store.markets(SERIES15).filter(m=>m.candles>0);if(m15.length<50)throw new Error('Not enough 15-minute history; run the fetch first');
  const from=Math.min(...m15.map(m=>m.open_ts)),to=Math.max(...m15.map(m=>m.close_ts));
  const s=spotSeries(store.spot(from-4*3600,to)),basis=basisTrack(store.markets(SERIES15),s);
  log(`Replaying ${m15.length} 15-minute rounds`);
  const rows=buildRows(m15,store.allCandles(SERIES15),s,basis.at,{cluster:'ticker'});
  const split=median(rows.map(r=>r.time)),rounds=new Set(rows.map(r=>r.cluster)).size;
  const minuteOrder=Array.from({length:14},(_,i)=>`${14-i} min`);
  const accuracy=scoreBy(rows,r=>`${Math.round(r.tau/60)} min`,minuteOrder);
  const overall=scoreBy(rows,()=>'all minutes',['all minutes'])[0];
  const fair=priceBuckets(rows,undefined,300),fairLate=priceBuckets(rows,undefined,60,299);
  const withMid=rows.filter(r=>r.mid!==null);
  const calModel=calibration(withMid,r=>r.model),calKalshi=calibration(withMid,r=>r.mid);
  const scales=[.6,.8,1,1.25,1.5,2].map(k=>({k,brier:withMid.reduce((a,r)=>a+(modelP(r.spot,r.strike,r.sigma,r.tau,r.basis,k)-r.y)**2,0)/withMid.length}));
  const run=(name:string,pick:Picker,exit?:ExitRule,on:Row[]=rows,sp=split):Line=>{const trades=simulate(on,pick,exit);return {name,s:summarize(trades,sp),trades};};
  const q=(r:Row)=>r.quant,m=(r:Row)=>r.model;
  const fav=(r:Row)=>r.mid===null?null:r.mid>=.5?'yes' as const:'no' as const,dog=(r:Row)=>r.mid===null?null:r.mid>=.5?'no' as const:'yes' as const;
  const strategies15:Line[]=[
    run('App BUY rule (quant blend, ≥ 4¢ edge) · hold to settle',appRule(q)),
    run('App BUY rule · fixed exits (TP 25 % / SL 50 % / win chance < 25 %)',appRule(q),FIXED_EXIT),
    run('App BUY rule · current trailing exits',appRule(q),TRAIL_EXIT),
    run('Raw diffusion model, ≥ 4¢ edge · hold',appRule(m)),
    ...[.02,.08,.12,.2].map(e=>run(`Quant blend, ≥ ${Math.round(e*100)}¢ edge · hold`,appRule(q,{minEdge:e,earlyEdge:.08,maxSpread:.06,windowMax:900}))),
    ...[.08,.12,.2].map(e=>run(`Raw model, ≥ ${Math.round(e*100)}¢ edge · hold`,appRule(m,{minEdge:e,earlyEdge:.08,maxSpread:.06,windowMax:900}))),
    run('Minute 1: buy the market favorite · hold',atMinute(840,fav)),
    run('Minute 1: buy the market favorite · trailing exits',atMinute(840,fav),TRAIL_EXIT),
    run('Minute 1: buy the underdog · hold',atMinute(840,dog)),
    run('Minute 1: buy the side BTC has moved toward · hold',atMinute(840,r=>r.model>=.5?'yes':'no')),
    run('Any time: buy a 40–60¢ side · hold',priceBand(.4,.6,60,840)),
    run('Favorite at 80–90¢, 5–14 min left · hold',priceBand(.8,.9,300,840)),
    run('Favorite at 90–97¢, 5–14 min left · hold',priceBand(.9,.97,300,840)),
    run('Favorite at 80–90¢, 1–5 min left · hold',priceBand(.8,.9,60,299)),
    run('Favorite at 90–97¢, 1–5 min left · hold',priceBand(.9,.97,60,299)),
    run('Heavy favorite at 97–99.9¢ · hold',priceBand(.97,.9995,60,840)),
    run('Longshot at ≤ 10¢, ≥ 2 min left · hold',priceBand(.001,.1,120,840)),
  ];
  log(`15-minute: ${rows.length} decision rows, ${rounds} rounds`);
  // Hourly
  const mH=store.markets(SERIES_HOURLY).filter(x=>x.candles>0);let hourly:{rows:number;events:number;accuracy:Score[];fair:Bucket[];strategies:Line[];from:number;to:number}|null=null;
  if(mH.length){
    const hrows=buildRows(mH,store.allCandles(SERIES_HOURLY),s,basis.at,{cluster:'event',band:600}),hsplit=median(hrows.map(r=>r.time));
    const order=['50–59 min','40–50 min','30–40 min','20–30 min','10–20 min','5–10 min','1–5 min'];
    const bucket=(r:Row)=>{const mins=r.tau/60;return mins>=50?order[0]:mins>=40?order[1]:mins>=30?order[2]:mins>=20?order[3]:mins>=10?order[4]:mins>=5?order[5]:order[6];};
    const hrun=(name:string,pick:Picker,exit?:ExitRule)=>run(name,pick,exit,hrows,hsplit);
    hourly={rows:hrows.length,events:new Set(hrows.map(r=>r.cluster)).size,accuracy:scoreBy(hrows,bucket,order),fair:priceBuckets(hrows,undefined,60),from:Math.min(...mH.map(x=>x.close_ts)),to:Math.max(...mH.map(x=>x.close_ts)),strategies:[
      hrun('App hourly rule (quant blend, ≥ 4¢ edge, last 15 min or ≥ 8¢) · hold',appRule(q)),
      hrun('App hourly rule · current trailing exits',appRule(q),TRAIL_EXIT),
      hrun('Raw model, ≥ 4¢ edge · hold',appRule(m)),
      ...[.08,.12,.2].map(e=>hrun(`Quant blend, ≥ ${Math.round(e*100)}¢ edge, any time · hold`,appRule(q,{minEdge:e,earlyEdge:e,maxSpread:.06,windowMax:3600}))),
      hrun('Favorite strike at 80–90¢, last 15 min · hold',priceBand(.8,.9,60,900)),
      hrun('Favorite strike at 90–97¢, last 15 min · hold',priceBand(.9,.97,60,900)),
      hrun('Any strike at 40–60¢, 30+ min left · hold',priceBand(.4,.6,1800,3540)),
      hrun('Longshot strike at ≤ 10¢, ≥ 5 min left · hold',priceBand(.001,.1,300,3540)),
    ]};
    log(`Hourly: ${hrows.length} decision rows, ${hourly.events} hours`);
  }
  // Basis and plain-English conclusions
  const raw=basis.points.map(x=>x.raw),sorted=[...raw].sort((a,b)=>a-b),q25=sorted[Math.floor(sorted.length*.25)],q75=sorted[Math.floor(sorted.length*.75)];
  const all=[...strategies15,...(hourly?.strategies??[])],winners=all.filter(l=>l.s.n>=30&&l.s.ci[0]>0),robust=winners.filter(l=>l.s.early>0&&l.s.late>0),losers=all.filter(l=>l.s.n>=30&&l.s.ci[1]<0);
  const modelWins=accuracy.filter(a=>a.diffCI[1]<0).map(a=>a.label),kalshiWins=accuracy.filter(a=>a.diffCI[0]>0).map(a=>a.label);
  const app=strategies15[0].s,bestScale=scales.reduce((a,b)=>b.brier<a.brier?b:a);
  // Exits vs holding the very same entries: paired per-round difference.
  const paired=(exit:Line)=>{const hold=new Map(strategies15[0].trades.map(t=>[t.cluster,t.pnl]));const d=exit.trades.map(t=>({sum:t.pnl-(hold.get(t.cluster)??t.pnl),n:1}));return {mean:d.reduce((a,x)=>a+x.sum,0)/d.length,ci:clusterCI(d,2000,5)};};
  const fixedVsHold=paired(strategies15[1]),trailVsHold=paired(strategies15[2]);
  const final=journal?finalMinuteStudy(journal):null;if(final)log(`Final minute (live journal): ${final.rounds} rounds`);
  const finalWins=final?.accuracy.filter(a=>a.diffCI[1]<0).map(a=>a.label)??[],finalLoses=final?.accuracy.filter(a=>a.diffCI[0]>0).map(a=>a.label)??[];
  const takeaways=[
    `**Forecast accuracy (15-min).** Over ${rounds.toLocaleString()} rounds, Kalshi's price was significantly more accurate at ${kalshiWins.length?kalshiWins.join(', '):'no horizon'} left; the app's model was significantly more accurate at ${modelWins.length?modelWins.join(', '):'no horizon'}; the rest are ties. Overall Brier: model ${b4(overall.model)}, quant blend ${b4(overall.quant)}, Kalshi ${b4(overall.kalshi)} (0.25 = coin flip).`,
    `**The app's BUY rule (15-min)** made ${app.n.toLocaleString()} trades averaging ${c(app.mean)} per contract (95% range ${ci(app.ci)}): ${app.ci[0]>0?'a statistically real edge in this sample':app.ci[1]<0?'it loses money after fees':'not distinguishable from zero'}.`,
    winners.length?`**Positive with 95% confidence:** ${winners.map(w=>`${w.name} (${c(w.s.mean)})`).join('; ')}. ${robust.length===winners.length?'Each was positive in both halves of the period.':`Positive in both halves: ${robust.length?robust.map(r=>r.name).join('; '):'none'}.`} About ${all.length} strategies were tested, so roughly one could clear this bar by luck alone.`:`**No strategy tested (${all.length}) was profitable with 95% confidence after fees.**`,
    losers.length?`**Lose money with 95% confidence:** ${losers.map(w=>`${w.name} (${c(w.s.mean)})`).join('; ')}.`:'',
    `**Exit plans vs holding the same entries:** fixed take-profit/stop-loss ${c(fixedVsHold.mean)} per trade (95% range ${ci(fixedVsHold.ci)}), current trailing plan ${c(trailVsHold.mean)} (${ci(trailVsHold.ci)}). Selling early pays a second fee and sells at the bid.`,
    `**Volatility scale.** The model's Brier was best with variance ×${bestScale.k} (${scales.map(x=>`×${x.k}: ${b4(x.brier)}`).join(', ')}).`,
    final?`**Final minute (live journal, ${final.rounds} rounds so far).** The model beat Kalshi's price at ${finalWins.length?finalWins.join(', '):'no 10-s bucket'} left and lost at ${finalLoses.length?finalLoses.join(', '):'none'}; a ≥ 4¢-edge entry in the last minute averaged ${c(final.model.mean)} per contract over ${final.model.n} trades (95% range ${ci(final.model.ci)}). ${final.model.n<300?`With ${final.model.n} trades the range is still wide; a few hundred rounds are needed before it can show an edge of a few cents.`:''}`:'**Final minute:** no live journal found (data/advisor.db), so it was not studied.',
    `**Coinbase→BRTI basis** (K minus Coinbase in the minute before the open): median $${median(raw).toFixed(2)}, middle half $${q25?.toFixed(2)} to $${q75?.toFixed(2)}.`,
  ].filter(Boolean);
  const md=[
    `# Backtest: ${day(from)} to ${day(to)}`,'',
    `Generated ${new Date().toISOString().slice(0,16).replace('T',' ')} UTC by \`npm run backtest\`. Data: ${rounds.toLocaleString()} settled KXBTC15M rounds with Kalshi 1-minute YES bid/ask candles${hourly?`, ${hourly.events.toLocaleString()} KXBTCD hours (${day(hourly.from)} to ${day(hourly.to)}, strikes within $600 of spot)`:''}, Coinbase BTC-USD 1-minute candles. Every result is per 1 contract after Kalshi's taker fee on entry and on any early exit, with one trade per round (per hour for hourly) so the 95% ranges are honest.`,'',
    '## What this says','',...takeaways.map(t=>'- '+t),'',
    '## 1. Who forecasts better: the app or Kalshi? (15-min)','',
    'Brier score (lower is better; 0.25 = coin flip). One sample per round per minute; 95% range of the model − Kalshi difference resamples whole rounds.','',
    scoreTable(accuracy,'Time left'),'',
    '## 2. Is Kalshi\'s price fair? (15-min)','',
    'Every quote, both sides, bought at the ask and held to settlement. A positive number means contracts at that price won more often than the price plus fee implies.','',
    '**5–14 minutes left**','',bucketTable(fair),'','**1–5 minutes left**','',bucketTable(fairLate),'',
    '## 3. Strategies (15-min)','',strategyTable(strategies15),'',
    '## 4. Calibration and volatility (15-min)','',
    '| Forecast range | Model: avg forecast | Model: actual | Kalshi: avg price | Kalshi: actual |','|---|---:|---:|---:|---:|',
    ...calModel.map((x,i)=>{const k=calKalshi.find(y=>y.lo===x.lo);return `| ${Math.round(x.lo*100)}–${Math.round(x.hi*100)}% | ${p(x.forecast)} (${x.n}) | ${p(x.actual)} | ${k?`${p(k.forecast)} (${k.n})`:'—'} | ${k?p(k.actual):'—'} |`;}),'',
    `Model Brier by variance multiplier: ${scales.map(x=>`×${x.k} ${b4(x.brier)}`).join(' · ')}.`,'',
    '## 5. Bet size: what happens to $40','',
    'Each row replays 2,000 random 100-trade sequences drawn from the strategy\'s real backtest trades, staking a fixed share of the current balance every time.','',
    bankrollTable([strategies15[0],strategies15.find(l=>l.name.startsWith('Minute 1: buy the market favorite · hold'))!]),'',
    ...(hourly?[
      '## 6. Hourly (KXBTCD)','',`${hourly.events.toLocaleString()} hours, strikes within $600 of the spot at each minute; samples resample whole hours.`,'',
      scoreTable(hourly.accuracy,'Time left'),'','**Is the hourly price fair?** (any time with ≥ 1 min left)','',bucketTable(hourly.fair),'',strategyTable(hourly.strategies),'']:[]),
    '## 7. Final minute (live journal, second by second)','',
    ...(final?[`${final.rounds} settled rounds the app watched (${day(final.from)} to ${day(final.to)}), ${final.rows.toLocaleString()} seconds with a model price. The model sees the locked part of the settlement average here; the 1-minute history above cannot. Entries take the ask the second the forecast beats it by ≥ 4¢ after the fee (5–59 s left), one per round, held to settlement.`,'',
      scoreTable(final.accuracy,'Time left'),'',strategyTable([{name:'Final minute: model edge ≥ 4¢ · hold',s:final.model,trades:[]},{name:'Final minute: quant blend edge ≥ 4¢ · hold',s:final.quant,trades:[]}]),'']:['No live journal (data/advisor.db) found.','']),
    '## Method and limits','',
    '- Decisions happen at the end of each Kalshi 1-minute candle using its closing YES bid/ask, so the final minute (where the live model sees the locked average) is not tested here; the live journal keeps measuring it second by second.',
    '- Spot is Coinbase, corrected to BRTI by the rolling median of (K − Coinbase) over the previous 96 rounds. The live app uses a 4-venue median each second, so live forecasts differ slightly.',
    '- Volatility: EWMA (30-minute half-life) of 1-minute log returns blended 25% with the trailing 2-hour mean; no parameter was tuned on this data except the variance-multiplier table, which is reported, not used.',
    '- Fills assume the closing ask was available for 1 contract; Kalshi\'s books hold thousands of contracts per level, so size up to tens of contracts would not move this, but latency would: a manual trader acts seconds later than the candle close.',
    '- Order-book depth, feed-health and guardrail gates are not modelled. Maker (resting) orders are not simulated.',
    '- "First half / second half" splits the period at its midpoint; an edge that is real should show up in both.',
  ].join('\n');
  const summary=takeaways.map(t=>'• '+t.replace(/\*\*/g,'')).join('\n');
  const rule=(x:Summary):RuleResult=>({n:x.n,mean:x.mean,ci:x.ci,early:x.early,late:x.late});
  const lowBucket=(b:Bucket[])=>{const x=b.find(y=>y.lo===0);return x?x.pnl/x.price:null;};
  const verdict:Verdict={generated:new Date().toISOString(),from,to,rounds,hours:hourly?.events??0,buy15:rule(app),buy15Model:rule(strategies15.find(l=>l.name.startsWith('Raw diffusion model, ≥ 4¢'))!.s),buyHourly:hourly?rule(hourly.strategies[0].s):null,
    exits:{fixed:fixedVsHold,trailing:trailVsHold},kalshiBetter:{fifteen:kalshiWins.length,fifteenOf:accuracy.length,hourly:hourly?.accuracy.filter(a=>a.diffCI[0]>0).length??0,hourlyOf:hourly?.accuracy.length??0},
    profitable:winners.map(w=>w.name),strategies:all.length,ruin:[1,.25,.1,.02].map(stake=>({stake,ruined:bankroll(strategies15[0].trades,stake).ruined})),
    longshot:{fifteen:lowBucket(fair),hourly:hourly?lowBucket(hourly.fair):null},finalMinute:final?{rounds:final.rounds,trade:rule(final.model)}:null};
  const strip=(l:Line[])=>l.map(({name,s})=>({name,s}));
  return {markdown:md,summary,verdict,json:{from,to,rounds,accuracy,overall,fair,fairLate,calModel,calKalshi,scales,strategies15:strip(strategies15),hourly:hourly?{...hourly,strategies:strip(hourly.strategies)}:null,final,basis:{median:median(raw),q25,q75},verdict}};
}
export function runBacktest(store:HistoryStore,o:{out:string;log?:(m:string)=>void;journal?:string}){
  // The live journal is opened read-only, so this can run while the app is writing to it.
  const path=o.journal??process.env.ADVISOR_DB??'./data/advisor.db',journal=existsSync(path)?new Database(path,{readonly:true,fileMustExist:true}):null;
  try{const r=analyze(store,o.log,journal);mkdirSync(dirname(o.out),{recursive:true});writeFileSync(o.out,r.markdown);
    mkdirSync('output',{recursive:true});writeFileSync('output/backtest.json',JSON.stringify(r.json,null,1));
    mkdirSync(dirname(VERDICT_PATH),{recursive:true});writeFileSync(VERDICT_PATH,JSON.stringify(r.verdict,null,1));return r.summary;}
  finally{journal?.close();}
}
