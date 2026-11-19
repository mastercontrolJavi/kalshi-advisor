import {it,expect} from 'vitest';
import {WebSocketServer} from 'ws';
import {defaults} from '../src/engine/config';
import {guardrails,dayKey,type RealEvent} from '../src/engine/guardrails';
import {ReconnectingSocket} from '../src/engine/feeds/socket';
import {delaySide} from '../src/engine/feeds/orderbook';
import {LoopLag} from '../src/engine/loop-lag';
import {orderFlowEnabled} from '../src/engine/feeds/microstructure';
import {fullSpeed} from '../src/engine/power';
import {spawn} from 'node:child_process';
// 2026-10-23 audit: the engine fell seconds behind Kalshi in busy minutes while an idle process on the same machine
// and connection kept up. On battery Windows ran the windowless engine 3.5–7× slower than a foreground process (power
// throttling); on that core a final-minute profile put the engine's own thread at the limit: guardrails recomputed every
// past trade's day 4×/s (11%) and inflating compressed feed frames took 17% (affordable once at full speed, see below).
it.runIf(process.platform==='win32')('a process opts itself out of Windows power throttling',async()=>{
  const target=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{windowsHide:true});
  try{const result=await new Promise<any>(r=>fullSpeed((_event,data)=>r(data),target.pid));
    expect(result).toMatchObject({ok:true,controlMask:1,stateMask:0});}
  finally{target.kill();}
},30000);
it('power throttling is left alone off Windows',()=>{expect(fullSpeed(()=>{},process.pid,'linux')).toBe(false);});

/** A trading history like the live journal's: fills, settlements with and without contracts, over many days. */
function history(n:number,now:number):RealEvent[]{
  return Array.from({length:n},(_,i)=>{const time=now-(n-i)*600_000,type=i%3===0?'settlement':'fill';
    return {id:`${type}:${i}`,time,ticker:`T${i%400}`,type,pnl:i%5?.4:-.6,contracts:type==='settlement'&&i%2?0:2,closedContracts:i%4?0:1,orderId:`o${i}`} as RealEvent;});
}
it('guardrails stay fast as the trade history grows (4 Hz on the engine loop)',()=>{
  const now=Date.UTC(2026,9,23,23,0),events=history(4000,now);guardrails(events,100,defaults,now);
  // The fastest of five batches: a machine busy with its own start-up (this test once took 196 ms right after the
  // laptop woke, and that stopped the app from starting) slows some batches, while slower code slows every one.
  let best=Infinity;
  for(let b=0;b<5;b++){const started=performance.now();for(let i=0;i<20;i++)guardrails(events,100,defaults,now+i*250);best=Math.min(best,performance.now()-started);}
  expect(best).toBeLessThan(150);
});
it('the day key is exact in every zone across DST changes, however often it is asked',()=>{
  const zones=['America/Los_Angeles','America/New_York','Asia/Kathmandu','Australia/Lord_Howe','UTC'];
  const reference=new Map(zones.map(z=>[z,new Intl.DateTimeFormat('en-CA',{timeZone:z,year:'numeric',month:'2-digit',day:'2-digit'})])),fresh=(t:number,z:string)=>reference.get(z)!.format(t);
  // Every 7 minutes for two weeks around each 2026 US DST change, plus random times over the year.
  const times=[...[Date.UTC(2026,2,1),Date.UTC(2026,9,25)].flatMap(s=>Array.from({length:2880},(_,i)=>s+i*420_000)),...Array.from({length:3000},(_,i)=>Date.UTC(2026,0,1)+((i*2654435761)%31_536_000)*1000+i)];
  for(const z of zones)for(const t of times)expect(dayKey(t,z)).toBe(fresh(t,z));
});
// In Kalshi's busiest bursts bandwidth, not CPU, is the limit: an uncompressed connection fell 7 s behind while a
// compressed one on the same PC stayed under 0.5 s (2026-10-23). Keep asking for compression.
it('feed sockets ask for per-message compression',async()=>{
  const wss=new WebSocketServer({port:0,perMessageDeflate:true});await new Promise(r=>wss.once('listening',r));
  const offered=new Promise<string|undefined>(r=>wss.once('connection',(_ws,req)=>r(req.headers['sec-websocket-extensions'])));
  const socket=new ReconnectingSocket(`ws://127.0.0.1:${(wss.address() as any).port}`,()=>[],()=>{},()=>{});socket.start();
  const extensions=await offered;socket.stop();wss.close();
  expect(extensions).toContain('permessage-deflate');
},10000);
it('a saturated engine is named as the cause, not Kalshi',()=>{
  // No single stall over 1 s, but the loop has been busy 95% of the last few seconds: the backlog is local.
  expect(delaySide(6000,300,400,.95)).toBe('engine');
  expect(delaySide(6000,300,400,.3)).toBe('kalshi');
  expect(delaySide(6000,300,400)).toBe('kalshi');
});
it('tracks how busy the event loop has been over the last few seconds',()=>{
  const l=new LoopLag(),t0=1_000_000;
  for(let i=0;i<5;i++)l.sample(t0+i*1000,10_000,20,.2);expect(l.busy).toBeCloseTo(.2,5);
  for(let i=5;i<10;i++)l.sample(t0+i*1000,10_000,20,1);expect(l.busy).toBeCloseTo(1,5);
});
it('the Coinbase order-flow recorder is off unless switched on',()=>{
  expect(orderFlowEnabled({})).toBe(false);expect(orderFlowEnabled({RECORD_ORDER_FLOW:'off'})).toBe(false);
  expect(orderFlowEnabled({RECORD_ORDER_FLOW:'on'})).toBe(true);
});
