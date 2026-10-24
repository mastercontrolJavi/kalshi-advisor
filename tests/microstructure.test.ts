import {describe,it,expect} from 'vitest';
import {WebSocketServer} from 'ws';
import {CoinbaseMicrostructureFeed,quoteOfi,type MicrostructureEvent} from '../src/engine/feeds/microstructure';

const T=Date.parse('2026-10-23T10:00:00Z');
const iso=(time:number)=>new Date(time).toISOString();
const snapshot={type:'snapshot',product_id:'BTC-USD',bids:[['100','2'],['99','5']],asks:[['102','6'],['103','3']]};
const update=(time:number,changes:unknown[]=[])=>({type:'l2update',product_id:'BTC-USD',time:iso(time),changes});
const heartbeat=(time:number,id=10,sequence=100)=>({type:'heartbeat',product_id:'BTC-USD',time:iso(time),last_trade_id:id,sequence});
const trade=(time:number,id:number,side='sell',size='2',sequence=999)=>({type:'match',product_id:'BTC-USD',time:iso(time),trade_id:id,side,size,price:'101',sequence});
function warm(feed:CoinbaseMicrostructureFeed){
  feed.handle(snapshot,T);feed.handle({type:'last_match',product_id:'BTC-USD',trade_id:10,time:iso(T-100000)},T);
  for(let s=0;s<=30;s++){feed.handle(heartbeat(T+s*1000),T+s*1000);feed.handle(update(T+s*1000),T+s*1000);}
}
describe('Coinbase public microstructure fixtures',()=>{
  it('does not invent a source timestamp for the snapshot or count last_match as a new trade',()=>{
    const events:MicrostructureEvent[]=[],f=new CoinbaseMicrostructureFeed({onEvent:e=>events.push(e)});
    f.handle(snapshot,T);f.handle({type:'last_match',product_id:'BTC-USD',trade_id:10,time:iso(T-900000)},T);f.handle(heartbeat(T),T);
    expect(f.snapshot(T)).toMatchObject({bookHealthy:false,bookSourceTime:null,bookReceivedAt:T,flowHealthy:false});
    expect(events.find(e=>e.kind==='snapshot')?.sourceTime).toBeNull();expect(events.some(e=>e.kind==='trade')).toBe(false);
    f.handle(update(T+10),T+20);expect(f.snapshot(T+20)).toMatchObject({bookHealthy:true,bookSourceTime:T+10,bookReceivedAt:T+20,sourceLagMs:10});
  });
  it('uses absolute L2 sizes, removes zero levels and computes opposite-side microprice and top depth',()=>{
    const f=new CoinbaseMicrostructureFeed();warm(f);f.handle(update(T+30010,[['buy','100','4'],['sell','103','0']]),T+30020);
    const s=f.snapshot(T+30020);expect(s).toMatchObject({bid:100,ask:102,bidSize:4,askSize:6,bidDepth10:9,askDepth10:6,ofi30s:2});
    expect(s.microprice).toBeCloseTo(100.8);expect(s.mid).toBe(101);expect(s.depthImbalance10).toBeCloseTo(.2);
    f.handle(update(T+30030,[['buy','100','0']]),T+30040);expect(f.snapshot(T+30040)).toMatchObject({bid:99,bidSize:5,ofi30s:-2});
  });
  it('evaluates OFI after the whole batch, ignoring transient crossed intermediate states',()=>{
    const f=new CoinbaseMicrostructureFeed();warm(f);f.handle(update(T+30010,[['buy','103','4'],['sell','102','0'],['sell','103','0'],['sell','104','7']]),T+30020);
    expect(f.snapshot(T+30020)).toMatchObject({bookHealthy:true,bid:103,ask:104,ofi30s:10});
    expect(quoteOfi({bid:100,ask:102,bidSize:2,askSize:6},{bid:101,ask:101.5,bidSize:4,askSize:3})).toBe(1);
  });
  it('inverts maker side, deduplicates IDs, and does not interpret filtered product sequence jumps as gaps',()=>{
    const events:MicrostructureEvent[]=[],f=new CoinbaseMicrostructureFeed({onEvent:e=>events.push(e)});warm(f);
    f.handle(trade(T+30010,11,'sell','3',10000),T+30020);f.handle(trade(T+30030,12,'buy','1',999999),T+30040);
    f.handle(trade(T+30030,12,'buy','1',999999),T+30050);
    expect(f.snapshot(T+30050)).toMatchObject({flowHealthy:true,takerBuy30s:3,takerSell30s:1,takerNet30s:2,takerVolume30s:4,takerImbalance30s:.5,tradeCount30s:2,gapCount:0});
    expect(events.filter(e=>e.kind==='trade').map(e=>e.kind==='trade'&&[e.takerSide,e.accepted])).toEqual([['buy',true],['sell',true],['sell',false]]);
  });
  it('invalidates the trade window on missing IDs without throwing away the independent book',()=>{
    const f=new CoinbaseMicrostructureFeed();warm(f);f.handle(trade(T+30010,12),T+30020);
    expect(f.snapshot(T+30020)).toMatchObject({bookHealthy:true,flowHealthy:false,takerNet30s:null,tradeWindowMs:0,gapCount:1});
    for(let s=1;s<=30;s++){f.handle(heartbeat(T+30020+s*1000,12),T+30020+s*1000);f.handle(update(T+30020+s*1000),T+30020+s*1000);}
    expect(f.snapshot(T+60020)).toMatchObject({flowHealthy:true,takerVolume30s:0,tradeCount30s:0});
  });
  it('uses heartbeat last_trade_id to detect silent trade loss and allows a short inter-channel grace',()=>{
    const f=new CoinbaseMicrostructureFeed();warm(f);f.handle(heartbeat(T+30100,11),T+30100);
    expect(f.snapshot(T+30100).flowHealthy).toBe(false);
    f.handle(trade(T+30150,11),T+30150);expect(f.snapshot(T+30150).flowHealthy).toBe(true);
    f.handle(heartbeat(T+30200,12),T+30200);expect(f.snapshot(T+31200)).toMatchObject({flowHealthy:false,gapCount:1,takerImbalance30s:null});
    f.handle(trade(T+31210,13),T+31210);expect(f.snapshot(T+31210).gapCount).toBe(1);
  });
  it('does not recover a full flow window merely because a heartbeat returns after a silent interval',()=>{
    const f=new CoinbaseMicrostructureFeed();warm(f);f.handle(heartbeat(T+40000),T+40000);f.handle(update(T+40000),T+40000);
    expect(f.snapshot(T+40000)).toMatchObject({bookHealthy:true,flowHealthy:false,ofiHealthy:false,tradeWindowMs:0,bookWindowMs:0});
  });
  it('suppresses stale, future and malformed source messages and requires a fresh snapshot after book corruption',()=>{
    const f=new CoinbaseMicrostructureFeed();warm(f);f.handle(update(T+40000),T+30010);
    expect(f.snapshot(T+30010)).toMatchObject({bookHealthy:false,bookLevels:{bids:0,asks:0}});
    f.handle(update(T+30020,[['buy','100','9']]),T+30020);expect(f.snapshot(T+30020).bookHealthy).toBe(false);
    f.handle(snapshot,T+30030);f.handle(heartbeat(T+30040),T+30040);f.handle(update(T+30040),T+30040);expect(f.snapshot(T+30040).bookHealthy).toBe(true);
    f.handle(update(T+20000),T+30050);expect(f.snapshot(T+30050).bookHealthy).toBe(false);
  });
  it('rejects crossed books and negative or nonnumeric levels atomically',()=>{
    for(const changes of [[['buy','103','2']],[['buy','100','-1']],[['sell','102','oops']]]){
      const f=new CoinbaseMicrostructureFeed();warm(f);f.handle(update(T+30010,changes),T+30010);expect(f.snapshot(T+30010)).toMatchObject({bookHealthy:false,bookLevels:{bids:0,asks:0}});
    }
  });
  it('enforces per-stream source ordering while allowing unrelated channel timestamps to differ',()=>{
    const f=new CoinbaseMicrostructureFeed();warm(f);f.handle(update(T+30100),T+30100);f.handle(trade(T+30050,11),T+30110);
    expect(f.snapshot(T+30110).flowHealthy).toBe(true);f.handle(trade(T+30040,12),T+30120);expect(f.snapshot(T+30120).flowHealthy).toBe(false);
    f.handle(update(T+30099),T+30130);expect(f.snapshot(T+30130).bookHealthy).toBe(false);
  });
  it('never returns future state for a retrospective snapshot and invalidates receive-clock regressions',()=>{
    const f=new CoinbaseMicrostructureFeed();warm(f);expect(f.snapshot(T+10000)).toMatchObject({bookHealthy:false,flowHealthy:false,mid:null});
    expect(f.snapshot(T+30000).bookHealthy).toBe(true);f.handle(heartbeat(T+29000),T+29000);expect(f.snapshot(T+30000).bookHealthy).toBe(false);
  });
  it('fails closed at book/window memory limits instead of silently truncating depth or claiming complete flow',()=>{
    const f=new CoinbaseMicrostructureFeed({maxBookLevels:2,maxWindowEvents:2});f.handle(snapshot,T);f.handle(heartbeat(T),T);f.handle(update(T),T);
    f.handle(trade(T+10,11),T+10);f.handle(trade(T+20,12),T+20);f.handle(trade(T+30,13),T+30);
    expect(f.snapshot(T+30)).toMatchObject({flowHealthy:false,buffered:{trades:1},gapCount:1});
    f.handle(update(T+40,[['buy','98','3']]),T+40);expect(f.snapshot(T+40)).toMatchObject({bookHealthy:false,bookLevels:{bids:0,asks:0}});
  });
  it('emits ordered normalized public events and reports sink failures without leaking callback errors',()=>{
    const events:MicrostructureEvent[]=[],statuses:string[]=[],f=new CoinbaseMicrostructureFeed({onEvent:e=>events.push(e),onStatus:s=>statuses.push(s)});warm(f);
    f.handle({...trade(T+30010,11),maker_order_id:'not-stored',taker_order_id:'not-stored'},T+30020);
    expect(new Set(events.map(e=>e.sessionId)).size).toBe(1);expect(events.map(e=>e.ordinal)).toEqual(events.map((_,i)=>i+1));expect(JSON.stringify(events)).not.toContain('not-stored');
    const broken=new CoinbaseMicrostructureFeed({onEvent:()=>{throw Error('private callback text');},onStatus:s=>statuses.push(s)});broken.handle(snapshot,T);
    expect(broken.snapshot(T).sinkErrors).toBeGreaterThan(0);expect(statuses.join(' ')).not.toContain('private callback text');
  });
  it('ignores other products and reports a stale feed as unavailable, not zero-valued evidence',()=>{
    const f=new CoinbaseMicrostructureFeed();warm(f);f.handle({...trade(T+30010,500),product_id:'ETH-USD'},T+30010);
    expect(f.snapshot(T+30000).gapCount).toBe(0);expect(f.snapshot(T+34000)).toMatchObject({bookHealthy:false,flowHealthy:false,ofiHealthy:false,mid:null,takerNet30s:null,ofi30s:null});
  });
});

it('subscribes without authentication and fences callbacks when restarting a real local socket',async()=>{
  const server=new WebSocketServer({port:0});await new Promise<void>(resolve=>server.once('listening',resolve));
  const subscriptions:unknown[]=[];let connections=0;server.on('connection',ws=>{connections++;ws.on('message',raw=>{subscriptions.push(JSON.parse(raw.toString()));const now=Date.now();for(const m of [snapshot,heartbeat(now),update(now)])ws.send(JSON.stringify(m));});});
  const feed=new CoinbaseMicrostructureFeed({url:`ws://127.0.0.1:${(server.address() as {port:number}).port}`});
  const until=async(test:()=>boolean)=>{const end=Date.now()+3000;while(!test()){if(Date.now()>end)throw Error('local fixture timeout');await new Promise(r=>setTimeout(r,10));}};
  try{feed.start();feed.start();await until(()=>feed.snapshot().bookHealthy);const first=feed.snapshot().sessionId;feed.restart();await until(()=>feed.snapshot().bookHealthy&&feed.snapshot().sessionId!==first);await new Promise(r=>setTimeout(r,700));
    expect(connections).toBe(2);expect(feed.snapshot().bookHealthy).toBe(true);expect(subscriptions).toEqual(Array(2).fill({type:'subscribe',product_ids:['BTC-USD'],channels:['level2_batch','matches','heartbeat']}));
    const before=feed.snapshot().gapCount,now=Date.now();feed.handle(update(now-10000),now);
    for(let i=0;i<10;i++)feed.handle(update(now-10000),now);
    expect(feed.snapshot().gapCount).toBe(before+1);await until(()=>feed.snapshot().bookHealthy);
    feed.stop();expect(feed.snapshot()).toMatchObject({status:'stopped',bookHealthy:false,flowHealthy:false});
  }finally{feed.stop();for(const client of server.clients)client.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},10000);
