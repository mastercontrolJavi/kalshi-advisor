import {describe,it,expect} from 'vitest';
import {absorption,beta,crossCorrelation,gapClosure,quantile,roundTripCents,share,summary,type Round,type Second} from '../scripts/calibrate-baseline';

const round=(rows:[number,number,number|null][]):Round=>new Map(rows.map(([s,p,mid])=>[s,{p,mid,proxy:null,brti:null} as Second]));

describe('baseline calibration helpers',()=>{
  it('summarizes and interpolates quantiles',()=>{
    expect(quantile([1,2,3,4],.5)).toBe(2.5);
    const s=summary([3,1,2,NaN]);expect(s.n).toBe(3);expect(s.mean).toBe(2);expect(s.sd).toBe(1);expect(s.p50).toBe(2);
    expect(summary([]).mean).toBeNull();
  });
  it('fits a slope with an intercept',()=>{expect(beta([0,1,2],[1,3,5])).toBe(2);expect(beta([1,1],[0,1])).toBeNull();});
  it('measures how many seconds Kalshi takes to absorb a model move',()=>{
    // The model jumps 10¢ at s=2; Kalshi moves half of it at s=3 and the rest at s=4.
    const r=round([[0,.5,.5],[1,.5,.5],[2,.6,.5],[3,.6,.55],[4,.6,.6],[5,.6,.6],[6,.6,.6]]);
    const a=absorption([r],[0,1,2],.05);
    expect(a.map(x=>x.n)).toEqual([1,1,1]);expect(a.map(x=>x.beta)).toEqual([0,expect.closeTo(.5),expect.closeTo(1)]);
    // Seconds without a model move add nothing to a slope through the origin.
    expect(absorption([r],[2])[0].beta).toBeCloseTo(1);
    expect(share([1,2],[2,4])).toBe(2);expect(share([0],[1])).toBeNull();
  });
  it('finds the lag at which one series follows another',()=>{
    const rows:[number,number,number|null][]=[];let p=.5;const ps:number[]=[];
    for(let s=0;s<300;s++){p+=((s*7919)%101-50)/3000;ps.push(p);rows.push([s,p,s>=2?ps[s-2]:p]);}
    const c=crossCorrelation([round(rows)],x=>x.p,x=>x.mid,[0,1,2,3]);
    expect(c.reduce((best,x)=>(x.corr??-1)>(best.corr??-1)?x:best).lag).toBe(2);
  });
  it('splits a gap into the part Kalshi closed and the part the model closed',()=>{
    const r=round([[0,.6,.5],[1,.6,.5],[2,.58,.52],[3,.58,.52]]);
    const g=gapClosure([r],.05,2);expect(g.n).toBe(1);expect(g.closedByKalshi).toBeCloseTo(.2);expect(g.closedByModel).toBeCloseTo(.2);
  });
  it('prices a round trip as spread plus two taker fees',()=>{expect(roundTripCents(.01,.5)).toBeCloseTo(1+2*1.75,6);});
});
