import {it,expect} from 'vitest';
import {Orderbook,FeedDelay,MAX_BOOK_DELAY_MS,MAX_LOOP_LAG_MS,delaySide} from '../src/engine/feeds/orderbook';
import {ProxyFeed,type Venue} from '../src/engine/feeds/proxy';
import {LoopLag} from '../src/engine/loop-lag';
import {delayCause} from '../src/components/delay-cause';
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
it('reads the delay from every Kalshi message and keeps 2 min of trades without re-copying the list per trade',()=>{
  const f=new KalshiFeed(new KalshiClient('',''),()=>{});f.books.set('A',new Orderbook());const t0=Date.now();
  f.handle({type:'ticker',sid:2,sending_ts_ms:t0-25_000,msg:{market_ticker:'A'}});
  f.handle({type:'ticker',sid:2,sending_ts_ms:t0-25_000+50,msg:{market_ticker:'A'}});expect(f.delay.ms).toBeLessThan(1000);
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
it('says which side a Kalshi delay comes from: this computer, the connection or Kalshi',()=>{
  expect(delaySide(1500,null,5000)).toBeNull();
  // A stalled loop delays every feed, so it wins even when the exchange feeds are late too.
  expect(delaySide(20_000,15_000,3000)).toBe('engine');
  expect(delaySide(20_000,8000,40)).toBe('network');
  expect(delaySide(20_000,300,40)).toBe('kalshi');
  expect(delaySide(20_000,null,40)).toBe('unknown');expect(MAX_LOOP_LAG_MS).toBe(1000);
  expect(delayCause({side:'network',exchangeDelay:8000})).toMatch(/internet connection.*8\.0 s behind/);
  expect(delayCause({side:'kalshi'})).toMatch(/Kalshi’s end/);expect(delayCause({side:'engine',loopLag:2400})).toMatch(/This computer.*2\.4 s/);
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
