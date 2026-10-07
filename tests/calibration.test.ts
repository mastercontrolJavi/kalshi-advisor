import {it,expect} from 'vitest';
import {reliability,clusterCI,buildCalibration} from '../src/engine/calibration';
import {Journal} from '../src/engine/journal';
it('paired Brier score and bucket counts',()=>{const c=reliability([{ticker:'A',p:.7,mid:.5,y:1},{ticker:'B',p:.3,mid:.5,y:0}]);expect(c.modelBrier).toBeCloseTo(.09);expect(c.marketBrier).toBe(.25);expect(c.buckets.reduce((s,b)=>s+b.count,0)).toBe(2);});
it('CI requires independent markets, handles repeated signals within market',()=>{expect(clusterCI([{ticker:'A',pnl:1}]).low).toBeNull();const c=clusterCI([{ticker:'A',pnl:1},{ticker:'A',pnl:1},{ticker:'B',pnl:-1}]);expect(c.markets).toBe(2);expect(c.low).toBeLessThanOrEqual(c.mean!);expect(c.high).toBeGreaterThanOrEqual(c.mean!);});
it('uses one prediction per market at fixed horizon and preserves it after pruning ticks',()=>{const j=new Journal(':memory:');for(const tau of [150,180,210])j.tick({time:300000-tau*1000,ticker:'A',proxy:100,K:100,tau,sigma:.01,p:.7,mid:.5,regime:'normal'});j.settle('A','yes',300000,100,100,99,{});expect(buildCalibration(j).count).toBe(1);j.prune(40*86400000);expect(buildCalibration(j).count).toBe(1);j.db.close();});
