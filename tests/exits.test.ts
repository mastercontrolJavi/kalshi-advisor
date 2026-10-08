import {it,expect} from 'vitest';
import {exitAdvice,entryCost,type ExitConfig,type ExitMemory} from '../src/engine/exits';
import {baseFees,fee} from '../src/engine/model/fees';
const risk:ExitConfig={exitMode:'risk',exitMargin:.02,makerMargin:.03,takeProfitPct:.25,stopLossPct:.5,stopWinProb:.25,trailGiveback:.5,trailFloor:.05};
const ev:ExitConfig={...risk,exitMode:'ev'};
const no=(n:string,cost:string)=>({ticker:'M',position_fp:'-'+n,market_exposure_dollars:cost});
const yes=(n:string,cost:string)=>({ticker:'M',position_fp:n,market_exposure_dollars:cost});
const mem=(action:any=null,peak:number|null=null):ExitMemory=>({action,peak});
const book=(yesBid:number|null,noBid:number|null)=>({yesBid,noBid});
it('below the arm level it holds and shows the bid that arms the trailing take-profit',()=>{
  const e=exitAdvice(yes('10','4.00'),.55,book(.45,.53),baseFees,risk)!;expect(e.action).toBe('HOLD');expect(e.takeProfitBid!).toBeGreaterThan(.4);expect(e.reason).toContain('Plan: ride from bid ≥');});
it('at +25% it rides the winner instead of selling, and trails the best gain seen',()=>{
  const e=exitAdvice(yes('10','4.00'),.6,book(.53,.45),baseFees,risk)!;expect(e.unrealizedPct!).toBeGreaterThan(.25);expect(e.action).toBe('RIDE');expect(e.trailBid!).toBeGreaterThan(.4);
  const higher=exitAdvice(yes('10','4.00'),.75,book(.7,.28),baseFees,risk,mem('RIDE',e.peakPct))!;expect(higher.action).toBe('RIDE');expect(higher.peakPct!).toBeGreaterThan(e.peakPct!);
  // Gain falls back to half the peak: take profit, and it stays until a new high.
  const back=exitAdvice(yes('10','4.00'),.6,book(.5,.48),baseFees,risk,mem('RIDE',higher.peakPct))!;expect(back.action).toBe('TAKE PROFIT');expect(back.unrealized!).toBeGreaterThan(0);
  expect(exitAdvice(yes('10','4.00'),.6,book(.55,.43),baseFees,risk,mem('TAKE PROFIT',higher.peakPct))!.action).toBe('TAKE PROFIT');
  expect(exitAdvice(yes('10','4.00'),.8,book(.74,.24),baseFees,risk,mem('TAKE PROFIT',higher.peakPct))!.action).toBe('RIDE');});
it('the trailing stop never gives back below the floor gain',()=>{
  const e=exitAdvice(yes('10','4.00'),.55,book(.46,.52),baseFees,risk,mem('RIDE',.26))!;expect(e.action).toBe('TAKE PROFIT');});
it('cuts the loss on the stop or a collapsing win chance, and the stop is sticky',()=>{
  const e=exitAdvice(no('10.21','4.9008'),.841,book(.84,.15),baseFees,risk)!;expect(e.winProb).toBeCloseTo(.159);expect(e.action).toBe('CUT LOSS');expect(e.sellValue!).toBeGreaterThan(1.3);
  expect(exitAdvice(no('10','4.8'),.4,book(.6,.2),baseFees,risk)!.action).toBe('CUT LOSS');
  expect(exitAdvice(no('10','4.8'),.73,book(.72,.27),baseFees,risk,mem('CUT LOSS'))!.action).toBe('CUT LOSS');expect(exitAdvice(no('10','4.8'),.55,book(.54,.45),baseFees,risk,mem('CUT LOSS'))!.action).toBe('HOLD');});
it('terminal states with hysteresis: settle above 97¢ and keep settling down to 95¢; dead positions are too late',()=>{
  expect(exitAdvice(yes('5','2.5'),.995,book(.98,.01),baseFees,risk)!.action).toBe('LET IT SETTLE');
  expect(exitAdvice(yes('5','2.5'),.99,book(.966,.02),baseFees,risk,mem('LET IT SETTLE'))!.action).toBe('LET IT SETTLE');
  expect(exitAdvice(yes('5','2.5'),.99,book(.966,.02),baseFees,risk,mem('RIDE',.9))!.action).not.toBe('LET IT SETTLE');
  expect(exitAdvice(no('10.21','4.9008'),.99,book(.99,.002),baseFees,risk)!.action).toBe('TOO LATE');expect(exitAdvice(no('3','1.5'),.99,book(.99,null),baseFees,risk)!.action).toBe('TOO LATE');});
it('risk mode no longer issues the noisy expected-value SELL NOW; EV mode keeps it',()=>{
  expect(exitAdvice(yes('10','4.50'),.5,book(.52,.46),baseFees,risk)!.action).toBe('HOLD');
  const s=exitAdvice(yes('10','4.00'),.5,book(.75,.2),baseFees,ev)!;expect(s.action).toBe('SELL NOW');expect(s.sellFee).toBeCloseTo(.1313,3);
  expect(exitAdvice(yes('10','4.00'),.8,book(.7,.2),baseFees,ev)!.action).toBe('HOLD');expect(exitAdvice(yes('10','4.00'),.8,book(.7,.2),baseFees,ev)!.takeProfitBid).toBeNull();});
it('negative positions are NO contracts; no model means no estimate; flat is nothing',()=>{
  const e=exitAdvice(no('5','1.50'),.3,book(.25,.6),baseFees,risk)!;expect(e.side).toBe('no');expect(e.winProb).toBeCloseTo(.7);
  expect(exitAdvice(yes('3','1'),null,book(.5,.4),baseFees,risk)!.action).toBe('NO MODEL');expect(exitAdvice(yes('0.00','0'),.6,null,baseFees,risk)).toBeNull();});
it('a closed round shows SETTLING with the official result, or the closing-average estimate before it lands',()=>{
  const e=exitAdvice(yes('17.25','13.80'),null,book(.999,.001),baseFees,risk,mem(),{result:null,estimate:'yes'})!;expect(e.action).toBe('SETTLING');expect(e.reason).toContain('won');expect(e.reason).toContain('$17.25 pays out');
  const lost=exitAdvice(yes('10','6'),null,book(.01,.99),baseFees,risk,mem(),{result:'no',estimate:'yes'})!;expect(lost.reason).toContain('Kalshi settled it lost');expect(lost.holdValue).toBe(0);
  expect(exitAdvice(yes('10','6'),null,null,baseFees,risk,mem(),{result:null,estimate:null})!.reason).toContain('waiting for Kalshi');});
it('expensive contracts still get a reachable ride level (half the maximum possible gain)',()=>{
  const e=exitAdvice(yes('17.25','13.80'),.85,book(.84,.15),baseFees,risk)!;expect(e.takeProfitBid).not.toBeNull();expect(e.takeProfitBid!).toBeLessThan(.99);expect(e.takeProfitBid!).toBeGreaterThan(.84);
  const ride=exitAdvice(yes('17.25','13.80'),.95,book(.92,.07),baseFees,risk)!;expect(ride.action).toBe('RIDE');
  expect(exitAdvice(yes('10','4.00'),.55,book(.45,.53),baseFees,risk)!.takeProfitBid).toBe(exitAdvice(yes('10','4.00'),.55,book(.45,.53),baseFees,{...risk,takeProfitPct:.25})!.takeProfitBid);});
const hold:ExitConfig={...risk,exitMode:'hold'};
it('hold mode keeps the position to settlement where risk mode would take profit or cut loss',()=>{
  const winning=exitAdvice(yes('10','4.00'),.9,book(.6,.38),baseFees,hold,mem('RIDE',.6))!;expect(winning.action).toBe('HOLD');expect(winning.reason).toContain('Holding to settlement');expect(winning.reason).not.toContain('Plan:');
  expect(exitAdvice(yes('10','4.00'),.9,book(.6,.38),baseFees,risk,mem('RIDE',.6))!.action).not.toBe('HOLD');
  const losing=exitAdvice(yes('10','6.00'),.15,book(.2,.78),baseFees,hold)!;expect(losing.action).toBe('HOLD');expect(losing.reason).toContain('lose $');
  expect(exitAdvice(yes('10','6.00'),.15,book(.2,.78),baseFees,risk)!.action).toBe('CUT LOSS');
  // One steady word in hold mode: settle-level and nothing-left bids only change the explanation.
  const settle=exitAdvice(yes('10','6.00'),.99,book(.98,.01),baseFees,hold)!;expect(settle.action).toBe('HOLD');expect(settle.reason).toContain('pays $1.00 at settlement');
  const late=exitAdvice(yes('10','6.00'),.2,book(.02,.97),baseFees,hold)!;expect(late.action).toBe('HOLD');expect(late.reason).toContain('too little left');
  expect(exitAdvice(yes('10','6.00'),.99,book(.98,.01),baseFees,risk)!.action).toBe('LET IT SETTLE');
  // A wobbling bid around the old flicker point keeps one action across ticks.
  const seq=[.36,.37,.35,.38,.36].map(b=>exitAdvice(yes('10','7.00'),.4,book(b,1-b-.01),baseFees,hold)!.action);expect(new Set(seq).size).toBe(1);});
it('cost includes the entry fee: FIFO cost of open fills when they match the position, else the fee implied by exposure',()=>{
  const pos=yes('14.1','7.755');
  expect(entryCost(pos,{side:'yes',contracts:14.1,avgCost:.567},baseFees)).toEqual({avgCost:.567,source:'fills'});
  const est=entryCost(pos,{side:'yes',contracts:10,avgCost:.6},baseFees)!;expect(est.source).toBe('estimate');expect(est.avgCost).toBeCloseTo(.55+fee(.55,14.1)/14.1,9);
  expect(entryCost(no('5','2'),{side:'yes',contracts:5,avgCost:.5},baseFees)!.source).toBe('estimate');
  expect(entryCost({ticker:'M',position_fp:'3'},undefined,baseFees)).toBeNull();
  // P&L if sold now includes both fees.
  const e=exitAdvice(pos,.54,book(.54,.45),baseFees,hold,mem(),null,{avgCost:.567,source:'fills'})!;
  expect(e.unrealized!).toBeCloseTo(14.1*.54-fee(.54,14.1)-14.1*.567,9);expect(e.costSource).toBe('fills');});
it('risk mode: once CUT LOSS fires it stays while the loss is still beyond 35%, even if the win chance ticks up',()=>{
  const first=exitAdvice(yes('10','7.00'),.36,book(.34,.65),baseFees,risk)!;expect(first.action).toBe('CUT LOSS');
  expect(exitAdvice(yes('10','7.00'),.40,book(.37,.62),baseFees,risk,mem('CUT LOSS'))!.action).toBe('CUT LOSS');
  expect(exitAdvice(yes('10','7.00'),.40,book(.37,.62),baseFees,risk)!.action).toBe('HOLD');
  expect(exitAdvice(yes('10','7.00'),.6,book(.5,.49),baseFees,risk,mem('CUT LOSS'))!.action).toBe('HOLD');});
