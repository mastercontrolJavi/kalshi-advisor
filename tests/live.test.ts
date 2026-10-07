import {it,expect} from 'vitest';
import {nextDirection,confidence,dueHorizon,dataQuality} from '../src/engine/model/live';
import {evaluate} from '../src/engine/signals';
import {defaults} from '../src/engine/config';
import {baseFees} from '../src/engine/model/fees';
import {Orderbook} from '../src/engine/feeds/orderbook';
import {Journal} from '../src/engine/journal';
import {openingCall} from '../src/engine/model/opening';
const market={ticker:'BTC',event_ticker:'BTC',open_time:'',close_time:'',status:'active'};
const ready={feedsHealthy:true,kConfirmed:true,lock:null,modelReady:true,accountReady:true,now:Date.now(),healthyFeeds:4,totalFeeds:4};
it('direction needs to clear 50% by the band to flip, so it does not flicker',()=>{
  expect(nextDirection(null,.5)).toBe('UP');expect(nextDirection(null,.49)).toBe('DOWN');
  expect(nextDirection('UP',.49)).toBe('UP');expect(nextDirection('UP',.481)).toBe('UP');expect(nextDirection('UP',.48)).toBe('DOWN');
  expect(nextDirection('DOWN',.51)).toBe('DOWN');expect(nextDirection('DOWN',.52)).toBe('UP');});
it('confidence labels by distance from 50%',()=>{expect(confidence(.52)).toBe('Toss-up');expect(confidence(.4)).toBe('Lean');expect(confidence(.75)).toBe('Likely');expect(confidence(.05)).toBe('Strong');});
it('each horizon snapshots once, only within 30 s after crossing it',()=>{expect(dueHorizon(700,new Set())).toBeNull();expect(dueHorizon(600,new Set())).toBe(600);expect(dueHorizon(575,new Set())).toBe(600);expect(dueHorizon(565,new Set())).toBeNull();expect(dueHorizon(299,new Set([600]))).toBe(300);expect(dueHorizon(299,new Set([300]))).toBeNull();});
it('data quality blocks on warming model, too few feeds or estimated K; degrades on softer issues',()=>{
  const ok={healthyFeeds:4,totalFeeds:4,kalshiLive:true,bookLive:true,kConfirmed:true,modelReady:true,clockSynced:true};
  expect(dataQuality(ok).level).toBe('solid');expect(dataQuality({...ok,healthyFeeds:3}).level).toBe('degraded');expect(dataQuality({...ok,kalshiLive:false}).level).toBe('degraded');
  expect(dataQuality({...ok,healthyFeeds:1}).level).toBe('unreliable');expect(dataQuality({...ok,modelReady:false}).level).toBe('unreliable');expect(dataQuality({...ok,kConfirmed:false}).level).toBe('degraded');});
it('timing shows as waiting (not failing) before the entry window and in the final minute',()=>{const b=new Orderbook();b.snapshot([['.49','40']],[['.49','40']]);
  const early=evaluate(.52,600,b,market,1000,{...defaults,sweetMaxSeconds:300},baseFees,ready).gates!.find(g=>g.key==='timing')!;expect(early.ok).toBe(false);expect(early.wait).toBe(true);expect(early.detail).toContain('opens in 5:00');
  const inWin=evaluate(.52,200,b,market,1000,defaults,baseFees,ready).gates!.find(g=>g.key==='timing')!;expect(inWin.ok).toBe(true);
  expect(evaluate(.52,30,b,market,1000,defaults,baseFees,ready).gates!.find(g=>g.key==='timing')!.wait).toBe(true);});
it('gate checklist agrees with the decision: all pass on BUY, at least one fails on NO TRADE',()=>{
  const b=new Orderbook();b.snapshot([['.49','40']],[['.49','40']]);
  const buy=evaluate(.65,180,b,market,1000,defaults,baseFees,ready);expect(buy.action).toBe('BUY YES');expect(buy.gates!.every(g=>g.ok)).toBe(true);expect(buy.idea!.belowMinSize).toBe(false);
  for(const [p,tau,cond] of [[.52,180,ready],[.55,600,ready],[.65,180,{...ready,feedsHealthy:false,healthyFeeds:3}],[.65,180,{...ready,lock:'Hourly trade limit reached'}]] as const){
    const e=evaluate(p,tau,b,market,1000,defaults,baseFees,cond);expect(e.action).toBe('NO TRADE');expect(e.gates!.some(g=>!g.ok)).toBe(true);}
  // A tiny balance no longer hides the signal: it fires as paper-only with 0 contracts, and the size check is advisory.
  const small=evaluate(.65,180,b,market,5,defaults,baseFees,ready);expect(small.action).toBe('BUY YES');expect(small.idea!.contracts).toBe(0);expect(small.idea!.belowMinSize).toBe(true);expect(small.reason).toContain('paper only');
  const sizeGate=small.gates!.find(g=>g.key==='size')!;expect(sizeGate.ok).toBe(false);expect(sizeGate.advisory).toBe(true);expect(small.gates!.filter(g=>!g.ok&&!g.advisory)).toHaveLength(0);
  const strict=evaluate(.65,180,b,market,5,{...defaults,signalBelowMinSize:false},baseFees,ready);expect(strict.action).toBe('NO TRADE');expect(strict.reason).toContain('Risk budget below one contract');expect(strict.gates!.find(g=>g.key==='size')!.advisory).toBe(false);
  // Size never overrides the edge/timing gates.
  expect(evaluate(.52,180,b,market,5,defaults,baseFees,ready).action).toBe('NO TRADE');});
it('live snapshots are kept once per market and horizon',()=>{const j=new Journal(':memory:');const c=openingCall({modelP:.6,sigma:.0002,momentum30s:0,momentum120s:0,imbalance:0,tradeFlow30s:0});
  j.saveLiveCall('M',300,1,299,c,.55);j.saveLiveCall('M',300,2,290,{...c,p:.1},.2);j.saveLiveCall('M',120,3,119,c,null);expect([...j.liveHorizons('M')].sort()).toEqual([120,300]);
  expect((j.db.prepare('SELECT p FROM live_calls WHERE ticker=? AND horizon=300').get('M') as any).p).toBeCloseTo(.6);});
