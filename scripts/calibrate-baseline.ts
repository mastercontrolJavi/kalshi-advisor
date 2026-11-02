import Database from 'better-sqlite3';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {takerFee} from '../src/engine/model/fees';

/**
 * Baseline calibration from the data already collected (2026-11-01, user: "parse my collected data so we can calibrate
 * baseline BTC 15-minute volatility, average Kalshi bid-ask spreads, and historical pricing lag before finalizing signal
 * thresholds"). Read-only: every database is opened read-only with query_only on, so it is safe while the engine runs.
 * Writes output/BASELINE-CALIBRATION.json and .md. `--since <ISO>` limits the live journal (ticks, outcomes).
 *
 * Sources: data/benchmark-history.db (official BRTI, 1 s), data/history.db (settled KXBTC15M rounds, 1-min Kalshi
 * bid/ask candles, 1-min BTC), data/advisor.db (the engine's 1-s journal: proxy, model p, book, BRTI, delays; outcomes).
 */
export interface Summary {n:number;mean:number|null;sd:number|null;p10:number|null;p50:number|null;p90:number|null;p99:number|null}
export function quantile(sorted:number[],q:number){if(!sorted.length)return null;const i=(sorted.length-1)*q,lo=Math.floor(i),hi=Math.ceil(i);return sorted[lo]+(sorted[hi]-sorted[lo])*(i-lo);}
export function summary(values:number[]):Summary{
  const v=values.filter(Number.isFinite).sort((a,b)=>a-b),n=v.length;if(!n)return {n,mean:null,sd:null,p10:null,p50:null,p90:null,p99:null};
  const mean=v.reduce((s,x)=>s+x,0)/n,sd=n>1?Math.sqrt(v.reduce((s,x)=>s+(x-mean)**2,0)/(n-1)):0;
  return {n,mean,sd,p10:quantile(v,.1),p50:quantile(v,.5),p90:quantile(v,.9),p99:quantile(v,.99)};
}
/** Slope of y on x (with intercept). Null without variation. */
export function beta(x:number[],y:number[]){
  const n=x.length;if(n<2)return null;const mx=x.reduce((s,a)=>s+a,0)/n,my=y.reduce((s,a)=>s+a,0)/n;let sxy=0,sxx=0;
  for(let i=0;i<n;i++){sxy+=(x[i]-mx)*(y[i]-my);sxx+=(x[i]-mx)**2;}return sxx>0?sxy/sxx:null;
}
/** Slope of y on x through the origin: for 1-s changes, the share of a move in x that shows up in y. */
export function share(x:number[],y:number[]){let sxy=0,sxx=0;for(let i=0;i<x.length;i++){sxy+=x[i]*y[i];sxx+=x[i]**2;}return sxx>0?sxy/sxx:null;}
export function correlation(x:number[],y:number[]){
  const n=x.length;if(n<2)return null;const mx=x.reduce((s,a)=>s+a,0)/n,my=y.reduce((s,a)=>s+a,0)/n;let sxy=0,sxx=0,syy=0;
  for(let i=0;i<n;i++){sxy+=(x[i]-mx)*(y[i]-my);sxx+=(x[i]-mx)**2;syy+=(y[i]-my)**2;}return sxx>0&&syy>0?sxy/Math.sqrt(sxx*syy):null;
}
/** One second of one round from the journal, keyed by whole second. */
export interface Second {p:number;mid:number|null;proxy:number|null;brti:number|null}
export type Round=Map<number,Second>;
/**
 * How much of a model move Kalshi's mid has absorbed L seconds later: the slope (through the origin) of mid(s+L) − mid(s−1)
 * on p(s) − p(s−1).
 * 1.0 means Kalshi fully reflects the spot-implied change by then; a slope that keeps rising with L is lag.
 * `minMove` keeps only model moves at least that large (probability units), where the response is not lost in tick noise.
 */
export function absorption(rounds:Round[],lags:number[],minMove=0){
  return lags.map(L=>{const x:number[]=[],y:number[]=[];
    for(const r of rounds)for(const [s,cur] of r){const prev=r.get(s-1),later=r.get(s+L);
      if(!prev||!later||prev.mid===null||later.mid===null)continue;const dp=cur.p-prev.p;if(Math.abs(dp)<minMove)continue;x.push(dp);y.push(later.mid-prev.mid);}
    return {lag:L,n:x.length,beta:share(x,y)};});
}
/** corr(Δa(s), Δb(s+L)) over 1-s changes; a peak at L>0 means a leads b by L seconds. */
export function crossCorrelation(rounds:Round[],a:(x:Second)=>number|null,b:(x:Second)=>number|null,lags:number[]){
  return lags.map(L=>{const x:number[]=[],y:number[]=[];
    for(const r of rounds)for(const [s,cur] of r){const prev=r.get(s-1),bc=r.get(s+L),bp=r.get(s+L-1);if(!prev||!bc||!bp)continue;
      const a1=a(cur),a0=a(prev),b1=b(bc),b0=b(bp);if(a1===null||a0===null||b1===null||b0===null)continue;x.push(a1-a0);y.push(b1-b0);}
    return {lag:L,n:x.length,corr:correlation(x,y)};});
}
/**
 * When model and Kalshi disagree by at least `minGap`, who moves over the next `horizon` seconds? closedByKalshi is the
 * share of the gap Kalshi's mid moved toward the model, closedByModel the share the model moved toward Kalshi. Events in
 * one round are at least `horizon` seconds apart so they do not overlap.
 */
export function gapClosure(rounds:Round[],minGap:number,horizon:number){
  let n=0,gap=0,kalshi=0,model=0;
  for(const r of rounds){let next=-Infinity;for(const s of [...r.keys()].sort((a,b)=>a-b)){if(s<next)continue;const cur=r.get(s)!,later=r.get(s+horizon);
    if(cur.mid===null||!later||later.mid===null)continue;const g=cur.p-cur.mid;if(Math.abs(g)<minGap)continue;const sign=Math.sign(g);
    n++;gap+=Math.abs(g);kalshi+=(later.mid-cur.mid)*sign;model+=-(later.p-cur.p)*sign;next=s+horizon;}}
  return {minGap,horizon,n,meanGap:n?gap/n:null,closedByKalshi:gap>0?kalshi/gap:null,closedByModel:gap>0?model/gap:null};
}
const TAU_BUCKETS=[[600,900],[300,600],[120,300],[60,120],[0,60]] as const;
const MID_BUCKETS=[[0,.1],[.1,.3],[.3,.7],[.7,.9],[.9,1]] as const;
const bucketLabel=([a,b]:readonly [number,number],unit='')=>`${a}–${b}${unit}`;
/** Round-trip cost in cents of buying at the ask and later selling at the bid, at this mid: spread + two taker fees. */
export function roundTripCents(spread:number,mid:number){return spread*100+2*takerFee(Math.min(.99,Math.max(.01,mid)),100)};
function hourIn(timeZone:string){const f=new Intl.DateTimeFormat('en-US',{timeZone,hour:'numeric',hourCycle:'h23'}),cache=new Map<number,number>();
  return (ms:number)=>{const k=Math.floor(ms/3600000);let h=cache.get(k);if(h===undefined){h=Number(f.format(new Date(k*3600000)))%24;cache.set(k,h);}return h;};}
const open=(file:string)=>{const db=new Database(file,{readonly:true,fileMustExist:true});db.pragma('query_only = ON');db.pragma('busy_timeout = 5000');return db;};

export function calibrate({since=0,timeZone='America/Los_Angeles'}:{since?:number;timeZone?:string}={}){
  const hour=hourIn(timeZone),log=(m:string)=>console.error(`[calibrate] ${m}`);
  // 1. Volatility -------------------------------------------------------------------------------------------------
  log('official BRTI 1 s');const bench=open('data/benchmark-history.db');
  const brti=bench.prepare('SELECT time,price FROM values_1s WHERE amended=0 ORDER BY time').all() as {time:number;price:number}[];bench.close();
  const r1:number[]=[],r15:number[]=[],byTime=new Map(brti.map(x=>[x.time,x.price]));
  for(let i=1;i<brti.length;i++)if(brti[i].time-brti[i-1].time===1000)r1.push(Math.log(brti[i].price/brti[i-1].price));
  for(const x of brti)if(x.time%900000===0){const end=byTime.get(x.time+900000);if(end)r15.push(Math.log(end/x.price));}
  const sd1=summary(r1).sd,sd15=summary(r15).sd,brtiPrice=summary(brti.map(x=>x.price)).p50;
  const official={from:brti[0]?.time??null,to:brti.at(-1)?.time??null,seconds:brti.length,
    perSecondBps:sd1===null?null:sd1*1e4,per15mBps:sd15===null?null:sd15*1e4,per15mDollars:sd15===null||brtiPrice===null?null:sd15*brtiPrice,
    sqrtTimeBps:sd1===null?null:sd1*Math.sqrt(900)*1e4,varianceRatio:sd1&&sd15?sd15**2/(900*sd1**2):null,annualized:sd1===null?null:sd1*Math.sqrt(365*86400),quarters:r15.length};

  log('settled rounds, Kalshi candles, 1-min BTC');const hist=open('data/history.db');
  const markets=hist.prepare("SELECT ticker,open_ts,close_ts,strike,settle,result FROM markets WHERE series='KXBTC15M' AND strike>0 AND settle>0 ORDER BY close_ts").all() as {ticker:string;open_ts:number;close_ts:number;strike:number;settle:number;result:string}[];
  const move=markets.map(m=>m.settle-m.strike),abs=move.map(Math.abs),months=new Map<string,number[]>();
  for(const m of markets){const k=new Date(m.close_ts*1000).toISOString().slice(0,7);(months.get(k)??months.set(k,[]).get(k)!).push((m.settle/m.strike-1)*1e4);}
  const rounds={from:markets[0]?.close_ts*1000||null,to:(markets.at(-1)?.close_ts??0)*1000||null,n:markets.length,yesShare:markets.length?markets.filter(m=>m.result==='yes').length/markets.length:null,
    moveDollars:summary(move),absMoveDollars:summary(abs),moveBps:summary(markets.map(m=>(m.settle/m.strike-1)*1e4)),
    within:[5,10,25,50,100].map(d=>({dollars:d,share:abs.filter(a=>a<d).length/Math.max(1,abs.length)})),
    byMonth:[...months].map(([month,v])=>({month,n:v.length,sdBps:summary(v).sd}))};
  const spot=hist.prepare('SELECT ts,close FROM spot ORDER BY ts').all() as {ts:number;close:number}[],close=new Map(spot.map(x=>[x.ts,x.close])),hours=new Map<number,number[]>();
  // A quarter starting at b runs from the close of the minute before b to the close of its last minute (b+840).
  for(const x of spot)if(x.ts%900===0){const a=close.get(x.ts-60),b=close.get(x.ts+840);if(a&&b){const h=hour((x.ts)*1000);(hours.get(h)??hours.set(h,[]).get(h)!).push(Math.log(b/a)*1e4);}}
  const byHour=[...hours].sort((a,b)=>a[0]-b[0]).map(([h,v])=>({hour:h,n:v.length,sdBps:summary(v).sd}));
  // 2a. Spreads in Kalshi's 1-min candles (Jul → now): the minute's closing bid/ask.
  const candles=hist.prepare("SELECT c.ts,c.bid,c.ask,m.close_ts FROM candles c JOIN markets m ON m.ticker=c.ticker WHERE m.series='KXBTC15M' AND c.bid>0 AND c.ask<1 AND c.ask>c.bid").all() as {ts:number;bid:number;ask:number;close_ts:number}[];hist.close();
  const candleSpreads=TAU_BUCKETS.map(b=>{const v=candles.filter(c=>{const tau=c.close_ts-c.ts;return tau>=b[0]&&tau<b[1];});
    return {tau:bucketLabel(b,' s'),spreadCents:summary(v.map(c=>(c.ask-c.bid)*100)),oneCent:v.length?v.filter(c=>c.ask-c.bid<=.0101).length/v.length:null};});

  // 2b/3. The engine's live journal --------------------------------------------------------------------------------
  log('live journal ticks (json_extract over every row; this is the slow part)');const adv=open('data/advisor.db');
  const ticks=adv.prepare(`SELECT time,ticker,tau,p,proxy,sigma,json_extract(context,'$.book.yesBid') yesBid,json_extract(context,'$.book.yesAsk') yesAsk,
    json_extract(context,'$.book.yesDepth') yesDepth,json_extract(context,'$.book.valid') valid,json_extract(context,'$.bookDelay') bookDelay,
    json_extract(context,'$.benchmark.price') brti,json_extract(context,'$.benchmark.ageMs') brtiAge FROM ticks WHERE time>=? ORDER BY time`).all(since) as any[];
  log(`${ticks.length} ticks`);
  const live=ticks.filter(t=>t.valid===1&&Number.isFinite(t.yesBid)&&Number.isFinite(t.yesAsk)&&t.yesBid>0&&t.yesAsk<1&&t.yesAsk>t.yesBid&&(t.bookDelay??0)<=2000);
  const liveSpreads=TAU_BUCKETS.map(b=>{const v=live.filter(t=>t.tau>=b[0]&&t.tau<b[1]);
    return {tau:bucketLabel(b,' s'),spreadCents:summary(v.map(t=>(t.yesAsk-t.yesBid)*100)),oneCent:v.length?v.filter(t=>t.yesAsk-t.yesBid<=.0101).length/v.length:null,askDepth:summary(v.map(t=>t.yesDepth))};});
  const byMid=MID_BUCKETS.map(b=>{const v=live.filter(t=>{const m=(t.yesBid+t.yesAsk)/2;return m>=b[0]&&m<b[1];});const s=summary(v.map(t=>(t.yesAsk-t.yesBid)*100));
    return {mid:bucketLabel([b[0]*100,b[1]*100],'¢'),spreadCents:s,roundTripCents:s.p50===null?null:roundTripCents(s.p50/100,(b[0]+b[1])/2)};});
  const delays=ticks.map(t=>t.bookDelay).filter(Number.isFinite) as number[];
  const feed={bookDelayMs:summary(delays),overTwoSeconds:delays.length?delays.filter(d=>d>2000).length/delays.length:null};
  // Rounds keyed by second, inside the window where the 60-s average is not yet locking (60 s < tau ≤ 840 s).
  const byRound=new Map<string,Round>();
  for(const t of ticks){if(!(t.tau>60&&t.tau<=840)||!Number.isFinite(t.p))continue;
    const ok=t.valid===1&&Number.isFinite(t.yesBid)&&Number.isFinite(t.yesAsk)&&t.yesAsk>t.yesBid&&(t.bookDelay??0)<=2000,mid=ok?(t.yesBid+t.yesAsk)/2:null;
    const r=byRound.get(t.ticker)??byRound.set(t.ticker,new Map()).get(t.ticker)!;
    r.set(Math.round(t.time/1000),{p:t.p,mid:mid!==null&&mid>=.05&&mid<=.95?mid:null,proxy:Number.isFinite(t.proxy)?t.proxy:null,brti:Number.isFinite(t.brti)&&(t.brtiAge??Infinity)<=1500?t.brti:null});}
  const roundList=[...byRound.values()];
  const lag={rounds:roundList.length,
    absorptionAll:absorption(roundList,[0,1,2,3,5,10,20,30]),
    absorptionBigMoves:absorption(roundList,[0,1,2,3,5,10,20,30],.01),
    crossCorrelation:crossCorrelation(roundList,x=>x.p,x=>x.mid,[-5,-3,-2,-1,0,1,2,3,5,10]),
    gapClosure:[.03,.05,.1].flatMap(g=>[5,10,30].map(h=>gapClosure(roundList,g,h)))};
  const both=ticks.filter(t=>Number.isFinite(t.proxy)&&Number.isFinite(t.brti)&&(t.brtiAge??Infinity)<=1500);
  const proxyVsBrti={n:both.length,from:both[0]?.time??null,gapDollars:summary(both.map(t=>t.proxy-t.brti)),absGapDollars:summary(both.map(t=>Math.abs(t.proxy-t.brti))),
    crossCorrelation:crossCorrelation(roundList,x=>x.proxy,x=>x.brti,[-3,-2,-1,0,1,2,3])};
  const outcomes=adv.prepare('SELECT result,proxy_result,basis_error FROM outcomes WHERE time>=? AND basis_error IS NOT NULL').all(since) as {result:string;proxy_result:string;basis_error:number}[];
  adv.close();
  const settlement={rounds:outcomes.length,proxyMinusActualDollars:summary(outcomes.map(o=>o.basis_error)),absDollars:summary(outcomes.map(o=>Math.abs(o.basis_error))),
    wrongSide:outcomes.filter(o=>o.proxy_result&&o.proxy_result!==o.result).length};
  return {generated:new Date().toISOString(),since:since?new Date(since).toISOString():null,timeZone,
    volatility:{official,rounds,byHour,engineSigmaPerSecondBps:summary(ticks.filter(t=>t.sigma>0).map(t=>t.sigma*1e4))},
    spreads:{live:{n:live.length,from:live[0]?.time??null,byTau:liveSpreads,byMid},candles:{n:candles.length,byTau:candleSpreads}},
    lag,proxyVsBrti,settlement,feed};
}
type Report=ReturnType<typeof calibrate>;
const f=(x:number|null|undefined,d=2)=>x===null||x===undefined||!Number.isFinite(x)?'—':x.toFixed(d);
const pct=(x:number|null|undefined,d=0)=>x===null||x===undefined?'—':(x*100).toFixed(d)+'%';
const day=(ms:number|null)=>ms?new Date(ms).toISOString().slice(0,10):'—';
export function calibrationMarkdown(r:Report){
  const v=r.volatility,o=v.official,s=r.spreads,L=r.lag,b=r.proxyVsBrti,st=r.settlement;
  return [`# Baseline calibration`,'',`Generated ${r.generated}${r.since?`; live journal since ${r.since}`:''}. Reproduce with \`npm run calibrate\`. Read-only; nothing here changes advice or orders.`,'',
  `## BTC volatility`,'',`Official BRTI, 1 s, ${day(o.from)} → ${day(o.to)} (${o.seconds.toLocaleString()} s, ${o.quarters} quarter-hours):`,'',
  `| Per second | 15 min (measured) | 15 min (√t from 1 s) | Variance ratio | 15 min in $ | Annualized |`,`|---:|---:|---:|---:|---:|---:|`,
  `| ${f(o.perSecondBps,3)} bp | ${f(o.per15mBps,1)} bp | ${f(o.sqrtTimeBps,1)} bp | ${f(o.varianceRatio)} | $${f(o.per15mDollars,0)} | ${pct(o.annualized,1)} |`,'',
  `Engine's live per-second σ (median of its EWMA estimate): ${f(v.engineSigmaPerSecondBps.p50,3)} bp (p10 ${f(v.engineSigmaPerSecondBps.p10,3)}, p90 ${f(v.engineSigmaPerSecondBps.p90,3)}).`,'',
  `Settled KXBTC15M rounds ${day(v.rounds.from)} → ${day(v.rounds.to)} (${v.rounds.n.toLocaleString()}; YES ${pct(v.rounds.yesShare,1)}). Move = settlement average − target:`,'',
  `| | sd | p50 | p90 | p99 |`,`|---|---:|---:|---:|---:|`,
  `| Move, $ | ${f(v.rounds.moveDollars.sd,1)} | ${f(v.rounds.moveDollars.p50,1)} | ${f(v.rounds.moveDollars.p90,1)} | ${f(v.rounds.moveDollars.p99,1)} |`,
  `| |Move|, $ | — | ${f(v.rounds.absMoveDollars.p50,1)} | ${f(v.rounds.absMoveDollars.p90,1)} | ${f(v.rounds.absMoveDollars.p99,1)} |`,
  `| Move, bp | ${f(v.rounds.moveBps.sd,1)} | ${f(v.rounds.moveBps.p50,1)} | ${f(v.rounds.moveBps.p90,1)} | ${f(v.rounds.moveBps.p99,1)} |`,'',
  `Rounds settling within: ${v.rounds.within.map(w=>`$${w.dollars} ${pct(w.share)}`).join(' · ')}.`,'',
  `By month (sd of move, bp): ${v.rounds.byMonth.map(m=>`${m.month} ${f(m.sdBps,1)} (${m.n})`).join(' · ')}.`,'',
  `15-min BTC sd by hour (${r.timeZone}, 1-min BTC, bp): ${v.byHour.map(h=>`${h.hour}h ${f(h.sdBps,1)}`).join(' · ')}.`,'',
  `## Kalshi spreads`,'',`Live journal, fresh books only (≤ 2 s behind), ${s.live.n.toLocaleString()} seconds since ${day(s.live.from)}:`,'',
  `| Time left | Seconds | Median | Mean | p90 | At 1¢ | Median ask depth |`,`|---|---:|---:|---:|---:|---:|---:|`,
  ...s.live.byTau.map(x=>`| ${x.tau} | ${x.spreadCents.n.toLocaleString()} | ${f(x.spreadCents.p50,1)}¢ | ${f(x.spreadCents.mean,2)}¢ | ${f(x.spreadCents.p90,1)}¢ | ${pct(x.oneCent)} | ${f(x.askDepth.p50,0)} |`),'',
  `| YES mid | Seconds | Median spread | p90 | Round trip at median (spread + 2 taker fees) |`,`|---|---:|---:|---:|---:|`,
  ...s.live.byMid.map(x=>`| ${x.mid} | ${x.spreadCents.n.toLocaleString()} | ${f(x.spreadCents.p50,1)}¢ | ${f(x.spreadCents.p90,1)}¢ | ${f(x.roundTripCents,2)}¢ |`),'',
  `1-min Kalshi candles, Jul → now (${s.candles.n.toLocaleString()} minutes): ${s.candles.byTau.map(x=>`${x.tau} median ${f(x.spreadCents.p50,1)}¢ / mean ${f(x.spreadCents.mean,2)}¢`).join(' · ')}.`,'',
  `## Pricing lag`,'',`${L.rounds} rounds, 60 s < time left ≤ 840 s, fresh books, YES mid 5–95¢. Absorption = slope of Kalshi's mid change (s−1 → s+L) on the model's 1-s change; 1.00 = fully priced in.`,'',
  `| L (s) | ${L.absorptionAll.map(x=>x.lag).join(' | ')} |`,`|---|${L.absorptionAll.map(()=>'---:').join('|')}|`,
  `| All model moves | ${L.absorptionAll.map(x=>f(x.beta)).join(' | ')} |`,`| Model moves ≥ 1¢ | ${L.absorptionBigMoves.map(x=>f(x.beta)).join(' | ')} |`,'',
  `Cross-correlation corr(Δmodel(s), ΔKalshi(s+L)); a peak at L > 0 means Kalshi follows the model: ${L.crossCorrelation.map(x=>`${x.lag}: ${f(x.corr,3)}`).join(' · ')}.`,'',
  `When the model and Kalshi disagree, who moves next (non-overlapping events):`,'',`| Gap ≥ | Horizon | Events | Mean gap | Closed by Kalshi | Closed by model |`,`|---:|---:|---:|---:|---:|---:|`,
  ...L.gapClosure.map(g=>`| ${f(g.minGap*100,0)}¢ | ${g.horizon} s | ${g.n.toLocaleString()} | ${f(g.meanGap===null?null:g.meanGap*100,1)}¢ | ${pct(g.closedByKalshi)} | ${pct(g.closedByModel)} |`),'',
  `## Spot proxy vs official BRTI`,'',`${b.n.toLocaleString()} seconds with a BRTI value ≤ 1.5 s old (since ${day(b.from)}). Proxy − BRTI: median $${f(b.gapDollars.p50)}, sd $${f(b.gapDollars.sd)}, |gap| p90 $${f(b.absGapDollars.p90)}, p99 $${f(b.absGapDollars.p99)}.`,'',
  `corr(Δproxy(s), ΔBRTI(s+L)); a peak at L > 0 means the proxy leads: ${b.crossCorrelation.map(x=>`${x.lag}: ${f(x.corr,3)}`).join(' · ')}.`,'',
  `Settlement: on ${st.rounds} rounds the engine's 60-s proxy average minus Kalshi's settlement value had median $${f(st.proxyMinusActualDollars.p50)}, sd $${f(st.proxyMinusActualDollars.sd)}, |error| p90 $${f(st.absDollars.p90)}; the proxy called the wrong side ${st.wrongSide} times.`,'',
  `Kalshi book delay (journal): median ${f(r.feed.bookDelayMs.p50,0)} ms, p99 ${f(r.feed.bookDelayMs.p99,0)} ms, > 2 s ${pct(r.feed.overTwoSeconds,2)} of seconds.`,''].join('\n');
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url))){
  const i=process.argv.indexOf('--since'),since=i>0?Date.parse(process.argv[i+1]):0;
  if(i>0&&!Number.isFinite(since))throw new Error('--since needs an ISO time');
  const report=calibrate({since,timeZone:process.env.SESSION_TIMEZONE||'America/Los_Angeles'}),output=resolve('output/BASELINE-CALIBRATION.json');
  mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');writeFileSync(resolve('output/BASELINE-CALIBRATION.md'),calibrationMarkdown(report));
  console.log(calibrationMarkdown(report));
}
