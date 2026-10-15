import {it,expect} from 'vitest';
import {fitStack,predict,priorFit,logit,sigmoid,effectiveWeights,type StackSample} from '../src/engine/quant/stack';
import {autoBasis,nextWindow} from '../src/engine/quant/forecast';
import {scalp,dips} from '../src/engine/quant/tactics';
import {baseFees} from '../src/engine/model/fees';
const neutral={sigma:.00003,momentum30s:0,momentum120s:0,imbalance:0,tradeFlow30s:0};
it('with no data the stack is a 90%-Kalshi logit blend of model and Kalshi, and falls back to the model without a mid',()=>{
  const p=predict(priorFit(),{...neutral,modelP:.9,mid:.6}).p;expect(p).toBeCloseTo(sigmoid(.1*logit(.9)+.9*logit(.6)),6);
  expect(predict(priorFit(),{...neutral,modelP:.8,mid:null}).p).toBeCloseTo(.8,6);
  expect(predict(priorFit(),{...neutral,modelP:.5,mid:.5}).p).toBeCloseTo(.5,6);});
it('learns to trust the source that actually predicts outcomes, and scores itself out of sample',()=>{
  let seed=7;const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const samples:StackSample[]=[];
  // The prior already leans on Kalshi, so the test makes Kalshi the noisy source: the fit must learn to move back.
  for(let i=0;i<300;i++){const truth=.05+.9*rnd(),noisyMid=Math.min(.99,Math.max(.01,truth+(rnd()-.5)*.8));
    samples.push({...neutral,modelP:truth,mid:noisyMid,y:rnd()<truth?1:0,ticker:'M'+(i%60),horizon:'300'});}
  const fit=fitStack(samples),w=effectiveWeights(fit,'fittedWeights');expect(w.model).toBeGreaterThan(w.kalshi);expect(fit.markets).toBe(60);
  expect(fit.cv.stack!).toBeLessThan(fit.cv.kalshi!);expect(fit.cv.markets).toBe(60);expect(fit.active).toBe('fitted');expect(fit.weights).toEqual(fit.fittedWeights);});
it('keeps the prior blend until the fit beats it out of sample with enough markets',()=>{
  let seed=11;const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const few:StackSample[]=Array.from({length:40},(_,i)=>({...neutral,modelP:.2+.6*rnd(),mid:.5,y:rnd()<.5?1:0,ticker:'F'+(i%10),horizon:'300'}));
  const fit=fitStack(few);expect(fit.active).toBe('prior');expect(fit.weights).toEqual(priorFit().weights);expect(fit.markets).toBe(10);});
it('feature weights stay near zero unless the data supports them',()=>{
  let seed=3;const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const samples:StackSample[]=Array.from({length:40},(_,i)=>({...neutral,momentum120s:(rnd()-.5)*.001,modelP:.5,mid:.5,y:rnd()<.5?1:0,ticker:'T'+i,horizon:'600'}));
  expect(Math.abs(fitStack(samples).weights[3])).toBeLessThan(.15);});
it('auto basis is −median of recent errors, shrunk while the sample is small',()=>{
  expect(autoBasis([-3,-4]).correction).toBe(0);const b=autoBasis([-4,-3,-5,-4,10]);expect(b.correction).toBeCloseTo(4*5/10);expect(b.n).toBe(5);});
it('next-window head start is zero before the final minute and follows the locked average inside it',()=>{
  const early=nextWindow(84000,.00003,300,[]);expect(early.pUp).toBeCloseTo(.5,6);expect(early.headStart).toBe(0);
  const locked=Array(30).fill(83990),late=nextWindow(84000,.00003,30,locked);expect(late.headStart).toBeCloseTo(5);expect(late.pUp).toBeGreaterThan(.5);
  const v=(.00003*84000)**2;expect(nextWindow(84000,.00003,60,[]).headStartSd).toBeCloseTo(Math.sqrt(20*v),6);
  expect(late.expectedK).toBeCloseTo((30*83990+30*84000)/60);});
const quote=(yesAsk:number,noAsk:number,spread=.01)=>({yesAsk,yesBid:+(yesAsk-spread).toFixed(2),noAsk,noBid:+(noAsk-spread).toFixed(2),yesDepth:100,noDepth:100});
const cfg={scalpMinEdge:.03,scalpMinSeconds:180,scalpMaxSpread:.03,dipMove:.08,minDepth:20,minEdge:.04};
it('scalp needs enough edge after fees, time and a tight spread; target sits between entry and fair',()=>{
  const s=scalp(.62,400,quote(.52,.49),baseFees,cfg)!;expect(s.side).toBe('yes');expect(s.target).toBeGreaterThan(.52);expect(s.target).toBeLessThanOrEqual(.61);expect(s.profitAtTarget).toBeGreaterThan(.01);
  expect(scalp(.62,100,quote(.52,.49),baseFees,cfg)).toBeNull();expect(scalp(.54,400,quote(.52,.49),baseFees,cfg)).toBeNull();expect(scalp(.62,400,quote(.52,.49,.06),baseFees,cfg)).toBeNull();});
it('a sharp drop with unchanged fair value is a dip to buy; a drop the model agrees with is a falling knife',()=>{
  const hist=[{time:0,yesAsk:.62,noAsk:.39,q:.62},{time:30000,yesAsk:.55,noAsk:.46,q:.61}];
  const buy=dips(hist,50000,.61,quote(.52,.49),baseFees,cfg,400);expect(buy.watch[0].verdict).toBe('buy');expect(buy.idea?.kind).toBe('dip');expect(buy.idea!.target).toBeGreaterThan(.52);
  const knife=dips(hist,50000,.5,quote(.52,.49),baseFees,cfg,400);expect(knife.watch[0].verdict).toBe('knife');expect(knife.idea).toBeNull();
  expect(dips(hist,50000,.61,quote(.58,.43),baseFees,cfg,400).watch).toHaveLength(0);});
