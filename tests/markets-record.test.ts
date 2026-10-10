import {it,expect} from 'vitest';
import {accuracy,accuracyTables,yourRecord,buildRecord} from '../src/markets/record';
import {normalizeAccount} from '../src/engine/account';
import type {BackfillRow} from '../src/markets/journal';
const row=(ticker:string,event:string,p1:number|null,result:'yes'|'no',grp:any='sports'):BackfillRow=>({ticker,event,series:'S',grp,title:ticker,eventTs:1,settleTs:2,result,volume:500,p24:null,a24:null,p1,a1:p1===null?null:p1+.01,vwap:null,priced:1});
it('accuracy buckets: implied vs actual with a Wilson range; markets without a price at the horizon are left out',()=>{
  const rows=[row('A','E1',.03,'no'),row('B','E2',.04,'yes'),row('C','E3',.6,'yes'),row('D','E4',null,'yes')];
  const b=accuracy(rows,'p1');const low=b.find(x=>x.lo===0)!;expect(low.n).toBe(2);expect(low.price!).toBeCloseTo(.035);expect(low.win).toBe(.5);expect(low.low!).toBeLessThan(.5);expect(low.high!).toBeGreaterThan(.5);
  expect(b.reduce((s,x)=>s+x.n,0)).toBe(3);expect(b.find(x=>x.lo===.5)!.n).toBe(1);});
it('return per $1 buys YES at the ask after the fee; both sides of one game are one bootstrap cluster',()=>{
  const rows=[row('A-1','G1',.5,'yes'),row('A-2','G1',.5,'no'),row('B-1','G2',.5,'yes'),row('B-2','G2',.5,'no')];
  const b=accuracy(rows,'p1').find(x=>x.lo===.5)!;expect(b.events).toBe(2);expect(b.ret!).toBeLessThan(0);
  expect(b.retLow!).toBeCloseTo(b.retHigh!,9);expect(accuracy(rows.slice(0,2),'p1').find(x=>x.lo===.5)!.retLow).toBeNull();});
it('your record by group and entry price, from real fills and settlements',()=>{
  const fills=[{fill_id:'1',ticker:'KXNCAAFGAME-X-ARIZ',outcome_side:'yes',action:'buy',count_fp:'10',yes_price_dollars:'0.83',fee_cost:'0.10',created_time:'2026-10-04T00:00:00Z'},
    {fill_id:'2',ticker:'KXMVECROSSCATEGORY-S-A',outcome_side:'yes',action:'buy',count_fp:'1000',yes_price_dollars:'0.003',fee_cost:'0.21',created_time:'2026-10-04T00:00:00Z'}];
  const settlements=[{ticker:'KXNCAAFGAME-X-ARIZ',revenue:1000,yes_total_cost_dollars:'8.3',no_total_cost_dollars:'0',fee_cost:'0.10',settled_time:'2026-10-05T00:00:00Z',yes_count_fp:'10',no_count_fp:'0'},
    {ticker:'KXMVECROSSCATEGORY-S-A',revenue:0,yes_total_cost_dollars:'3',no_total_cost_dollars:'0',fee_cost:'0.21',settled_time:'2026-10-05T00:00:00Z',yes_count_fp:'1000',no_count_fp:'0'}];
  const events=normalizeAccount(fills,settlements,(t:string)=>!t.startsWith('KXBTC'));
  const r=yourRecord(events,fills,t=>t.startsWith('KXMVE')?'combos':'sports');
  expect(r.byGroup.find(x=>x.bucket==='combos')).toMatchObject({markets:1,wins:0});expect(r.byGroup.find(x=>x.bucket==='combos')!.pnl).toBeCloseTo(-3.21);
  expect(r.byGroup.find(x=>x.bucket==='sports')!.pnl).toBeCloseTo(1.6);expect(r.byEntry.find(x=>x.bucket==='0–5¢')!.markets).toBe(1);expect(r.byEntry.find(x=>x.bucket==='80–100¢')!.wins).toBe(1);
  expect(r.total.ret!).toBeCloseTo((1.6-3.21)/(8.4+3.21),3);
  expect(r.entryBy.combos.find(x=>x.bucket==='0–5¢')!.markets).toBe(1);expect(r.entryBy.combos.find(x=>x.bucket==='80–100¢')!.markets).toBe(0);expect(r.entryBy.sports.find(x=>x.bucket==='80–100¢')!.wins).toBe(1);});
it('an empty backfill gives empty accuracy and the stats, not zeros',()=>{
  const s=buildRecord({accuracy:null,events:[],fills:[],groupFor:()=>'sports',stats:{markets:0,priced:0,from:null,to:null},finished:null});
  expect(s.accuracy.all.p1.every(b=>b.n===0&&b.win===null&&b.ret===null)).toBe(true);expect(s.backfill.markets).toBe(0);expect(s.yours.total.markets).toBe(0);});
it('category accuracy only uses its own markets',()=>{
  const s=buildRecord({accuracy:accuracyTables([row('A','E1',.5,'yes','sports'),row('B','E2',.5,'no','politics')]),events:[],fills:[],groupFor:()=>'sports',stats:{markets:2,priced:2,from:1,to:1},finished:5});
  expect(s.accuracy.sports.p1.find(x=>x.lo===.5)!.win).toBe(1);expect(s.accuracy.politics.p1.find(x=>x.lo===.5)!.win).toBe(0);expect(s.accuracy.all.p1.find(x=>x.lo===.5)!.n).toBe(2);});
import {compareSources} from '../src/markets/record';
import {MarketsJournal} from '../src/markets/journal';
import {parseMarket} from '../src/markets/quotes';
it('compares Brier scores of Kalshi and each outside source on matched settled markets',()=>{
  const c=compareSources([{ticker:'A',source:'polymarket',y:1,kalshi:.6,ref:.7},{ticker:'B',source:'polymarket',y:0,kalshi:.3,ref:.4}]);
  expect(c).toHaveLength(1);expect(c[0]).toMatchObject({source:'polymarket',n:2});expect(c[0].brierKalshi).toBeCloseTo((.16+.09)/2);expect(c[0].brierRef).toBeCloseTo((.09+.16)/2);expect(c[0].diff).toBeCloseTo(0);expect(compareSources([])).toEqual([]);});
it('pairs each settled matched market with the last Kalshi and outside prices at least 1 h before the result',()=>{
  const j=new MarketsJournal(':memory:'),H=3600e3,end=10*H;
  j.upsertMarket({...parseMarket({ticker:'K-A',event_ticker:'K',status:'finalized',result:'yes',expected_expiration_time:new Date(end).toISOString()},1)},'Sports','sports');
  j.snapshot([{ticker:'K-A',time:end-3*H,yesBid:.5,yesAsk:.52,last:null,volume24h:null,held:true},{ticker:'K-A',time:end-.5*H,yesBid:.9,yesAsk:.92,last:null,volume24h:null,held:true}]);
  j.putRef('K-A','polymarket',end-2*H,.55);j.putRef('K-A','polymarket',end-.2*H,.95);
  expect(j.sourcePairs()).toEqual([{ticker:'K-A',source:'polymarket',y:1,kalshi:.51,ref:.55}]);j.db.close();});
it('accuracy also scores the NO side: buying NO at 1 − YES bid, after the fee',()=>{
  const rows=Array.from({length:4},(_,i)=>({...row('N'+i,'G'+i,.03,'no'),a1:.04}));
  const b=accuracy(rows,'p1').find(x=>x.lo===0)!;expect(b.noRet!).toBeGreaterThan(0);expect(b.noRet!).toBeLessThan(.03);expect(b.ret!).toBeLessThan(-.9);
  const upset=accuracy([...rows,{...row('N9','G9',.03,'yes'),a1:.04}],'p1').find(x=>x.lo===0)!;expect(upset.noRet!).toBeLessThan(0);});
