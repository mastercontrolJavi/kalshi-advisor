import Database from 'better-sqlite3';
import {existsSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
/**
 * The bot's record for the Bot page, read from its own ledger (written by bot/paper.py) and its status file: the paper
 * account (data/bot.db), or in live mode the real-money one (data/bot-live.db). The ledger is opened read-only, per
 * request, by the web process: the engine never touches it.
 *
 * The one thing written here is the real-money switch (data/bot-live.json), and only from the Bot page's button. The
 * bot reads it before every real order and can itself only switch it off (bot/live.py).
 *
 * Switching on is good for one run of the bot and for a few hours (2026-11-18): the file names the bot's boot id (from
 * its status file; a new one at every start) and an end time. The bot refuses an arming without both, so a restart
 * after a crash is never armed and nothing stays on for days (bot/live.py Switch.why_off).
 */
export const LIVE_DB='data/bot-live.db',LIVE_SWITCH='data/bot-live.json';
/** expires_at: UTC ms after which the arming no longer counts; boot_id: the run of the bot it was made for. Both null when off. */
export interface LiveSwitch {armed:boolean;time:number|null;by:string|null;note:string;expires_at:number|null;boot_id:string|null}
export const ARM_MAX_HOURS=4;
export function readSwitch(path=LIVE_SWITCH):LiveSwitch{
  try{const d=JSON.parse(readFileSync(path,'utf8'));return {armed:d.armed===true,time:typeof d.time==='number'?d.time:null,by:typeof d.by==='string'?d.by:null,note:typeof d.note==='string'?d.note:'',
    expires_at:typeof d.expires_at==='number'?d.expires_at:null,boot_id:typeof d.boot_id==='string'?d.boot_id:null};}
  catch{return {armed:false,time:null,by:null,note:'',expires_at:null,boot_id:null};}
}
/** True only while the arming is good for the bot that is running now: on, made for its boot id, and not run out. */
export function switchLive(sw:LiveSwitch|null,status:any,now=Date.now()):boolean{
  return !!sw&&sw.armed&&typeof status?.bootId==='string'&&sw.boot_id===status.bootId&&sw.expires_at!==null&&now<sw.expires_at;
}
/**
 * Switching on needs the bot running in live mode (its status file says so) and is written for that run (its bootId)
 * with an end time: the bot's own limit (status.armMaxHours), never more than ARM_MAX_HOURS. Switching off always works.
 */
export function setSwitch(armed:unknown,status:any,now=Date.now(),path=LIVE_SWITCH):LiveSwitch{
  if(typeof armed!=='boolean')throw new Error('armed must be true or false');
  if(armed&&!(status?.running&&status.mode==='live'))throw new Error('The bot is not running in real-money mode, so it cannot be switched on');
  if(armed&&!(typeof status.bootId==='string'&&status.bootId))throw new Error('The running bot is an older version without a boot id; restart it, then switch on');
  // The bot compares its record with Kalshi when it starts (up to about a minute). No arming until that result is on the page (PR 16 review).
  if(armed&&status.auditPending!==false)throw new Error('The bot is still checking its record against Kalshi after starting. Try again in a minute, once the check is shown as finished');
  const hours=Math.min(ARM_MAX_HOURS,Number.isFinite(status?.armMaxHours)&&status.armMaxHours>0?status.armMaxHours:ARM_MAX_HOURS);
  const next:LiveSwitch={armed,time:now,by:'user',note:'',expires_at:armed?now+hours*3600000:null,boot_id:armed?status.bootId:null};
  writeFileSync(path+'.tmp',JSON.stringify(next));replaceFile(path+'.tmp',path);return next;
}
/** rename over `to`, retried for a moment: on Windows it fails (EPERM/EBUSY/EACCES) while the bot has the file open to
 * read it, and "Turn off" must not fail on that. Up to ~0.5 s, only when the file is busy. */
export function replaceFile(from:string,to:string,rename:(a:string,b:string)=>void=renameSync,tries=10){
  for(let i=1;;i++){
    try{rename(from,to);return;}
    catch(e){if(i>=tries||!['EPERM','EBUSY','EACCES'].includes((e as NodeJS.ErrnoException).code??''))throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);}
  }
}
/**
 * The owner's feature switches on the Bot page (2026-11-19), data/bot-features.json. The page writes the file here and
 * the bot reads it every 10 s (bot/features.py): no restart. A switch that is not in the file leaves the bot's own
 * setting as it is. None of them switches real trading on.
 *   cheap: buy tickets under 10c · sellLosers: sell a losing or reversing position early · scalp: sell a ticket
 *   bought under 10c when its bid has jumped to 5x the price paid.
 */
export const FEATURES='data/bot-features.json';
export const FEATURE_NAMES=['cheap','sellLosers','scalp'] as const;
export type FeatureName=typeof FEATURE_NAMES[number];
export type Features=Partial<Record<FeatureName,boolean>>;
export function readFeatures(path=FEATURES):Features{
  try{const d=JSON.parse(readFileSync(path,'utf8')),out:Features={};for(const k of FEATURE_NAMES)if(typeof d?.[k]==='boolean')out[k]=d[k];return out;}
  catch{return {};}
}
/** Sets one switch and keeps the others as the file has them. */
export function setFeature(name:unknown,on:unknown,now=Date.now(),path=FEATURES):Features{
  if(typeof name!=='string'||!(FEATURE_NAMES as readonly string[]).includes(name))throw new Error('Unknown feature');
  if(typeof on!=='boolean')throw new Error('on must be true or false');
  const next:Features={...readFeatures(path),[name]:on};
  writeFileSync(path+'.tmp',JSON.stringify({...next,time:now,by:'user'}));replaceFile(path+'.tmp',path);return next;
}
/** What the page shows: what the running bot reports as in effect, with the file on top (a press shows at once; the bot follows within 10 s). */
export function featuresShown(status:any,file:Features):Features{
  const out:Features={},bot=status?.features;
  for(const k of FEATURE_NAMES){const v=typeof file[k]==='boolean'?file[k]:typeof bot?.[k]==='boolean'?bot[k]:undefined;if(v!==undefined)out[k]=v;}
  return out;
}
/** True when an Origin header names the same host as the Host header; a missing, "null" or malformed Origin is not the same origin (and must not throw). */
export function sameOrigin(origin:string|undefined,host:string|undefined):boolean{
  if(!origin||!host)return false;
  try{return new URL(origin).host===host;}catch{return false;}
}
export function readStatus(statusPath='data/bot-status.json',now=Date.now()):any{
  try{if(!existsSync(statusPath))return null;const status=JSON.parse(readFileSync(statusPath,'utf8'));status.running=now-Number(status.time)<=BOT_STATUS_MAX_AGE_MS;return status;}catch{return null;}
}
/** exitCash: what early sales of this round brought in, after fees (live mode; 0 or absent otherwise). */
export interface BotTrade {time:number;ticker:string;side:'yes'|'no';contracts:number;price:number;fee:number;q:number|null;edge:number|null;secsLeft:number|null;result:string|null;pnl:number|null;exitCash?:number}
export interface BotRecord {
  missing:boolean;updated:number;start:number;started:number;cash:number;equity:number;peak:number;open:number;
  rounds:number;wins:number;contracts:number;pnl:number;fees:number;misses:number;
  /** Average result per contract after fees, with a 95% half-width over rounds (null under 2 rounds). */
  perContract:number|null;perContractCi:number|null;avgPrice:number|null;avgEdge:number|null;
  curve:{time:number;pnl:number}[];trades:BotTrade[];status:any|null;
  /** Real-money mode: which ledger this is, and the switch as the file says right now. switchLive: that arming is
   * good for the bot running now (its boot id, not run out); the page shows "on" only then. */
  live:boolean;switch:LiveSwitch|null;switchLive:boolean;
  /** The feature switches as the page should show them (featuresShown). A name is absent when neither the bot nor the file says. */
  features:Features;
}
/** Stale after 30 s: the bot rewrites the file every 10 s while it runs. */
export const BOT_STATUS_MAX_AGE_MS=30000;
export function summarize(rows:BotTrade[],account:{cash:number;start:number;started:number;peak:number},misses:number,now:number):Omit<BotRecord,'status'|'missing'|'live'|'switch'|'switchLive'|'features'>{
  const settled=rows.filter(r=>r.pnl!=null).sort((a,b)=>a.time-b.time),open=rows.filter(r=>r.pnl==null);
  const per=settled.map(r=>r.pnl!/r.contracts),n=per.length,mean=n?per.reduce((a,b)=>a+b,0)/n:null;
  const ci=n>1?1.96*Math.sqrt(per.reduce((a,b)=>a+(b-mean!)**2,0)/(n-1)/n):null;
  const contracts=settled.reduce((a,r)=>a+r.contracts,0),pnl=settled.reduce((a,r)=>a+r.pnl!,0);
  let run=0;const curve=settled.map(r=>({time:r.time,pnl:run+=r.pnl!}));
  const edges=settled.filter(r=>r.edge!=null);
  // Open rounds at cost, less what early sales already put in the cash (the bot's PaperBroker.equity does the same).
  const held=open.reduce((a,r)=>a+Math.max(0,r.contracts*r.price+r.fee-(r.exitCash??0)),0);
  return {updated:now,start:account.start,started:account.started,cash:account.cash,equity:account.cash+held,peak:account.peak,open:open.length,
    rounds:n,wins:settled.filter(r=>r.pnl!>0).length,contracts,pnl,fees:settled.reduce((a,r)=>a+r.fee,0),misses,perContract:mean,perContractCi:ci,
    avgPrice:contracts?settled.reduce((a,r)=>a+r.price*r.contracts,0)/contracts:null,avgEdge:edges.length?edges.reduce((a,r)=>a+r.edge!,0)/edges.length:null,
    curve,trades:[...rows].sort((a,b)=>b.time-a.time).slice(0,200)};
}
export function readBotRecord(dbPath?:string,statusPath='data/bot-status.json',now=Date.now(),switchPath=LIVE_SWITCH,featuresPath=FEATURES):BotRecord{
  const status=readStatus(statusPath,now),live=status?.mode==='live',sw=live?readSwitch(switchPath):null;
  const mode={live,switch:sw,switchLive:switchLive(sw,status,now),features:featuresShown(status,readFeatures(featuresPath))};
  dbPath??=live?LIVE_DB:'data/bot.db';
  const empty={start:0,started:0,cash:0,peak:0};
  if(!existsSync(dbPath))return {missing:true,...summarize([],empty,0,now),status,...mode};
  const db=new Database(dbPath,{readonly:true,fileMustExist:true});
  try{
    const account=db.prepare('SELECT cash,start,started*1000 AS started,peak FROM account WHERE id=1').get() as typeof empty|undefined;
    if(!account)return {missing:true,...summarize([],empty,0,now),status,...mode};
    // exit_cash exists once the bot has opened this ledger since 2026-11-17 (it adds the column itself).
    const hasExit=(db.prepare('PRAGMA table_info(fills)').all() as {name:string}[]).some(c=>c.name==='exit_cash');
    const rows=db.prepare(`SELECT ts*1000 AS time,ticker,side,contracts,price,fee,q,edge,secs_left AS secsLeft,result,pnl${hasExit?',exit_cash AS exitCash':''} FROM fills ORDER BY id`).all() as BotTrade[];
    const misses=(db.prepare('SELECT COUNT(*) AS n FROM misses').get() as {n:number}).n;
    return {missing:false,...summarize(rows,account,misses,now),status,...mode};
  }finally{db.close();}
}
