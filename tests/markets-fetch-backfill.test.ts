import {it,expect} from 'vitest';
import {runBackfill} from '../src/markets/fetch-backfill';
import {MarketsJournal} from '../src/markets/journal';
const H=3600,NOW=Date.UTC(2026,9,9)/1000,CUTOFF=NOW-10*86400;
const market=(t:string,occ:number,result='yes',vol='500')=>({ticker:t,event_ticker:t.split('-').slice(0,2).join('-'),title:t,result,volume_fp:vol,occurrence_datetime:new Date(occ*1000).toISOString(),settlement_ts:new Date((occ+3*H)*1000).toISOString(),close_time:new Date((occ+3*H)*1000).toISOString(),status:'finalized'});
const candle=(end:number,bid:string,ask:string)=>({end_period_ts:end,yes_bid:{close_dollars:bid},yes_ask:{close_dollars:ask},price:{mean_dollars:bid},volume_fp:'10'});
function fake(fail=false){const calls:string[]=[];const occ=NOW-2*86400;return {calls,async get(p:string){calls.push(p);
  if(p==='/historical/cutoff')return {market_settled_ts:new Date(CUTOFF*1000).toISOString()};
  if(p.startsWith('/series?'))return {series:[{ticker:'KXNFLGAME',category:'Sports',volume_fp:'9e9'},{ticker:'KXFED',category:'Economics',volume_fp:'1e8'},{ticker:'KXBTC15M',category:'Crypto',volume_fp:'9e10'}]};
  if(p.startsWith('/markets?series_ticker=KXNFLGAME'))return {markets:[market('KXNFLGAME-26OCT07KCLV-KC',occ),market('KXNFLGAME-26OCT07KCLV-LV',occ,'no'),market('KXNFLGAME-26OCT07KCLV-X',occ,'no','5')]};
  if(p.startsWith('/markets?series_ticker='))return {markets:[]};
  if(p.startsWith('/markets/candlesticks')){if(fail)throw new Error('HTTP 503');const t=decodeURIComponent(p.split('market_tickers=')[1].split('&')[0]).split(',');
    return {markets:t.map(x=>({market_ticker:x,candlesticks:[candle(occ-24*H,'0.40','0.42'),candle(occ-H,'0.60','0.62')]}))};}
  throw new Error('unexpected '+p);}};}
it('lists settled markets of the chosen series since the cutoff and prices them from candles',async()=>{
  const j=new MarketsJournal(':memory:'),c=fake();const r=await runBackfill(c,j,{now:NOW,traded:new Set(),log:()=>{}});
  expect(r).toEqual({listed:3,priced:3});expect(c.calls.some(p=>p.includes('KXBTC15M'))).toBe(false);
  expect(c.calls.find(p=>p.startsWith('/markets?series_ticker=KXNFLGAME'))).toContain(`min_close_ts=${CUTOFF}`);
  const kc=j.backfillRows().find(x=>x.ticker.endsWith('-KC'))!;expect(kc).toMatchObject({grp:'sports',result:'yes',a1:.62,a24:.42});expect(kc.p1).toBeCloseTo(.61,9);expect(kc.p24).toBeCloseTo(.41,9);expect(kc.vwap).toBeCloseTo(.6,9);});
it('resumes: stored markets are not refetched for candles, and a failed candle batch stays unpriced for next time',async()=>{
  const j=new MarketsJournal(':memory:');await runBackfill(fake(true),j,{now:NOW,traded:new Set(),log:()=>{}});expect(j.unpriced()).toHaveLength(3);
  const c=fake();const r=await runBackfill(c,j,{now:NOW,traded:new Set(),log:()=>{}});expect(r.priced).toBe(3);expect(j.unpriced()).toHaveLength(0);
  const again=fake();await runBackfill(again,j,{now:NOW,traded:new Set(),log:()=>{}});expect(again.calls.filter(p=>p.startsWith('/markets/candlesticks'))).toHaveLength(0);
  expect(again.calls.find(p=>p.startsWith('/markets?series_ticker=KXNFLGAME'))).toContain(`min_close_ts=${NOW-2*86400}`);});
import {BackfillRefresher} from '../src/markets/refresh';
it('the daily refresh never starts a second backfill while one is running (fresh heartbeat), and starts once it is stale',()=>{
  const j=new MarketsJournal(':memory:'),t0=Date.now();const r=new BackfillRefresher(()=>{},j,t0-3600e3);let starts=0;r.start=()=>{starts++;};
  j.set('backfillHeartbeat',t0-60e3);r.tick(t0);expect(starts).toBe(0);
  j.set('backfillHeartbeat',t0-11*60e3);r.tick(t0);expect(starts).toBe(1);});
it('a running backfill keeps its heartbeat fresh, and clears it when it finishes',async()=>{
  const j=new MarketsJournal(':memory:'),c=fake(),get=c.get,beats:number[]=[];c.get=async(p:string)=>{beats.push(j.get<number>('backfillHeartbeat',0));return get(p);};
  const before=Date.now();await runBackfill(c,j,{now:NOW,traded:new Set(),log:()=>{}});expect(Math.min(...beats)).toBeGreaterThanOrEqual(before);expect(j.get<number>('backfillHeartbeat',-1)).toBe(0);});
it('a backfill counts as running when this process started it or another one is beating',()=>{
  const j=new MarketsJournal(':memory:'),t0=Date.now(),r=new BackfillRefresher(()=>{},j,t0);
  expect(r.active(t0)).toBe(false);j.set('backfillHeartbeat',t0-60e3);expect(r.active(t0)).toBe(true);expect(r.active(t0+11*60e3)).toBe(false);});
it('a finished backfill stores the accuracy tables, so the markets process never computes them',async()=>{
  const j=new MarketsJournal(':memory:');await runBackfill(fake(),j,{now:NOW,traded:new Set(),log:()=>{}});
  const t=j.get<any>('accuracy',null);expect(t.sports.p1.find((b:any)=>b.lo===.5).n).toBe(3);expect(t.politics.p1.every((b:any)=>b.n===0)).toBe(true);});
it('selection never depends on volume or outcome: thin markets are kept, and a per-series cap samples by ticker hash',async()=>{
  const j=new MarketsJournal(':memory:');await runBackfill(fake(),j,{now:NOW,traded:new Set(),log:()=>{}});expect(j.backfillStats().markets).toBe(3);
  const pick=async(vols:string[])=>{const k=new MarketsJournal(':memory:'),c=fake(),get=c.get;c.get=async(p:string)=>p.startsWith('/markets?series_ticker=KXNFLGAME')?{markets:['A','B','C','D'].map((t,i)=>market('KXNFLGAME-G-'+t,NOW-2*86400,'yes',vols[i]))}:get(p);
    await runBackfill(c,k,{now:NOW,traded:new Set(),log:()=>{},perSeries:2});return k.unpriced().map(x=>x.ticker).concat(k.backfillRows().map(x=>x.ticker)).sort();};
  expect(await pick(['1','2','3','4000'])).toEqual(await pick(['4000','3','2','1']));});
