import {clusterCI} from '../backtest/sim';
import type {FlagRow} from './journal';
/** Results of one flag type (in one category, or 'all'): paper P&L per contract after fees, settled flags only. */
export interface FlagStats {type:string;group:string;n:number;markets:number;mean:number|null;low:number|null;high:number|null;first:number|null;second:number|null;proven:boolean}
const PROVEN_N=100;
const mean=(xs:number[])=>xs.length?xs.reduce((s,x)=>s+x,0)/xs.length:null;
/**
 * Per flag type × category (and × all): mean P&L with a 95% bootstrap range over events (both sides of a game, or one strike
 * ladder, move together), and the first and second half by flag time. Proven = ≥ 100 settled, range above zero, both halves
 * positive: the same bar as the Bitcoin final-minute study.
 */
export function flagStats(rows:FlagRow[]):FlagStats[]{
  const settled=rows.filter((r):r is FlagRow&{pnl:number}=>r.pnl!==null),keys=new Map<string,(FlagRow&{pnl:number})[]>();
  for(const r of settled)for(const g of [r.group,'all']){const k=r.type+'|'+g;(keys.get(k)??keys.set(k,[]).get(k)!).push(r);}
  return [...keys].map(([k,xs])=>{
    const [type,group]=k.split('|'),byTime=[...xs].sort((a,b)=>a.time-b.time),half=Math.floor(byTime.length/2);
    const ev=new Map<string,{sum:number;n:number}>();for(const r of xs){const c=ev.get(r.event)??{sum:0,n:0};c.sum+=r.pnl;c.n++;ev.set(r.event,c);}
    const [l,u]=clusterCI([...ev.values()]),m=mean(xs.map(r=>r.pnl)),first=mean(byTime.slice(0,half).map(r=>r.pnl)),second=mean(byTime.slice(half).map(r=>r.pnl));
    const low=Number.isFinite(l)?l:null,high=Number.isFinite(u)?u:null;
    return {type,group,n:xs.length,markets:new Set(xs.map(r=>r.ticker)).size,mean:m,low,high,first,second,proven:xs.length>=PROVEN_N&&low!==null&&low>0&&(first??0)>0&&(second??0)>0};
  });
}
export const evidence=(stats:FlagStats[],type:string,group:string)=>stats.find(s=>s.type===type&&s.group===group)??null;

/** Copying the sharps, one result per game: by category and overall (Top traders page, 2026-10-22). */
export interface CopyRecord {group:string;n:number;wins:number;implied:number;mean:number;low:number;high:number;first:number|null;second:number|null;proven:boolean;since:number|null}
/**
 * The first settled copy flag (sharp-yes or sharp-no) on each event, so one game counts once however many times it was
 * flagged. Wins against the wins the Kalshi prices paid implied; mean P&L per contract after the fee with a 95% range
 * (games are independent); halves by time. Proven = the same bar as every other rule.
 */
export function copyRecord(rows:FlagRow[]):CopyRecord[]{
  const first=new Map<string,FlagRow&{pnl:number}>();
  for(const r of [...rows].sort((a,b)=>a.time-b.time))if(r.type.startsWith('sharp')&&r.pnl!==null&&!first.has(r.event))first.set(r.event,r as FlagRow&{pnl:number});
  const groups=new Map<string,(FlagRow&{pnl:number})[]>();for(const r of first.values())for(const g of [r.group,'all'])(groups.get(g)??groups.set(g,[]).get(g)!).push(r);
  return [...groups].map(([group,xs]):CopyRecord=>{
    const n=xs.length,m=mean(xs.map(r=>r.pnl))!,sd=n>1?Math.sqrt(xs.reduce((s,r)=>s+(r.pnl-m)**2,0)/(n-1)):0,h=1.96*sd/Math.sqrt(Math.max(1,n)),half=n>>1;
    const f=mean(xs.slice(0,half).map(r=>r.pnl)),sec=mean(xs.slice(half).map(r=>r.pnl));
    return {group,n,wins:xs.filter(r=>r.pnl>0).length,implied:xs.reduce((s,r)=>s+r.price,0),mean:m,low:m-h,high:m+h,first:f,second:sec,proven:n>=PROVEN_N&&m-h>0&&(f??0)>0&&(sec??0)>0,since:xs[0]?.time??null};
  }).sort((a,b)=>b.n-a.n);
}
