import {it,expect,vi} from 'vitest';
import {Orderbook,FeedDelay,MAX_BOOK_DELAY_MS,MAX_LOOP_LAG_MS,delaySide} from '../src/engine/feeds/orderbook';
import {ProxyFeed,type Venue} from '../src/engine/feeds/proxy';
import {LoopLag} from '../src/engine/loop-lag';
import {RestProbe,compareRest} from '../src/engine/rest-probe';
import {delayCause,backupNote} from '../src/components/delay-cause';
import {KalshiFeed,KalshiClient} from '../src/engine/feeds/kalshi';
import {evaluate} from '../src/engine/signals';
import {defaults} from '../src/engine/config';
import {baseFees} from '../src/engine/model/fees';
it('measures how far the stream is behind Kalshi, whatever the clock difference',()=>{
  // Local clock 900 ms ahead of Kalshi's plus ~100 ms network: the floor absorbs both.
  const d=new FeedDelay(),t0=1_792_000_000_000;
  for(let i=0;i<50;i++)d.observe(t0+i*100,t0+i*100+1000+(i%3)*20);
  expect(d.ms).toBeLessThan(100);expect(d.delayed).toBe(false);
  // A busy final minute: messages sent at t arrive 30 s later.
  d.observe(t0+10_000,t0+10_000+31_000);expect(d.ms).toBeCloseTo(30_000,-2);expect(d.delayed).toBe(true);
  // Catching up clears it.
  d.observe(t0+45_000,t0+46_000);expect(d.delayed).toBe(false);
  // The floor forgets values older than the window, so a lasting clock change re-baselines instead of alarming forever.
  d.observe(t0+800_000,t0+800_000+5_000);d.observe(t0+800_100,t0+800_100+5_000);expect(d.ms).toBe(0);
  d.reset();d.observe(t0,t0+3000);expect(d.ms).toBe(0);expect(MAX_BOOK_DELAY_MS).toBe(2000);
});
it('reads book delay and keeps 2 min of trades without re-copying the list per trade',()=>{
  const f=new KalshiFeed(new KalshiClient('',''),()=>{});f.books.set('A',new Orderbook());const t0=Date.now();
  f.handle({type:'orderbook_snapshot',sid:2,sending_ts_ms:t0-25_000,msg:{market_ticker:'A'}});
  f.handle({type:'orderbook_snapshot',sid:2,sending_ts_ms:t0-25_000+50,msg:{market_ticker:'A'}});expect(f.delay.ms).toBeLessThan(1000);
  // 3 min of trades at 1,000 a second: the old per-trade filter took ~57 s for one minute of this.
  const started=performance.now();
  for(let s=0;s<180;s++)for(let i=0;i<1000;i++){f.lastMessage=t0+s*1000;f.handle({type:'trade',sid:2,msg:{market_ticker:'A',yes_price_dollars:'0.41',count_fp:'5',taker_side:'yes',ts_ms:t0+s*1000+i}});}
  expect(performance.now()-started).toBeLessThan(5000);
  expect(f.trades.length).toBeGreaterThanOrEqual(120_000);expect(f.trades.length).toBeLessThanOrEqual(122_000);
  expect(f.trades[0].time).toBeGreaterThan(t0+179_000-121_000);
});
it('a delayed book blocks entries and says how far behind it is',()=>{
  const b=new Orderbook();b.snapshot([['.49','40']],[['.49','40']]);
  const market={ticker:'BTC',event_ticker:'BTC',open_time:'',close_time:'',status:'active'},ready={feedsHealthy:true,kConfirmed:true,lock:null,modelReady:true,accountReady:true,now:Date.now()};
  expect(evaluate(.65,180,b,market,1000,defaults,baseFees,{...ready,bookDelayMs:500}).action).toBe('BUY YES');
  const late=evaluate(.65,180,b,market,1000,defaults,baseFees,{...ready,bookDelayMs:12_000});
  expect(late.action).toBe('NO TRADE');expect(late.reason).toBe('Kalshi prices 12 s behind');
  expect(late.gates!.find(g=>g.key==='book')).toMatchObject({ok:false,detail:'12 s behind Kalshi'});
});
it('reports observed delay patterns without claiming the network or provider is proven at fault',()=>{
  expect(delaySide(1500,null,5000)).toBeNull();
  // A stalled loop delays every feed, so it wins even when the exchange feeds are late too.
  expect(delaySide(20_000,15_000,3000)).toBe('engine');
  expect(delaySide(20_000,8000,40)).toBe('network');
  expect(delaySide(20_000,300,40)).toBe('kalshi');
  expect(delaySide(20_000,null,40)).toBe('unknown');expect(MAX_LOOP_LAG_MS).toBe(1000);
  expect(delayCause({side:'network',exchangeDelay:8000})).toMatch(/8\.0 s behind.*may be contributing/);
  expect(delayCause({side:'kalshi'})).toMatch(/exact cause is not established/);expect(delayCause({side:'engine',loopLag:2400})).toMatch(/app recently stalled for 2\.4 s/);
  expect(delayCause({side:'unknown'})).toBeNull();
});
it('measures each exchange feed against its own timestamps, and counts a silent link as behind',()=>{
  const p=new ProxyFeed(),t0=1_792_000_000_000;
  const v:Venue=p.venues.Coinbase={name:'Coinbase',mid:null,spread:null,updated:0,alive:t0,lag:null,status:'connected',delay:0};
  (p as any).delays.set('Coinbase',new FeedDelay());
  // Heartbeats (no quote) still measure the delay; clocks 700 ms apart cancel out.
  for(let i=0;i<20;i++)p.handle(v,null,t0+i*1000,t0+i*1000+700);
  expect(v.delay).toBeLessThan(50);expect(v.mid).toBeNull();
  p.handle(v,[100,101,t0+20_000],null,t0+20_000+9_700);expect(v.delay).toBeCloseTo(9000,-2);expect(v.mid).toBe(100.5);
  v.alive=t0+30_000;expect(p.delay(t0+30_500).coinbase).toBeCloseTo(9000,-2);
  // No frame or pong for 12 s on a link pinged every second: at least 11 s behind.
  expect(p.delay(t0+42_000).median).toBe(11_000);
  v.status='disconnected';expect(p.delay(t0+42_000)).toMatchObject({median:null,coinbase:null});
});
it('keeps the worst event-loop stall of the last 10 s',()=>{
  const l=new LoopLag(),t0=1_000_000;
  l.sample(t0,10_000,20);l.sample(t0+1000,10_000,2500);l.sample(t0+2000,10_000,30);expect(l.ms).toBe(2500);
  l.sample(t0+11_500,10_000,25);expect(l.ms).toBe(30);
});
it('compares Kalshi REST with the stream: a REST trade newer by the delay means the stream is the hold-up',()=>{
  const now=1_792_000_000_000,q={yesBid:.41,yesAsk:.43};
  expect(compareRest(now,now-21_000,now-500,{yesBid:.88,yesAsk:.9},q)).toMatchObject({restLeadMs:20_500,restTradeAgeMs:500,wsTradeAgeMs:21_000,sameQuote:false});
  expect(compareRest(now,null,null,q,q)).toMatchObject({restLeadMs:null,restTradeAgeMs:null,sameQuote:true});
  const p=new RestProbe(new KalshiClient('',''),()=>{});expect(p.due(now,false)).toBe(true);
});
it('probes REST once and logs the comparison, without touching trading',async()=>{
  const logs:any[]=[],client=new KalshiClient('','');const t=new Date(Date.now()-300).toISOString();
  client.get=(async(path:string)=>path.startsWith('/markets/trades')?{trades:[{created_time:t}]}:{orderbook_fp:{yes_dollars:[['0.88','10']],no_dollars:[['0.10','5']]}}) as any;
  const p=new RestProbe(client,(e,d)=>logs.push([e,d])),now=Date.now();
  await p.run('A',21_000,now-21_000,{yesBid:.41,yesAsk:.43},now);
  expect(logs[0][0]).toBe('rest-probe');expect(logs[0][1]).toMatchObject({ticker:'A',delayed:true,rest:{yesBid:.88,yesAsk:.9},sameQuote:false});
  expect(logs[0][1].restLeadMs).toBeGreaterThan(19_000);
  // Every 10 s while delayed, once a minute otherwise.
  expect(p.due(now+9000,true)).toBe(false);expect(p.due(now+10_000,true)).toBe(true);expect(p.due(now+30_000,false)).toBe(false);
});
it('uses the REST book while the stream is behind, only while it is fresh, and drops it once the stream catches up',async()=>{
  const client=new KalshiClient('','');let calls=0;
  client.get=(async()=>{calls++;return {orderbook_fp:{yes_dollars:[['0.88','10']],no_dollars:[['0.10','5']]}};}) as any;
  const f=new KalshiFeed(client,()=>{}),t0=Date.now(),stream=new Orderbook();stream.snapshot([['.41','5']],[['.57','5']]);
  f.books.set('A',stream);f.markets=[{ticker:'A',event_ticker:'E',open_time:new Date(t0-60_000).toISOString(),close_time:new Date(t0+60_000).toISOString(),status:'active'},
    {ticker:'B',event_ticker:'E',open_time:new Date(t0+60_000).toISOString(),close_time:new Date(t0+960_000).toISOString(),status:'initialized'}];
  // On time: the stream, no REST reads.
  await f.pollBackup(t0);expect(calls).toBe(0);expect(f.current('A',t0)).toMatchObject({source:'stream',delayed:false});
  // 12 s behind: only the open round is re-read over REST, and its book is used while ≤ 2 s old.
  f.delay.observe(t0-1000,t0-1000+100);f.delay.observe(t0,t0+12_000);expect(f.delay.delayed).toBe(true);
  expect(f.current('A',t0)).toMatchObject({source:'stream',delayed:true});
  await f.pollBackup(t0);expect(calls).toBe(1);
  const now=Date.now(),c=f.current('A',now)!;expect(c).toMatchObject({source:'rest',delayed:false});expect(c.book.view()).toMatchObject({yesBid:.88,yesAsk:.9,source:'rest'});
  expect(f.current('A',now+2500)).toMatchObject({source:'stream',delayed:true});
  // Caught up: back to the stream, the backup cleared.
  f.delay.observe(t0+20_000,t0+20_100);expect(f.delay.delayed).toBe(false);await f.pollBackup();expect(f.backup.size).toBe(0);
  expect(f.current('A')).toMatchObject({source:'stream',delayed:false});expect(f.current('Z')).toBeNull();
});
it('the warning says where prices come from while the REST backup is in use',()=>{
  expect(backupNote({delayed:false,delay:9400,backup:600})).toBe('Kalshi’s live stream is 9.4 s behind. Prices are using the REST backup (0.6 s old).');
  expect(backupNote({delayed:false,delay:9400,backup:600,recovery:{waitingForSnapshot:true}})).toMatch(/Reconnecting the stream and waiting for a current book/);
  expect(backupNote({delayed:true,delay:9400,backup:null})).toBeNull();expect(backupNote({delayed:false,delay:0,backup:null})).toBeNull();
});

it('fresh non-book messages cannot clear a delayed book or replace the REST backup',()=>{
  const now=Date.now(),f=new KalshiFeed(new KalshiClient('',''),()=>{}),book=new Orderbook(),backup=new Orderbook();
  book.snapshot([['.4','5']],[['.5','5']]);backup.snapshot([['.8','5']],[['.1','5']],'rest');f.books.set('A',book);f.backup.set('A',{book:backup,started:now});
  f.delay.observe(now-10000,now-9900);
  f.handle({type:'orderbook_snapshot',sending_ts_ms:now-20000,msg:{market_ticker:'A'}});
  const before=f.delay.ms;
  for(const type of ['ticker','subscribed','fill','trade'])f.handle({type,sending_ts_ms:Date.now(),msg:{market_ticker:'A',ts_ms:now,yes_price_dollars:'.5',count_fp:'1',taker_side:'yes'}});
  expect(f.delay.ms).toBe(before);expect(f.current('A')).toMatchObject({source:'rest',delayed:false});
});

it('recovers sustained backlog with a cooldown and retains the baseline until a fresh book arrives',async()=>{
  vi.useFakeTimers();const now=1_792_000_000_000;vi.setSystemTime(now);
  const logs:any[]=[],client=new KalshiClient('','');
  client.get=vi.fn(async()=>({orderbook_fp:{yes_dollars:[['.8','5']],no_dollars:[['.1','5']]}}));
  const f=new KalshiFeed(client,(event,data)=>logs.push({event,data})),book=new Orderbook();book.snapshot([['.4','5']],[['.5','5']]);f.books.set('A',book);
  f.markets=[{ticker:'A',event_ticker:'E',open_time:new Date(now-60000).toISOString(),close_time:new Date(now+120000).toISOString(),status:'active'}];f.status='connected';
  try{
    f.delay.observe(now-1000,now-900);f.delay.observe(now-20000,now);
    await f.pollBackup();vi.setSystemTime(now+4999);await f.pollBackup();expect(f.recovery.count).toBe(0);
    vi.setSystemTime(now+5000);await f.pollBackup();expect(f.recovery).toMatchObject({count:1,lastTime:now+5000,waitingForSnapshot:true});
    expect(f.delay.ms).toBe(19900);expect(f.current('A')).toMatchObject({source:'rest',delayed:false});expect(book.valid).toBe(false);
    // The first replacement snapshot is still old. Reconnecting must not make it look current.
    f.handle({type:'orderbook_snapshot',sending_ts_ms:now-15000,msg:{market_ticker:'A',yes_dollars_fp:[['.4','5']],no_dollars_fp:[['.5','5']]}});
    expect(f.delay.delayed).toBe(true);expect(f.current('A')?.source).toBe('rest');expect(f.recovery.waitingForSnapshot).toBe(true);
    f.status='connected';vi.setSystemTime(now+34999);await f.pollBackup();expect(f.recovery.count).toBe(1);
    vi.setSystemTime(now+35000);await f.pollBackup();expect(f.recovery.count).toBe(2);
    f.handle({type:'orderbook_snapshot',sending_ts_ms:now+34900,msg:{market_ticker:'A',yes_dollars_fp:[['.7','5']],no_dollars_fp:[['.2','5']]}});
    expect(f.recovery.waitingForSnapshot).toBe(false);expect(f.current('A')).toMatchObject({source:'stream',delayed:false});
    await f.pollBackup();expect(f.backup.size).toBe(0);expect(logs.filter(x=>x.event==='book-delay-resync')).toHaveLength(2);expect(logs.at(-1).event).toBe('book-delay-recovered');
  }finally{f.stop();vi.useRealTimers();}
});

it('does not reconnect for short spikes, and expired REST data remains blocked during recovery',async()=>{
  vi.useFakeTimers();const now=1_792_000_000_000;vi.setSystemTime(now);
  const client=new KalshiClient('',''),logs:string[]=[],f=new KalshiFeed(client,event=>logs.push(event));
  client.get=vi.fn(async()=>{throw new Error('offline');});f.status='connected';
  const book=new Orderbook(),backup=new Orderbook();book.snapshot([['.4','1']],[['.5','1']]);backup.snapshot([['.8','1']],[['.1','1']],'rest');
  f.books.set('A',book);f.backup.set('A',{book:backup,started:now});
  try{
    f.delay.observe(now-1000,now-900);f.delay.observe(now-10000,now);await f.pollBackup();
    vi.setSystemTime(now+4000);f.delay.observe(now+3900,now+4000);await f.pollBackup();expect(f.recovery.count).toBe(0);
    vi.setSystemTime(now+6000);f.delay.observe(now-4000,now+6000);await f.pollBackup();
    vi.setSystemTime(now+11000);await f.pollBackup();expect(f.recovery.count).toBe(1);
    expect(f.current('A')).toMatchObject({source:'stream',delayed:true});expect(book.valid).toBe(false);
  }finally{f.stop();vi.useRealTimers();}
});
