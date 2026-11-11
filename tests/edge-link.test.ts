import {describe,expect,it,vi} from 'vitest';
import {EdgeLink,edgeSpot,realBook,RealBookMemo,realOrderVeto,WindowReservations,RESERVATION_MS,EDGE_OFFLINE_MS,type EdgeView} from '../src/engine/edge-link';
import {normalizeAccount} from '../src/engine/account';

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

describe('real stop counts every market (review: copied-market losses were missing)',()=>{
  it('a sports loss today moves the day P&L but is not a Bitcoin window',()=>{
    const now=Date.parse('2026-11-04T18:00:00Z');
    const fill=(ticker:string,id:string,price:number)=>({ticker,fill_id:id,created_time:new Date(now-3600000).toISOString(),outcome_side:'yes',action:'buy',yes_price_dollars:String(price),count_fp:'10',fee_cost:'0.10'});
    const settle=(ticker:string)=>({ticker,revenue:0,yes_total_cost_dollars:'5',no_total_cost_dollars:'0',fee_cost:'0.10',settled_time:new Date(now-1800000).toISOString(),yes_count_fp:'10',no_count_fp:'0'});
    const fills=[fill('KXNFLGAME-26NOV04-X','a',.5),fill('KXBTC15M-26NOV041215-15','b',.5)],settlements=[settle('KXNFLGAME-26NOV04-X'),settle('KXBTC15M-26NOV041215-15')];
    const btcOnly=realBook(normalizeAccount(fills,settlements),100,null,now),all=realBook(normalizeAccount(fills,settlements,()=>true),100,null,now);
    expect(btcOnly.day_pnl).toBeCloseTo(-5.1);expect(all.day_pnl).toBeCloseTo(-10.2);
    expect(all.windows_today).toBe(1);
  });
});

describe('window reservations (review: two quick confirmations)',()=>{
  it('second reservation of the same window fails until released; expires after the window',()=>{
    const r=new WindowReservations();
    expect(r.reserve(T,0)).toBe(true);expect(r.reserve(T,10)).toBe(false);expect(r.has(T,10)).toBe(true);
    r.release(T);expect(r.reserve(T,20)).toBe(true);
    expect(r.has(T,20+RESERVATION_MS+1)).toBe(false);
  });
  it('survives a restart through its store (PR #10 review) and saves only on change',()=>{
    let saved:Record<string,number>={};let saves=0;const store={load:()=>({...saved}),save:(h:Record<string,number>)=>{saved=h;saves++;}};
    const a=new WindowReservations(store);a.reserve(T,1000);expect(saved).toEqual({[T]:1000});
    const restarted=new WindowReservations(store);expect(restarted.reserve(T,2000)).toBe(false);
    const n=saves;restarted.has(T,3000);restarted.tickers(3000);expect(saves).toBe(n);
    restarted.release(T);expect(saved).toEqual({});
    new WindowReservations(store).reserve('KXBTC15M-OLD',0);expect(new WindowReservations(store).has('KXBTC15M-OLD',RESERVATION_MS+1)).toBe(false);
    expect(saved).toEqual({});
  });
  it('a reserved window counts as in-window and toward the window cap',()=>{
    const b=realBook([],100,T,Date.parse('2026-11-04T18:00:00Z'),[T,'KXBTC15M-OTHER']);
    expect(b.in_window).toBe(true);expect(b.windows_today).toBe(2);
  });
});

describe('real book memo',()=>{
  it('reuses the result until events, minute, window, value or reservations change',()=>{
    const now=Date.parse('2026-11-04T18:00:00Z'),m=new RealBookMemo(),ev:any[]=[{id:'a',time:now-1000,ticker:'X',type:'settlement',pnl:-1,contracts:1}];
    const a=m.get(ev,100,T,now);expect(m.get(ev,100,T,now+30000)).toBe(a);
    expect(m.get(ev,100,T,now+60000)).not.toBe(a);
    const b=m.get(ev,100,T,now+60000);expect(m.get([...ev],100,T,now+60000)).not.toBe(b);
    expect(m.get(ev,100,T,now+60000,[T]).in_window).toBe(true);
  });
});

describe('real order veto',()=>{
  it('refuses a real KXBTC15M order that is worse or bigger than the gate approved',()=>{
    expect(realOrderVeto(T,'yes',v(),undefined,{limit:.9,count:3})).toBeNull();
    expect(realOrderVeto(T,'yes',v(),undefined,{limit:.85,count:1})).toBeNull();
    expect(realOrderVeto(T,'yes',v(),undefined,{limit:.93,count:3})).toMatch(/priced YES at 90\.0¢.*up to 93\.0¢/);
    expect(realOrderVeto(T,'yes',v(),undefined,{limit:.9,count:4})).toMatch(/sized this at 3 contracts; this order is 4/);
    expect(realOrderVeto(T,'yes',v({gate:{action:'TRADE',side:'yes',ask:null,edge:.03,contracts:3,reason:'ok'}}),undefined,{limit:.9,count:3})).toMatch(/priced YES/);
    expect(realOrderVeto('KXNFLGAME-X','yes',v(),undefined,{limit:.99,count:99})).toBeNull();
  });
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
