import {it,expect} from 'vitest';
import {coach,accountLookup,marketLabel,COACH} from '../src/engine/coach';
import {normalizeAccount} from '../src/engine/account';
import type {RealEvent} from '../src/engine/guardrails';
const T0=Date.parse('2026-10-08T00:20:00Z');
const fill=(id:string,t:number,side:'yes'|'no',contracts:number,price:number,o:Partial<RealEvent>={}):RealEvent=>({id,orderId:id,time:t,ticker:'KXBTC15M-26OCT072030-30',type:'fill',pnl:0,closedContracts:0,contracts,side,price,action:'buy',...o});
const always=()=>true,acct=(v:number)=>()=>v;
it('flags bets that are large against the account: caution from 10%, stop from 50%',()=>{
  expect(coach([fill('a',T0,'yes',1,.5)],acct(40),T0,always).items).toHaveLength(0);
  const caution=coach([fill('a',T0,'yes',10,.5)],acct(40),T0,always);expect(caution.items[0]).toMatchObject({kind:'size',level:'caution'});expect(caution.level).toBe('caution');
  const stop=coach([fill('a',T0,'yes',51.39,.87)],acct(45),T0,always);expect(stop.items[0]).toMatchObject({kind:'size',level:'stop',title:'Too big for the account'});
  expect(stop.items[0].text).toContain('99% of your $45.00 account');expect(stop.items[0].text).toContain('the 8:30 PM ET round');
  // Unknown account value: no size judgement.
  expect(coach([fill('a',T0,'yes',51,.87)],()=>null,T0,always).items).toHaveLength(0);});
it('partial fills of one order count as one bet; closing fills are not new bets',()=>{
  const parts=[fill('p1',T0,'yes',3,.5,{orderId:'o'}),fill('p2',T0+50,'yes',3,.5,{orderId:'o'})];
  expect(coach(parts,acct(25),T0,always).items.filter(i=>i.kind==='size')).toHaveLength(1);
  expect(coach([fill('c',T0,'no',20,.5,{closedContracts:20,pnl:-1})],acct(25),T0,always).items).toHaveLength(0);});
it('switching sides in the same market, and twice is a stop',()=>{
  const evs=[fill('1',T0,'no',1,.29),fill('2',T0+6000,'yes',1,.77,{closedContracts:0}),fill('3',T0+90000,'no',1,.37)];
  const s=coach(evs,acct(100),T0+90000,always),flips=s.items.filter(i=>i.kind==='flip');
  expect(flips).toHaveLength(2);expect(flips[0]).toMatchObject({level:'stop',title:'Switched sides 2 times'});expect(flips[1].level).toBe('caution');expect(flips[1].text).toContain('NO → YES');});
it('chasing: a new position within 3 minutes of a realized loss of at least $1',()=>{
  const loss=fill('l',T0,'no',36,.66,{closedContracts:36,pnl:-14.12});
  const s=coach([loss,fill('n',T0+17000,'no',1,.37)],acct(100),T0+17000,always);expect(s.items.find(i=>i.kind==='chase')!.text).toContain('17 s after losing $14.12');
  expect(coach([loss,fill('n',T0+(COACH.chaseSeconds+1)*1000,'no',1,.37)],acct(100),T0,always).items.some(i=>i.kind==='chase')).toBe(false);
  expect(coach([{...loss,pnl:-.5},fill('n',T0+17000,'no',1,.37)],acct(100),T0,always).items.some(i=>i.kind==='chase')).toBe(false);});
it('lottery tickets: $1 or more on contracts at 5¢ or less',()=>{
  const s=coach([fill('t',T0,'yes',724,.01)],acct(1000),T0,always);expect(s.items[0]).toMatchObject({kind:'longshot',level:'caution'});expect(s.items[0].text).toContain('724 contracts at 1.0¢');
  expect(coach([fill('t',T0,'yes',50,.01)],acct(1000),T0,always).items).toHaveLength(0);});
it('only today is listed and the level fades after an hour',()=>{
  const evs=[fill('a',T0,'yes',51,.87)];
  expect(coach(evs,acct(45),T0+61*60000,always).level).toBe('ok');expect(coach(evs,acct(45),T0+61*60000,always).items).toHaveLength(1);
  expect(coach(evs,acct(45),T0,()=>false).items).toHaveLength(0);});
it('account lookup takes the last snapshot at least a second before the trade',()=>{
  const at=accountLookup([{time:1000,value:10},{time:5000,value:20},{time:9000,value:30}]);
  expect(at(500)).toBeNull();expect(at(5999)).toBe(10);expect(at(6000)).toBe(20);expect(at(99999)).toBe(30);});
it('names markets the way a person reads them',()=>{
  expect(marketLabel('KXBTC15M-26OCT072030-30')).toBe('the 8:30 PM ET round');expect(marketLabel('KXBTC15M-26OCT071200-00')).toBe('the 12 PM ET round');
  expect(marketLabel('KXBTCD-26OCT0720-T83199.99')).toBe('the 8 PM ET hour ($83,200 strike)');expect(marketLabel('OTHER')).toBe('OTHER');});
it('hourly fills are normalized for the coach while P&L stays 15-minute only',()=>{
  const fills=[{fill_id:'h',ticker:'KXBTCD-26OCT0720-T83199.99',outcome_side:'yes',book_side:'bid',count_fp:'10',yes_price_dollars:'.5',no_price_dollars:'.5',fee_cost:'.1',created_time:'2026-10-08T00:00:00Z'}];
  expect(normalizeAccount(fills,[])).toHaveLength(0);expect(normalizeAccount(fills,[],['KXBTC15M','KXBTCD'])).toHaveLength(1);});
