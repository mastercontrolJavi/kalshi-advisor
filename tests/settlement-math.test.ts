import {describe,expect,it} from 'vitest';
import {averageMoments,discreteAverageMoments,discreteAverageProbability,probability} from '../src/engine/model/math';

describe('discrete benchmark settlement average',()=>{
  it('matches the full Brownian covariance matrix with irregular publication offsets',()=>{
    const offsets=[.2,1.2,2.2,3.2,4.2],locked=Array(55).fill(98),spot=100,sigma=.01;
    const covariance=offsets.reduce((sum,t)=>sum+offsets.reduce((row,u)=>row+Math.min(t,u),0),0);
    const actual=discreteAverageMoments(spot,sigma,locked,offsets);
    expect(actual.expected).toBeCloseTo((55*98+5*100)/60,12);
    expect(actual.variance).toBeCloseTo((spot*sigma)**2*covariance/3600,12);
    expect(actual.lockedCount).toBe(55);
    expect(discreteAverageMoments(spot,sigma,locked,[...offsets].reverse())).toEqual(actual);
  });
  it('distinguishes endpoint schedules from the continuous average approximation',()=>{
    const future=Array.from({length:60},(_,i)=>i+1);
    const discrete=discreteAverageMoments(100,.01,[],future);
    // For 60 future one-second observations, sum min(i,j) = sum k^2 = 73,810.
    expect(discrete.variance).toBeCloseTo(73810/3600,12);
    expect(averageMoments(100,.01,60).variance).toBe(20);
    // A one-second shift moves the entire path together, so the average gains one second of variance.
    const before=discreteAverageMoments(100,.01,[],future.map(t=>t-1));
    expect(discrete.variance-before.variance).toBeCloseTo(1,12);
  });
  it('shares the entire pre-window Brownian path across all sixty observations',()=>{
    const offsets=Array.from({length:60},(_,i)=>840+i+1);
    const m=discreteAverageMoments(100,.01,[],offsets);
    expect(m.variance).toBeCloseTo(840+73810/3600,12);
  });
  it('computes a known normal exceedance probability for one remaining observation',()=>{
    // Average = (59*100+S_1)/60; E=100 and SD=1/60.
    const p=discreteAverageProbability(100,100-1/60,.01,Array(59).fill(100),[1]);
    expect(p.sd).toBeCloseTo(1/60,12);
    expect(p.z).toBeCloseTo(1,12);
    expect(p.p).toBeCloseTo(.841344746,6);
  });
  it('is symmetric at the strike and invariant to a change in currency units',()=>{
    const offsets=[.1,1.1,2.1],locked=Array(57).fill(101);
    const a=discreteAverageProbability(100,100.8,.01,locked,offsets,0,.2);
    const b=discreteAverageProbability(1000,1008,.01,locked.map(p=>p*10),offsets,0,2);
    expect(a.p).toBeCloseTo(b.p,12);
    expect(discreteAverageProbability(100,100,.01,Array(57).fill(100),offsets).p).toBe(.5);
  });
  it('accepts a fully known average but never silently fills a missing benchmark slot',()=>{
    const m=discreteAverageProbability(100,99,.01,Array(60).fill(100),[]);
    expect(m.sd).toBe(0);expect(m.p).toBe(.99);
    expect(()=>discreteAverageMoments(100,.01,Array(58).fill(100),[1])).toThrow('Incomplete');
    expect(()=>discreteAverageMoments(100,.01,Array(59).fill(100),[-.2])).toThrow('Invalid');
    expect(()=>discreteAverageMoments(100,.01,Array(59).fill(100),[NaN])).toThrow('Invalid');
  });
});

describe('settlement residual uncertainty',()=>{
  it('preserves legacy probabilities with zero residual and adds independent variance in dollar units',()=>{
    const raw=probability(100,101,.01,30,Array(30).fill(100));
    const uncertain=probability(100,101,.01,30,Array(30).fill(100),0,4);
    expect(raw.diffusionVariance).toBe(raw.variance);
    expect(uncertain.variance).toBeCloseTo(raw.variance+16,12);
    expect(uncertain.expected).toBe(raw.expected);
    expect(uncertain.p).toBeGreaterThan(raw.p);
    expect(uncertain.p).toBeLessThan(.5);
  });
  it('keeps proxy residual uncertainty after the entire price average is known',()=>{
    const proxy=probability(100,100,.01,0,Array(60).fill(101),0,5);
    const benchmark=discreteAverageProbability(100,100,.01,Array(60).fill(101),[],0,5);
    expect(proxy.diffusionVariance).toBe(0);expect(proxy.sd).toBe(5);
    expect(proxy.p).toBeGreaterThan(.5);expect(proxy.p).toBeLessThan(.6);
    expect(benchmark.p).toBeCloseTo(.5792597,6);
  });
  it.each([NaN,Infinity,-1])('rejects invalid residual standard deviations: %s',sd=>{
    expect(()=>probability(100,100,.01,60,[],0,sd)).toThrow('Invalid');
    expect(()=>discreteAverageProbability(100,100,.01,Array(59).fill(100),[1],0,sd)).toThrow('Invalid');
  });
  it('rejects invalid strikes, corrections, and locked prices instead of emitting NaN probabilities',()=>{
    expect(()=>probability(100,NaN,.01,60)).toThrow('Invalid');
    expect(()=>probability(100,100,.01,60,[],Infinity)).toThrow('Invalid');
    expect(()=>probability(100,100,.01,30,Array(30).fill(-100))).toThrow('Invalid');
  });
});
