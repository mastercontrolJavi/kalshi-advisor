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
import {filledSeconds} from '../src/engine/model/math';
it('final-minute gaps up to 5 s are bridged by interpolation; longer gaps still pause the model',()=>{
  const s=(t:number,p:number)=>({time:t*1000,price:p});
  const one=filledSeconds([s(0,100),s(1,101),s(3,103),s(4,104)],0,5000)!;expect(one.values).toEqual([100,101,102,103,104]);expect(one.imputed).toBe(1);
  const edge=filledSeconds([s(-1,99),s(1,101),s(2,102)],0,3000)!;expect(edge.values[0]).toBeCloseTo(100);expect(edge.imputed).toBe(1);
  const tail=filledSeconds([s(0,100),s(1,101)],0,3000)!;expect(tail.values).toEqual([100,101,101]);
  expect(filledSeconds([s(0,100),s(7,107)],0,8000)).toBeNull();expect(filledSeconds([],0,3000)).toBeNull();expect(filledSeconds([s(0,1)],0,0)).toEqual({values:[],imputed:0});});
import {warmVolatility} from '../src/engine/model/math';
it('after a restart the saved σ carries the model until enough fresh returns arrive',()=>{
  const now=1e9,saved={sigma:.00003,time:now-3600000};
  const cold=warmVolatility({sigma:0,count:0,regime:'warming'},saved,120,now);expect(cold.source).toBe('carried over');expect(cold.sigma).toBeCloseTo(.00003);expect(cold.count).toBe(120);
  const half=warmVolatility({sigma:.00005,count:60,regime:'normal'},saved,120,now);expect(half.sigma).toBeCloseTo(Math.sqrt(.5*.00005**2+.5*.00003**2));
  expect(warmVolatility({sigma:.00004,count:200,regime:'calm'},saved,120,now)).toMatchObject({sigma:.00004,source:'live'});
  expect(warmVolatility({sigma:0,count:5,regime:'warming'},{sigma:.00003,time:now-13*3600000},120,now).source).toBe('warming');
  expect(warmVolatility({sigma:0,count:5,regime:'warming'},null,120,now).count).toBe(5);});
import {varianceRatio,volatility as vol2,VR_PRIOR} from '../src/engine/model/math';
it('variance ratio: prior 1.5 without data, rises for trending paths, ~1 for a random walk, and scales sigma',()=>{
  expect(varianceRatio([]).ratio).toBe(VR_PRIOR);
  let seed=5;const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296-.5;};
  const walk=[{time:0,price:100}];for(let i=1;i<3600;i++)walk.push({time:i*1000,price:walk[i-1].price*Math.exp(rnd()*.0002)});
  const w=varianceRatio(walk,60,1.5,0);expect(w.live!).toBeGreaterThan(.6);expect(w.live!).toBeLessThan(1.5);
  const trend=[{time:0,price:100}];let drift=0;for(let i=1;i<3600;i++){if(i%60===0)drift=rnd()*.0004;trend.push({time:i*1000,price:trend[i-1].price*Math.exp(drift+rnd()*.0001)});}
  expect(varianceRatio(trend,60,1.5,0).live!).toBeGreaterThan(2);
  const v=vol2(walk,300,.25);expect(v.sigma).toBeCloseTo(v.sigma1s*Math.sqrt(v.varianceRatio),12);expect(v.varianceRatio).toBeGreaterThanOrEqual(1);});
