import type {Leg,Quote} from './types';
import {seriesOf} from './categories';
const price=(v:unknown)=>{const n=Number(v);return v===undefined||v===null||v===''||!Number.isFinite(n)?null:n;};
/** Kalshi shows an empty book as bid 0 / ask 1; neither is a price you can trade at. */
const bidOf=(v:unknown)=>{const n=price(v);return n!==null&&n>0?n:null;};
const askOf=(v:unknown)=>{const n=price(v);return n!==null&&n>0&&n<1?n:null;};
const time=(v:unknown)=>{const t=typeof v==='string'?Date.parse(v):NaN;return Number.isFinite(t)?t:null;};
export function parseMarket(m:any,now:number):Quote{
  const legs:Leg[]|null=Array.isArray(m.mve_selected_legs)&&m.mve_selected_legs.length?m.mve_selected_legs.map((l:any)=>({eventTicker:String(l.event_ticker),marketTicker:String(l.market_ticker),side:l.side==='no'?'no':'yes'})):null;
  return {ticker:String(m.ticker),eventTicker:String(m.event_ticker??''),seriesTicker:seriesOf(String(m.ticker)),title:String(m.title??''),yesLabel:String(m.yes_sub_title??m.title??''),status:String(m.status??''),
    result:m.result==='yes'||m.result==='no'?m.result:null,yesBid:bidOf(m.yes_bid_dollars),yesAsk:askOf(m.yes_ask_dollars),noBid:bidOf(m.no_bid_dollars),noAsk:askOf(m.no_ask_dollars),
    last:bidOf(m.last_price_dollars),volume24h:price(m.volume_24h_fp),closeTime:time(m.close_time),expectedExpiration:time(m.expected_expiration_time),legs,updated:now};
}
export const sideBid=(q:Quote,side:'yes'|'no')=>side==='yes'?q.yesBid:q.noBid;
/** Market-implied chance that `side` wins: the two-sided YES mid, else the last trade; null when Kalshi has neither. */
export function sideProb(q:Quote,side:'yes'|'no'):number|null{
  const yes=q.yesBid!==null&&q.yesAsk!==null&&q.yesAsk>=q.yesBid?(q.yesBid+q.yesAsk)/2:q.last;
  return yes===null?null:side==='yes'?yes:1-yes;
}
export const sideLabel=(q:Quote,side:'yes'|'no')=>side==='yes'?q.yesLabel:`Not ${q.yesLabel}`;
