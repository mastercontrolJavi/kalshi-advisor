import {it,expect} from 'vitest';
import {Journal} from '../src/engine/journal';
import {PriceForecastJournal} from '../src/engine/quant/price-journal';
import {emptyPriceFit,priceInputs,priceTraining,fitPrice,forecastPrice,priceProjection,priceScores,PRICE_HORIZONS,type PriceTraining} from '../src/engine/quant/price-forecast';

const prices=Array.from({length:1001},(_,i)=>({time:i*1000,price:80000+Math.sin(i/8)*15+i*.05}));
const input={time:360000,spot:80000,sigma:.00005,x:[1,.5,.2,.1,.1,.1,.1,.1]};
it('closed-candle features are causal and require uninterrupted, valid past prices',()=>{
  const a=priceInputs(prices,360000);expect(a).not.toBeNull();expect(a!.x.every(Number.isFinite)).toBe(true);
  expect(priceInputs([...prices.filter(s=>s.time<=360000),{time:361000,price:999999}],360000)).toEqual(a);
  expect(priceInputs(prices.filter(s=>s.time!==200000),360000)).toBeNull();
  expect(priceInputs(prices.map(s=>s.time===200000?{...s,price:NaN}:s),360000)).toBeNull();
});
it('training targets use the exact future deadline and cannot form before that endpoint exists',()=>{
  const rows=priceTraining(prices,30);expect(rows.length).toBeGreaterThan(10);
  for(const r of rows){expect(r.time%30000).toBe(0);expect(r.targetTime-r.time).toBe(30000);expect(r.z).toBeCloseTo(Math.log(prices[r.targetTime/1000].price/r.spot)/(r.sigma*Math.sqrt(30)));}
  expect(priceTraining(prices.filter(s=>s.time<=360000),30).some(r=>r.time===360000)).toBe(false);
  expect(priceTraining(prices.filter(s=>s.time!==390000),30).some(r=>r.time===360000)).toBe(false);
});
function synthetic(signal:boolean){let seed=25;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return (seed+1)/4294967297;};
  return Array.from({length:1200},(_,i)=>{const x=rand()*2-1,noise=Math.sqrt(-2*Math.log(rand()))*Math.cos(2*Math.PI*rand())*.8;return {time:i*180000,targetTime:i*180000+30000,horizon:30,spot:80000,sigma:.0001,x:[1,x,0,0,0,0,0,0],z:(signal?1.8*x:0)+noise} as PriceTraining;});
}
it('adopts a predictive feature only after chronological tests, with future labels purged',()=>{
  const rows=synthetic(true),fit=fitPrice(rows,30,rows.at(-1)!.targetTime);expect(fit.active).toBe(true);expect(fit.validation.improvement!).toBeGreaterThan(.005);expect(fit.validation.improvementLow!).toBeGreaterThan(0);expect(fit.validation.blocks).toBeGreaterThanOrEqual(20);
  expect(fit.folds).toHaveLength(3);for(const fold of fit.folds)expect(fold.trainThrough).toBeLessThan(fold.testFrom-180000);
  expect(forecastPrice({...input,x:[1,1,0,0,0,0,0,0],time:fit.fitted},fit).direction).toBe('UP');
});
it('noise and inadequate evidence stay UNCLEAR, with a 50–50 forecast',()=>{
  const rows=synthetic(false),fit=fitPrice(rows,30,rows.at(-1)!.targetTime);expect(fit.active).toBe(false);
  const p=forecastPrice({...input,time:fit.fitted},fit);expect(p.direction).toBe('UNCLEAR');expect(p.pUp).toBe(.5);
  expect(fitPrice(synthetic(true).slice(0,80),30,1e10).active).toBe(false);
});
it('observations that have not happened cannot change a fit',()=>{
  const rows=synthetic(true),now=rows[700].targetTime,a=fitPrice(rows,30,now);
  const b=fitPrice(rows.map((r,i)=>i>700?{...r,z:1000,x:[1,1,1,1,1,1,1,1]}:r),30,now);
  expect(b).toEqual(a);
});
it('an expired fit cannot continue producing confident directional calls',()=>{
  const fit={...emptyPriceFit(60),active:true,fitted:360000,weights:[0,1,0,0,0,0,0,0]};
  expect(forecastPrice(input,fit,360000).active).toBe(true);
  const expired=forecastPrice(input,fit,360000+30*60000);expect(expired.active).toBe(false);expect(expired.pUp).toBe(.5);expect(expired.reason).toContain('expired');
});
it('future ranges start at the observed spot, end at the stated horizon, and widen with uncertainty',()=>{
  const p=forecastPrice(input,emptyPriceFit(180)),points=priceProjection(p);
  expect(points[0]).toEqual({time:360,expected:80000,low:80000,high:80000});
  expect(points.at(-1)!.time).toBe(540);expect(points.at(-1)!.low).toBe(p.low);expect(points.at(-1)!.high).toBe(p.high);
  expect(points.every((p,i)=>!i||p.time>points[i-1].time)).toBe(true);expect(p.low).toBeLessThan(p.expected);expect(p.high).toBeGreaterThan(p.expected);
  expect(priceProjection(p,5)).toHaveLength(37);expect(priceProjection(p,60)).toHaveLength(4);
  expect(priceProjection(p,300).at(-1)!.time).toBe(540);
});
it('probability scores distinguish flat prices and abstentions from correct direction calls',()=>{
  const score=priceScores([{p:.5,z:1,mean:0,noise:1,direction:'UNCLEAR'},{p:.8,z:1,mean:1,noise:1,direction:'UP'},{p:.8,z:-1,mean:1,noise:1,direction:'UP'},{p:.5,z:0,mean:0,noise:1,direction:'UNCLEAR'}]);
  expect(score.n).toBe(3);expect(score.calls).toBe(2);expect(score.hits).toBe(1);expect(score.baseline).toBe(.25);expect(score.coverage).toBe(.75);
});
it('live forecasts persist before the result and cannot be overwritten by a later estimate',()=>{
  const j=new Journal(':memory:'),record=new PriceForecastJournal(j.db);try{
    record.capture(input.time,input,PRICE_HORIZONS.map(emptyPriceFit));record.capture(input.time,{...input,spot:90000},PRICE_HORIZONS.map(emptyPriceFit));
    expect((j.db.prepare('SELECT COUNT(*) n FROM price_forecasts').get() as any).n).toBe(3);
    record.settle([{time:389000,price:81000}],389000,true);expect(record.scores()[30].n).toBe(0);
    record.settle([{time:390000,price:81000}],390000,true);const row=j.db.prepare('SELECT * FROM price_forecasts WHERE horizon=30').get() as any;
    expect(row.spot).toBe(80000);expect(row.actual).toBe(81000);expect(row.actual_time).toBe(390000);expect(row.status).toBe('scored');expect(record.scores()[30].calls).toBe(0);expect(record.scores()[30].n).toBe(1);
    expect(j.export('price_forecasts')).toContain('target_time');
  }finally{j.db.close();}
});
it('missing and unhealthy deadline prices are excluded instead of forward-filled',()=>{
  const j=new Journal(':memory:'),record=new PriceForecastJournal(j.db);try{
    record.capture(input.time,input,[emptyPriceFit(30)]);record.settle([{time:389000,price:81000}],392000,true);expect(record.scores()[30].missing).toBe(1);expect(record.scores()[30].n).toBe(0);
    record.capture(420000,{...input,time:420000},[emptyPriceFit(30)]);record.settle([{time:450000,price:80000}],450000,false);expect(record.scores()[30].pending).toBe(1);
    record.settle([{time:450000,price:80000}],452000,false);expect(record.scores()[30].missing).toBe(2);
  }finally{j.db.close();}
});
it('late restart outcomes are marked missing and flat prices do not become direction wins',()=>{
  const j=new Journal(':memory:'),record=new PriceForecastJournal(j.db);try{
    record.capture(input.time,input,[emptyPriceFit(30)]);record.settle([{time:390000,price:81000}],400000,true);expect(record.scores()[30].missing).toBe(1);
    record.capture(420000,{...input,time:420000},[emptyPriceFit(30)]);record.settle([{time:450000,price:80000}],450000,true);expect(record.scores()[30].flat).toBe(1);expect(record.scores()[30].n).toBe(0);expect(record.scores()[30].calls).toBe(0);
  }finally{j.db.close();}
});
it('the 80% range covers about 80% of later outcomes even when rare jumps inflate the RMS error',()=>{
  // Mostly normal moves with occasional 8σ jumps: the RMS-based scale overstates typical spread.
  let seed=7;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return (seed+1)/4294967297;};
  const rows=Array.from({length:1500},(_,i)=>{const n=Math.sqrt(-2*Math.log(rand()))*Math.cos(2*Math.PI*rand()),jump=rand()<.03?(rand()<.5?-8:8):0;
    return {time:i*180000,targetTime:i*180000+30000,horizon:30,spot:80000,sigma:.0001,x:[1,0,0,0,0,0,0,0],z:n+jump} as PriceTraining;});
  const fit=fitPrice(rows,30,rows.at(-1)!.targetTime);
  expect(fit.band!).toBeLessThan(fit.noise);expect(fit.validation.coverage!).toBeGreaterThan(.74);expect(fit.validation.coverage!).toBeLessThan(.86);
  const p=forecastPrice({...input,time:fit.fitted},fit);expect(p.logSD).toBeCloseTo(fit.band!*input.sigma*Math.sqrt(30));
});
