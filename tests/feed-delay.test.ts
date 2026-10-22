import {it,expect} from 'vitest';
import {Orderbook,FeedDelay,MAX_BOOK_DELAY_MS} from '../src/engine/feeds/orderbook';
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
