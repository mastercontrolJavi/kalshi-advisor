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
it('hold mode reacts to big moves with a heads-up while the plan stays HOLD',()=>{
  const at=(bid:number,p:number,m:ExitMemory=mem())=>exitAdvice(yes('10','5.00'),p,book(bid,1-bid-.01),baseFees,hold,m)!;
  const flat=at(.5,.55);expect(flat.action).toBe('HOLD');expect(flat.notice).toBeNull();expect(flat.entryWinProb).toBeCloseTo(.55);
  const up=at(.7,.75,{action:'HOLD',peak:0,entryProb:.55});expect(up.action).toBe('HOLD');expect(up.notice!.kind).toBe('gain');expect(up.notice!.text).toContain('lock in');
  // Peak +38% then back to +6%: gave back more than half.
  const back=at(.55,.6,{action:'HOLD',peak:.38,entryProb:.55});expect(back.notice!.kind).toBe('giveback');expect(back.peakPct).toBeCloseTo(.38);
  const down=at(.22,.25,{action:'HOLD',peak:.02,entryProb:.55});expect(down.action).toBe('HOLD');expect(down.notice!.kind).toBe('loss');expect(down.notice!.text).toContain('55% when you bought');expect(down.troughPct!).toBeLessThan(-.5);
  // Win chance −25 points without a big loss yet.
  const odds=at(.45,.29,{action:'HOLD',peak:0,entryProb:.55});expect(odds.notice!.kind).toBe('odds');
  // Hysteresis: a loss notice stays while the loss is still beyond 80% of the threshold, then clears.
  expect(at(.3,.35,{action:'HOLD',peak:0,entryProb:.4,notice:'loss'}).notice!.kind).toBe('loss');
  expect(at(.3,.35,{action:'HOLD',peak:0,entryProb:.4}).notice).toBeNull();
  expect(at(.45,.5,{action:'HOLD',peak:0,entryProb:.5,notice:'loss'}).notice).toBeNull();
  // Risk mode is unchanged: no notices, real exit calls.
  expect(exitAdvice(yes('10','5.00'),.25,book(.22,.77),baseFees,risk)!.action).toBe('CUT LOSS');});
const advise:ExitConfig={...risk,exitMode:'advise'};
const adv=(p:number,bid:number,tau:number|null,prev:any=null,n='10',cost='5.00')=>exitAdvice(yes(n,cost),p,book(bid,Math.max(0,1-bid-.01)),baseFees,advise,mem(prev),null,null,tau)!;
it('advise mode: the favourite rides, an underdog holds, and neither is ever told to sell with more than 90 s left',()=>{
  expect(adv(.7,.65,400).action).toBe('LET IT RIDE');
  expect(adv(.4,.35,400).action).toBe('HOLD');
  // A bid far above the forecast with 5 minutes left: on 8,794 past rounds selling here lost to holding, so still HOLD.
  const rich=adv(.2,.4,300);expect(rich.action).toBe('HOLD');expect(rich.reason).toContain('selling did worse than holding');
  expect(adv(.3,.25,400).reason).toContain('Do not add to a losing position');});
it('advise mode: in the final 90 s it says SELL at a 3¢ gap and SELL NOW at 6¢, with a firm limit price',()=>{
  const sell=adv(.4,.45,60);expect(sell.action).toBe('SELL');expect(sell.urgent).toBeFalsy();expect(sell.sellAtBid!).toBeGreaterThanOrEqual(.43);expect(sell.sellAtBid!).toBeLessThanOrEqual(.45);
  const now=adv(.3,.4,40);expect(now.action).toBe('SELL NOW');expect(now.urgent).toBe(true);expect(now.reason).toContain('can vanish');
  expect(adv(.42,.44,60).action).toBe('HOLD');});
it('advise mode: release bands stop 1¢ wobbles from flipping the call',()=>{
  // SELL NOW stays until the gap falls under 4¢; SELL stays until under 1¢; LET IT RIDE stays down to 55%.
  expect(adv(.4,.465,40,'SELL NOW').action).toBe('SELL NOW');expect(adv(.4,.465,40).action).toBe('SELL');
  expect(adv(.4,.435,40,'SELL').action).toBe('SELL');expect(adv(.4,.435,40).action).toBe('HOLD');
  expect(adv(.4,.41,40,'SELL').action).toBe('HOLD');
  expect(adv(.57,.55,400,'LET IT RIDE').action).toBe('LET IT RIDE');expect(adv(.57,.55,400,null).action).toBe('HOLD');
  const seq=[.36,.37,.35,.38,.36].map(b=>adv(.4,b,400).action);expect(new Set(seq).size).toBe(1);});
it('advise mode: let it settle near $1, too late with nothing to sell',()=>{
  expect(adv(.9,.98,400).action).toBe('LET IT SETTLE');
  expect(adv(.96,.9,50).action).toBe('LET IT SETTLE');
  const late=adv(.1,.02,100);expect(late.action).toBe('TOO LATE');expect(late.reason).toContain('Do not add');});
