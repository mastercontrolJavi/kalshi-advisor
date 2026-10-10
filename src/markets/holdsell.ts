import {fee,type FeeSchedule} from '../engine/model/fees';
import {holdNotice,type ExitConfig,type ExitNotice} from '../engine/exits';
import type {OpenCost} from '../engine/account';
import type {Quote} from './types';
import type {ComboView} from './combos';
import {sideBid,sideProb} from './quotes';
import {trusted,type Reference} from './references';
export const STALE_MS=30000,LEG_WON_MS=10*60000;
export interface MarketNotice {kind:'gain'|'giveback'|'loss'|'odds'|'dead'|'one-left'|'leg-won';tone:'yes'|'warn'|'no';title:string;text:string}
export interface MarketMemory {peak:number|null;trough:number|null;notice:MarketNotice['kind']|null;legsWon:number|null;legWonAt:number|null}
export type Verdict='HOLD'|'SELL BEATS HOLD'|'SETTLING'|'DEAD'|'NO PRICE';
export interface PositionView {ticker:string;side:'yes'|'no';contracts:number;avgCost:number|null;costSource:'fills'|'estimate'|null;bid:number|null;winProb:number|null;probSource:'market'|'legs'|'reference'|'settled'|null;marketProb:number|null;reference:Reference|null;sellFee:number|null;sellValue:number|null;holdValue:number|null;unrealized:number|null;unrealizedPct:number|null;peakPct:number|null;troughPct:number|null;verdict:Verdict;reason:string;notice:MarketNotice|null;stale:boolean}
export interface PositionInput {position:{ticker:string;position_fp:string;market_exposure_dollars?:string;fees_paid_dollars?:string};quote:Quote|null;combo:ComboView|null;open:OpenCost|undefined;schedule:FeeSchedule;cfg:ExitConfig;memory:MarketMemory|undefined;now:number;reference?:Reference|null}
const pct=(v:number)=>`${(v*100).toFixed(1)}%`,NAME={polymarket:'Polymarket',sportsbooks:'Sportsbooks'};
const c=(v:number)=>v<.01?`${(v*100).toFixed(2)}¢`:`${(v*100).toFixed(1)}¢`,usd=(v:number)=>`$${Math.abs(v).toFixed(2)}`;
const HOLD_KINDS:ExitNotice['kind'][]=['gain','giveback','loss','odds'];
/**
 * What an open position is worth sold now versus held. Hold value is the market-implied chance of winning (the YES mid,
 * or for a combo the product of its legs) × $1 per contract; selling pays the side's bid minus the taker fee. With market
 * odds alone, selling almost never beats holding (it costs half the spread plus the fee). SELL BEATS HOLD appears when
 * the bid exceeds what the position is worth by the margin: max(0.05¢, min(exitMargin, 20% of the win chance)), so a
 * sub-cent combo is not held to the 2¢ margin meant for ordinary contracts.
 */
export function positionView(i:PositionInput):{view:PositionView;memory:MarketMemory}|null{
  const signed=Number(i.position.position_fp);if(!Number.isFinite(signed)||Math.abs(signed)<1e-9)return null;
  const side:'yes'|'no'=signed>0?'yes':'no',contracts=Math.abs(signed),q=i.quote,prev=i.memory;
  // Cost per contract including entry fees: FIFO over the still-open fills; until those sync, exposure + fees paid.
  const exposure=Number(i.position.market_exposure_dollars),paid=Number(i.position.fees_paid_dollars);
  const fromFills=!!i.open&&i.open.side===side&&Math.abs(i.open.contracts-contracts)<.011;
  const avgCost=fromFills?i.open!.avgCost:Number.isFinite(exposure)&&exposure>0?(exposure+(Number.isFinite(paid)?paid:0))/contracts:null;
  const costSource=fromFills?'fills' as const:avgCost!==null?'estimate' as const:null;
  const stale=!q||i.now-q.updated>STALE_MS,rawBid=q?sideBid(q,side):null,bid=rawBid!==null&&rawBid>0?rawBid:null;
  const sellFee=bid!==null?fee(bid,contracts,'taker',i.schedule):null,sellValue=bid!==null&&sellFee!==null?contracts*bid-sellFee:null;
  const unrealized=sellValue!==null&&avgCost!==null?sellValue-contracts*avgCost:null,unrealizedPct=unrealized!==null&&avgCost?unrealized/(contracts*avgCost):null;
  const peak=Math.max(prev?.peak??-Infinity,unrealizedPct??-Infinity),trough=Math.min(prev?.trough??Infinity,unrealizedPct??Infinity);
  const memory:MarketMemory={peak:Number.isFinite(peak)?peak:null,trough:Number.isFinite(trough)?trough:null,notice:null,legsWon:prev?.legsWon??null,legWonAt:prev?.legWonAt??null};
  const combo=i.combo,ref=i.reference??null,sideOf=(x:number)=>side==='yes'?x:1-x;
  const marketProb=combo?(combo.value===null?null:sideOf(combo.value)):q?sideProb(q,side):null;
  const base={ticker:i.position.ticker,side,contracts,avgCost,costSource,bid,sellFee,sellValue,unrealized,unrealizedPct,peakPct:memory.peak,troughPct:memory.trough,stale,marketProb,reference:ref};
  const old=stale?' Prices are more than 30 s old; these numbers may be out of date.':'';
  const done=(view:Omit<PositionView,keyof typeof base>)=>{memory.notice=view.notice?.kind??null;return {view:{...base,...view},memory};};
  if(q?.result){const won=q.result===side;
    return done({winProb:won?1:0,probSource:'settled',holdValue:won?contracts:0,verdict:'SETTLING',notice:null,reason:`Kalshi settled it ${won?'won':'lost'}: ${won?`${usd(contracts)} pays out`:'pays $0'}${avgCost!==null?` (${won?'+':'−'}${usd(won?contracts-contracts*avgCost:contracts*avgCost)} vs your cost)`:''}. Nothing to do.`});}
  if(combo){
    // First sight is a silent baseline, so a restart does not announce legs that were already won.
    if(memory.legsWon===null)memory.legsWon=combo.won;else if(combo.won>memory.legsWon){memory.legsWon=combo.won;memory.legWonAt=i.now;}
    if(combo.dead){const lost=combo.legs.find(l=>l.status==='lost');
      return done({winProb:0,probSource:'legs',holdValue:0,verdict:'DEAD',reason:'A leg lost, so the combo settles at $0. Nothing to sell into or wait for.',notice:{kind:'dead',tone:'no',title:'Combo is dead',text:`${lost?.label??'A leg'} lost. The combo pays $0${avgCost!==null?`; ${usd(contracts*avgCost)} spent`:''}.`}});}
  }
  // A trusted outside reference (auto-matched sports, or a match you confirmed) is the win chance; Kalshi's stays alongside.
  const useRef=!combo&&trusted(ref),refSide=ref?sideOf(ref.prob):null;
  const p=useRef?refSide:combo?(combo.refLegs>0&&combo.refValue!==null?sideOf(combo.refValue):marketProb):marketProb;
  const why=!combo&&ref&&!useRef?(ref.status==='suggested'?` A ${NAME[ref.source]} match is not confirmed, so Kalshi's odds are used.`:` The ${NAME[ref.source]} price is stale, so Kalshi's odds are used.`):'';
  if(p===null)return done({winProb:null,probSource:null,holdValue:null,verdict:'NO PRICE',notice:null,reason:(combo?'A leg has no price or was not returned by Kalshi, so the combo cannot be valued.':'Kalshi shows no bid, ask or last trade for this market.')+old});
  const holdValue=contracts*p,net=sellValue!==null?sellValue/contracts:null,margin=Math.max(.0005,Math.min(i.cfg.exitMargin,.2*p));
  const verdict:Verdict=net!==null&&net-p>=margin?'SELL BEATS HOLD':'HOLD';
  const worth=combo?`Priced leg by leg${combo.refLegs?` (${combo.refLegs} of ${combo.legs.length} legs at outside odds)`:''}, it is worth ${c(p)} a contract${combo.correlated?' (rough: some legs are on the same game)':''}`
    :useRef?`${NAME[ref!.source]} ${pct(refSide!)} vs Kalshi ${marketProb!==null?pct(marketProb):'—'}: it is worth ${c(p)} a contract`:`At market odds it is worth ${c(p)} a contract`;
  const reason=net===null?`${worth}. No ${side.toUpperCase()} bid to sell into.`:verdict==='SELL BEATS HOLD'?`The bid nets ${c(net)} a contract after the fee, ${c(net-p)} more than it is worth. ${worth}.`
    :`${worth}; selling at the bid nets ${c(net)} after the fee${combo||useRef?'':', so holding is worth more unless another source disagrees with Kalshi'}.`;
  let notice:MarketNotice|null=null;
  const lastLeg=combo?.oneLeft?combo.legs.find(l=>l.status==='pending'):undefined;
  if(lastLeg)notice={kind:'one-left',tone:'yes',title:'One leg left',text:`${lastLeg.label} at ${lastLeg.p!==null?`${Math.round(lastLeg.p*100)}%`:'—'}. Pays ${usd(contracts)} if it wins.`};
  else if(combo&&memory.legWonAt!==null&&i.now-memory.legWonAt<LEG_WON_MS)notice={kind:'leg-won',tone:'yes',title:`Leg won · ${combo.won} of ${combo.legs.length}`,text:`${combo.pending} still to play; worth ${usd(holdValue)} if the legs are independent.`};
  else if(!combo&&avgCost){
    // Same heads-up rules as Bitcoin hold mode; the entry chance is the price paid.
    const maxGain=(.99-fee(.99,contracts,'taker',i.schedule)/contracts-avgCost)/avgCost,arm=maxGain>0?Math.min(i.cfg.takeProfitPct,maxGain/2):null;
    const before=prev?.notice&&HOLD_KINDS.includes(prev.notice as ExitNotice['kind'])?prev.notice as ExitNotice['kind']:null;
    notice=holdNotice(unrealized,unrealizedPct,memory.peak,arm,p,Math.min(1,avgCost),bid,sellValue,contracts,i.cfg,before,'Your call.');
  }
  return done({winProb:p,probSource:combo?'legs':useRef?'reference':'market',holdValue,verdict,reason:reason+why+old,notice});
}
