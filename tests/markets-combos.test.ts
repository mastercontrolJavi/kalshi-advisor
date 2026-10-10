import {it,expect} from 'vitest';
import {comboView,gameKey} from '../src/markets/combos';
import {parseMarket} from '../src/markets/quotes';
import type {Leg,Quote} from '../src/markets/types';
const q=(ticker:string,bid:string,ask:string,extra:any={})=>parseMarket({ticker,event_ticker:ticker.split('-').slice(0,2).join('-'),yes_sub_title:ticker.split('-').at(-1),status:'active',result:'',yes_bid_dollars:bid,yes_ask_dollars:ask,...extra},1);
// The user's open 8-leg combo on 2026-10-09 (South Alabama already won).
const legs:Leg[]=['KXNCAAFGAME-26OCT08USAARST-USA','KXNCAAFGAME-26OCT09IOWAWASH-IOWA','KXNCAAFGAME-26OCT10ARIZWVU-ARIZ','KXNCAAFGAME-26OCT10HOUKSU-HOU','KXNCAAFGAME-26OCT10ILLMSU-MSU','KXNCAAFGAME-26OCT10MINNPUR-MINN','KXNCAAFGAME-26OCT10USCPSU-USC','KXNCAAFTOTAL-26OCT10UGAALA-52']
  .map(t=>({marketTicker:t,eventTicker:t.split('-').slice(0,2).join('-'),side:'yes'}));
const quotes=()=>new Map<string,Quote>([
  q(legs[0].marketTicker,'0','1',{status:'finalized',result:'yes'}),q(legs[1].marketTicker,'0.42','0.43'),q(legs[2].marketTicker,'0.59','0.60'),q(legs[3].marketTicker,'0.45','0.46'),
  q(legs[4].marketTicker,'0.43','0.44'),q(legs[5].marketTicker,'0.54','0.55'),q(legs[6].marketTicker,'0.47','0.48'),q(legs[7].marketTicker,'0.47','0.48')].map(x=>[x.ticker,x]));
it('values the real combo as the product of its legs, won legs counting 1',()=>{
  const c=comboView(legs,quotes());expect(c.won).toBe(1);expect(c.pending).toBe(7);expect(c.value!).toBeCloseTo(.006154,5);expect(c.dead).toBe(false);expect(c.oneLeft).toBe(false);expect(c.correlated).toBe(false);
  expect(c.legs[0]).toMatchObject({status:'won',label:'USA'});});
it('a lost leg kills the combo: value 0 and dead',()=>{
  const m=quotes();m.set(legs[1].marketTicker,q(legs[1].marketTicker,'0','1',{status:'finalized',result:'no'}));const c=comboView(legs,m);expect(c.dead).toBe(true);expect(c.value).toBe(0);expect(c.lost).toBe(1);});
it('a missing or unpriced leg makes the value unavailable, never a partial product',()=>{
  const m=quotes();m.delete(legs[2].marketTicker);expect(comboView(legs,m).value).toBeNull();expect(comboView(legs,m).unknown).toBe(1);
  const u=quotes();u.set(legs[3].marketTicker,q(legs[3].marketTicker,'0','1'));expect(comboView(legs,u).value).toBeNull();});
it('one pending leg left is flagged; a NO leg uses the NO probability',()=>{
  const two:Leg[]=[legs[0],{...legs[1],side:'no'}];const c=comboView(two,quotes());expect(c.oneLeft).toBe(true);expect(c.value!).toBeCloseTo(.575);expect(c.legs[1].label).toBe('Not IOWA');});
it('legs on the same game are correlated (winner + total of one matchup)',()=>{
  expect(gameKey('KXNCAAFTOTAL-26OCT10UGAALA')).toBe(gameKey('KXNCAAFGAME-26OCT10UGAALA'));
  const two:Leg[]=[{marketTicker:'KXNCAAFGAME-26OCT10UGAALA-UGA',eventTicker:'KXNCAAFGAME-26OCT10UGAALA',side:'yes'},legs[7]];
  expect(comboView(two,new Map([[two[0].marketTicker,q(two[0].marketTicker,'.6','.62')],[legs[7].marketTicker,q(legs[7].marketTicker,'.47','.48')]])).correlated).toBe(true);});
it('outside odds: each leg uses its trusted reference where there is one, Kalshi otherwise, and says how many',()=>{
  const ref=(prob:number,status:'auto'|'suggested'='auto')=>({source:'polymarket' as const,prob,time:1,stale:false,status,title:'',url:'',refId:'r'});
  const refs:Record<string,any>={[legs[1].marketTicker]:ref(.5),[legs[2].marketTicker]:ref(.6),[legs[3].marketTicker]:ref(.9,'suggested')};
  const c=comboView(legs.slice(0,4),quotes(),t=>refs[t]??null);expect(c.refLegs).toBe(2);expect(c.refValue!).toBeCloseTo(1*.5*.6*.455,6);expect(c.legs[1].ref).toBe(.5);expect(c.legs[3].ref).toBeNull();
  expect(comboView(legs.slice(0,4),quotes()).refLegs).toBe(0);});
