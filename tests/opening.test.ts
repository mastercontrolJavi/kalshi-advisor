import {it,expect} from 'vitest';
import {openingCall,wilson,MAX_LEAN} from '../src/engine/model/opening';
import {Journal} from '../src/engine/journal';
import {openingScore} from '../src/engine/calibration';
const neutral={modelP:.5,sigma:.0002,momentum30s:0,momentum120s:0,imbalance:0,tradeFlow30s:0};
it('neutral features leave the model probability unchanged',()=>{const c=openingCall({...neutral,modelP:.53});expect(c.p).toBeCloseTo(.53);expect(c.lean).toBe(0);expect(c.direction).toBe('UP');});
it('upward momentum, YES book and YES flow lean UP but never more than the cap',()=>{
  const mild=openingCall({...neutral,momentum120s:.0002*Math.sqrt(120)});expect(mild.direction).toBe('UP');expect(mild.p).toBeGreaterThan(.5);
  const extreme=openingCall({modelP:.5,sigma:.0002,momentum30s:1,momentum120s:1,imbalance:1,tradeFlow30s:1e6});expect(extreme.p).toBeCloseTo(.5+MAX_LEAN,6);
  const down=openingCall({modelP:.5,sigma:.0002,momentum30s:-1,momentum120s:-1,imbalance:-1,tradeFlow30s:-1e6});expect(down.direction).toBe('DOWN');expect(down.p).toBeCloseTo(.5-MAX_LEAN,6);});
it('missing features count as neutral and are disclosed',()=>{const c=openingCall({...neutral,momentum30s:null,imbalance:null,tradeFlow30s:null,momentum120s:null});expect(c.p).toBe(.5);expect(c.reasons.filter(r=>r.includes('unavailable'))).toHaveLength(4);});
it('rejects invalid inputs',()=>{expect(()=>openingCall({...neutral,sigma:0})).toThrow();expect(()=>openingCall({...neutral,modelP:NaN})).toThrow();});
it('Wilson interval brackets the hit rate',()=>{const w=wilson(50,100);expect(w.low!).toBeCloseTo(.404,2);expect(w.high!).toBeCloseTo(.596,2);expect(wilson(0,0).low).toBeNull();});
it('only the first call per window is kept',()=>{const j=new Journal(':memory:');j.saveOpeningCall('M',1000,895,openingCall({...neutral,modelP:.6}),.55);j.saveOpeningCall('M',2000,880,openingCall({...neutral,modelP:.3}),.4);const c=j.openingCall('M')!;expect(c.direction).toBe('UP');expect(c.tau).toBe(895);expect(c.mid).toBe(.55);});
it('scores calls against outcomes, coin flip and Kalshi mid',()=>{
  const s=openingScore([{ticker:'A',direction:'UP',p:.6,base_p:.5,mid:.5,result:'yes'},{ticker:'B',direction:'DOWN',p:.4,base_p:.5,mid:null,result:'yes'},{ticker:'C',direction:'UP',p:.55,base_p:.5,mid:.5,result:null}]);
  expect(s.count).toBe(2);expect(s.pending).toBe(1);expect(s.hits).toBe(1);expect(s.callBrier).toBeCloseTo(((.6-1)**2+(.4-1)**2)/2);expect(s.baseBrier).toBeCloseTo(.25);expect(s.midCount).toBe(1);expect(s.midBrier).toBeCloseTo(.25);expect(s.callBrierMidSubset).toBeCloseTo(.16);});
it('trade flow is scored as a share of volume so heavy trading does not saturate it',()=>{const half=openingCall({...neutral,tradeFlow30s:-2920,tradeVolume30s:5840});const all=openingCall({...neutral,tradeFlow30s:-5840,tradeVolume30s:5840});expect(half.p).toBeCloseTo(.5-MAX_LEAN*.15*.5,6);expect(all.p).toBeCloseTo(.5-MAX_LEAN*.15,6);expect(half.reasons.some(r=>r.includes('-50% net toward NO'))).toBe(true);});
