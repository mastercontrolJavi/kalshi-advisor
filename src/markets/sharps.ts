import {takerFee} from '../engine/model/fees';
import type {SharpWallet} from './sources/falcon';
import type {PmPosition,PmTrade} from './sources/pmdata';
import type {Flag,LastLookup} from './flags';
import type {Group} from './types';
import type {LeanRow} from './journal';
/**
 * Sharp money: what Polymarket's best traders hold, and whether copying them on Kalshi pays.
 *
 * Who counts as sharp: Falcon's Heisenberg leaderboard (15-day window, bots / wash traders / lucky streaks filtered) for
 * everything, and Polymarket's own crypto profit leaders for the 15-minute Bitcoin rounds. A 15-day ranking still rewards
 * luck, and a trader's size can move the price after they bought, so nothing here is called an edge until its own paper
 * record proves it (≥ 100 settled, 95% range above zero, both halves positive), like every scanner flag.
 */
export interface SharpHolder {address:string;tier:string;rank:number;value:number;avgPrice:number}
export interface SharpBet {cond:string;title:string;eventSlug:string;outcome:string;holders:SharpHolder[];wallets:number;value:number;avgEntry:number|null;curPrice:number|null;endDate:string|null;against:{wallets:number;value:number;outcomes:string[]}}
export const SHARP={minValue:100,minPrice:.02,maxPrice:.98} as const;
/** Live positions worth ≥ $100 at a price between 2¢ and 98¢ (still undecided), grouped by market and outcome, most wallets first. */
export function aggregate(positions:PmPosition[],wallets:Map<string,SharpWallet>):SharpBet[]{
  const live=positions.filter(p=>wallets.has(p.wallet)&&!p.redeemable&&p.value>=SHARP.minValue&&p.curPrice>SHARP.minPrice&&p.curPrice<SHARP.maxPrice);
  const groups=new Map<string,PmPosition[]>();for(const p of live){const k=p.cond+'\u0000'+p.outcome;(groups.get(k)??groups.set(k,[]).get(k)!).push(p);}
  const byCond=new Map<string,PmPosition[]>();for(const p of live)(byCond.get(p.cond)??byCond.set(p.cond,[]).get(p.cond)!).push(p);
  const out:SharpBet[]=[];
  for(const ps of groups.values()){
    const first=ps[0],holders=new Map<string,SharpHolder>();
    // Polymarket returns one position per wallet and outcome token; a repeat (none seen) just adds its value.
    for(const p of ps){const w=wallets.get(p.wallet)!,h=holders.get(p.wallet);if(h)h.value+=p.value;else holders.set(p.wallet,{address:p.wallet,tier:w.tier,rank:w.rank,value:p.value,avgPrice:p.avgPrice});}
    const size=ps.reduce((s,p)=>s+p.size,0),others=(byCond.get(first.cond)??[]).filter(p=>p.outcome!==first.outcome);
    out.push({cond:first.cond,title:first.title,eventSlug:first.eventSlug,outcome:first.outcome,holders:[...holders.values()].sort((a,b)=>b.value-a.value),wallets:holders.size,value:ps.reduce((s,p)=>s+p.value,0),
      avgEntry:size>0?ps.reduce((s,p)=>s+p.avgPrice*p.size,0)/size:null,curPrice:first.curPrice,endDate:first.endDate,
      against:{wallets:new Set(others.map(p=>p.wallet)).size,value:others.reduce((s,p)=>s+p.value,0),outcomes:[...new Set(others.map(p=>p.outcome))]}});
  }
  return out.sort((a,b)=>b.wallets-a.wallets||b.value-a.value);
}
/** The Kalshi side that pays when this Polymarket outcome wins (two-outcome markets: Kalshi YES is `yesOutcome`). */
export const kalshiSide=(yesOutcome:string,outcome:string):'yes'|'no'=>yesOutcome.toLowerCase()===outcome.toLowerCase()?'yes':'no';
export interface SharpLink {ticker:string;event:string;group:Group;side:'yes'|'no';ask:number|null;status:string}
/**
 * Copy flag: ≥ 3 sharp wallets on one outcome with ≥ $3,000 at stake, sharp money against it ≤ 25% of that, a Kalshi market
 * tied to it automatically or by your ✓, and Kalshi's ask on that side no more than 3¢ above the sharps' average entry (you
 * get roughly their price, not the price after they moved it), between 5¢ and 92¢. Once per market per 12 h, or sooner
 * if more wallets join. Paper-scored at settlement like every flag.
 */
export const SHARP_FLAG={minWallets:3,minValue:3000,maxAgainst:.25,chase:.03,minAsk:.05,maxAsk:.92,cooldown:12*3600000} as const;
export function sharpFlags(bet:SharpBet,link:SharpLink,now:number,last:LastLookup):Flag[]{
  if(link.status==='suggested'||link.ask===null||bet.avgEntry===null)return [];
  if(bet.wallets<SHARP_FLAG.minWallets||bet.value<SHARP_FLAG.minValue||bet.against.value>SHARP_FLAG.maxAgainst*bet.value)return [];
  const ask=link.ask;if(ask<SHARP_FLAG.minAsk||ask>SHARP_FLAG.maxAsk||ask>bet.avgEntry+SHARP_FLAG.chase+1e-9)return [];
  const type=link.side==='yes'?'sharp-yes':'sharp-no',prev=last(link.ticker,type);
  if(prev&&now-prev.time<SHARP_FLAG.cooldown&&bet.wallets<=prev.edge)return [];
  const fee=takerFee(ask);
  // edge holds the wallet count, so a later sweep can tell when more sharps joined; the price gap is in the context.
  return [{time:now,ticker:link.ticker,event:link.event,group:link.group,type,side:link.side,price:ask,fee,edge:bet.wallets,
    context:{cond:bet.cond,title:bet.title,outcome:bet.outcome,wallets:bet.wallets,value:bet.value,avgEntry:bet.avgEntry,pmPrice:bet.curPrice,against:bet.against,gap:bet.curPrice!==null?bet.curPrice-ask-fee:null}}];
}
/** Net dollars on Up in a 15-minute round's trades up to `until` (s): buying Up or selling Down counts +, the reverse −. */
export function lean(trades:PmTrade[],sharp:Set<string>,until:number){
  let sharpNet=0,allNet=0,sharpTrades=0;const ws=new Set<string>();
  for(const t of trades){if(t.time>until)continue;const up=t.outcome.toLowerCase()==='up'?1:-1,v=(t.side==='BUY'?1:-1)*up*t.size*t.price;allNet+=v;if(sharp.has(t.wallet)){sharpNet+=v;sharpTrades++;ws.add(t.wallet);}}
  return {sharpNet,allNet,sharpWallets:ws.size,sharpTrades};
}
const ET=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'2-digit',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
/** Kalshi's KXBTC15M ticker for the round starting at `startSec`: close time in New York, e.g. KXBTC15M-26OCT101715-15. */
export function kalshiBtcTicker(startSec:number){
  const p=Object.fromEntries(ET.formatToParts((startSec+900)*1000).map(x=>[x.type,x.value]));
  return `KXBTC15M-${p.year}${p.month.toUpperCase()}${p.day}${p.hour}${p.minute}-${p.minute}`;
}
export const LEAN_HORIZONS=[600,300,120,60] as const;
export const LEAN_MIN=100;
export interface LeanStats {horizon:number;calls:number;hits:number;rate:number|null;low:number|null;high:number|null;paper:{n:number;mean:number|null;low:number|null;high:number|null;first:number|null;second:number|null};proven:boolean}
const wilson=(k:number,n:number)=>{if(!n)return [null,null] as const;const z=1.96,p=k/n,d=1+z*z/n,c=(p+z*z/(2*n))/d,h=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;return [c-h,c+h] as const;};
/**
 * Per horizon, rounds where sharp wallets had ≥ $100 net on one side: how often that side won, and the paper P&L of buying it
 * on Kalshi at the ask then (plus the taker fee). Hit rate alone is not an edge, Kalshi's price already knows the trend; the
 * paper P&L is the test.
 */
export function leanStats(rows:LeanRow[]):LeanStats[]{
  return LEAN_HORIZONS.map(h=>{
    const xs=rows.filter(r=>r.horizon===h&&(r.result==='yes'||r.result==='no')&&Math.abs(r.sharpNet)>=LEAN_MIN).sort((a,b)=>a.round-b.round);
    const hits=xs.filter(r=>(r.sharpNet>0)===(r.result==='yes')).length,[low,high]=wilson(hits,xs.length);
    const pnl=xs.map(r=>{const side=r.sharpNet>0?'yes':'no',ask=side==='yes'?r.yesAsk:r.yesBid!==null?1-r.yesBid:null;return ask===null||ask<=0||ask>=1?null:(r.result===side?1:0)-ask-takerFee(ask);}).filter((x):x is number=>x!==null);
    const m=(a:number[])=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null,mean=m(pnl),sd=pnl.length>1?Math.sqrt(pnl.reduce((s,x)=>s+(x-mean!)**2,0)/(pnl.length-1)):null;
    const half=pnl.length>>1,first=m(pnl.slice(0,half)),second=m(pnl.slice(half)),lo=mean!==null&&sd!==null?mean-1.96*sd/Math.sqrt(pnl.length):null,hi=mean!==null&&sd!==null?mean+1.96*sd/Math.sqrt(pnl.length):null;
    return {horizon:h,calls:xs.length,hits,rate:xs.length?hits/xs.length:null,low,high,paper:{n:pnl.length,mean,low:lo,high:hi,first,second},proven:pnl.length>=100&&lo!==null&&lo>0&&(first??0)>0&&(second??0)>0};
  });
}
