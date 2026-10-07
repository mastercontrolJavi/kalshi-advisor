import {fee,type FeeSchedule} from './model/fees';
/**
 * Exit plan for an open position, priced on the real cost after fees (selling pays the taker fee).
 *
 * Risk mode (default):
 *   HOLD          until the gain reaches takeProfitPct (default +25%),
 *   RIDE          once armed: a trailing take-profit follows the best gain seen,
 *   TAKE PROFIT   when the gain falls back to max(trailFloor, peak × (1 − trailGiveback)),
 *   CUT LOSS      when the loss reaches stopLossPct, or the forecast win chance falls below stopWinProb
 *                 (only while a bid ≥ 5¢ is left to sell into),
 *   LET IT SETTLE above a 97¢ bid; TOO LATE when nothing worth selling is left.
 * Evidence (2026-10-07, 256 simulated entries on 49 recorded windows, market-clustered CI): hold −1.87¢/contract,
 * fixed TP25/SL50/p<25 −2.95¢, trailing TP (arm 25%, give back 50%, floor +5%) with the same stops −1.58¢.
 * Exits do not create edge; trailing keeps winners (the user re-bought after fixed take-profits, paying fees twice)
 * while still capping blow-ups. EV mode is the original comparison: sell only when the bid beats the forecast.
 */
export interface Position {ticker:string;position_fp:string;market_exposure_dollars?:string}
export type ExitAction='TAKE PROFIT'|'RIDE'|'CUT LOSS'|'SELL NOW'|'HOLD'|'LET IT SETTLE'|'TOO LATE'|'NO MODEL';
export interface ExitConfig {exitMode:'risk'|'ev';exitMargin:number;makerMargin:number;takeProfitPct:number;stopLossPct:number;stopWinProb:number;trailGiveback:number;trailFloor:number}
/** Per-position memory between evaluations: last action (hysteresis) and best gain since entry (trailing stop). */
export interface ExitMemory {action:ExitAction|null;peak:number|null}
export interface ExitAdvice {ticker:string;side:'yes'|'no';contracts:number;avgCost:number|null;winProb:number|null;bid:number|null;holdValue:number|null;sellValue:number|null;sellFee:number|null;unrealized:number|null;unrealizedPct:number|null;action:ExitAction;limitPrice:number|null;takeProfitBid:number|null;stopBid:number|null;trailBid:number|null;peakPct:number|null;reason:string}
const c=(v:number)=>`${(v*100).toFixed(1)}¢`;
const pctTxt=(v:number)=>`${v>=0?'+':'−'}${Math.abs(v*100).toFixed(0)}%`;
const MIN_SELLABLE_BID=.05,SETTLE_BID=.97,SETTLE_RELEASE=.95;
// Hysteresis for stops: once CUT LOSS fires it stays until the position clearly recovers.
const LATCH_SL=.7,LATCH_PROB=.1;
/** Net proceeds per contract from selling `contracts` into `bid` (taker fee spread across the lot). */
const netPer=(bid:number,contracts:number,s:FeeSchedule)=>bid-fee(bid,contracts,'taker',s)/contracts;
/** Lowest bid whose net proceeds reach `target` (atLeast) or highest bid at or below it (atMost), in cents. */
function bidFor(target:number,contracts:number,s:FeeSchedule,dir:'atLeast'|'atMost'){
  if(dir==='atLeast'){for(let b=.01;b<1;b=+(b+.01).toFixed(2))if(netPer(b,contracts,s)>=target-1e-9)return b;return null;}
  for(let b=.99;b>=MIN_SELLABLE_BID;b=+(b-.01).toFixed(2))if(netPer(b,contracts,s)<=target+1e-9)return b;return null;
}
export function exitAdvice(position:Position,p:number|null,book:{yesBid:number|null;noBid:number|null}|null,schedule:FeeSchedule,cfg:ExitConfig,memory:ExitMemory={action:null,peak:null}):ExitAdvice|null{
  const signed=Number(position.position_fp);if(!Number.isFinite(signed)||Math.abs(signed)<1e-9)return null;
  // Kalshi convention: positive position = YES contracts, negative = NO contracts.
  const side=signed>0?'yes':'no',contracts=Math.abs(signed),exposure=Number(position.market_exposure_dollars);
  const avgCost=Number.isFinite(exposure)&&exposure>0?exposure/contracts:null;
  const rawBid=book?(side==='yes'?book.yesBid:book.noBid):null,bid=rawBid!==null&&rawBid>0?rawBid:null;
  const sellFee=bid!==null?fee(bid,contracts,'taker',schedule):null,sellValue=bid!==null&&sellFee!==null?contracts*bid-sellFee:null;
  const unrealized=sellValue!==null&&avgCost!==null?sellValue-contracts*avgCost:null,unrealizedPct=unrealized!==null&&avgCost?unrealized/(contracts*avgCost):null;
  const risk=cfg.exitMode==='risk'&&avgCost!==null;
  const peakPct=risk?Math.max(memory.peak??-Infinity,unrealizedPct??-Infinity):null,armed=risk&&peakPct!==null&&peakPct>=cfg.takeProfitPct;
  const trailLevel=armed?Math.max(cfg.trailFloor,peakPct!*(1-cfg.trailGiveback)):null;
  const takeProfitBid=risk?bidFor(avgCost!*(1+cfg.takeProfitPct),contracts,schedule,'atLeast'):null;
  const stopBid=risk?bidFor(avgCost!*(1-cfg.stopLossPct),contracts,schedule,'atMost'):null;
  const trailBid=trailLevel!==null?bidFor(avgCost!*(1+trailLevel),contracts,schedule,'atMost'):null;
  const base={ticker:position.ticker,side,contracts,avgCost,bid,sellFee,sellValue,unrealized,unrealizedPct,takeProfitBid,stopBid,trailBid,peakPct:Number.isFinite(peakPct??NaN)?peakPct:null} as const;
  const plan=risk?(armed?` Plan: trailing stop at bid ≤ ${trailBid!==null?c(trailBid):'—'} (gain ${pctTxt(trailLevel!)}) · cut loss if win chance < ${(cfg.stopWinProb*100).toFixed(0)}%.`
    :` Plan: ride from bid ≥ ${takeProfitBid!==null?c(takeProfitBid):'—'} (${pctTxt(cfg.takeProfitPct)}) · cut loss at bid ≤ ${stopBid!==null?c(stopBid):'—'} (${pctTxt(-cfg.stopLossPct)}) or if win chance < ${(cfg.stopWinProb*100).toFixed(0)}%.`):'';
  if(p===null||!Number.isFinite(p))return {...base,winProb:null,holdValue:null,action:'NO MODEL',limitPrice:null,reason:'Model not ready for this market; no exit estimate.'+plan};
  const winProb=side==='yes'?p:1-p,holdValue=contracts*winProb;
  const limit=Math.ceil((winProb+cfg.makerMargin)*100-1e-9)/100,limitPrice=limit<1&&(bid===null||limit>bid)?limit:null;
  const out=(action:ExitAction,reason:string):ExitAdvice=>({...base,winProb,holdValue,action,limitPrice:action==='HOLD'?limitPrice:null,reason:reason+(action==='HOLD'||action==='RIDE'?plan:'')});
  // Terminal states first: nothing sensible to do but wait. Settle has hysteresis so 96.9¢/97.0¢ does not flicker.
  if(bid!==null&&(bid>=SETTLE_BID||memory.action==='LET IT SETTLE'&&bid>=SETTLE_RELEASE))return out('LET IT SETTLE',`Bid ${c(bid)} — it pays $1.00 at settlement, and selling now only costs the fee.`);
  // A bid hovering around the 5¢ floor should not flip between CUT LOSS and TOO LATE every second.
  if(bid===null||bid<MIN_SELLABLE_BID||memory.action==='TOO LATE'&&bid<.08)return out(winProb<.5?'TOO LATE':'HOLD',bid===null?`No ${side.toUpperCase()} bid to sell into; win chance ${(winProb*100).toFixed(1)}%.`:`Bid only ${c(bid)} (${sellValue!==null?`$${sellValue.toFixed(2)} total`:''}) — too little left to be worth selling; win chance ${(winProb*100).toFixed(1)}%.`);
  if(risk&&unrealizedPct!==null){
    const stopping=memory.action==='CUT LOSS';
    if(unrealizedPct<=-cfg.stopLossPct||stopping&&unrealizedPct<=-cfg.stopLossPct*LATCH_SL&&winProb<cfg.stopWinProb+LATCH_PROB)return out('CUT LOSS',`Down ${pctTxt(unrealizedPct)} ($${unrealized!.toFixed(2)}). Selling now saves $${sellValue!.toFixed(2)} instead of risking it on a ${(winProb*100).toFixed(0)}% chance.`);
    if(winProb<cfg.stopWinProb||stopping&&winProb<cfg.stopWinProb+LATCH_PROB)return out('CUT LOSS',`Win chance has fallen to ${(winProb*100).toFixed(0)}% (stop at ${(cfg.stopWinProb*100).toFixed(0)}%). Selling now recovers $${sellValue!.toFixed(2)} (${pctTxt(unrealizedPct)}).`);
    if(armed){
      // Sticky once fired: stay on TAKE PROFIT unless the gain makes a new high.
      if(unrealizedPct<=trailLevel!||memory.action==='TAKE PROFIT'&&unrealizedPct<peakPct!)return out('TAKE PROFIT',`Gain fell back to ${pctTxt(unrealizedPct)} from a peak of ${pctTxt(peakPct!)}. Selling now still locks in $${unrealized!.toFixed(2)}.`);
      return out('RIDE',`Winning ${pctTxt(unrealizedPct)} ($${unrealized!.toFixed(2)} if sold) with a ${(winProb*100).toFixed(0)}% win chance — let it run; the trailing stop protects the gain.`);
    }
    return out('HOLD',`Win chance ${(winProb*100).toFixed(0)}%; selling now would ${unrealized!>=0?'lock in':'lose'} $${Math.abs(unrealized!).toFixed(2)}.`);
  }
  const gain=(sellValue!-holdValue)/contracts;
  if(gain>=cfg.exitMargin)return out('SELL NOW',`The market pays ${c(sellValue!/contracts)}/contract after fees, ${c(gain)} more than the forecast says it is worth (${c(winProb)}).`);
  return out('HOLD',`Win chance ${(winProb*100).toFixed(0)}%; selling now would ${unrealized!==null?`${unrealized>=0?'lock in':'lose'} $${Math.abs(unrealized).toFixed(2)}`:`pay ${c(sellValue!/contracts)}/contract`}.`);
}
