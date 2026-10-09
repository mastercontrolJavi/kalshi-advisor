import {it,expect} from 'vitest';
import {accuracy,yourRecord,buildRecord} from '../src/markets/record';
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
  expect(r.total.ret!).toBeCloseTo((1.6-3.21)/(8.4+3.21),3);});
it('an empty backfill gives empty accuracy and the stats, not zeros',()=>{
  const s=buildRecord({rows:[],events:[],fills:[],groupFor:()=>'sports',stats:{markets:0,priced:0,from:null,to:null},finished:null});
  expect(s.accuracy.all.p1.every(b=>b.n===0&&b.win===null&&b.ret===null)).toBe(true);expect(s.backfill.markets).toBe(0);expect(s.yours.total.markets).toBe(0);});
it('category accuracy only uses its own markets',()=>{
  const s=buildRecord({rows:[row('A','E1',.5,'yes','sports'),row('B','E2',.5,'no','politics')],events:[],fills:[],groupFor:()=>'sports',stats:{markets:2,priced:2,from:1,to:1},finished:5});
  expect(s.accuracy.sports.p1.find(x=>x.lo===.5)!.win).toBe(1);expect(s.accuracy.politics.p1.find(x=>x.lo===.5)!.win).toBe(0);expect(s.accuracy.all.p1.find(x=>x.lo===.5)!.n).toBe(2);});
