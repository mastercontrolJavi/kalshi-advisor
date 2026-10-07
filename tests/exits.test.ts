import {it,expect} from 'vitest';
import {exitAdvice} from '../src/engine/exits';
import {baseFees} from '../src/engine/model/fees';
const yes=(n:string,cost:string)=>({ticker:'M',position_fp:n,market_exposure_dollars:cost});
it('holds when the model values the position above the bid after fees',()=>{const e=exitAdvice(yes('10','4.00'),.8,{yesBid:.7,noBid:.2},baseFees,.02,.03)!;expect(e.action).toBe('HOLD');expect(e.side).toBe('yes');expect(e.avgCost).toBeCloseTo(.4);expect(e.holdValue).toBeCloseTo(8);expect(e.sellValue!).toBeLessThan(7);expect(e.limitPrice).toBe(.83);expect(e.unrealized!).toBeGreaterThan(2.8);});
it('sells when the bid minus fee beats model value by the margin',()=>{const e=exitAdvice(yes('10','4.00'),.5,{yesBid:.75,noBid:.2},baseFees,.02,.03)!;expect(e.action).toBe('SELL NOW');expect(e.sellFee).toBeCloseTo(.1313,3);expect(e.sellValue).toBeCloseTo(7.3687,3);});
it('negative positions are NO contracts valued at 1 − P(up)',()=>{const e=exitAdvice(yes('-5','1.50'),.3,{yesBid:.25,noBid:.6},baseFees,.02,.03)!;expect(e.side).toBe('no');expect(e.contracts).toBe(5);expect(e.winProb).toBeCloseTo(.7);expect(e.action).toBe('HOLD');});
it('a tiny selling gain under the margin still says hold',()=>{const e=exitAdvice(yes('1','.5'),.5,{yesBid:.53,noBid:.4},baseFees,.02,.03)!;expect(e.action).toBe('HOLD');expect(e.reason).toContain('only');});
it('no bid means hold, no model means no recommendation, flat means nothing',()=>{expect(exitAdvice(yes('3','1'),.6,{yesBid:null,noBid:null},baseFees,.02,.03)!.action).toBe('HOLD');expect(exitAdvice(yes('3','1'),null,{yesBid:.5,noBid:.4},baseFees,.02,.03)!.action).toBe('NO MODEL');expect(exitAdvice(yes('0.00','0'),.6,null,baseFees,.02,.03)).toBeNull();});
