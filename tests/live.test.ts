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
  expect(dataQuality({...ok,healthyFeeds:1}).level).toBe('unreliable');expect(dataQuality({...ok,modelReady:false}).level).toBe('unreliable');expect(dataQuality({...ok,kConfirmed:false}).level).toBe('unreliable');});
it('gate checklist agrees with the decision: all pass on BUY, at least one fails on NO TRADE',()=>{
  const b=new Orderbook();b.snapshot([['.49','40']],[['.49','40']]);
  const buy=evaluate(.65,180,b,market,1000,defaults,baseFees,ready);expect(buy.action).toBe('BUY YES');expect(buy.gates!.every(g=>g.ok)).toBe(true);
  for(const [p,tau,cond] of [[.52,180,ready],[.55,600,ready],[.65,180,{...ready,feedsHealthy:false,healthyFeeds:3}],[.65,180,{...ready,lock:'Hourly trade limit reached'}]] as const){
    const e=evaluate(p,tau,b,market,1000,defaults,baseFees,cond);expect(e.action).toBe('NO TRADE');expect(e.gates!.some(g=>!g.ok)).toBe(true);}
  const small=evaluate(.65,180,b,market,5,defaults,baseFees,ready);expect(small.action).toBe('NO TRADE');expect(small.gates!.find(g=>g.key==='size')!.ok).toBe(false);});
it('live snapshots are kept once per market and horizon',()=>{const j=new Journal(':memory:');const c=openingCall({modelP:.6,sigma:.0002,momentum30s:0,momentum120s:0,imbalance:0,tradeFlow30s:0});
  j.saveLiveCall('M',300,1,299,c,.55);j.saveLiveCall('M',300,2,290,{...c,p:.1},.2);j.saveLiveCall('M',120,3,119,c,null);expect([...j.liveHorizons('M')].sort()).toEqual([120,300]);
  expect((j.db.prepare('SELECT p FROM live_calls WHERE ticker=? AND horizon=300').get('M') as any).p).toBeCloseTo(.6);});
