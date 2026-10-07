import {it,expect} from 'vitest';
import {KalshiFeed,KalshiClient} from '../src/engine/feeds/kalshi';
// Regression: at the open Kalshi briefly lists the new market under neither status=open nor status=unopened.
it('a market missing from one refresh stays tracked until it closes',async()=>{
  const now=Date.now(),iso=(ms:number)=>new Date(now+ms).toISOString();
  const A={ticker:'A',event_ticker:'A',open_time:iso(-1000),close_time:iso(899000),status:'active'},B={ticker:'B',event_ticker:'B',open_time:iso(899000),close_time:iso(1799000),status:'initialized'},C={ticker:'C',event_ticker:'C',open_time:iso(1799000),close_time:iso(2699000),status:'initialized'};
  const responses=[{open:[A],unopened:[B]},{open:[],unopened:[B,C]}];let call=0;
  const client=new KalshiClient('','');(client as any).get=async(path:string)=>{const r=responses[Math.min(1,Math.floor(call++/2))];if(path.startsWith('/markets'))return {markets:path.includes('status=open')?r.open:r.unopened};if(path.startsWith('/series'))return {series:{fee_type:'quadratic',fee_multiplier:1}};return {event_fee_changes:[]};};
  const feed=new KalshiFeed(client,()=>{});(feed as any).connect=()=>{};
  await feed.refresh();expect(feed.markets.map(m=>m.ticker)).toEqual(['A','B']);
  await feed.refresh();expect(feed.markets.map(m=>m.ticker)).toEqual(['A','B']);
  // Fresh data still wins for markets the API does return.
  expect(feed.markets.find(m=>m.ticker==='B')!.status).toBe('initialized');});
