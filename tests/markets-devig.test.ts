import {it,expect} from 'vitest';
import {devig,consensus} from '../src/markets/devig';
import {similarity,SUGGEST_MIN} from '../src/markets/similarity';
it('removes the bookmaker margin multiplicatively',()=>{
  expect(devig([1.91,1.91])).toEqual([.5,.5]);const p=devig([1.5,2.8]);expect(p[0]+p[1]).toBeCloseTo(1,12);expect(p[0]).toBeCloseTo(.651,3);
  expect(devig([1,2])).toEqual([]);expect(devig([NaN,2])).toEqual([]);});
it('consensus is the per-outcome median of de-vigged books, renormalised',()=>{
  const c=consensus([[1.8,2.0],[1.9,1.9],[2.1,1.75]])!;expect(c[0]+c[1]).toBeCloseTo(1,12);expect(c[0]).toBeCloseTo(.5,2);expect(consensus([])).toBeNull();});
it('title similarity ranks the same question high and an unrelated one low',()=>{
  expect(similarity('Will the Fed cut rates in October 2026?','Fed rate cut in October 2026')).toBeGreaterThanOrEqual(SUGGEST_MIN);
  expect(similarity('Will the Fed cut rates in October 2026?','Will Bitcoin hit 150k in 2026?')).toBeLessThan(.3);expect(similarity('','x')).toBe(0);});
