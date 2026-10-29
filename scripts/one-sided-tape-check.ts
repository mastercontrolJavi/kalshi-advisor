import Database from 'better-sqlite3';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {REST} from '../src/engine/feeds/kalshi';
import {EXECUTION_PROTOCOL} from '../src/engine/quant/execution-study';
import {pinnedRuns,tapeCheck,type CapturedBook,type PublicTrade,type TapeCheck} from '../src/engine/quant/one-sided';

/**
 * Checks the journal's pinned final-minute books against Kalshi's public trade tape (docs/ONE-SIDED-BOOK-STUDY-2026-10-28.md).
 * Read-only: the journal is opened read-only and Kalshi is asked only for public trades, unsigned, on the fixed REST host,
 * with redirects refused and about 3 requests a second. Writes output/ONE-SIDED-TAPE-CHECK.json and .md.
 */
type Round={ticker:string;closeLocal:number;closeExchange:number};
export function roundsFromJournal(db:Database.Database,asOf:number):Round[]{
  const rows=db.prepare('SELECT ticker,context FROM research_forecasts WHERE version=? AND time<=? ORDER BY time').all(EXECUTION_PROTOCOL.forecastVersion,asOf) as {ticker:string;context:string}[],rounds=new Map<string,Round>();
  for(const row of rows){if(rounds.has(row.ticker))continue;try{const c=JSON.parse(row.context);if(Number.isFinite(c.closeTime)&&Number.isFinite(c.clockOffset)&&c.closeTime+c.clockOffset<=asOf)rounds.set(row.ticker,{ticker:row.ticker,closeLocal:c.closeTime,closeExchange:c.closeTime+c.clockOffset});}catch{}}
  return [...rounds.values()];
}
export function booksFromJournal(db:Database.Database,round:Round,seconds=75):CapturedBook[]{
  const rows=db.prepare('SELECT time,context FROM research_books WHERE ticker=? AND time>=? AND time<=? ORDER BY time').all(round.ticker,round.closeLocal-seconds*1000,round.closeLocal) as {time:number;context:string}[];
  return rows.flatMap(row=>{try{const c=JSON.parse(row.context);return Array.isArray(c.yes)&&Array.isArray(c.no)?[{time:row.time,valid:c.valid===true,delayMs:Number.isFinite(c.delayMs)?c.delayMs:null,clockOffset:Number(c.clockOffset),yes:c.yes,no:c.no}]:[];}catch{return [];}});
}
export function parseTrade(t:any):PublicTrade|null{
  const time=Date.parse(t?.created_time),yesPrice=Number(t?.yes_price_dollars),takerSide=t?.taker_outcome_side??t?.taker_side,count=Number(t?.count_fp);
  return Number.isFinite(time)&&Number.isFinite(yesPrice)&&(takerSide==='yes'||takerSide==='no')?{time,yesPrice,takerSide,count}:null;
}
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function publicTrades(ticker:string,from:number,to:number,maxPages=40):Promise<{trades:PublicTrade[];truncated:boolean;error:string|null}>{
  const trades:PublicTrade[]=[];let cursor='';
  for(let page=0;page<maxPages;page++){
    const url=`${REST}/markets/trades?ticker=${encodeURIComponent(ticker)}&min_ts=${Math.floor(from/1000)}&max_ts=${Math.ceil(to/1000)}&limit=1000${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`;
    let body:any=null;
    for(let attempt=0;attempt<3&&body===null;attempt++){
      const response=await fetch(url,{redirect:'error',headers:{accept:'application/json'}});
      if(response.status===429){await sleep(2000);continue;}
      if(!response.ok)return {trades,truncated:false,error:`HTTP ${response.status}`};
      body=await response.json();
    }
    await sleep(350);
    if(body===null)return {trades,truncated:false,error:'rate limited'};
    for(const t of body.trades??[]){const parsed=parseTrade(t);if(parsed)trades.push(parsed);}
    if(!body.cursor||!(body.trades??[]).length)return {trades,truncated:false,error:null};
    cursor=body.cursor;
  }
  return {trades,truncated:true,error:null};
}
export function tapeMarkdown(report:{asOf:string;marginMs:number;totals:TapeCheck;markets:{ticker:string;check:TapeCheck;error:string|null;truncated:boolean}[]}){
  const t=report.totals,flagged=report.markets.filter(m=>m.check.favouriteTaker>0),failed=report.markets.filter(m=>m.error||m.truncated);
  return [`# One-sided book tape check — ${report.asOf.slice(0,10)}`,'',
    `Pinned runs in the journal (favourite bid at the ceiling, no longshot ladder), shrunk by ${report.marginMs} ms at each end, compared with Kalshi's public trades in the same exchange-time windows.`,'',
    `- Rounds: ${report.markets.length} (${failed.length} with a fetch error or truncated tape).`,
    `- Pinned runs: ${t.runs}, ${t.pinnedSeconds.toFixed(0)} s.`,
    `- Trades inside pinned runs: ${t.trades}. Longshot taker (the only trade a pinned book allows): ${t.longshotTaker}${t.trades?` (${(t.longshotTaker/t.trades*100).toFixed(2)}%)`:''}, of which ${t.belowCeiling} swept below the ceiling.`,
    `- Favourite taker (needs a resting longshot bid, so contradicts the pinned capture): ${t.favouriteTaker} trades, ${t.favouriteContracts} contracts, in ${flagged.length} rounds.`,'',
    ...(flagged.length?['| Round | Favourite-taker trades | Contracts | Trades in pinned runs |','|---|---:|---:|---:|',...flagged.map(m=>`| ${m.ticker} | ${m.check.favouriteTaker} | ${m.check.favouriteContracts} | ${m.check.trades} |`),'']:[]),
    'Limits: the tape shows only liquidity that traded, so a quote cancelled before anyone hit it cannot be detected. Windows rely on the recorded clock offset and transport delay.',''].join('\n');
}

if(process.argv[1]&&resolve(process.argv[1])===resolve(fileURLToPath(import.meta.url))){
  const args=process.argv.slice(2),arg=(name:string)=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
  const dbPath=resolve(arg('--db')??process.env.ADVISOR_DB??'data/advisor.db'),through=arg('--through'),asOf=through===undefined?Date.now():/^\d+$/.test(through)?Number(through):Date.parse(through);
  const marginMs=Number(arg('--margin')??500),last=arg('--markets')===undefined?Infinity:Number(arg('--markets'));
  if(!Number.isFinite(asOf)||!Number.isFinite(marginMs)||marginMs<0)throw new Error('Invalid --through or --margin');
  const db=new Database(dbPath,{readonly:true,fileMustExist:true});
  try{
    db.pragma('query_only = ON');db.pragma('busy_timeout = 5000');
    const rounds=roundsFromJournal(db,asOf).slice(-last),markets:{ticker:string;check:TapeCheck;error:string|null;truncated:boolean}[]=[];
    for(const [i,round] of rounds.entries()){
      const runs=pinnedRuns(booksFromJournal(db,round),marginMs);
      const tape=runs.length?await publicTrades(round.ticker,round.closeExchange-80000,round.closeExchange+5000):{trades:[],truncated:false,error:null};
      markets.push({ticker:round.ticker,check:tapeCheck(runs,tape.trades),error:tape.error,truncated:tape.truncated});
      if((i+1)%20===0)console.error(`${i+1}/${rounds.length} rounds`);
    }
    const totals=markets.reduce((s,m)=>({runs:s.runs+m.check.runs,pinnedSeconds:s.pinnedSeconds+m.check.pinnedSeconds,trades:s.trades+m.check.trades,longshotTaker:s.longshotTaker+m.check.longshotTaker,belowCeiling:s.belowCeiling+m.check.belowCeiling,favouriteTaker:s.favouriteTaker+m.check.favouriteTaker,favouriteContracts:Math.round((s.favouriteContracts+m.check.favouriteContracts)*100)/100}),{runs:0,pinnedSeconds:0,trades:0,longshotTaker:0,belowCeiling:0,favouriteTaker:0,favouriteContracts:0});
    const report={asOf:new Date(asOf).toISOString(),marginMs,totals,markets},output=resolve('output/ONE-SIDED-TAPE-CHECK.json');
    mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');writeFileSync(resolve('output/ONE-SIDED-TAPE-CHECK.md'),tapeMarkdown(report));
    console.log(JSON.stringify({asOf:report.asOf,rounds:markets.length,...totals,output},null,2));
  }finally{db.close();}
}
