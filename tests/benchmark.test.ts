import {describe,it,expect} from 'vitest';
import {KalshiClient} from '../src/engine/feeds/kalshi';
import {BenchmarkFeed,parseBenchmark} from '../src/engine/feeds/benchmark';
import {benchmarkForecast} from '../src/engine/quant/benchmark';
import {BenchmarkJournal,benchmarkScores} from '../src/engine/quant/benchmark-journal';
import {Journal} from '../src/engine/journal';
const base=1_790_000_000_000;
const message=(time=base,price=80000,fast=false)=>({type:fast?'cfbenchmarks_value_5hz':'cfbenchmarks_value',msg:{index_id:'BRTI',data:JSON.stringify({type:'value',id:'BRTI',time,value:String(price)}),...(fast?{source_ts_ms:time,value_usd:String(price)}:{})}});
describe('official benchmark data integrity',()=>{
  it('parses raw index values and rejects malformed frames, wrong IDs and conflicting fields',()=>{
    expect(parseBenchmark(message(),base+100)).toMatchObject({price:80000,time:base,received:base+100});
    expect(parseBenchmark(message(base+200,80001,true))?.time).toBe(base+200);
    for(const m of [{type:'ticker'}, {...message(),msg:{index_id:'ETHUSD_RTI'}},{...message(),msg:{...message().msg,data:'bad'}},message(base,-1),message(base,Infinity),message(base+1),{...message(),msg:{...message().msg,value_usd:'1'}}])expect(parseBenchmark(m)).toBeNull();
  });
  it('rejects future and nonmonotonic ticks, stores 1Hz separately, and suppresses stale/disconnected data',()=>{
    const client=new KalshiClient('',''),saved:unknown[]=[],feed=new BenchmarkFeed(client,()=>{},t=>saved.push(t));feed.status='connected';
    expect(feed.handle(message(),base+100)).toBe(true);expect(feed.handle(message(),base+200)).toBe(false);
    expect(feed.handle(message(base-1000),base+200)).toBe(false);expect(feed.handle(message(base+10000),base+200)).toBe(false);
    expect(feed.handle(message(base+200,80002,true),base+300)).toBe(true);expect(feed.history).toHaveLength(1);expect(saved).toHaveLength(2);
    expect(feed.snapshot(base+400)).toMatchObject({price:80002,ageMs:200,highFrequency:true,available:true});
    expect(feed.current(base-1)).toBeNull();expect(feed.current(base+2501)).toBeNull();feed.status='disconnected';expect(feed.current(base+500)).toBeNull();
  });
  it('uses source time with the measured server clock offset, not receive time as index freshness',()=>{
    const client=new KalshiClient('','');client.clockOffset=500;const feed=new BenchmarkFeed(client);feed.status='connected';
    feed.handle(message(),base-400);expect(feed.current(base)).not.toBeNull();expect(feed.snapshot(base).ageMs).toBe(500);
    expect(feed.current(base+2001)).toBeNull();
  });
  it('keeps the last fresh observation when coarse clock correction places the newest tick slightly ahead',()=>{
    const client=new KalshiClient('',''),feed=new BenchmarkFeed(client);feed.status='connected';
    feed.handle(message(),base+100);feed.handle(message(base+1000,80001),base+900);
    expect(feed.current(base+950)?.time).toBe(base);expect(feed.current(base+1100)?.time).toBe(base+1000);
  });
});
const prices=(end:number)=>Array.from({length:180},(_,i)=>({time:end-(179-i)*1000,price:80000+Math.sin(i/3)*15}));
describe('benchmark settlement challenger',()=>{
  it('uses [close−60s, close) and complete contiguous official observations',()=>{
    const close=base+180000,history=prices(close-10000),forecast=benchmarkForecast(history,80000,close,close-9900)!;
    expect(forecast.lockedCount).toBe(51);expect(forecast.active).toBe(false);expect(forecast.p).toBeGreaterThan(0);
    expect(benchmarkForecast(prices(close-61000),80000,close,close-60900)?.lockedCount).toBe(0);
    expect(benchmarkForecast(prices(close-60000),80000,close,close-59900)?.lockedCount).toBe(1);
    // With the last pre-close second in, all 60 are locked and the expected average is exactly Kalshi's settlement value.
    const full=prices(close-1000),settled=benchmarkForecast(full,80000,close,close-900)!,window=full.filter(s=>s.time>=close-60000&&s.time<close);
    expect(settled.lockedCount).toBe(60);expect(window).toHaveLength(60);
    expect(settled.expected).toBeCloseTo(window.reduce((sum,s)=>sum+s.price,0)/60,9);expect(settled.variance).toBe(0);
    expect(benchmarkForecast(history.slice(-120),80000,close,close-9900)).toBeNull();
    expect(benchmarkForecast(history.filter((_,i)=>i!==170),80000,close,close-9900)).toBeNull();
    expect(benchmarkForecast(history,80000,close,close-7000)).toBeNull();expect(benchmarkForecast(history,80000,close,close)).toBeNull();
    expect(benchmarkForecast(history,80000,close,close-11000)).toBeNull();
  });
  it('records immutable paired checkpoint scores, rejects retrospective captures, and never counts raw ticks as outcomes',()=>{
    const journal=new Journal(':memory:'),j=new BenchmarkJournal(journal.db);
    j.tick(parseBenchmark(message(),base+100)!);j.tick(parseBenchmark(message(),base+100)!);
    expect((journal.db.prepare('SELECT count(*) n FROM benchmark_ticks').get() as any).n).toBe(1);
    j.capture('round',base,60,{p:.8,sourceTime:base},.7,.75,.6,{});
    j.capture('round',base+1000,59,{p:.2,sourceTime:base+1000},.3,.4,.5,{});
    j.capture('future',base,60,{p:.8,sourceTime:base+1000},.7,.75,.6,{});
    j.capture('invalid',base,60,{p:NaN,sourceTime:base},.7,.75,.6,{});
    expect(benchmarkScores(journal.db).find(s=>s.horizon===60)).toMatchObject({pending:1,paired:0,brier:null});
    journal.settle('round','yes',base+60000,null,null,null,{});
    j.capture('round',base+30000,30,{p:.99,sourceTime:base+30000},.7,.75,.6,{});
    const scores=benchmarkScores(journal.db);expect(scores.find(s=>s.horizon===60)).toMatchObject({pending:0,paired:1});
    expect(scores.find(s=>s.horizon===60)?.brier).toBeCloseTo(.04);expect(scores.find(s=>s.horizon===30)?.paired).toBe(0);
    expect((journal.db.prepare('SELECT count(*) n FROM benchmark_forecasts').get() as any).n).toBe(1);journal.db.close();
  });
});
