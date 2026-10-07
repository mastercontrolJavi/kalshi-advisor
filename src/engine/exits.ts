import {fee,type FeeSchedule} from './model/fees';
/**
 * Exit plan for an open position.
 *
 * Risk mode (default) gives every position a take-profit and a stop, priced after the taker fee on the way out:
 *   TAKE PROFIT  when selling now locks in ≥ takeProfitPct over cost,
 *   CUT LOSS     when selling now loses ≥ stopLossPct of cost, or the forecast win chance falls below stopWinProb
 *                (only while there is still a bid worth selling into),
 *   SELL NOW     when the market pays more than the position is worth by exitMargin/contract (expected-value exit),
 *   HOLD         otherwise, with the exact bid levels that would trigger each exit.
 * On the user's 26 real KXBTC15M entries of 2026-10-07, hold-to-settlement averaged −0.95¢/contract while
 * TP 25% / SL 50% / win chance < 25% averaged +0.70¢ (16/26 vs 13/26 wins). Small sample: treat as direction, not proof.
 * EV mode is the original pure expected-value comparison (sell only when the bid beats model value by the margin).
 */
export interface Position {ticker:string;position_fp:string;market_exposure_dollars?:string}
export type ExitAction='TAKE PROFIT'|'CUT LOSS'|'SELL NOW'|'HOLD'|'LET IT SETTLE'|'TOO LATE'|'NO MODEL';
export interface ExitConfig {exitMode:'risk'|'ev';exitMargin:number;makerMargin:number;takeProfitPct:number;stopLossPct:number;stopWinProb:number}
export interface ExitAdvice {ticker:string;side:'yes'|'no';contracts:number;avgCost:number|null;winProb:number|null;bid:number|null;holdValue:number|null;sellValue:number|null;sellFee:number|null;unrealized:number|null;unrealizedPct:number|null;action:ExitAction;limitPrice:number|null;takeProfitBid:number|null;stopBid:number|null;reason:string}
const c=(v:number)=>`${(v*100).toFixed(1)}¢`;
const pctTxt=(v:number)=>`${v>=0?'+':'−'}${Math.abs(v*100).toFixed(0)}%`;
const MIN_SELLABLE_BID=.05;
/** Net proceeds per contract from selling `contracts` into `bid` (taker fee spread across the lot). */
const netPer=(bid:number,contracts:number,s:FeeSchedule)=>bid-fee(bid,contracts,'taker',s)/contracts;
/** Lowest bid (in cents) whose net proceeds reach `target`, or null if none below $1. */
function bidFor(target:number,contracts:number,s:FeeSchedule,dir:'atLeast'|'atMost'){
  if(dir==='atLeast'){for(let b=.01;b<1;b=+(b+.01).toFixed(2))if(netPer(b,contracts,s)>=target-1e-9)return b;return null;}
  for(let b=.99;b>=MIN_SELLABLE_BID;b=+(b-.01).toFixed(2))if(netPer(b,contracts,s)<=target+1e-9)return b;return null;
}
// Hysteresis: once an exit fires it stays on screen until the position clearly leaves the zone, so a price wobbling
// around the threshold does not flash TAKE PROFIT for one second (replay of the 13:45 PT trade showed exactly that).
const LATCH_TP=.6,LATCH_SL=.7,LATCH_PROB=.1;
export function exitAdvice(position:Position,p:number|null,book:{yesBid:number|null;noBid:number|null}|null,schedule:FeeSchedule,cfg:ExitConfig,previous:ExitAction|null=null):ExitAdvice|null{
  const signed=Number(position.position_fp);if(!Number.isFinite(signed)||Math.abs(signed)<1e-9)return null;
  // Kalshi convention: positive position = YES contracts, negative = NO contracts.
  const side=signed>0?'yes':'no',contracts=Math.abs(signed),exposure=Number(position.market_exposure_dollars);
  const avgCost=Number.isFinite(exposure)&&exposure>0?exposure/contracts:null;
  const rawBid=book?(side==='yes'?book.yesBid:book.noBid):null,bid=rawBid!==null&&rawBid>0?rawBid:null;
  const sellFee=bid!==null?fee(bid,contracts,'taker',schedule):null,sellValue=bid!==null&&sellFee!==null?contracts*bid-sellFee:null;
  const unrealized=sellValue!==null&&avgCost!==null?sellValue-contracts*avgCost:null,unrealizedPct=unrealized!==null&&avgCost?unrealized/(contracts*avgCost):null;
  const takeProfitBid=avgCost!==null&&cfg.exitMode==='risk'?bidFor(avgCost*(1+cfg.takeProfitPct),contracts,schedule,'atLeast'):null;
  const stopBid=avgCost!==null&&cfg.exitMode==='risk'?bidFor(avgCost*(1-cfg.stopLossPct),contracts,schedule,'atMost'):null;
  const base={ticker:position.ticker,side,contracts,avgCost,bid,sellFee,sellValue,unrealized,unrealizedPct,takeProfitBid,stopBid} as const;
  const plan=cfg.exitMode==='risk'&&avgCost!==null?` Plan: take profit at bid ≥ ${takeProfitBid!==null?c(takeProfitBid):'—'} (${pctTxt(cfg.takeProfitPct)}) · cut loss at bid ≤ ${stopBid!==null?c(stopBid):'—'} (${pctTxt(-cfg.stopLossPct)}) or if win chance < ${(cfg.stopWinProb*100).toFixed(0)}%.`:'';
  if(p===null||!Number.isFinite(p))return {...base,winProb:null,holdValue:null,action:'NO MODEL',limitPrice:null,reason:'Model not ready for this market; no exit estimate.'+plan};
  const winProb=side==='yes'?p:1-p,holdValue=contracts*winProb;
  const limit=Math.ceil((winProb+cfg.makerMargin)*100-1e-9)/100,limitPrice=limit<1&&(bid===null||limit>bid)?limit:null;
  const out=(action:ExitAction,reason:string):ExitAdvice=>({...base,winProb,holdValue,action,limitPrice:action==='HOLD'?limitPrice:null,reason:reason+(action==='HOLD'?plan:'')});
  // Terminal states first: nothing sensible to do but wait.
  if(bid!==null&&bid>=.97)return out('LET IT SETTLE',`Bid ${c(bid)} — it pays $1.00 at settlement, and selling now only costs the fee.`);
  if(bid===null||bid<MIN_SELLABLE_BID)return out(winProb<.5?'TOO LATE':'HOLD',bid===null?`No ${side.toUpperCase()} bid to sell into; win chance ${(winProb*100).toFixed(1)}%.`:`Bid only ${c(bid)} (${sellValue!==null?`$${sellValue.toFixed(2)} total`:''}) — too little left to be worth selling; win chance ${(winProb*100).toFixed(1)}%.`);
  if(cfg.exitMode==='risk'&&avgCost!==null&&unrealizedPct!==null){
    if(unrealizedPct>=cfg.takeProfitPct||previous==='TAKE PROFIT'&&unrealizedPct>=cfg.takeProfitPct*LATCH_TP)return out('TAKE PROFIT',`Selling now locks in ${pctTxt(unrealizedPct)} ($${unrealized!.toFixed(2)}) after fees. Bank it — the price can reverse in seconds.`);
    if(unrealizedPct<=-cfg.stopLossPct||previous==='CUT LOSS'&&unrealizedPct<=-cfg.stopLossPct*LATCH_SL&&winProb<cfg.stopWinProb+LATCH_PROB)return out('CUT LOSS',`Down ${pctTxt(unrealizedPct)} ($${unrealized!.toFixed(2)}). Selling now saves $${sellValue!.toFixed(2)} instead of risking it on a ${(winProb*100).toFixed(0)}% chance.`);
    if(winProb<cfg.stopWinProb||previous==='CUT LOSS'&&winProb<cfg.stopWinProb+LATCH_PROB)return out('CUT LOSS',`Win chance has fallen to ${(winProb*100).toFixed(0)}% (stop at ${(cfg.stopWinProb*100).toFixed(0)}%). Selling now recovers $${sellValue!.toFixed(2)} (${pctTxt(unrealizedPct)}).`);
  }
  const gain=(sellValue!-holdValue)/contracts;
  if(gain>=cfg.exitMargin)return out('SELL NOW',`The market pays ${c(sellValue!/contracts)}/contract after fees, ${c(gain)} more than the forecast says it is worth (${c(winProb)}).`);
  return out('HOLD',`Win chance ${(winProb*100).toFixed(0)}%; selling now would ${unrealized!==null?`${unrealized>=0?'lock in':'lose'} $${Math.abs(unrealized).toFixed(2)}`:`pay ${c(sellValue!/contracts)}/contract`}.`);
}
