import {it,expect} from 'vitest';
import {generateKeyPairSync,verify} from 'node:crypto';
import {RealCopy,orderBody,describeFill,QUOTE_TTL_MS} from '../src/engine/real-copy';
import {signedHeaders} from '../src/engine/feeds/kalshi';
import {baseFees,fee} from '../src/engine/model/fees';
import type {MarketNow} from '../src/engine/paper';
const now=1_792_700_000_000;
// YES asks: 71¢ ×10 then 72¢ ×100 (NO bids 29¢, 28¢); NO asks: 30¢ ×50 (YES bid 70¢).
const market=(over:Partial<MarketNow>={}):MarketNow=>({ticker:'KXNBAGAME-26OCT23HOUSAS-SAS',tau:86400,active:true,book:{yes:[[.70,50]],no:[[.29,10],[.28,100]],valid:true,updated:now},
  delayed:false,delayMs:0,schedule:baseFees,bookStaleMs:5000,now,context:{title:'San Antonio wins'},...over});
const ok={enabled:true,cap:10,balance:105.66,lock:null,now};
it('refuses a real quote unless switched on, unlocked, live and affordable',()=>{
  const r=new RealCopy();
  expect(()=>r.quote(market(),'yes',undefined,{...ok,enabled:false})).toThrow(/off: switch them on in Settings/);
  expect(()=>r.quote(market(),'yes',undefined,{...ok,lock:'Daily loss limit reached'})).toThrow(/paused: Daily loss limit reached/);
  expect(()=>r.quote(market({delayed:true}),'yes',undefined,ok)).toThrow(/not live/);
  expect(()=>r.quote(market({book:{yes:[],no:[],valid:true,updated:now-60000}}),'yes',undefined,ok)).toThrow(/not live/);
  expect(()=>r.quote(market({active:false}),'yes',undefined,ok)).toThrow(/not open/);
  expect(()=>r.quote(market(),'yes',undefined,{...ok,balance:.5})).toThrow(/Not enough/);
  expect(()=>r.quote(market(),'yes',undefined,{...ok,balance:null})).toThrow(/balance not synced/);
});
it('quotes within the cap, fee included, and remembers the worst price it may pay',()=>{
  const r=new RealCopy(),q=r.quote(market(),'yes',50,ok);
  // The $10 cap wins over the $50 asked: 10 at 71¢, then 3 at 72¢ fit with the fee.
  expect(q.cost).toBeLessThanOrEqual(10);expect(q.count).toBe(13);expect(q.limit).toBe(.72);
  expect(q.cost).toBeCloseTo(10*.71+3*.72+fee(.71,10)+fee(.72,3),6);expect(q.expires).toBe(now+QUOTE_TTL_MS);
  // A smaller amount on the card is respected.
  expect(r.quote(market(),'no',3,ok).cost).toBeLessThanOrEqual(3);
});
it('a confirmed quote is sent once, and never after it expires',()=>{
  const r=new RealCopy(),q=r.quote(market(),'yes',undefined,ok);
  expect(r.take(q.token,now+1000).ticker).toBe('KXNBAGAME-26OCT23HOUSAS-SAS');
  expect(()=>r.take(q.token,now+1000)).toThrow(/no longer valid/);
  const late=r.quote(market(),'yes',undefined,ok);expect(()=>r.take(late.token,now+QUOTE_TTL_MS+1)).toThrow(/expired/);
  expect(()=>r.take('made-up',now)).toThrow(/no longer valid/);
});
it('maps YES and NO onto Kalshi’s V2 order, immediate-or-cancel at the confirmed limit',()=>{
  const r=new RealCopy(),yes=r.quote(market(),'yes',undefined,ok),no=r.quote(market(),'no',undefined,ok);
  expect(orderBody(yes,'cid-1')).toEqual({ticker:'KXNBAGAME-26OCT23HOUSAS-SAS',client_order_id:'cid-1',side:'bid',count:'13',price:'0.7200',time_in_force:'immediate_or_cancel',self_trade_prevention_type:'taker_at_cross',cancel_order_on_pause:true});
  // Buying NO at up to 30¢ = selling YES at no less than 70¢.
  expect(orderBody(no,'cid-2')).toMatchObject({side:'ask',price:'0.7000'});
  expect(describeFill(no,{fill_count:'0.00',remaining_count:'0.00'} as any).text).toMatch(/Nothing filled.*No money was spent/);
  expect(describeFill(yes,{fill_count:'13.00',average_fill_price:'0.7123',average_fee_paid:'0.0143'}).text).toBe('Bought 13 YES on Kalshi at 71.2¢ (fee $0.19).');
  expect(describeFill(no,{fill_count:'20.00',average_fill_price:'0.7000'}).text).toMatch(/^Bought 20 NO on Kalshi at 30\.0¢ · \d+ of \d+ were gone/);
});
it('signs a POST as POST',()=>{
  const {privateKey,publicKey}=generateKeyPairSync('ed25519'),h=signedHeaders(privateKey,'id','/trade-api/v2/portfolio/events/orders?x=1',1000,'POST');
  expect(verify(null,Buffer.from('1000POST/trade-api/v2/portfolio/events/orders'),publicKey,Buffer.from(h['KALSHI-ACCESS-SIGNATURE'],'base64'))).toBe(true);
});
