import {it,expect} from 'vitest';
import {defaults,validateConfig} from '../src/engine/config';
import {size,evaluate,roundDownTick} from '../src/engine/signals';
import {baseFees} from '../src/engine/model/fees';
import {Orderbook} from '../src/engine/feeds/orderbook';
import {guardrails,fillWarnings,dayKey,type RealEvent} from '../src/engine/guardrails';
const market={ticker:'BTC',event_ticker:'BTC',open_time:'',close_time:'',status:'active'};
const ready={feedsHealthy:true,kConfirmed:true,lock:null,modelReady:true,accountReady:true,now:Date.now()};
it('Kelly caps contracts and dollars including fees',()=>{expect(size(.9,.5,10000,defaults,baseFees).contracts).toBe(25);expect(size(.9,.5,100,defaults,baseFees).maxLoss).toBeLessThanOrEqual(2);expect(size(.4,.5,100,defaults,baseFees).contracts).toBe(0);});
it('fires both sides symmetrically with gate reasons',()=>{const b=new Orderbook();b.snapshot([['.49','40']],[['.49','40']]);expect(evaluate(.65,180,b,market,1000,defaults,baseFees,ready).action).toBe('BUY YES');expect(evaluate(.35,180,b,market,1000,defaults,baseFees,ready).action).toBe('BUY NO');expect(evaluate(.65,180,b,market,1000,defaults,baseFees,{...ready,feedsHealthy:false}).reason).toContain('stale');expect(evaluate(.65,180,b,market,1000,defaults,baseFees,{...ready,kConfirmed:false}).action).toBe('NO TRADE');expect(evaluate(.65,59,b,market,1000,defaults,baseFees,ready).action).toBe('NO TRADE');});
it('maker respects tick ranges',()=>expect(roundDownTick(.0875,{...market,price_ranges:[{start:'0',end:'.1',step:'.001'}]})).toBe(.087));
const event=(id:string,time:number,pnl:number,type:'fill'|'settlement'='settlement'):RealEvent=>({id,time,pnl,type,ticker:id,contracts:1});
const limitsOn={...defaults,guardrails:true};
it('with the limits off (the default since 2026-10-28) nothing locks, and the day is still reported',()=>{const now=Date.now(),events=[event('1',now-3,-40),event('2',now-2,-40),event('3',now-1,-40)],g=guardrails(events,100,defaults,now);expect(defaults.guardrails).toBe(false);expect(g).toMatchObject({locked:false,dailyLocked:false,reason:null,cooldownUntil:0,pnl:-120,streak:-3});const hourly=Array.from({length:6},(_,i)=>({...event(String(i),now-100,-.01,'fill'),orderId:String(i)}));expect(guardrails(hourly,100,defaults,now).locked).toBe(false);});
it('daily loss lock and explicit same-day override',()=>{const now=Date.now(),events=[event('1',now,-11)];expect(guardrails(events,100,limitsOn,now).dailyLocked).toBe(true);expect(guardrails(events,100,limitsOn,now,dayKey(now)).dailyLocked).toBe(false);});
it('three consecutive losses trigger cooldown, expires',()=>{const now=Date.now(),events=[event('1',now-3,-1),event('2',now-2,-1),event('3',now-1,-1)];expect(guardrails(events,100,limitsOn,now).reason).toContain('cooldown');expect(guardrails(events,100,limitsOn,now+1800001).locked).toBe(false);});
it('hourly cap counts orders once across partial fills',()=>{const now=Date.now();const events=Array.from({length:4},(_,i)=>({...event(String(i),now-100,-.01,'fill'),orderId:String(i)}));events.push(events[0]);expect(guardrails(events,100,limitsOn,now).hourly).toBe(4);expect(guardrails(events,100,limitsOn,now).reason).toContain('Hourly');});
it('chase and oversize warnings',()=>expect(fillWarnings({...event('1',100000,0,'fill'),price:.7,contracts:30},25,[{time:50000,price:.5}],defaults)).toHaveLength(2));
it('invalid settings rejected',()=>{expect(()=>validateConfig({minEdge:-1})).toThrow();expect(()=>validateConfig({maxContracts:2.5})).toThrow();expect(()=>validateConfig({feePrecision:0})).toThrow();});
it('realized closing fills also trigger loss cooldown before settlement',()=>{const now=Date.now(),events=Array.from({length:3},(_,i)=>({...event(String(i),now-i-1,-1,'fill'),closedContracts:1,orderId:String(i)}));expect(guardrails(events,100,limitsOn,now).reason).toContain('cooldown');});
it('advise is the default exit style and every style validates',()=>{expect(defaults.exitMode).toBe('advise');for(const m of ['advise','hold','risk','ev'])expect(validateConfig({exitMode:m}).exitMode).toBe(m);expect(()=>validateConfig({exitMode:'yolo'})).toThrow('exitMode');});
it('final-minute entries stay closed unless the user allows them, and never inside the last 5 s',()=>{
  const b=new Orderbook();b.snapshot([['.49','40']],[['.49','40']]);const r={...ready,now:Date.now()};
  const off=evaluate(.75,30,b,market,1000,defaults,baseFees,r);expect(off.action).toBe('NO TRADE');expect(off.reason).toContain('Outside entry window');
  expect(off.gates!.find(g=>g.key==='timing')!.detail).toContain('final minute');
  const on={...defaults,finalMinuteSignals:true};expect(evaluate(.75,30,b,market,1000,on,baseFees,r).action).toBe('BUY YES');
  expect(evaluate(.75,30,b,market,1000,on,baseFees,r).gates!.find(g=>g.key==='timing')!.ok).toBe(true);
  expect(evaluate(.75,4,b,market,1000,on,baseFees,r).action).toBe('NO TRADE');expect(defaults.finalMinuteSignals).toBe(false);});
it('averaging down into a losing side is called out on the fill',()=>{
  const buy=(id:string,time:number,price:number,side='yes'):RealEvent=>({id,time,pnl:0,type:'fill',ticker:'T',contracts:5,side,price,action:'buy'});
  const w=fillWarnings(buy('b',2000,.32),null,[],defaults,[buy('a',1000,.73),buy('c',3000,.2)]);expect(w).toContain('Averaging down: bought more YES at 32¢ after 73¢');
  expect(fillWarnings(buy('b',2000,.7),null,[],defaults,[buy('a',1000,.73)])).toHaveLength(0);
  expect(fillWarnings(buy('b',2000,.3,'no'),null,[],defaults,[buy('a',1000,.73)])).toHaveLength(0);});
import {latchSignal,emptyLatch,limitPrice,type Latch} from '../src/engine/signals';
it('firm signals: a BUY shows only after 3 s, then stays through blips until the edge is gone for 3 s',()=>{
  const ev=(action:string)=>({action,reason:'r',idea:null,makers:[],edges:{yes:null,no:null}});
  let l:Latch=emptyLatch();const step=(t:number,action:string,yesAsk=.5,p=.6,hard:string|null=null)=>{const r=latchSignal(l,ev(action),p,{yesAsk,noAsk:1-yesAsk+.01},defaults,baseFees,100,t,hard);l=r.latch;return r.evaluation;};
  expect(step(0,'BUY YES').action).toBe('NO TRADE');expect(step(1000,'BUY YES').forming!.side).toBe('yes');
  // A 2-second flash never shows.
  expect(step(2000,'NO TRADE').action).toBe('NO TRADE');expect(step(4500,'BUY YES').action).toBe('NO TRADE');
  expect(step(7500,'BUY YES').action).toBe('BUY YES');const limit=l.limit!;expect(limit).toBe(limitPrice(.6,defaults.minEdge,baseFees));
  // The raw rule drops out (spread blip) but the edge at the ask is still ≥ 1¢: still BUY, same limit.
  expect(step(8500,'NO TRADE',.55,.6).action).toBe('BUY YES');expect(l.limit).toBe(limit);
  // Forecast nudges the limit by under 2¢: unchanged.
  step(9000,'NO TRADE',.5,.61);expect(l.limit).toBe(limit);
  // Edge under 1¢ for 3 s releases it.
  expect(step(10000,'NO TRADE',.6,.6).action).toBe('BUY YES');expect(step(12900,'NO TRADE',.6,.6).action).toBe('BUY YES');expect(step(13100,'NO TRADE',.6,.6).action).toBe('NO TRADE');
  // A hard gate ends a standing signal at once.
  for(const t of [20000,21000,23100])step(t,'BUY YES');expect(l.side).toBe('yes');expect(step(23500,'BUY YES',.5,.6,'Price feeds: stale').action).toBe('NO TRADE');});
it('firm signals: a flip to the other side needs its own 3 s',()=>{
  const ev=(action:string)=>({action,reason:'r',idea:null,makers:[],edges:{yes:null,no:null}});
  let l:Latch=emptyLatch();const step=(t:number,action:string,p:number)=>{const r=latchSignal(l,ev(action),p,{yesAsk:.5,noAsk:.51},defaults,baseFees,100,t,null);l=r.latch;return r.evaluation.action;};
  for(const t of [0,1000,3000])step(t,'BUY YES',.6);expect(l.side).toBe('yes');
  expect(step(4000,'BUY NO',.4)).toBe('BUY YES');expect(step(6000,'BUY NO',.4)).toBe('BUY YES');expect(step(7000,'BUY NO',.4)).toBe('BUY NO');});
// Regression (2026-11-17 audit): `'__proto__' in defaults` is true (inherited), so {"__proto__":{}} passed as a known
// setting and replaced the validated config's prototype instead of being rejected as unknown.
it('settings reject inherited Object keys such as __proto__',async()=>{
  const {validateConfig,defaults}=await import('../src/engine/config');
  expect(()=>validateConfig(JSON.parse('{"__proto__":{}}'))).toThrow('Unknown setting __proto__');
  expect(()=>validateConfig(JSON.parse('{"__proto__":null}'))).toThrow('Unknown setting __proto__');
  expect(Object.getPrototypeOf(validateConfig({...defaults}))).toBe(Object.prototype);
});
