import {it,expect} from 'vitest';
import {parseCandle,eventTime,priceAt,vwap,pickSeries,candleGroups} from '../src/markets/backfill';
const raw=(end:number,bid:string,ask:string,mean:string|null,vol:string)=>({end_period_ts:end,yes_bid:{close_dollars:bid},yes_ask:{close_dollars:ask},price:mean===null?{}:{mean_dollars:mean},volume_fp:vol});
it('parses Kalshi hourly candles; an empty book side is null',()=>{
  expect(parseCandle(raw(10,'0.5000','0.5200','0.5100','228.61'))).toEqual({end:10,bid:.5,ask:.52,mean:.51,volume:228.61});
  expect(parseCandle(raw(10,'0.0000','1.0000',null,'0'))).toEqual({end:10,bid:null,ask:null,mean:null,volume:0});});
it('event time is the game start when Kalshi gives one before settlement, else settlement',()=>{
  expect(eventTime({occurrence_datetime:'2026-10-09T00:00:00Z',settlement_ts:'2026-10-09T03:53:53Z'})).toBe(Date.parse('2026-10-09T00:00:00Z')/1000);
  expect(eventTime({occurrence_datetime:'2026-10-10T00:00:00Z',settlement_ts:'2026-10-09T03:53:53Z'})).toBe(Math.floor(Date.parse('2026-10-09T03:53:53Z')/1000));
  expect(eventTime({close_time:'2026-10-09T03:49:52Z'})).toBe(Date.parse('2026-10-09T03:49:52Z')/1000);expect(eventTime({})).toBeNull();});
it('price at a horizon: latest candle ending at or before it, at most 2 h stale, two-sided and ≤ 20¢ wide',()=>{
  const cs=[raw(3600,'0.40','0.42','0.41','5'),raw(7200,'0.45','0.47','0.46','5'),raw(10800,'0.10','0.50','0.3','5')].map(parseCandle);
  const p=priceAt(cs,7300)!;expect(p.mid).toBeCloseTo(.46,9);expect(p.ask).toBe(.47);expect(priceAt(cs,10800)).toBeNull();
  expect(priceAt(cs.slice(0,2),7200+2*3600+1)).toBeNull();expect(priceAt(cs.slice(0,2),7200+2*3600)!.ask).toBe(.47);expect(priceAt(cs,100)).toBeNull();});
it('volume-weighted mean price over a window ignores hours without trades',()=>{
  const cs=[raw(3600,'0.4','0.42','0.40','10'),raw(7200,'0.5','0.52','0.60','30'),raw(10800,'0.5','0.52',null,'0')].map(parseCandle);
  expect(vwap(cs,0,10800)).toBeCloseTo(.55);expect(vwap(cs,7201,10800)).toBeNull();});
it('picks the top series per group by volume plus traded ones, never Bitcoin or combos',()=>{
  const s=[{ticker:'KXBTC15M',category:'Crypto',volume:9e9},{ticker:'KXBTCD',category:'Crypto',volume:8e9},{ticker:'KXETH15M',category:'Crypto',volume:1e9},{ticker:'KXSOLD',category:'Crypto',volume:5e8},
    {ticker:'KXNBAGAME',category:'Sports',volume:9e9},{ticker:'KXMLBGAME',category:'Sports',volume:8e9},{ticker:'KXFED',category:'Economics',volume:3e8},{ticker:'KXMVECROSSCATEGORY',category:'Exotics',volume:9e9},{ticker:'KXTINY',category:'Sports',volume:1}];
  expect(pickSeries(s,new Set(['KXTINY','KXBTC15M']),1).sort()).toEqual(['KXETH15M','KXFED','KXNBAGAME','KXTINY']);});
it('groups markets for the batch candle endpoint by event time within the candle budget',()=>{
  const rows=Array.from({length:250},(_,k)=>({ticker:'T'+k,event:k<200?1000:1000+100*3600}));
  const g=candleGroups(rows);expect(g.flat()).toHaveLength(250);expect(g.every(x=>x.length<=100)).toBe(true);
  expect(g.every(x=>{const span=Math.ceil((Math.max(...x.map(r=>r.event))-Math.min(...x.map(r=>r.event)))/3600)+25;return x.length*span<=9900;})).toBe(true);});
