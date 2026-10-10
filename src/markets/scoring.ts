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
