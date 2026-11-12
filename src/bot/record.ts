import Database from 'better-sqlite3';
import {existsSync,readFileSync} from 'node:fs';
/**
 * The paper bot's record for the Bot page, read from its own ledger (data/bot.db, written by bot/paper.py) and its
 * status file. Read-only and opened per request by the web process: the engine never touches it.
 */
export interface BotTrade {time:number;ticker:string;side:'yes'|'no';contracts:number;price:number;fee:number;q:number|null;edge:number|null;secsLeft:number|null;result:string|null;pnl:number|null}
export interface BotRecord {
  missing:boolean;updated:number;start:number;started:number;cash:number;equity:number;peak:number;open:number;
  rounds:number;wins:number;contracts:number;pnl:number;fees:number;misses:number;
  /** Average result per contract after fees, with a 95% half-width over rounds (null under 2 rounds). */
  perContract:number|null;perContractCi:number|null;avgPrice:number|null;avgEdge:number|null;
  curve:{time:number;pnl:number}[];trades:BotTrade[];status:any|null;
}
/** Stale after 30 s: the bot rewrites the file every 10 s while it runs. */
export const BOT_STATUS_MAX_AGE_MS=30000;
export function summarize(rows:BotTrade[],account:{cash:number;start:number;started:number;peak:number},misses:number,now:number):Omit<BotRecord,'status'|'missing'>{
  const settled=rows.filter(r=>r.pnl!=null).sort((a,b)=>a.time-b.time),open=rows.filter(r=>r.pnl==null);
  const per=settled.map(r=>r.pnl!/r.contracts),n=per.length,mean=n?per.reduce((a,b)=>a+b,0)/n:null;
  const ci=n>1?1.96*Math.sqrt(per.reduce((a,b)=>a+(b-mean!)**2,0)/(n-1)/n):null;
  const contracts=settled.reduce((a,r)=>a+r.contracts,0),pnl=settled.reduce((a,r)=>a+r.pnl!,0);
  let run=0;const curve=settled.map(r=>({time:r.time,pnl:run+=r.pnl!}));
  const edges=settled.filter(r=>r.edge!=null);
  return {updated:now,start:account.start,started:account.started,cash:account.cash,equity:account.cash+open.reduce((a,r)=>a+r.contracts*r.price+r.fee,0),peak:account.peak,open:open.length,
    rounds:n,wins:settled.filter(r=>r.pnl!>0).length,contracts,pnl,fees:settled.reduce((a,r)=>a+r.fee,0),misses,perContract:mean,perContractCi:ci,
    avgPrice:contracts?settled.reduce((a,r)=>a+r.price*r.contracts,0)/contracts:null,avgEdge:edges.length?edges.reduce((a,r)=>a+r.edge!,0)/edges.length:null,
    curve,trades:[...rows].sort((a,b)=>b.time-a.time).slice(0,200)};
}
export function readBotRecord(dbPath='data/bot.db',statusPath='data/bot-status.json',now=Date.now()):BotRecord{
  let status:any=null;
  try{if(existsSync(statusPath)){status=JSON.parse(readFileSync(statusPath,'utf8'));status.running=now-Number(status.time)<=BOT_STATUS_MAX_AGE_MS;}}catch{status=null;}
  const empty={start:0,started:0,cash:0,peak:0};
  if(!existsSync(dbPath))return {missing:true,...summarize([],empty,0,now),status};
  const db=new Database(dbPath,{readonly:true,fileMustExist:true});
  try{
    const account=db.prepare('SELECT cash,start,started*1000 AS started,peak FROM account WHERE id=1').get() as typeof empty|undefined;
    if(!account)return {missing:true,...summarize([],empty,0,now),status};
    const rows=db.prepare('SELECT ts*1000 AS time,ticker,side,contracts,price,fee,q,edge,secs_left AS secsLeft,result,pnl FROM fills ORDER BY id').all() as BotTrade[];
    const misses=(db.prepare('SELECT COUNT(*) AS n FROM misses').get() as {n:number}).n;
    return {missing:false,...summarize(rows,account,misses,now),status};
  }finally{db.close();}
}
