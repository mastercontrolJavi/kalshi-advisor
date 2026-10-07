import {fee,type FeeSchedule} from './model/fees';
/**
 * Hold-or-sell for an open position, valued under the model.
 * Hold value = contracts × P(your side wins) (settles at $1, no exit fee).
 * Sell-now value = contracts × your side's best bid − taker fee (selling into the bid is a taker trade).
 * SELL NOW only when selling beats holding by at least exitMargin per contract; otherwise HOLD.
 * A maker exit (resting sell at fair value + margin) is suggested as a middle path; it fills only if someone buys.
 */
export interface Position {ticker:string;position_fp:string;market_exposure_dollars?:string}
export interface ExitAdvice {ticker:string;side:'yes'|'no';contracts:number;avgCost:number|null;winProb:number|null;bid:number|null;holdValue:number|null;sellValue:number|null;sellFee:number|null;unrealized:number|null;action:'SELL NOW'|'HOLD'|'NO MODEL';limitPrice:number|null;reason:string}
const c=(v:number)=>`${(v*100).toFixed(1)}¢`;
export function exitAdvice(position:Position,p:number|null,book:{yesBid:number|null;noBid:number|null}|null,schedule:FeeSchedule,exitMargin:number,makerMargin:number):ExitAdvice|null{
  const signed=Number(position.position_fp);if(!Number.isFinite(signed)||Math.abs(signed)<1e-9)return null;
  // Kalshi convention: positive position = YES contracts, negative = NO contracts.
  const side=signed>0?'yes':'no',contracts=Math.abs(signed),exposure=Number(position.market_exposure_dollars);
  const avgCost=Number.isFinite(exposure)&&exposure>0?exposure/contracts:null;
  const bid=book?(side==='yes'?book.yesBid:book.noBid):null;
  const sellFee=bid!==null&&bid>0?fee(bid,contracts,'taker',schedule):null,sellValue=bid!==null&&sellFee!==null?contracts*bid-sellFee:null;
  const unrealized=sellValue!==null&&avgCost!==null?sellValue-contracts*avgCost:null;
  const base={ticker:position.ticker,side,contracts,avgCost,bid,sellFee,sellValue,unrealized} as const;
  if(p===null||!Number.isFinite(p))return {...base,winProb:null,holdValue:null,action:'NO MODEL',limitPrice:null,reason:'Model not ready for this market; no hold/sell estimate'};
  const winProb=side==='yes'?p:1-p,holdValue=contracts*winProb;
  // Maker exit: ask for fair value plus margin, rounded up to a cent, only if it is above the current bid and below $1.
  const limit=Math.ceil((winProb+makerMargin)*100-1e-9)/100,limitPrice=limit<1&&(bid===null||limit>bid)?limit:null;
  if(sellValue===null)return {...base,winProb,holdValue,action:'HOLD',limitPrice,reason:`No ${side.toUpperCase()} bid to sell into; holding is worth ${c(winProb)}/contract under the model`};
  const gain=(sellValue-holdValue)/contracts;
  if(gain>=exitMargin)return {...base,winProb,holdValue,action:'SELL NOW',limitPrice,reason:`Bid ${c(bid!)} − fee ${c(sellFee!/contracts)} = ${c(sellValue/contracts)}/contract beats model value ${c(winProb)} by ${c(gain)}`};
  return {...base,winProb,holdValue,action:'HOLD',limitPrice,reason:gain>=0?`Selling gains only ${c(gain)}/contract over holding (< ${c(exitMargin)} margin)`:`Holding is worth ${c(winProb)}/contract vs ${c(sellValue/contracts)} if sold now (${c(-gain)} better to hold)`};
}
