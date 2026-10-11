import {takerFee} from '../engine/model/fees';
import type {Group} from './types';
import type {AccuracyTables} from './record';
/**
 * Scanner flags: reasons a market stands out. Each is paper-traded (one contract at the flagged side's ask plus the taker fee)
 * and scored at settlement, so no flag type is called an edge until its own results prove it.
 */
export type FlagType='ref-gap-yes'|'ref-gap-no'|'move-follow'|'move-fade'|'bias-yes'|'bias-no'|'sharp-yes'|'sharp-no';
export interface Flag {time:number;ticker:string;event:string;group:Group;type:FlagType;side:'yes'|'no';price:number;fee:number;edge:number;context:Record<string,unknown>}
export interface LastFlag {time:number;edge:number}
export type LastLookup=(ticker:string,type:FlagType)=>LastFlag|null;
export interface ScanMarket {ticker:string;event:string;group:Group;yesAsk:number|null;noAsk:number|null}
const H=3600000,REF_EDGE=.04,REF_COOLDOWN=6*H,REF_REGROW=.02,MOVE=.1,MOVE_DOLLARS=500,MOVE_COOLDOWN=6*H,REF_EXPLAINS=.05,BIAS_N=200,BIAS_COOLDOWN=24*H,BIAS_DUE=48*H;
const flag=(m:ScanMarket,now:number,type:FlagType,side:'yes'|'no',price:number,edge:number,context:Record<string,unknown>):Flag=>({time:now,ticker:m.ticker,event:m.event,group:m.group,type,side,price,fee:takerFee(price),edge,context});
const askOf=(m:ScanMarket,side:'yes'|'no')=>side==='yes'?m.yesAsk:m.noAsk;
/** Outside chance of the side beats that side's ask plus the taker fee by ≥ 4¢. Again only after 6 h, or if the edge grew 2¢. */
export function refGapFlags(m:ScanMarket,refYes:number,now:number,last:LastLookup):Flag[]{
  const out:Flag[]=[];
  for(const side of ['yes','no'] as const){
    const ask=askOf(m,side);if(ask===null||!(ask>0&&ask<1))continue;
    const type=side==='yes'?'ref-gap-yes':'ref-gap-no',edge=(side==='yes'?refYes:1-refYes)-ask-takerFee(ask),prev=last(m.ticker,type);
    if(edge>=REF_EDGE&&(!prev||now-prev.time>=REF_COOLDOWN||edge>=prev.edge+REF_REGROW))out.push(flag(m,now,type,side,ask,edge,{ref:refYes}));
  }
  return out;
}
/**
 * The YES mid moved ≥ 10¢ against the snapshot 55–65 min ago, on ≥ $500 traded in that hour, and an outside price did not move
 * the same way (that would explain it). Recorded both ways: follow buys the side that rose, fade the other. Not for
 * commodities & crypto, whose prices follow a spot price.
 */
export function moveFlags(m:ScanMarket,mids:{t:number;mid:number;volume:number|null}[],refMove:number|null,now:number,last:LastLookup):Flag[]{
  if(m.group==='commodities'||m.group==='combos')return [];
  const cur=[...mids].filter(x=>x.t<=now).sort((a,b)=>b.t-a.t)[0],old=mids.filter(x=>x.t>=now-65*60000&&x.t<=now-55*60000).sort((a,b)=>Math.abs(now-60*60000-a.t)-Math.abs(now-60*60000-b.t))[0];
  if(!cur||!old||cur.volume===null||old.volume===null)return [];
  const move=cur.mid-old.mid,dollars=(cur.volume-old.volume)*cur.mid;
  if(Math.abs(move)<MOVE||dollars<MOVE_DOLLARS)return [];
  if(refMove!==null&&Math.sign(refMove)===Math.sign(move)&&Math.abs(refMove)>=REF_EXPLAINS)return [];
  const prev=last(m.ticker,'move-follow');if(prev&&now-prev.time<MOVE_COOLDOWN)return [];
  const up=move>0?'yes':'no',down=up==='yes'?'no':'yes',out:Flag[]=[],ctx={move,from:old.mid,to:cur.mid,dollars};
  const a=askOf(m,up),b=askOf(m,down);
  if(a!==null&&a>0&&a<1)out.push(flag(m,now,'move-follow',up,a,Math.abs(move),ctx));
  if(b!==null&&b>0&&b<1)out.push(flag(m,now,'move-fade',down,b,Math.abs(move),ctx));
  return out;
}
/**
 * The market's price band in its category has a settled history (Record tab, 24 h before) of ≥ 200 markets in which buying one
 * side (YES at the ask, or NO at 1 − bid) returned money after fees, with a 95% range above zero. A losing YES is not enough:
 * NO pays the spread and fee too, and at 98¢ one upset in 60 wipes out its 2¢ wins. Once a day per market, and only when
 * the result is due within 48 h: that history is prices 24 h before the result, not a 2028 nomination market.
 */
export function biasFlags(m:ScanMarket&{mid:number;due:number|null},tables:AccuracyTables|null,now:number,last:LastLookup):Flag[]{
  if(!tables||m.group==='combos'||m.due===null||m.due<=now||m.due-now>BIAS_DUE)return [];
  const bands=tables[m.group]?.p24??[],b=bands.find((x,i)=>m.mid>=x.lo&&(m.mid<x.hi||i===bands.length-1&&m.mid<=x.hi));
  if(!b||b.n<BIAS_N)return [];
  if([last(m.ticker,'bias-no'),last(m.ticker,'bias-yes')].some(p=>p&&now-p.time<BIAS_COOLDOWN))return [];
  const side=b.retLow!==null&&b.retLow>0?'yes':b.noRetLow!==null&&b.noRetLow>0?'no':null;if(!side)return [];
  const ask=askOf(m,side);if(ask===null||!(ask>0&&ask<1))return [];
  return [flag(m,now,side==='yes'?'bias-yes':'bias-no',side,ask,side==='yes'?b.ret!:b.noRet!,{band:[b.lo,b.hi],n:b.n,ret:side==='yes'?b.ret:b.noRet,range:side==='yes'?[b.retLow,b.retHigh]:[b.noRetLow,b.noRetHigh]})];
}
