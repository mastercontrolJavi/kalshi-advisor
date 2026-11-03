import {fee,type FeeSchedule} from './model/fees';
/**
 * Exit plan for an open position, priced on the real cost after fees (selling pays the taker fee).
 *
 * Hold mode (default since the 2026-10-07 backtest): keep the position to settlement. On 2,483 replayed BUY entries
 * (8,529 rounds) selling early cost 1.3¢/trade with fixed take-profit/stop-loss (CI −2.5..−0.1) and 0.9¢ with the
 * trailing plan versus holding the very same entries: a second fee, sold at the bid. Terminal states still show.
 *
 * Risk mode:
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
export type ExitAction='TAKE PROFIT'|'RIDE'|'LET IT RIDE'|'CUT LOSS'|'SELL'|'SELL NOW'|'HOLD'|'LET IT SETTLE'|'TOO LATE'|'NO MODEL'|'SETTLING'|'STALE BOOK';
/** A position whose round has already closed: Kalshi's official result if known, else the app's closing-average estimate. */
export interface ClosedRound {result:'yes'|'no'|null;estimate:'yes'|'no'|null}
export interface ExitConfig {exitMode:'advise'|'hold'|'risk'|'ev';exitMargin:number;makerMargin:number;takeProfitPct:number;stopLossPct:number;stopWinProb:number;trailGiveback:number;trailFloor:number}
/** Per-position memory between evaluations: last action (hysteresis) and best gain since entry (trailing stop). */
/** Hold-mode heads-up: the plan stays HOLD, but big moves are called out with what selling would lock in. */
export interface ExitNotice {kind:'gain'|'giveback'|'loss'|'odds';tone:'yes'|'warn'|'no';title:string;text:string}
export interface ExitMemory {action:ExitAction|null;peak:number|null;trough?:number|null;entryProb?:number|null;notice?:ExitNotice['kind']|null}
export interface ExitAdvice {urgent?:boolean;sellAtBid?:number|null;troughPct?:number|null;entryWinProb?:number|null;notice?:ExitNotice|null;ticker:string;side:'yes'|'no';contracts:number;avgCost:number|null;costSource?:'fills'|'estimate'|'exposure';winProb:number|null;bid:number|null;holdValue:number|null;sellValue:number|null;sellFee:number|null;unrealized:number|null;unrealizedPct:number|null;action:ExitAction;limitPrice:number|null;takeProfitBid:number|null;stopBid:number|null;trailBid:number|null;peakPct:number|null;reason:string}
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
/**
 * Cost per contract including the entry fee. Kalshi's market_exposure is the contract cost without fees (verified
 * 2026-10-07: 14.1 YES at 55¢ showed exposure $7.755 while $0.24 was paid in fees), so P&L if sold was overstated by
 * the entry fee (3.4% of cost on average). Prefer the FIFO cost of the still-open fills with their actual fees; when
 * those do not match the position yet (a sync in flight), add the taker fee the exposure implies.
 */
export function entryCost(position:Position,open:{side:string;contracts:number;avgCost:number}|undefined,schedule:FeeSchedule):{avgCost:number;source:'fills'|'estimate'}|null{
  const signed=Number(position.position_fp),contracts=Math.abs(signed),exposure=Number(position.market_exposure_dollars),side=signed>0?'yes':'no';
  if(!(contracts>0))return null;
  if(open&&open.side===side&&Math.abs(open.contracts-contracts)<.011)return {avgCost:open.avgCost,source:'fills'};
  if(!Number.isFinite(exposure)||exposure<=0)return null;const price=exposure/contracts;return {avgCost:price+fee(Math.min(.99,price),contracts,'taker',schedule)/contracts,source:'estimate'};
}
/**
 * Hold-mode heads-up, most serious first: a loss beyond stopLossPct, giving back trailGiveback of a gain that reached the
 * arm level, the win chance falling 25 points since entry, a gain past the arm level. Each stays on until its condition
 * clearly clears (80% of the threshold), so a 1¢ wobble does not re-fire it.
 */
export function holdNotice(unrealized:number|null,u:number|null,peak:number|null,arm:number|null,winProb:number,entryProb:number,bid:number|null,sellValue:number|null,contracts:number,cfg:ExitConfig,prev:ExitNotice['kind']|null,note='In the backtest, selling early did worse than holding on average; your call.'):ExitNotice|null{
  if(u===null||unrealized===null||bid===null)return null;
  const was=(k:ExitNotice['kind'])=>prev===k,usd=(x:number)=>`$${Math.abs(x).toFixed(2)}`,wp=`${(winProb*100).toFixed(0)}%`,ep=`${(entryProb*100).toFixed(0)}%`;
  const sell=`Selling now (bid ${c(bid)}) would ${unrealized>=0?'lock in':'lose'} ${usd(unrealized)}`,backtest=note;
  if(u<=-cfg.stopLossPct||was('loss')&&u<=-cfg.stopLossPct*.8)return {kind:'loss',tone:'no',title:`Down ${pctTxt(u)}`,text:`${sell} and keep ${sellValue!==null?usd(sellValue):'what is left'}; holding risks it on a ${wp} win chance (${ep} when you bought). ${backtest}`};
  if(peak!==null&&arm!==null&&peak>=arm){const level=Math.max(cfg.trailFloor,peak*(1-cfg.trailGiveback));
    if(u<=level||was('giveback')&&u<=peak*(1-cfg.trailGiveback*.8))return {kind:'giveback',tone:'warn',title:'Gave back part of the gain',text:`Peak ${pctTxt(peak)} → now ${pctTxt(u)}. ${sell}. ${backtest}`};}
  if(entryProb-winProb>=.25||was('odds')&&entryProb-winProb>=.2)return {kind:'odds',tone:'no',title:'Win chance dropped',text:`From ${ep} when you bought to ${wp} now. ${sell}. ${backtest}`};
  if(arm!==null&&(u>=arm||was('gain')&&u>=arm*.8))return {kind:'gain',tone:'yes',title:`Up ${pctTxt(u)}`,text:`${sell}; holding pays $${contracts.toFixed(2)} if it wins (${wp} chance). ${backtest}`};
  return null;
}
/**
 * Fee-aware exit comparison (2026-11-02, DECISIONS 70): what each way out pays, net of what the position cost you
 * (avgCost includes the entry fee). Of your 704 lots, 521 were sold early as a taker, paying a second fee each time
 * ($352.67 of exit fees); this puts that fee next to the alternatives instead of inside one number.
 *   hold  — no fee: pays $1 a contract if it wins, $0 if not; EV at the forecast win chance.
 *   maker — a resting sell at the held side's ask, at the maker fee (0 on this series): fills only if a buyer lifts it.
 *   taker — sell into the held side's bid now, paying the taker fee.
 */
export interface ExitComparison {
  cost:number|null;
  hold:{payout:number;win:number|null;lose:number|null;ev:number|null};
  maker:{price:number;proceeds:number;fee:number;net:number|null}|null;
  taker:{price:number;proceeds:number;fee:number;feePerContract:number;net:number|null;vsHold:number|null}|null;
}
export function exitComparison(side:'yes'|'no',contracts:number,avgCost:number|null,book:{yesBid:number|null;yesAsk:number|null;noBid:number|null;noAsk:number|null}|null,winProb:number|null,schedule:FeeSchedule):ExitComparison{
  const cost=avgCost!==null&&Number.isFinite(avgCost)?contracts*avgCost:null,ok=(x:number|null|undefined):x is number=>x!=null&&x>0&&x<1;
  const bid=book?(side==='yes'?book.yesBid:book.noBid):null,ask=book?(side==='yes'?book.yesAsk:book.noAsk):null;
  const ev=winProb!==null&&Number.isFinite(winProb)?contracts*winProb:null;
  const hold={payout:contracts,win:cost===null?null:contracts-cost,lose:cost===null?null:-cost,ev:ev===null||cost===null?null:ev-cost};
  const sale=(price:number,kind:'maker'|'taker')=>{const f=fee(price,contracts,kind,schedule),proceeds=contracts*price-f;return {price,proceeds,fee:f,net:cost===null?null:proceeds-cost};};
  const taker=ok(bid)?sale(bid,'taker'):null;
  return {cost,hold,maker:ok(ask)?sale(ask,'maker'):null,taker:taker?{...taker,feePerContract:taker.fee/contracts,vsHold:ev===null?null:taker.proceeds-ev}:null};
}
/**
 * The live round's exit advice while the stale-book breaker is on (DECISIONS 72): no call, and none of the numbers read
 * off the stale bid or BRTI (P&L, sell value, win chance, stops, heads-ups). Best / worst so far stay at what they were
 * before the breaker tripped. A closed round's SETTLING does not depend on the book, so it is kept.
 */
export function pausedExit(e:ExitAdvice,memory:ExitMemory):ExitAdvice{
  if(e.action==='SETTLING')return e;
  return {...e,action:'STALE BOOK',urgent:false,notice:null,sellAtBid:null,winProb:null,bid:null,holdValue:null,sellValue:null,sellFee:null,unrealized:null,unrealizedPct:null,limitPrice:null,takeProfitBid:null,stopBid:null,trailBid:null,
    peakPct:memory.peak,troughPct:memory.trough??null,reason:'Exit advice paused: the Kalshi book or BRTI is stale, so the bid, P&L and call would be out of date.'};
}
export function exitAdvice(position:Position,p:number|null,book:{yesBid:number|null;noBid:number|null}|null,schedule:FeeSchedule,cfg:ExitConfig,memory:ExitMemory={action:null,peak:null},closed:ClosedRound|null=null,cost:{avgCost:number;source:'fills'|'estimate'}|null=null,tau:number|null=null):ExitAdvice|null{
  const signed=Number(position.position_fp);if(!Number.isFinite(signed)||Math.abs(signed)<1e-9)return null;
  // Kalshi convention: positive position = YES contracts, negative = NO contracts.
  const side=signed>0?'yes':'no',contracts=Math.abs(signed),exposure=Number(position.market_exposure_dollars);
  const avgCost=cost?cost.avgCost:Number.isFinite(exposure)&&exposure>0?exposure/contracts:null,costSource=cost?cost.source:avgCost!==null?'exposure' as const:undefined;
  const rawBid=book?(side==='yes'?book.yesBid:book.noBid):null,bid=rawBid!==null&&rawBid>0?rawBid:null;
  const sellFee=bid!==null?fee(bid,contracts,'taker',schedule):null,sellValue=bid!==null&&sellFee!==null?contracts*bid-sellFee:null;
  const unrealized=sellValue!==null&&avgCost!==null?sellValue-contracts*avgCost:null,unrealizedPct=unrealized!==null&&avgCost?unrealized/(contracts*avgCost):null;
  const risk=cfg.exitMode==='risk'&&avgCost!==null;
  // The arm level must be reachable: a contract bought at 80¢ can gain at most ~24% before fees, so a fixed +25% would
  // never arm. Arm at the smaller of takeProfitPct and half the maximum possible gain (selling at 99¢).
  const maxGain=avgCost?(netPer(.99,contracts,schedule)-avgCost)/avgCost:null,armPct=maxGain!==null&&maxGain>0?Math.min(cfg.takeProfitPct,maxGain/2):null;
  // Best and worst gain since entry are tracked in every mode (hold mode reports them; risk mode trails from the peak).
  const peakPct=Math.max(memory.peak??-Infinity,unrealizedPct??-Infinity),troughPct=Math.min(memory.trough??Infinity,unrealizedPct??Infinity),armed=risk&&armPct!==null&&peakPct>=armPct;
  const trailLevel=armed?Math.max(cfg.trailFloor,peakPct!*(1-cfg.trailGiveback)):null;
  const takeProfitBid=risk&&armPct!==null?bidFor(avgCost!*(1+armPct),contracts,schedule,'atLeast'):null;
  const stopBid=risk?bidFor(avgCost!*(1-cfg.stopLossPct),contracts,schedule,'atMost'):null;
  const trailBid=trailLevel!==null?bidFor(avgCost!*(1+trailLevel),contracts,schedule,'atMost'):null;
  const base={ticker:position.ticker,side,contracts,avgCost,costSource,bid,sellFee,sellValue,unrealized,unrealizedPct,takeProfitBid,stopBid,trailBid,peakPct:Number.isFinite(peakPct)?peakPct:null,troughPct:Number.isFinite(troughPct)?troughPct:null} as const;
  const plan=risk?(armed?` Plan: trailing stop at bid ≤ ${trailBid!==null?c(trailBid):'—'} (gain ${pctTxt(trailLevel!)}) · cut loss if win chance < ${(cfg.stopWinProb*100).toFixed(0)}%.`
    :` Plan: ride from bid ≥ ${takeProfitBid!==null?c(takeProfitBid):'—'} (${armPct!==null?pctTxt(armPct):'—'}) · cut loss at bid ≤ ${stopBid!==null?c(stopBid):'—'} (${pctTxt(-cfg.stopLossPct)}) or if win chance < ${(cfg.stopWinProb*100).toFixed(0)}%.`):'';
  if(closed){
    const outcome=closed.result??closed.estimate,won=outcome===side,cost=avgCost!==null?contracts*avgCost:null;
    const reason=outcome===null?'Round closed — waiting for Kalshi to settle it.':`Round closed — ${closed.result?'Kalshi settled it':'the closing average says it'} ${won?'won':'lost'}: ${won?`$${contracts.toFixed(2)} pays out`:'pays $0'}${cost!==null?` (${won?'+':'−'}$${Math.abs(won?contracts-cost:cost).toFixed(2)} vs your cost)`:''}. Payout usually lands within a few minutes; nothing to do.`;
    return {...base,winProb:outcome===null?null:won?1:0,holdValue:outcome===null?null:won?contracts:0,action:'SETTLING',limitPrice:null,reason};
  }
  if(p===null||!Number.isFinite(p))return {...base,winProb:null,holdValue:null,action:'NO MODEL',limitPrice:null,reason:'Model not ready for this market; no exit estimate.'+plan};
  const winProb=side==='yes'?p:1-p,holdValue=contracts*winProb,entryWinProb=memory.entryProb??winProb;
  const limit=Math.ceil((winProb+cfg.makerMargin)*100-1e-9)/100,limitPrice=limit<1&&(bid===null||limit>bid)?limit:null;
  const out=(action:ExitAction,reason:string,notice:ExitNotice|null=null,extra:Partial<ExitAdvice>={}):ExitAdvice=>({...base,winProb,holdValue,entryWinProb,notice,action,limitPrice:action==='HOLD'?limitPrice:null,reason:reason+((action==='HOLD'||action==='RIDE')&&cfg.exitMode!=='advise'?plan:''),...extra});
  if(cfg.exitMode==='advise')return advise(out,{winProb,entryWinProb,bid,sellValue,unrealized,unrealizedPct,contracts,side,tau,prev:memory.action,schedule,peakPct:Number.isFinite(peakPct)?peakPct:null,armPct,cfg,notice:memory.notice??null});
  // Hold mode shows one steady word all the way to settlement: the settle / nothing-left-to-sell cases only change the
  // explanation. Showing LET IT SETTLE and TOO LATE here flipped the big label 6+ times a round on 1¢ moves.
  if(cfg.exitMode==='hold'){
    const held=`Holding to settlement · win chance ${(winProb*100).toFixed(0)}%${Math.abs(winProb-entryWinProb)>=.05?` (${(entryWinProb*100).toFixed(0)}% when you bought)`:''}.`;
    const notice=holdNotice(unrealized,unrealizedPct,Number.isFinite(peakPct)?peakPct:null,armPct,winProb,entryWinProb,bid,sellValue,contracts,cfg,memory.notice??null);
    if(bid!==null&&bid>=SETTLE_BID)return out('HOLD',`${held} Bid ${c(bid)}: it pays $1.00 at settlement, and selling now would only cost the fee.`,notice);
    if(bid===null||bid<MIN_SELLABLE_BID)return out('HOLD',`${held} ${bid===null?`No ${side.toUpperCase()} bid to sell into.`:`Bid only ${c(bid)}: too little left to be worth selling.`}`,notice);
    return out('HOLD',`${held} Selling now would ${unrealized!==null?`${unrealized>=0?'lock in':'lose'} $${Math.abs(unrealized).toFixed(2)}`:`pay ${c(sellValue!/contracts)}/contract`} after the fee.`,notice);
  }
  // Terminal states first: nothing sensible to do but wait. Settle has hysteresis so 96.9¢/97.0¢ does not flicker.
  if(bid!==null&&(bid>=SETTLE_BID||memory.action==='LET IT SETTLE'&&bid>=SETTLE_RELEASE))return out('LET IT SETTLE',`Bid ${c(bid)} — it pays $1.00 at settlement, and selling now only costs the fee.`);
  // A bid hovering around the 5¢ floor should not flip between CUT LOSS and TOO LATE every second.
  if(bid===null||bid<MIN_SELLABLE_BID||memory.action==='TOO LATE'&&bid<.08)return out(winProb<.5?'TOO LATE':'HOLD',bid===null?`No ${side.toUpperCase()} bid to sell into; win chance ${(winProb*100).toFixed(1)}%.`:`Bid only ${c(bid)} (${sellValue!==null?`$${sellValue.toFixed(2)} total`:''}) — too little left to be worth selling; win chance ${(winProb*100).toFixed(1)}%.`);
  if(risk&&unrealizedPct!==null){
    const stopping=memory.action==='CUT LOSS';
    // Latched on the loss alone: requiring the win chance too let a −49%/−51% bid wobble flip CUT LOSS ↔ HOLD 7 times in 40 s.
    if(unrealizedPct<=-cfg.stopLossPct||stopping&&unrealizedPct<=-cfg.stopLossPct*LATCH_SL)return out('CUT LOSS',`Down ${pctTxt(unrealizedPct)} ($${unrealized!.toFixed(2)}). Selling now saves $${sellValue!.toFixed(2)} instead of risking it on a ${(winProb*100).toFixed(0)}% chance.`);
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

/**
 * Advise mode (default since 2026-10-10, DECISIONS 50): one clear word per position, chosen on evidence.
 *
 * Evidence (2026-10-10). On 8,794 replayed rounds, a holder who sold whenever the forecast fell below the bid after fees
 * did worse than holding: −0.6¢ per contract (2¢ gap, 1–15 min left) and −1.3 to −3.6¢ with 1–5 min left (95% ranges
 * below zero). Selling there pays the spread and a second fee for nothing, so with more than 90 s left the advice is
 * never SELL. In the final 90 s the live forecast is sharper than Kalshi (Brier 0.022 vs 0.038 in the last 30 s, 242
 * rounds), and selling when it sat ≥ 3¢ below the net bid beat holding by +4.9¢ (30–120 s, 76 rounds) and +8.2¢
 * (last 30 s, 20 rounds). Those ranges still include zero, so the dashboard labels SELL / SELL NOW as unproven.
 *
 *   LET IT SETTLE  bid ≥ 97¢, or ≤ 90 s left at a ≥ 95% win chance: selling only costs the fee.
 *   SELL NOW       ≤ 90 s left and the bid nets ≥ 6¢ more than the forecast says the contract is worth. Urgent.
 *   SELL           ≤ 90 s left and the bid nets ≥ 3¢ more than it is worth.
 *   TOO LATE       no bid, or under 5¢, and it is losing: nothing left to sell.
 *   LET IT RIDE    you are the favourite (win chance ≥ 60%): hold to settlement.
 *   HOLD           otherwise: the bid undervalues it, so selling locks in less than holding is worth.
 * Escalations show at once (the engine evaluates 4×/s); each label has a release band so a 1¢ wobble cannot flip it.
 */
export const ADVISE={finalTau:90,sellGap:.03,urgentGap:.06,releaseGap:.01,urgentRelease:.04,rideP:.6,rideRelease:.55,settleP:.95} as const;
interface AdviseInput {winProb:number;entryWinProb:number;bid:number|null;sellValue:number|null;unrealized:number|null;unrealizedPct:number|null;contracts:number;side:'yes'|'no';tau:number|null;prev:ExitAction|null;schedule:FeeSchedule;peakPct:number|null;armPct:number|null;cfg:ExitConfig;notice:ExitNotice['kind']|null}
type Out=(action:ExitAction,reason:string,notice?:ExitNotice|null,extra?:Partial<ExitAdvice>)=>ExitAdvice;
function advise(out:Out,a:AdviseInput):ExitAdvice{
  const {winProb:p,bid,contracts,prev,tau}=a,wp=`${(p*100).toFixed(0)}%`,usd=(x:number)=>`$${Math.abs(x).toFixed(2)}`;
  const net=bid!==null&&a.sellValue!==null?a.sellValue/contracts:null,gap=net!==null?net-p:null,final=tau!==null&&tau<=ADVISE.finalTau;
  const lockIn=a.unrealized!==null?`${a.unrealized>=0?'locks in':'loses'} ${usd(a.unrealized)}`:`pays ${net!==null?c(net):'—'}/contract`;
  const was=(...xs:ExitAction[])=>prev!==null&&xs.includes(prev),left=`${Math.max(0,Math.round(tau??0))} s left`;
  // Only the 'win chance dropped' heads-up: gain/loss notices would read as sell hints beside a HOLD the data supports.
  const n=holdNotice(a.unrealized,a.unrealizedPct,a.peakPct,a.armPct,p,a.entryWinProb,bid,a.sellValue,contracts,a.cfg,a.notice==='odds'?'odds':null,''),notice=n?.kind==='odds'?{...n,text:n.text.trim()}:null;
  if(bid!==null&&(bid>=SETTLE_BID||was('LET IT SETTLE')&&bid>=SETTLE_RELEASE)||final&&(p>=ADVISE.settleP||was('LET IT SETTLE')&&p>=ADVISE.settleP-.03))
    return out('LET IT SETTLE',`Win chance ${wp}${bid!==null?` · bid ${c(bid)}`:''}: it pays ${usd(contracts)} at settlement, and selling now would only cost the fee.`);
  if(final&&gap!==null&&bid!==null&&bid>=MIN_SELLABLE_BID){
    // The lowest bid that still nets ≥ sellGap above the forecast: a firm price for a limit sell.
    const floor=bidFor(p+ADVISE.sellGap,contracts,a.schedule,'atLeast');
    if(gap>=ADVISE.urgentGap||was('SELL NOW')&&gap>=ADVISE.urgentRelease)return out('SELL NOW',`${left} and the forecast gives it only ${wp}, but the bid nets ${c(net!)} a contract, ${c(gap)} more than it is worth. Sell into the bid now (${lockIn}); this bid can vanish before the close.`,null,{urgent:true,sellAtBid:floor});
    if(gap>=ADVISE.sellGap||was('SELL','SELL NOW')&&gap>=ADVISE.releaseGap)return out('SELL',`${left}: the bid nets ${c(net!)}, ${c(gap)} more than the ${wp} forecast says it is worth. Sell at ${floor!==null?`${c(floor)} or better`:'the bid'} (${lockIn}).`,null,{sellAtBid:floor});
  }
  if((bid===null||bid<MIN_SELLABLE_BID||was('TOO LATE')&&bid<.08)&&p<.5)
    return out('TOO LATE',`${bid===null?`No ${a.side.toUpperCase()} bid`:`Bid only ${c(bid)}`}: nothing worth selling. Leave it; at ${wp} a comeback still pays ${usd(contracts)}. Do not add to it.`,notice);
  if(p>=ADVISE.rideP||was('LET IT RIDE')&&p>=ADVISE.rideRelease)
    return out('LET IT RIDE',`You are the favourite at ${wp}${Math.abs(p-a.entryWinProb)>=.05?` (${(a.entryWinProb*100).toFixed(0)}% when you bought)`:''}. Hold to settlement: it pays ${usd(contracts)} if it wins; selling now ${lockIn} after the fee.`,notice);
  const losing=a.unrealized!==null&&a.unrealized<-.005;
  return out('HOLD',`Win chance ${wp}. Selling now ${lockIn}, less than holding is worth${final?'':'; with this much time left, selling did worse than holding on past rounds'}.${losing?' Do not add to a losing position.':''}`,notice);
}
