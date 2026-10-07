import {describe,it,expect} from 'vitest';
import {fee,baseFees} from '../src/engine/model/fees';
import {probability,averageMoments,coveredSeconds,volatility} from '../src/engine/model/math';
describe('verified fees',()=>{
 it.each([[.01,.0007],[.5,.0175],[.99,.0007]])('direct taker %s',(p,f)=>expect(fee(p)).toBe(f));
 it.each([.01,.5,.99])('maker is zero for quadratic %s',p=>expect(fee(p,1,'maker')).toBe(0));
 it('maker charged series and legacy precision',()=>{expect(fee(.5,1,'maker',{...baseFees,makerMultiplier:1})).toBe(.0044);expect(fee(.5,1,'taker',{...baseFees,precision:.01})).toBe(.02);});
 it('rounds total order rather than individual contracts',()=>expect(fee(.5,100)).toBe(1.75));
});
describe('settlement average',()=>{
 it.each([60,120,900])('spot equals strike is symmetric at %s',t=>expect(probability(100,100,.001,t).p).toBe(.5));
 it('locked half contributes equally; future integral variance scales cubically',()=>{const m=averageMoments(100,.01,30,Array(30).fill(102));expect(m.expected).toBe(101);expect(m.variance).toBeCloseTo(2.5);});
 it('fully locked average and clipping',()=>{expect(probability(100,100,.001,0,Array(60).fill(101)).p).toBe(.99);expect(probability(100,100,.001,0,Array(60).fill(99)).p).toBe(.01);});
 it('rejects missing observations',()=>expect(()=>averageMoments(100,.01,30,[])).toThrow());
 it('variance continuous at 60 seconds',()=>expect(averageMoments(100,.01,60).variance).toBe(20));
 it('missing seconds are never imputed',()=>expect(coveredSeconds([{time:0,price:100}],0,2000)).toBeNull());
 it('volatility ignores gaps',()=>expect(volatility([{time:0,price:100},{time:2000,price:120}]).count).toBe(0));
});
