import {describe,expect,it,vi} from 'vitest';
import {EdgeLink,edgeSpot,realBook,realOrderVeto,EDGE_OFFLINE_MS,type EdgeView} from '../src/engine/edge-link';

const v=(o:Partial<EdgeView>={}):EdgeView=>({status:'OK',receivedAt:1000,ageMs:200,aliveMs:200,error:null,sent:1,failures:0,ticker:'KXBTC15M-26NOV041215-15',
  gate:{action:'TRADE',side:'yes',ask:.9,edge:.03,contracts:3,reason:'ok'},real_risk:{allowed:true,reason:'ok',stop_hit:false,stop_reason:null},...o});
const T='KXBTC15M-26NOV041215-15';

describe('edge spot',()=>{
  const venues=[{name:'Coinbase',mid:100,healthy:true},{name:'Kraken',mid:102,healthy:true},{name:'Bitstamp',mid:110,healthy:false},{name:'Gemini',mid:999,healthy:true}];
  it('uses a fresh BRTI print',()=>expect(edgeSpot({time:5000,price:101},venues,5000)).toMatchObject({spot:101,source:'brti',degraded:false,carried:false}));
  it('treats a 1-s-old print as normal publish lag and a 2-s-old one as carried',()=>{expect(edgeSpot({time:4000,price:101},venues,5000).carried).toBe(false);expect(edgeSpot({time:3000,price:101},venues,5000).carried).toBe(true);});
  it('falls back to the Coinbase/Kraken/Bitstamp median, degraded, Gemini excluded',()=>expect(edgeSpot({time:1000,price:101},venues,5000,1)).toMatchObject({spot:102,source:'proxy',degraded:true,venues:2}));
});

describe('real book',()=>{
  const now=Date.parse('2026-11-04T18:00:00Z');// Wed 1 PM ET
  const ev=[{id:'a',time:now-3600000,ticker:T,type:'fill' as const,pnl:-1,contracts:2,action:'buy'},
    {id:'b',time:now-1800000,ticker:'KXBTC15M-OTHER',type:'settlement' as const,pnl:-4,contracts:1},
    {id:'c',time:Date.parse('2026-11-02T15:00:00Z'),ticker:'KXBTC15M-MON',type:'fill' as const,pnl:-2,contracts:1,action:'buy'},
    {id:'d',time:Date.parse('2026-10-30T15:00:00Z'),ticker:'KXBTC15M-LASTWEEK',type:'settlement' as const,pnl:-50,contracts:1}];
  it('sums ET day and Monday-start week, counts windows, sees this window',()=>{
    const b=realBook(ev,100,T,now);
    expect(b).toEqual({day_pnl:-5,week_pnl:-7,start_day:105,start_week:107,windows_today:1,in_window:true});
  });
});

describe('real order veto',()=>{
  it('allows KXBTC15M only on gate TRADE, same side, governor ok, online',()=>{
    expect(realOrderVeto(T,'yes',v())).toBeNull();
    expect(realOrderVeto(T,'no',v())).toMatch(/favours YES/);
    expect(realOrderVeto(T,'yes',v({status:'OFFLINE'}))).toMatch(/offline/);
    expect(realOrderVeto(T,'yes',v({gate:{action:'NO_EDGE',side:null,ask:null,edge:null,contracts:0,reason:'edge −1¢'}}))).toMatch(/NO_EDGE/);
    expect(realOrderVeto(T,'yes',v({real_risk:{allowed:false,reason:'daily stop',stop_hit:true,stop_reason:'daily stop'}}))).toMatch(/daily stop/);
    expect(realOrderVeto(T,'yes',v({ticker:'KXBTC15M-OLD'}))).toMatch(/no current decision/);
    expect(realOrderVeto(T,'yes',v({ageMs:EDGE_OFFLINE_MS+1}))).toMatch(/no current decision/);
  });
  it('other markets: only the real daily/weekly stop, unaffected by offline',()=>{
    expect(realOrderVeto('KXNFLGAME-X','yes',v({status:'OFFLINE',gate:undefined}))).toBeNull();
    expect(realOrderVeto('KXNFLGAME-X','yes',v({real_risk:{allowed:false,reason:'x',stop_hit:true,stop_reason:'weekly stop'}}),1000+60000)).toMatch(/weekly stop/);
  });
});

describe('edge link',()=>{
  it('caches the reply, goes OFFLINE after 2 s, never throws into the loop',async()=>{
    const reply={action:'NO_EDGE',status:'OK',ticker:T};
    const fetchFn=vi.fn(async()=>new Response(JSON.stringify(reply),{status:200}));
    const link=new EdgeLink('http://x',()=>{},()=>{},fetchFn as any);
    expect(link.view().status).toBe('OFFLINE');
    link.tick({a:1});await vi.waitFor(()=>expect(link.view().status).toBe('OK'));
    expect(link.view().action).toBe('NO_EDGE');
    expect(link.view(Date.now()+EDGE_OFFLINE_MS+10).status).toBe('OFFLINE');
    const failing=new EdgeLink('http://x',()=>{},()=>{},(async()=>{throw new Error('ECONNREFUSED');}) as any);
    expect(()=>failing.tick({})).not.toThrow();await vi.waitFor(()=>expect(failing.view().error).toBe('ECONNREFUSED'));
    expect(failing.view().status).toBe('OFFLINE');
  });
  it('skips a second while a request is in flight',()=>{
    const fetchFn=vi.fn(()=>new Promise<Response>(()=>{}));const link=new EdgeLink('http://x',()=>{},()=>{},fetchFn as any);
    link.tick({});link.tick({});expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
