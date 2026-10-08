import type {RealEvent} from './guardrails';
/**
 * Trade coach: reads your real Kalshi fills (15-minute and hourly Bitcoin) and flags the patterns behind the
 * 2026-10-07 account wipe-out, the moment the fill syncs. Display and sound only; it never blocks anything.
 *   size      an order costing ≥ 10% of the account (stop ≥ 50%): the BUY rule's backtest trades staked at 25% fell
 *             below $2 in 94% of 100-trade runs, at 2% in none
 *   flip      opening the other side in the same market (stop on the second switch): fees twice, sold at the bid
 *   chase     opening a position within 3 min of a realized loss ≥ $1
 *   longshot  ≥ $1 on contracts at ≤ 5¢: in the backtest these returned −17% to −54% of the money spent
 */
export type CoachKind='size'|'flip'|'chase'|'longshot';
export interface CoachItem {id:string;kind:CoachKind;level:'caution'|'stop';time:number;ticker:string;title:string;text:string}
export interface CoachState {level:'ok'|'caution'|'stop';items:CoachItem[];counts:Record<CoachKind,number>;updated:number}
export const COACH={sizeCaution:.1,sizeStop:.5,chaseSeconds:180,chaseMinLoss:1,longshotPrice:.05,longshotMinCost:1,activeMinutes:60,maxItems:8};
const MONTHS=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const clock=(h:number,m:number)=>`${h%12||12}${m?':'+String(m).padStart(2,'0'):''} ${h<12?'AM':'PM'} ET`;
/** Human name for a market: "the 8:30 PM ET round" or "the 8 PM ET hour ($83,200 strike)". */
export function marketLabel(ticker:string){
  const q=ticker.match(/^KXBTC15M-\d{2}([A-Z]{3})\d{2}(\d{2})(\d{2})-/);if(q&&MONTHS.includes(q[1]))return `the ${clock(+q[2],+q[3])} round`;
  const h=ticker.match(/^KXBTCD-\d{2}([A-Z]{3})\d{2}(\d{2})-T([\d.]+)$/);if(h&&MONTHS.includes(h[1]))return `the ${clock(+h[2],0)} hour ($${Math.round(+h[3]).toLocaleString('en-US')} strike)`;
  return ticker;
}
const money=(x:number)=>`$${x.toFixed(2)}`;
interface Order {id:string;ticker:string;time:number;side:string;opened:number;openCost:number;price:number}
/**
 * `accountAt(t)` is the account value (cash + positions) last seen before t, or null if unknown. Items cover fills
 * for which `isToday` holds; the level reflects only the last `activeMinutes`.
 */
export function coach(events:RealEvent[],accountAt:(time:number)=>number|null,now:number,isToday:(time:number)=>boolean):CoachState{
  const orders=new Map<string,Order>();
  for(const e of events){if(e.type!=='fill')continue;const id=e.orderId??e.id,opened=Math.max(0,e.contracts-(e.closedContracts??0)),o=orders.get(id);
    if(o){o.time=Math.min(o.time,e.time);o.opened+=opened;o.openCost+=opened*(e.price??0);}
    else orders.set(id,{id,ticker:e.ticker,time:e.time,side:e.side??'?',opened,openCost:opened*(e.price??0),price:e.price??0});}
  // Realized losses: closing orders (summed across partial fills) and settlements.
  const closing=new Map<string,{time:number;pnl:number}>();
  for(const e of events)if(e.type==='fill'&&(e.closedContracts??0)>0){const id=e.orderId??e.id,c=closing.get(id);closing.set(id,{time:Math.max(e.time,c?.time??0),pnl:e.pnl+(c?.pnl??0)});}
  const losses=[...closing.values(),...events.filter(e=>e.type==='settlement').map(e=>({time:e.time,pnl:e.pnl}))].filter(l=>l.pnl<=-COACH.chaseMinLoss).sort((a,b)=>a.time-b.time);
  const sorted=[...orders.values()].sort((a,b)=>a.time-b.time),items:CoachItem[]=[],sides=new Map<string,string[]>();
  for(const o of sorted){
    if(o.opened<=1e-9)continue;
    const history=sides.get(o.ticker)??[],previous=history.at(-1);sides.set(o.ticker,[...history,o.side]);
    if(!isToday(o.time))continue;
    const add=(kind:CoachKind,level:'caution'|'stop',title:string,text:string)=>items.push({id:`${kind}:${o.id}`,kind,level,time:o.time,ticker:o.ticker,title,text});
    const value=accountAt(o.time);
    if(value!==null&&value>0){const share=o.openCost/value;
      if(share>=COACH.sizeCaution)add('size',share>=COACH.sizeStop?'stop':'caution',share>=COACH.sizeStop?'Too big for the account':'Big bet',
        `${money(o.openCost)} on one trade in ${marketLabel(o.ticker)}: ${Math.round(share*100)}% of your ${money(value)} account. At that size a couple of losses empty it; the app sizes trades at ≤ 2%.`);}
    if(previous&&previous!==o.side){const switches=[...history,o.side].reduce((n,s,i,a)=>n+(i>0&&s!==a[i-1]?1:0),0);
      add('flip',switches>=2?'stop':'caution',switches>=2?`Switched sides ${switches} times`:'Switched sides',`Went ${previous.toUpperCase()} → ${o.side.toUpperCase()} in ${marketLabel(o.ticker)}. Every switch pays the fee twice and sells at the bid.`);}
    const loss=[...losses].reverse().find(l=>l.time<o.time&&o.time-l.time<=COACH.chaseSeconds*1000);
    if(loss)add('chase','caution','Chasing a loss',`Bought again ${Math.round((o.time-loss.time)/1000)} s after losing ${money(-loss.pnl)}. Quick re-entries after a loss were behind the biggest losing rounds.`);
    if(o.price<=COACH.longshotPrice&&o.openCost>=COACH.longshotMinCost)add('longshot','caution','Lottery ticket',`${Math.round(o.opened).toLocaleString('en-US')} contracts at ${(o.price*100).toFixed(1)}¢ (${money(o.openCost)}) in ${marketLabel(o.ticker)}. In the backtest, contracts this cheap lost 17–54% of what they cost on average.`);
  }
  const active=items.filter(i=>now-i.time<=COACH.activeMinutes*60000),counts={size:0,flip:0,chase:0,longshot:0} as Record<CoachKind,number>;for(const i of items)counts[i.kind]++;
  return {level:active.some(i=>i.level==='stop')?'stop':active.length?'caution':'ok',items:items.sort((a,b)=>b.time-a.time).slice(0,COACH.maxItems),counts,updated:now};
}
/** Account value lookup from balance snapshots (time-sorted): the last one at least 1 s before t. */
export function accountLookup(snapshots:{time:number;value:number}[]){
  return (t:number)=>{let lo=0,hi=snapshots.length-1,best:number|null=null;while(lo<=hi){const m=(lo+hi)>>1;if(snapshots[m].time<=t-1000){best=snapshots[m].value;lo=m+1;}else hi=m-1;}return best;};
}
