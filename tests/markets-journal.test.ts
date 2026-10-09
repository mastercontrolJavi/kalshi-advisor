import {it,expect} from 'vitest';
import {MarketsJournal} from '../src/markets/journal';
const row=(time:number,held:boolean,bid=.4,ask=.42)=>({ticker:'T',time,yesBid:bid,yesAsk:ask,last:.41,volume24h:10,held});
it('stores snapshots and returns a downsampled mid line since a time',()=>{
  const j=new MarketsJournal(':memory:');j.snapshot(Array.from({length:300},(_,k)=>row(k*1000,true,.4+k/1000,.42+k/1000)));
  const s=j.spark('T',100000,50);expect(s.length).toBeLessThanOrEqual(51);expect(s[0].t).toBeGreaterThanOrEqual(100000);expect(s.at(-1)!.t).toBe(299000);expect(s.at(-1)!.mid).toBeCloseTo(.709,3);j.db.close();});
it('the line falls back to the last trade when one side of the book is empty',()=>{
  const j=new MarketsJournal(':memory:');j.snapshot([{...row(1,true),yesBid:null},row(2,true)]);const mids=j.spark('T',0).map(p=>p.mid);expect(mids).toHaveLength(2);for(const m of mids)expect(m).toBeCloseTo(.41,9);j.db.close();});
it('prune keeps held snapshots forever and drops non-held ones after 14 days',()=>{
  const j=new MarketsJournal(':memory:'),day=86400000;j.snapshot([row(0,true),{...row(1,false),ticker:'U'}]);j.prune(15*day);
  expect((j.db.prepare('SELECT COUNT(*) n FROM snapshots').get() as any).n).toBe(1);j.db.close();});
it('raw account records round-trip and dedupe by id; meta get/set',()=>{
  const j=new MarketsJournal(':memory:');const f={fill_id:'a',created_time:'2026-10-04T00:00:00Z',ticker:'X'};j.putRaw([f,f],[{ticker:'X',settled_time:'2026-10-05T00:00:00Z'}]);
  expect(j.raw().fills).toHaveLength(1);expect(j.raw().settlements).toHaveLength(1);j.set('k',{a:1});expect(j.get('k',null)).toEqual({a:1});j.db.close();});
it('backfill rows insert once, wait for prices, and only priced rows are read back',()=>{
  const j=new MarketsJournal(':memory:');const r={ticker:'A',event:'E',series:'S',grp:'sports' as const,title:'t',eventTs:100,settleTs:200,result:'yes' as const,volume:500};
  j.putBackfill([r,r,{...r,ticker:'B',eventTs:50}]);expect(j.unpriced().map(x=>x.ticker).sort()).toEqual(['A','B']);
  j.setPrices('A',{p24:.4,a24:.41,p1:.5,a1:.51,vwap:.45});expect(j.unpriced().map(x=>x.ticker)).toEqual(['B']);
  expect(j.backfillRows()).toEqual([{...r,p24:.4,a24:.41,p1:.5,a1:.51,vwap:.45,priced:1}]);expect(j.backfillStats()).toEqual({markets:2,priced:1,from:50,to:100});j.db.close();});
it('resetBackfill clears the history and its run markers so the next run starts from the cutoff',()=>{
  const j=new MarketsJournal(':memory:');j.putBackfill([{ticker:'A',event:'E',series:'S',grp:'sports',title:'t',eventTs:1,settleTs:2,result:'yes',volume:1}]);
  for(const k of ['backfillTo','backfillFinished','accuracy'])j.set(k,1);j.resetBackfill();
  expect(j.backfillStats().markets).toBe(0);for(const k of ['backfillTo','backfillFinished','accuracy'])expect(j.get(k,null)).toBeNull();j.db.close();});
