import type {Leg,Quote} from './types';
import {sideProb,sideLabel} from './quotes';
import {trusted,type Reference,type Source} from './references';
export type LegStatus='won'|'lost'|'pending'|'unknown';
export interface LegView {ticker:string;side:'yes'|'no';label:string;status:LegStatus;p:number|null;bid:number|null;ask:number|null;game:string;ref:number|null;refSource:Source|null}
export interface ComboView {legs:LegView[];value:number|null;won:number;lost:number;pending:number;unknown:number;dead:boolean;oneLeft:boolean;correlated:boolean;refValue:number|null;refLegs:number}
/** The matchup part of an event ticker: KXNCAAFGAME-26OCT10UGAALA and KXNCAAFTOTAL-26OCT10UGAALA are the same game. */
export const gameKey=(eventTicker:string)=>eventTicker.split('-').slice(1).join('-');
/**
 * A combo pays only if every leg wins. Valued as the product of each leg's market-implied chance (won = 1, lost = 0).
 * That assumes the legs are independent, so legs on the same game are flagged as correlated. A leg Kalshi did not
 * return, or one with no price, leaves the value unavailable: a partial product would overstate it.
 * refValue does the same with each open leg's trusted outside reference where there is one (Kalshi's chance otherwise).
 */
export function comboView(legs:Leg[],quotes:Map<string,Quote>,refFor:(ticker:string)=>Reference|null=()=>null):ComboView{
  const views=legs.map((l):LegView=>{const q=quotes.get(l.marketTicker),game=gameKey(l.eventTicker),r=refFor(l.marketTicker),ref=trusted(r)?(l.side==='yes'?r.prob:1-r.prob):null,refSource=ref!==null?r!.source:null;
    if(!q)return {ticker:l.marketTicker,side:l.side,label:l.marketTicker,status:'unknown',p:null,bid:null,ask:null,game,ref,refSource};
    const status:LegStatus=q.result?(q.result===l.side?'won':'lost'):'pending',p=status==='won'?1:status==='lost'?0:sideProb(q,l.side);
    return {ticker:l.marketTicker,side:l.side,label:sideLabel(q,l.side),status:status==='pending'&&p===null?'unknown':status,p,bid:l.side==='yes'?q.yesBid:q.noBid,ask:l.side==='yes'?q.yesAsk:q.noAsk,game,ref:status==='pending'?ref:null,refSource:status==='pending'?refSource:null};});
  const count=(s:LegStatus)=>views.filter(v=>v.status===s).length,lost=count('lost'),unknown=count('unknown'),pending=count('pending');
  const value=lost?0:unknown?null:views.reduce((x,v)=>x*(v.p as number),1);
  const usable=views.every(v=>v.status!=='unknown'||v.ref!==null),refValue=lost?0:usable?views.reduce((x,v)=>x*(v.status==='pending'||v.status==='unknown'?(v.ref??v.p as number):v.p as number),1):null;
  const games=views.map(v=>v.game);
  return {legs:views,value,won:count('won'),lost,pending,unknown,dead:lost>0,oneLeft:!lost&&!unknown&&pending===1,correlated:new Set(games).size<games.length,refValue,refLegs:views.filter(v=>v.ref!==null).length};
}
