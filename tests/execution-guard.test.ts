import {describe,it,expect} from 'vitest';
import {staleReasons,StaleBreaker,dangerBadges,BREAKER_CLEAR_MS,type FeedHealth} from '../src/engine/execution-guard';
import {exitComparison} from '../src/engine/exits';
import {lockReadout} from '../src/engine/quant/benchmark';
import {LockShadow,lockShadowScores} from '../src/engine/quant/lock-shadow';
import {BenchmarkFeed} from '../src/engine/feeds/benchmark';
import {KalshiClient} from '../src/engine/feeds/kalshi';
import {Journal} from '../src/engine/journal';
import {baseFees} from '../src/engine/model/fees';

const healthy:FeedHealth={kalshi:{status:'connected',bookValid:true,source:'stream',delayMs:20,silentMs:5},brti:{status:'connected',silentMs:150,delayMs:30,gapAgoMs:null}};
const k=(x:Partial<NonNullable<FeedHealth['kalshi']>>)=>({...healthy,kalshi:{...healthy.kalshi!,...x}});
const b=(x:Partial<FeedHealth['brti']>)=>({...healthy,brti:{...healthy.brti,...x}});

describe('stale-book breaker',()=>{
  it('passes healthy feeds and trips on each 500 ms or sequence condition',()=>{
    expect(staleReasons(healthy)).toEqual([]);
    expect(staleReasons(k({delayMs:501}))).toEqual(['Kalshi book 501 ms behind']);
    expect(staleReasons(k({delayMs:500}))).toEqual([]);
    expect(staleReasons(k({bookValid:false}))[0]).toMatch(/resyncing/);
    expect(staleReasons(k({status:'connecting'}))[0]).toMatch(/Kalshi stream connecting/);
    expect(staleReasons(k({silentMs:2500}))[0]).toMatch(/no Kalshi message/);
    // The REST backup is judged by its own age; the socket's status does not matter while it is in use.
    expect(staleReasons(k({source:'rest',status:'connecting',delayMs:300}))).toEqual([]);
    expect(staleReasons(k({source:'rest',delayMs:700}))).toEqual(['Kalshi book 700 ms behind']);
    expect(staleReasons(b({silentMs:600}))).toEqual(['no BRTI value for 600 ms']);
    expect(staleReasons(b({delayMs:900}))[0]).toMatch(/BRTI 900 ms later/);
    expect(staleReasons(b({gapAgoMs:200}))).toEqual(['BRTI skipped a sequence number']);
    expect(staleReasons(b({gapAgoMs:1500}))).toEqual([]);
    expect(staleReasons(b({status:'disconnected'}))).toEqual(['BRTI index disconnected']);
    expect(staleReasons({...healthy,kalshi:null})).toEqual([]);
  });
  it('trips at once and clears only after a full second of passing checks',()=>{
    const br=new StaleBreaker(),t=1_000_000;
    expect(br.update(t,[]).stale).toBe(false);
    expect(br.update(t+250,['x'])).toMatchObject({stale:true,reasons:['x'],trips:1,sinceMs:0});
    expect(br.update(t+500,[])).toMatchObject({stale:true,clearing:true,reasons:['x']});
    expect(br.update(t+750,['y'])).toMatchObject({stale:true,clearing:false,reasons:['y'],trips:1});
    expect(br.update(t+1000,[]).stale).toBe(true);
    expect(br.update(t+1000+BREAKER_CLEAR_MS-1,[]).stale).toBe(true);
    expect(br.update(t+1000+BREAKER_CLEAR_MS,[])).toMatchObject({stale:false,reasons:[],sinceMs:null});
    expect(br.update(t+5000,['z']).trips).toBe(2);
  });
});

describe('danger badges',()=>{
  const noon=Date.parse('2026-11-02T20:00:00Z');// 12:00 PST
  it('flags the 40–60¢ fee peak with the taker fee per contract',()=>{
    expect(dangerBadges(.5,noon,baseFees).peakFee).toEqual({mid:.5,feePerContract:.0175});
    expect(dangerBadges(.4,noon,baseFees).peakFee?.feePerContract).toBeCloseTo(.0168,6);
    expect(dangerBadges(.6,noon,baseFees).peakFee).not.toBeNull();
    expect(dangerBadges(.39,noon,baseFees).peakFee).toBeNull();expect(dangerBadges(.61,noon,baseFees).peakFee).toBeNull();
    expect(dangerBadges(null,noon,baseFees).peakFee).toBeNull();
  });
  it('flags 9 PM to midnight Pacific in both standard and daylight time',()=>{
    expect(dangerBadges(null,Date.parse('2026-11-02T05:30:00Z'),baseFees).lowVol).toEqual({hour:21});// 21:30 PST
    expect(dangerBadges(null,Date.parse('2026-07-01T04:00:00Z'),baseFees).lowVol).toEqual({hour:21});// 21:00 PDT
    expect(dangerBadges(null,Date.parse('2026-11-02T07:59:00Z'),baseFees).lowVol).toEqual({hour:23});
    expect(dangerBadges(null,Date.parse('2026-11-02T08:00:00Z'),baseFees).lowVol).toBeNull();// midnight
    expect(dangerBadges(null,Date.parse('2026-11-02T04:59:00Z'),baseFees).lowVol).toBeNull();// 20:59
  });
});

describe('fee-aware exit comparison',()=>{
  const book={yesBid:.6,yesAsk:.62,noBid:.38,noAsk:.4};
  it('nets hold, maker at the ask and taker at the bid against the fee-inclusive cost',()=>{
    const c=exitComparison('yes',100,.5175,book,.7,baseFees);
    expect(c.cost).toBeCloseTo(51.75,9);
    expect(c.hold).toEqual({payout:100,win:expect.closeTo(48.25,9),lose:expect.closeTo(-51.75,9),ev:expect.closeTo(18.25,9)});
    expect(c.maker).toMatchObject({price:.62,fee:0,proceeds:62,net:expect.closeTo(10.25,9)});
    // Taker: 0.07 × 100 × 0.6 × 0.4 = $1.68, the second fee.
    expect(c.taker).toMatchObject({price:.6,fee:expect.closeTo(1.68,9),feePerContract:expect.closeTo(.0168,9),proceeds:expect.closeTo(58.32,9),net:expect.closeTo(6.57,9),vsHold:expect.closeTo(-11.68,9)});
  });
  it('uses the held side, and leaves out a way that has no price',()=>{
    const c=exitComparison('no',10,.3,{...book,noAsk:null},.4,{...baseFees,makerMultiplier:1});
    expect(c.maker).toBeNull();expect(c.taker?.price).toBe(.38);
    expect(exitComparison('no',10,.3,{...book,noAsk:.4},.4,{...baseFees,makerMultiplier:1}).maker?.fee).toBeCloseTo(.0175*10*.24,4);
    expect(exitComparison('yes',10,null,null,null,baseFees)).toMatchObject({cost:null,maker:null,taker:null,hold:{payout:10,win:null,ev:null}});
  });
});

const close=1_790_000_100_000,K=80000;
const brti=(from:number,to:number,price=(t:number)=>K+((t/1000)%7)-3)=>{const out=[];for(let t=from;t<=to;t+=1000)out.push({time:t,price:price(t)});return out;};
describe('final-minute lock readout',()=>{
  it('waits before the window, then reports the locked average and what the rest must average',()=>{
    expect(lockReadout(brti(close-200000,close-70000),K,close,close-65000,4e-5)).toMatchObject({phase:'before',opensIn:5,requiredAvg:K});
    const h=brti(close-200000,close-21000,()=>K+10),r=lockReadout(h,K,close,close-20500,4e-5)!;
    expect(r).toMatchObject({phase:'locking',lockedCount:40,lockedAvg:K+10,remaining:20,spot:K+10});
    expect(r.requiredAvg).toBeCloseTo((60*K-40*(K+10))/20,9);expect(r.requiredMove).toBeCloseTo(-30,9);
    const m=20,sd=(K+10)*4e-5*Math.sqrt(m*(m+1)*(2*m+1)/6)/m;expect(r.moveSd).toBeCloseTo(sd,9);expect(r.z).toBeCloseTo(-30/sd,9);
  });
  it('settles on exactly [close − 60 s, close), and pauses on a missing second',()=>{
    const h=brti(close-200000,close,t=>t===close?1:K-1);// the close second itself must not count
    expect(lockReadout(h,K,close,close+500,4e-5)).toMatchObject({phase:'settled',lockedCount:60,settledAvg:K-1,result:'no'});
    expect(lockReadout(brti(close-200000,close-1000,()=>K),K,close,close+500,null)).toMatchObject({phase:'settled',result:'yes'});// ≥ K is YES
    expect(lockReadout(brti(close-200000,close-10000).filter(s=>s.time!==close-30000),K,close,close-9500,4e-5)).toMatchObject({phase:'gap',missing:1});
    expect(lockReadout([],K,close,close+10000,null)).toBeNull();
  });
});

describe('lock shadow log',()=>{
  const quote={yesBid:.7,yesAsk:.72,noBid:.28,noAsk:.3},obs=(time:number,p:number|null,q=quote,fresh=true)=>({ticker:'R',time,tau:(close-time)/1000,close,p,quote:q,schedule:baseFees,fresh,complete:true});
  it('records one taker fill at the next second’s ask per bucket, tracks the maker bid, and scores on the official result',()=>{
    const journal=new Journal(':memory:'),shadow=new LockShadow(journal.db);
    shadow.observe(obs(close-40000,.9));// too early for either bucket
    shadow.observe(obs(close-30000,.9));// ≤ 30 s: YES edge .9 − .72 − fee ≈ 16.6¢
    shadow.observe(obs(close-29000,.9,{...quote,yesAsk:.73}));// fills at .73; maker bid .70 rests
    shadow.observe(obs(close-20000,.9,{...quote,yesAsk:.70}));// touch only: not a trade-through
    shadow.observe(obs(close-15000,.9,{...quote,yesAsk:.69}));// trades through .70: maker filled; ≤ 15 s decides
    shadow.observe(obs(close-14000,.9,quote,false));// stale: the ≤ 15 s decision is dropped, not filled
    shadow.observe(obs(close-13000,.9));shadow.observe(obs(close-12000,.9));// re-decides, then fills
    shadow.observe(obs(close-11000,.9));// already logged: nothing new
    const rows=journal.db.prepare('SELECT bucket,decided,filled,side,taker_price,maker_limit,maker_filled FROM lock_shadow ORDER BY bucket DESC').all();
    expect(rows).toEqual([
      {bucket:30,decided:close-30000,filled:close-29000,side:'yes',taker_price:.73,maker_limit:.7,maker_filled:close-15000},
      {bucket:15,decided:close-13000,filled:close-12000,side:'yes',taker_price:.72,maker_limit:.7,maker_filled:null}]);
    expect(lockShadowScores(journal.db).buckets.map(x=>x.pending)).toEqual([1,1]);
    journal.settle('R','yes',close+5000,null,null,null,{});
    const [b30,b15]=lockShadowScores(journal.db).buckets;
    expect(b30).toMatchObject({settled:1,takerWins:1,makerPosted:1,makerFilled:1});
    expect(b30.takerAvg).toBeCloseTo(1-.73-.07*.73*.27,4);expect(b30.makerAvg).toBeCloseTo(.3,9);
    expect(b15).toMatchObject({settled:1,makerFilled:0,makerAvg:null});journal.db.close();
  });
  it('needs a 2¢ edge, a complete window and a fresh book',()=>{
    const journal=new Journal(':memory:'),shadow=new LockShadow(journal.db);
    shadow.observe(obs(close-20000,.735));shadow.observe(obs(close-19000,.735));// .735 − .72 − 1.4¢ fee < 2¢
    shadow.observe({...obs(close-18000,.95),complete:false});shadow.observe(obs(close-17000,.95,quote,false));shadow.observe(obs(close-16000,null));
    expect((journal.db.prepare('SELECT count(*) n FROM lock_shadow').get() as any).n).toBe(0);
    // NO side: p .05 → NO fair .95 vs NO ask .30.
    shadow.observe(obs(close-10000,.05));shadow.observe(obs(close-9000,.05));
    expect(journal.db.prepare('SELECT side,taker_price,maker_limit FROM lock_shadow').all()).toEqual([{side:'no',taker_price:.3,maker_limit:.28},{side:'no',taker_price:.3,maker_limit:.28}]);
    journal.db.close();
  });
});

describe('BRTI feed health',()=>{
  const msg=(seq:number,time:number)=>({type:'cfbenchmarks_value_5hz',sid:2,seq,msg:{index_id:'BRTI',source_ts_ms:time,value_usd:'80000',data:JSON.stringify({type:'value',id:'BRTI',time,value:'80000'})}});
  it('reports arrival silence, delivery delay above the floor, and skipped sequence numbers',()=>{
    const feed=new BenchmarkFeed(new KalshiClient('',''));feed.status='connected';const t=1_790_000_000_000;
    expect(feed.health(t).silentMs).toBeNull();
    feed.handle(msg(1,t),t+100);feed.handle(msg(2,t+200),t+300);
    expect(feed.health(t+400)).toMatchObject({silentMs:100,delayMs:0,gapAgoMs:null});
    feed.handle(msg(3,t+400),t+1300);// arrives 800 ms later than the usual 100 ms
    expect(feed.health(t+1300).delayMs).toBe(800);
    feed.handle(msg(5,t+600),t+1400);expect(feed.health(t+1500)).toMatchObject({gapAgoMs:100});expect(feed.gaps).toBe(1);
  });
});
