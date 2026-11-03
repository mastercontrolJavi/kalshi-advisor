import {describe,it,expect} from 'vitest';
import Database from 'better-sqlite3';
import {FlowState,parseBinance,parseBybit,parseCoinbase,flowAlignment,barValues,FLOW_INSERT,FLOW_SCHEMA,type FlowPulse,type FlowVenueId} from '../src/engine/flow';
const base=1_790_000_000_000;
const connect=(f:FlowState,at=base)=>{for(const id of ['coinbase','binance','bybit'] as FlowVenueId[])f.status(id,'connected',at);};
const trade=(f:FlowState,venue:FlowVenueId,at:number,price:number,size:number,buy:boolean,id?:number)=>f.trade({venue,at,source:at-20,price,size,buy,id});
describe('order-flow parsers',()=>{
  it('reads taker sides correctly on each venue',()=>{
    // Coinbase `side` is the maker's: a maker sell is a taker buy.
    expect(parseCoinbase({type:'match',product_id:'BTC-USD',side:'sell',price:'77000.5',size:'0.1',time:new Date(base).toISOString(),trade_id:7},base+30)).toMatchObject({buy:true,price:77000.5,size:.1,source:base,id:7});
    expect(parseCoinbase({type:'match',product_id:'BTC-USD',side:'buy',price:'1',size:'1',time:'x'},base)?.buy).toBe(false);
    expect(parseCoinbase({type:'heartbeat',product_id:'BTC-USD'},base)).toBeNull();
    // Binance aggTrade `m`: the buyer is the maker, so the taker sold.
    expect(parseBinance({stream:'btcusdt@aggTrade',data:{e:'aggTrade',s:'BTCUSDT',p:'77010.1',q:'2.5',m:true,T:base,a:9}},base)?.trade).toMatchObject({buy:false,size:2.5,id:9});
    expect(parseBinance({e:'aggTrade',s:'BTCUSDT',p:'77010.1',q:'2.5',m:false,T:base},base)?.trade?.buy).toBe(true);
    expect(parseBinance({data:{e:'depthUpdate',s:'BTCUSDT',E:base,b:[['77000.1','3']],a:[['77000.2','1']]}},base)?.quote).toMatchObject({bid:77000.1,ask:77000.2});
    expect(parseBinance({data:{e:'depthUpdate',s:'BTCUSDT',b:[['2','1']],a:[['1','1']]}},base)).toBeNull();
    expect(parseBinance({data:{e:'markPriceUpdate',s:'BTCUSDT',E:base,p:'77020',i:'77000',r:'0.0001'}},base)?.mark).toMatchObject({mark:77020,index:77000,funding:.0001});
    expect(parseBinance({data:{e:'aggTrade',s:'ETHUSDT',p:'1',q:'1',m:true}},base)).toBeNull();
    // Bybit `S` is the taker's side; block trades are off-book.
    expect(parseBybit({topic:'publicTrade.BTCUSDT',data:[{T:base,S:'Buy',v:'0.5',p:'77005'},{T:base,S:'Sell',v:'1',p:'77004'},{T:base,S:'Buy',v:'9',p:'77004',BT:true}]},base).map(t=>t.buy)).toEqual([true,false]);
  });
});
describe('flow windows, basis and lead',()=>{
  it('sums taker flow per window once the window is fully observed',()=>{
    const f=new FlowState();connect(f);
    expect(f.pulse(base+1000).venues[0].windows[0].cvd).toBeNull();
    trade(f,'coinbase',base+45_000,77000,1,true,1);trade(f,'coinbase',base+58_000,77001,.5,false,2);trade(f,'coinbase',base+64_000,77002,.25,true,3);
    const w=f.pulse(base+65_000).venues[0].windows;
    expect(w.map(x=>x.seconds)).toEqual([5,15,60]);
    expect(w[0]).toMatchObject({buy:.25,sell:0,cvd:.25,ratio:1,trades:1});
    expect(w[1]).toMatchObject({buy:.25,sell:.5,trades:2});expect(w[1].cvd).toBeCloseTo(-.25);
    expect(w[2]).toMatchObject({buy:1.25,sell:.5,trades:3});expect(w[2].ratio).toBeCloseTo(1.25/1.75);
    // A reconnect empties the windows until they are observed again.
    f.status('coinbase','connecting',base+65_500);f.status('coinbase','connected',base+66_000);
    expect(f.pulse(base+67_000).venues[0].windows[2].cvd).toBeNull();
  });
  it('forgets learned feed delay when the clock offset changes',()=>{
    const f=new FlowState();connect(f);for(let i=0;i<20;i++)trade(f,'coinbase',base+i*100,77000,.1,true);
    // The same feed, now stamped 2.2 s later by a new Kalshi clock offset: not 2.2 s of delay.
    const shifted=(sent:number)=>f.trade({venue:'coinbase',at:sent+20+2200,source:sent,price:77000,size:.1,buy:true});
    shifted(base+2000);expect(f.pulse(base+4300).venues[0].delayMs).toBe(2200);
    f.rebase();shifted(base+2100);const v=f.pulse(base+4400).venues[0];expect(v.delayMs).toBe(0);expect(v.healthy).toBe(true);
  });
  it('counts trade-ID gaps and ignores duplicates',()=>{
    const f=new FlowState();connect(f);trade(f,'binance',base+100,77000,1,true,10);trade(f,'binance',base+200,77000,1,true,10);trade(f,'binance',base+300,77000,1,true,12);
    const v=f.pulse(base+60_000).venues[1];expect(v.gaps).toBe(1);expect(v.windows[2].trades).toBe(2);
  });
  it('measures the perp-to-spot basis and a perp move that spot has not followed',()=>{
    const f=new FlowState();connect(f);let id=0;
    // Two minutes of a steady $20 basis with small wiggles, then the perp jumps $30 in the last second while spot is flat.
    for(let t=base;t<base+120_000;t+=250){const wiggle=((t/250)%7-3)*.5;trade(f,'binance',t,77020+wiggle,.1,true,++id);trade(f,'coinbase',t,77000+wiggle/2,.01,true);}
    f.book({at:base+119_900,source:base+119_880,bid:77019.9,ask:77020.1});
    let p=f.pulse(base+119_950);expect(p.healthy).toBe(true);expect(Math.abs(p.basis.usd!-20)).toBeLessThan(1);expect(Math.abs(p.basis.change!)).toBeLessThan(2);expect(p.lead.impulse).toBe(0);
    trade(f,'binance',base+120_000,77050,.5,true,++id);trade(f,'coinbase',base+120_000,77000,.01,true);
    p=f.pulse(base+120_100);expect(p.lead.perp1s).toBeGreaterThan(25);expect(Math.abs(p.lead.spot1s!)).toBeLessThan(5);expect(p.lead.z).toBeGreaterThan(2);expect(p.lead.impulse).toBe(1);
    // The 200 ms old depth5 quote is behind the trade that printed after it, so the trade is the perp price.
    expect(p.perp).toBe(77050);
  });
  it('writes each completed 250 ms bar once',()=>{
    const f=new FlowState();connect(f);trade(f,'coinbase',base+10,77000,1,true);trade(f,'coinbase',base+20,77001,.5,false);trade(f,'binance',base+260,77020,2,false);
    f.book({at:base+270,source:base+260,bid:77019,ask:77021});f.mark({at:base+300,source:base+290,mark:77021,index:77000,funding:.0001});
    const rows=f.drain(base+500);expect(rows.map(r=>r.t)).toEqual([base,base+250]);
    expect(rows[0]).toMatchObject({cb_last:77001,cb_buy:1,cb_sell:.5,cb_n:2,bn_last:null});expect(rows[1]).toMatchObject({bn_last:77020,bn_sell:2,bn_bid:77019,bn_ask:77021,bn_mark:77021,bn_index:77000});
    expect(f.drain(base+500)).toEqual([]);
    const db=new Database(':memory:');db.exec(FLOW_SCHEMA);const insert=db.prepare(FLOW_INSERT);for(const r of rows)insert.run(...barValues(r));
    expect(db.prepare('SELECT count(*) n,sum(cb_n) trades FROM flow_bars').get()).toEqual({n:2,trades:2});db.close();
  });
});
describe('flow alignment badge',()=>{
  const pulse=(spot:1|-1|0|null,perp:1|-1|0|null,impulse:1|-1|0|null,healthy=true)=>({healthy,flow:{spot:{vote:spot},perp:{vote:perp}},lead:{impulse}}) as unknown as FlowPulse;
  it('confirms only when spot and perp flow both agree and the impulse is not against',()=>{
    expect(flowAlignment('UP',pulse(1,1,null))).toMatchObject({verdict:'confirmed',label:'FLOW CONFIRMED — HOLD TO SETTLEMENT'});
    expect(flowAlignment('no',pulse(-1,-1,-1)).verdict).toBe('confirmed');
    expect(flowAlignment('UP',pulse(1,1,-1)).verdict).toBe('mixed');
    expect(flowAlignment('UP',pulse(-1,-1,null)).verdict).toBe('fighting');
    expect(flowAlignment('UP',pulse(0,-1,-1)).verdict).toBe('fighting');
    expect(flowAlignment('UP',pulse(1,-1,-1)).verdict).toBe('mixed');
    expect(flowAlignment('DOWN',pulse(0,0,null)).verdict).toBe('mixed');
    expect(flowAlignment('UP',pulse(1,1,1,false)).verdict).toBe('unknown');expect(flowAlignment(null,pulse(1,1,1)).verdict).toBe('unknown');expect(flowAlignment('UP',null).verdict).toBe('unknown');
  });
  it('needs enough volume before a side votes',()=>{
    const f=new FlowState();connect(f);for(let i=0;i<10;i++)trade(f,'coinbase',base+30_000+i,77000,.001,true);
    for(let i=0;i<10;i++)trade(f,'binance',base+30_000+i,77020,1,true);
    f.alive('coinbase',base+60_500);f.alive('binance',base+60_500);
    const p=f.pulse(base+61_000);expect(p.flow.spot.vote).toBe(0);expect(p.flow.perp.vote).toBe(1);expect(p.flow.perp.ratio).toBe(1);
  });
});
