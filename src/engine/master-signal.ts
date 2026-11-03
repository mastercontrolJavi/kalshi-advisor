import {fee,type FeeSchedule} from './model/fees';
import {flowAlignment,type FlowPulse,type FlowVerdict} from './flow';
import type {DangerBadges} from './execution-guard';
/**
 * The dashboard's Master Signal card (user request 2026-11-03, DECISIONS 73): one action from the live and opening calls,
 * the flow badge, the perp lead, the stale-book breaker and the danger badges. Pure and run in the browser, so it costs
 * the engine nothing. Untested: neither call beats Kalshi's price (DECISIONS 37, 56) and the flow badge has no out-of-
 * sample result yet; the card says so.
 *
 * STRONG BUY needs every one of: fresh data, no stale book, entries open, a live call (and the opening call, when there
 * is one) on the same side, FLOW CONFIRMED for that side, a perp impulse that way within the last IMPULSE_HOLD_MS, and
 * an ask to buy. Anything else is NO TRADE / WAIT with the first reason that failed. A position in the live round turns
 * the card into its exit: flow confirmed → hold; flow fighting → maker sell at the ask; otherwise whichever of hold (A)
 * and maker sell (B) has the higher expected value.
 */
/** The perp impulse is a 1-second event; it counts for this long so the card does not blink at the 4 Hz pulse. */
export const IMPULSE_HOLD_MS=5000;
export type MasterKind='buy'|'wait'|'hold'|'exit'|'paused';
export interface MasterEntry {side:'yes'|'no';maker:{price:number;fee:number};taker:{price:number;fee:number}}
export interface MasterSignal {kind:MasterKind;title:string;side:'yes'|'no'|null;reasons:string[];flow:FlowVerdict|null;entry:MasterEntry|null;exit:{price:number;fee:number;net:number|null}|null;holdEv:number|null;advice:string|null}
type Book={yesBid:number|null;yesAsk:number|null;noBid:number|null;noAsk:number|null};
type Call={direction:string;p?:number|null}|null|undefined;
export interface MasterInput {
  fresh:boolean;stale:boolean;staleReasons?:string[];entriesClosed:boolean;
  liveCall:Call;openingCall:Call;pulse:FlowPulse|null|undefined;
  /** The perp impulse's direction and how long ago it last fired (ms); null when none has. */
  impulse:{dir:1|-1;ageMs:number}|null;
  danger:DangerBadges|null|undefined;book:Book|null|undefined;schedule:FeeSchedule;
  /** The live round's exit advice (with its A/B/C comparison), when you hold a position in it. */
  position?:{side:'yes'|'no';action:string;stale?:boolean;compare?:{hold:{ev:number|null};maker:{price:number;fee:number;net:number|null}|null}|null}|null;
}
const c=(v:number)=>`${Math.round(v*100)}¢`,usd=(v:number)=>`${v<0?'−':'+'}$${Math.abs(v).toFixed(2)}`;
const sideOf=(direction:string)=>direction==='UP'?'yes' as const:direction==='DOWN'?'no' as const:null;
const ok=(x:number|null|undefined):x is number=>x!=null&&x>0&&x<1;
/** Rest one cent above the best bid when the spread allows, else join it; with no bid, one cent under the ask. */
export function makerEntryPrice(bid:number|null,ask:number):number{
  const p=ok(bid)?(ask-bid>.0101?bid+.01:bid):ask-.01;return Math.round(Math.max(.01,Math.min(p,ask-.01))*100)/100;
}
function dangerText(d:DangerBadges|null|undefined){
  return [d?.lowVol?'9 PM–12 AM PT':null,d?.peakFee?`price in the 40–60¢ fee peak (${c(d.peakFee.mid)})`:null].filter(Boolean).join(' · ');
}
export function masterSignal(i:MasterInput):MasterSignal{
  const none={side:null,flow:null,entry:null,exit:null,holdEv:null,advice:null};
  const wait=(reasons:string[],extra:Partial<MasterSignal>={}):MasterSignal=>({...none,kind:'wait',title:'NO TRADE / WAIT',reasons,...extra});
  if(!i.fresh)return {...none,kind:'paused',title:'PAUSED',reasons:['Updates from the engine are stale.']};
  const danger=dangerText(i.danger),pos=i.position;
  if(pos){
    if(pos.action==='SETTLING')return {...none,kind:'hold',side:pos.side,title:'HOLD TO $0-FEE SETTLEMENT',reasons:['The round has closed; the position settles by itself.']};
    if(pos.stale||i.stale)return {...none,kind:'paused',side:pos.side,title:'EXIT PAUSED — STALE BOOK',reasons:[`Exit prices are paused${i.staleReasons?.length?`: ${i.staleReasons.join(' · ')}`:''}. Check Kalshi before you sell.`]};
    const a=flowAlignment(pos.side==='yes'?'UP':'DOWN',i.pulse),cmp=pos.compare,ev=cmp?.hold.ev??null,m=cmp?.maker??null;
    const base={...none,side:pos.side,flow:a.verdict,holdEv:ev,advice:pos.action};
    const exit=(reasons:string[]):MasterSignal=>({...base,kind:'exit',title:`MAKER EXIT @ ${c(m!.price)}`,exit:{price:m!.price,fee:m!.fee,net:m!.net},reasons:reasons.filter(Boolean)});
    const hold=(reasons:string[]):MasterSignal=>({...base,kind:'hold',title:'HOLD TO $0-FEE SETTLEMENT',reasons:reasons.filter(Boolean)});
    if(!cmp)return hold(['No live book to price an exit.']);
    if(a.verdict==='confirmed')return hold([`Flow confirms your ${pos.side.toUpperCase()}.`,ev!==null?`A · hold EV ${usd(ev)}.`:'']);
    if(a.verdict==='fighting'&&m)return exit([`Flow is against your ${pos.side.toUpperCase()}.`,`B · rest a sell at the ask: ${m.net!==null?usd(m.net):'—'} net${ev!==null?` vs A · hold EV ${usd(ev)}`:''}.`]);
    if(m&&m.net!==null&&ev!==null&&m.net>ev)return exit([`B · maker sell ${usd(m.net)} beats A · hold EV ${usd(ev)}.`,`Flow ${a.verdict}.`]);
    return hold([ev!==null?`A · hold EV ${usd(ev)}${m?.net!=null?` ≥ B · maker sell ${usd(m.net)}`:''}.`:'No forecast to value holding.',`Flow ${a.verdict}${a.verdict==='fighting'?' (no ask to rest a sell at)':''}.`]);
  }
  if(i.stale)return wait([`Stale book — do not trade${i.staleReasons?.length?`: ${i.staleReasons.join(' · ')}`:''}.`]);
  if(i.entriesClosed)return wait(['Closed for entries (final minute).']);
  const live=i.liveCall?.direction?sideOf(i.liveCall.direction):null;
  if(!live)return wait(['No live call yet.']);
  const open=i.openingCall?.direction?sideOf(i.openingCall.direction):null;
  if(open&&open!==live)return wait([`Opening call ${i.openingCall!.direction} and live call ${i.liveCall!.direction} disagree.`],{side:live});
  const a=flowAlignment(i.liveCall!.direction,i.pulse),d=live==='yes'?1:-1,call=`Live call ${i.liveCall!.direction}${open?' (opening call agrees)':''}`;
  if(a.verdict!=='confirmed')return wait([`${call}, but ${a.label}.`],{side:live,flow:a.verdict});
  const impulse=i.impulse&&i.impulse.dir===d&&i.impulse.ageMs<=IMPULSE_HOLD_MS;
  if(!impulse)return wait([danger?`Danger zone (${danger}) without a perp impulse ${i.liveCall!.direction}.`:`${call} and flow confirmed, but no perp impulse ${i.liveCall!.direction} yet.`],{side:live,flow:a.verdict});
  const b=i.book,ask=b?(live==='yes'?b.yesAsk:b.noAsk):null,bid=b?(live==='yes'?b.yesBid:b.noBid):null;
  if(!ok(ask))return wait([`No ${live.toUpperCase()} ask to buy.`],{side:live,flow:a.verdict});
  const mp=makerEntryPrice(bid??null,ask);
  // Per contract on a 100-lot, as the danger badge does: Kalshi rounds the fee up per order, so 1 contract overstates it.
  const entry={side:live,maker:{price:mp,fee:fee(mp,100,'maker',i.schedule)/100},taker:{price:ask,fee:fee(ask,100,'taker',i.schedule)/100}};
  return {...none,kind:'buy',side:live,flow:a.verdict,entry,title:`STRONG BUY ${i.liveCall!.direction} (${live.toUpperCase()})`,
    reasons:[`${call}, flow confirmed, perp leading ${i.liveCall!.direction}.`,danger?`Inside the danger zone (${danger}); the perp impulse is the only reason this is not a wait.`:''].filter(Boolean)};
}
