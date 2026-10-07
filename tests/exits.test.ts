import {it,expect} from 'vitest';
import {exitAdvice,type ExitConfig} from '../src/engine/exits';
import {baseFees} from '../src/engine/model/fees';
const risk:ExitConfig={exitMode:'risk',exitMargin:.02,makerMargin:.03,takeProfitPct:.25,stopLossPct:.5,stopWinProb:.25};
const ev:ExitConfig={...risk,exitMode:'ev'};
const no=(n:string,cost:string)=>({ticker:'M',position_fp:'-'+n,market_exposure_dollars:cost});
const yes=(n:string,cost:string)=>({ticker:'M',position_fp:n,market_exposure_dollars:cost});
// The 2026-10-07 16:45 trade: 10.21 NO at 48¢ (+ fee) — up ~21% at 16:50, flat at 16:56:30, gone by 16:58.
it('takes profit once selling locks in the target, before the price can reverse',()=>{const e=exitAdvice(yes('10','4.00'),.6,{yesBid:.53,noBid:.45},baseFees,risk)!;expect(e.unrealizedPct!).toBeGreaterThan(.25);expect(e.action).toBe('TAKE PROFIT');});
it('cuts the loss when the win chance falls below the stop, while there is still a bid worth selling',()=>{
  const e=exitAdvice(no('10.21','4.9008'),.841,{yesBid:.84,noBid:.15},baseFees,risk)!;expect(e.winProb).toBeCloseTo(.159);expect(e.action).toBe('CUT LOSS');expect(e.sellValue!).toBeGreaterThan(1.3);
  expect(exitAdvice(no('10','4.8'),.4,{yesBid:.6,noBid:.2},baseFees,risk)!.action).toBe('CUT LOSS');});
it('holds inside the band and shows the bid levels that would trigger each exit',()=>{
  const e=exitAdvice(no('10.21','4.9008'),.47,{yesBid:.52,noBid:.46},baseFees,risk)!;expect(e.action).toBe('HOLD');
  expect(e.takeProfitBid!).toBeGreaterThan(.48);expect(e.stopBid!).toBeLessThan(.48);expect(e.reason).toContain('Plan: take profit at bid ≥');});
it('terminal states: let a near-certain winner settle; a dead position is too late to sell',()=>{
  expect(exitAdvice(yes('5','2.5'),.995,{yesBid:.98,noBid:.01},baseFees,risk)!.action).toBe('LET IT SETTLE');
  const dead=exitAdvice(no('10.21','4.9008'),.99,{yesBid:.99,noBid:.002},baseFees,risk)!;expect(dead.action).toBe('TOO LATE');
  expect(exitAdvice(no('3','1.5'),.99,{yesBid:.99,noBid:null},baseFees,risk)!.action).toBe('TOO LATE');});
it('EV mode keeps the original rule: sell only when the bid beats model value by the margin',()=>{
  expect(exitAdvice(yes('10','4.00'),.8,{yesBid:.7,noBid:.2},baseFees,ev)!.action).toBe('HOLD');
  const s=exitAdvice(yes('10','4.00'),.5,{yesBid:.75,noBid:.2},baseFees,ev)!;expect(s.action).toBe('SELL NOW');expect(s.sellFee).toBeCloseTo(.1313,3);
  expect(exitAdvice(yes('10','4.00'),.8,{yesBid:.7,noBid:.2},baseFees,ev)!.takeProfitBid).toBeNull();});
it('negative positions are NO contracts; no model means no estimate; flat is nothing',()=>{
  const e=exitAdvice(no('5','1.50'),.3,{yesBid:.25,noBid:.6},baseFees,risk)!;expect(e.side).toBe('no');expect(e.winProb).toBeCloseTo(.7);
  expect(exitAdvice(yes('3','1'),null,{yesBid:.5,noBid:.4},baseFees,risk)!.action).toBe('NO MODEL');expect(exitAdvice(yes('0.00','0'),.6,null,baseFees,risk)).toBeNull();});
it('exits are sticky: take profit stays until the gain clearly fades; a recovered stop clears',()=>{
  const pos=yes('10','4.00'),tp=exitAdvice(pos,.6,{yesBid:.53,noBid:.45},baseFees,risk)!;expect(tp.action).toBe('TAKE PROFIT');
  expect(exitAdvice(pos,.6,{yesBid:.5,noBid:.48},baseFees,risk,'TAKE PROFIT')!.action).toBe('TAKE PROFIT');expect(exitAdvice(pos,.6,{yesBid:.5,noBid:.48},baseFees,risk,'HOLD')!.action).toBe('HOLD');
  expect(exitAdvice(pos,.6,{yesBid:.44,noBid:.54},baseFees,risk,'TAKE PROFIT')!.action).toBe('HOLD');
  expect(exitAdvice(no('10','4.8'),.73,{yesBid:.72,noBid:.27},baseFees,risk,'CUT LOSS')!.action).toBe('CUT LOSS');expect(exitAdvice(no('10','4.8'),.55,{yesBid:.54,noBid:.45},baseFees,risk,'CUT LOSS')!.action).toBe('HOLD');});
