import type {Journal} from './journal';
import type {RealEvent} from './guardrails';
import {classifySetup,type Setup,type MyRecord,type MySetupCell,type MySetups} from '../backtest/setups';
/**
 * Your own record per chart setup, shown under the market's history in the Chart setup box: every settled KXBTC15M
 * round you traded, placed by the setup on screen at your FIRST buy (with = that buy was on BTC's side), with the
 * round's whole P&L as the app records it. The live version of the last section of scripts/pattern-study.ts.
 * Since 2026-10-17 each tick stores the setup the dashboard showed; older ticks are classified again from the
 * journaled proxy, K, time left and volatility (raw proxy, no basis correction, so a near-boundary round can differ).
 */
export interface SetupTick {proxy:number|null;k:number|null;tau:number|null;sigma:number|null;setup:Setup|null}
const empty=():MyRecord=>({n:0,up:0,pnl:0,staked:0,flips:0,flipPnl:0});
function setupAt(ticker:string,time:number,tickAt:(ticker:string,time:number)=>SetupTick|null):Setup|null{
  const t=tickAt(ticker,time);if(!t)return null;if(t.setup)return t.setup;
  if(t.proxy===null||t.k===null||t.tau===null||t.sigma===null)return null;
  return classifySetup({tau:t.tau,spot:t.proxy,k:t.k,sigma:t.sigma,spot60:tickAt(ticker,time-60000)?.proxy??null});
}
/** A round counts once Kalshi's settlement is in (its P&L is final) and the journal has its result. */
export function tallyMySetups(events:RealEvent[],results:Map<string,string>,tickAt:(ticker:string,time:number)=>SetupTick|null,now=Date.now()):MySetups{
  const rounds=new Map<string,{first:RealEvent|null;pnl:number;staked:number;flipped:boolean;settled:boolean}>();
  for(const e of [...events].sort((a,b)=>a.time-b.time)){
    if(!e.ticker.startsWith('KXBTC15M'))continue;const r=rounds.get(e.ticker)??{first:null,pnl:0,staked:0,flipped:false,settled:false};rounds.set(e.ticker,r);
    r.pnl+=e.pnl;if(e.type==='settlement'){r.settled=true;continue;}
    // Fills are canonical (account.ts): a buy's side is the side bought; a sale is action 'sell', so it is never a flip.
    if(e.action!=='buy'||(e.side!=='yes'&&e.side!=='no'))continue;r.staked+=(e.price??0)*e.contracts;
    if(!r.first)r.first=e;else if(e.side!==r.first.side)r.flipped=true;
  }
  const cells=new Map<string,MySetupCell>();let placed=0,unclassified=0;
  for(const [ticker,r] of rounds){
    if(!r.first||!r.settled||!results.has(ticker))continue;
    const setup=setupAt(ticker,r.first.time,tickAt);if(!setup?.window){unclassified++;continue;}
    const key=`${setup.window}|${setup.kind}`,cell=cells.get(key)??{window:setup.window,kind:setup.kind,with:null,against:null};cells.set(key,cell);
    const which=r.first.side===setup.side?'with':'against',x=cell[which]??=empty();
    x.n++;x.pnl+=r.pnl;x.staked+=r.staked;if(r.pnl>.005)x.up++;if(r.flipped){x.flips++;x.flipPnl+=r.pnl;}placed++;
  }
  return {updated:now,rounds:placed,unclassified,cells:[...cells.values()]};
}
/** ~100 settled rounds: two reads of the (time,ticker) index each (the tick at the first buy and 60 s before). */
export function mySetups(journal:Journal,now=Date.now()):MySetups{
  const results=new Map((journal.db.prepare("SELECT ticker,result FROM outcomes WHERE ticker LIKE 'KXBTC15M%'").all() as {ticker:string;result:string}[]).map(r=>[r.ticker,r.result]));
  const tick=journal.db.prepare("SELECT proxy,k,tau,sigma,json_extract(context,'$.setup') AS setup FROM ticks INDEXED BY sqlite_autoindex_ticks_1 WHERE time BETWEEN ? AND ? AND ticker=? ORDER BY time DESC LIMIT 1");
  return tallyMySetups(journal.realEvents(),results,(ticker,time)=>{
    const r=tick.get(time-5000,time,ticker) as (Omit<SetupTick,'setup'>&{setup:string|null})|undefined;return r?{...r,setup:r.setup?JSON.parse(r.setup):null}:null;},now);
}
