import {it,expect} from 'vitest';
import {MarketsData} from '../src/markets/kalshi-data';
import {MarketsJournal} from '../src/markets/journal';
import {parseMarket} from '../src/markets/quotes';
const market=(ticker:string,extra:any={})=>({ticker,event_ticker:ticker.split('-').slice(0,2).join('-'),title:ticker,yes_sub_title:ticker,status:'active',result:'',yes_bid_dollars:'.4',yes_ask_dollars:'.42',...extra});
function fakeClient(){const calls:string[]=[];return {calls,authenticated:true,clockOffset:0,
  async get(path:string){calls.push(path);
    if(path.startsWith('/markets?tickers=')){const t=decodeURIComponent(path.split('tickers=')[1].split('&')[0]).split(',');return {markets:t.map(x=>x.startsWith('KXMVE')?market(x,{mve_selected_legs:[{event_ticker:'KXNFLGAME-A',market_ticker:'KXNFLGAME-A-KC',side:'yes'}]}):market(x))};}
    if(path.startsWith('/series/'))return {series:{category:path.includes('KXMVE')?'Exotics':'Sports',fee_type:'quadratic',fee_multiplier:1}};
    throw new Error('unexpected '+path);},
  async pages(path:string){calls.push(path);if(path.startsWith('/portfolio/positions'))return [{ticker:'KXMVECROSSCATEGORY-S-A',position_fp:'10',market_exposure_dollars:'.1'},{ticker:'KXBTC15M-Q',position_fp:'1'}];return [];}};}
it('polls held markets, then their combo legs, in batched requests; Bitcoin positions are ignored',async()=>{
  const c=fakeClient(),d=new MarketsData(c as any,new MarketsJournal(':memory:'),()=>{});await d.syncAccount();await d.pollQuotes(1000);
  expect(d.quotes.has('KXMVECROSSCATEGORY-S-A')).toBe(true);expect(d.quotes.has('KXNFLGAME-A-KC')).toBe(true);expect(d.quotes.has('KXBTC15M-Q')).toBe(false);
  expect(c.calls.filter(p=>p.startsWith('/markets?tickers=')).length).toBe(2);expect(d.series.get('KXNFLGAME')?.category).toBe('Sports');
  await d.pollQuotes(2000);expect(c.calls.filter(p=>p.startsWith('/markets?tickers=')).length).toBe(4);expect(c.calls.filter(p=>p.startsWith('/series/')).length).toBe(2);});
it('a failing Kalshi request is reported, not thrown, and keeps the last quotes',async()=>{
  const c=fakeClient(),d=new MarketsData(c as any,new MarketsJournal(':memory:'),()=>{});await d.syncAccount();await d.pollQuotes(1000);
  c.get=async()=>{throw new Error('HTTP 503');};await d.pollQuotes(2000);expect(d.error.quotes).toContain('503');expect(d.quotes.get('KXMVECROSSCATEGORY-S-A')!.updated).toBe(1000);});
it('groups every traded ticker by its series category, combos apart, fetching each unknown series once',async()=>{
  const c=fakeClient() as any;const pages=c.pages;c.pages=async(p:string)=>p.startsWith('/portfolio/fills')?[{fill_id:'f',ticker:'KXNFLGAME-OLD-KC',outcome_side:'yes',action:'buy',count_fp:'1',yes_price_dollars:'.5',fee_cost:'.01',created_time:'2026-10-01T00:00:00Z'}]:pages(p);
  const d=new MarketsData(c as any,new MarketsJournal(':memory:'),()=>{});await d.syncAccount();
  expect(d.groupFor('KXNFLGAME-OLD-KC')).toBe('sports');expect(d.groupFor('KXMVECROSSCATEGORY-S-A')).toBe('combos');expect(d.groupFor('KXUNKNOWN-X')).toBe('politics');
  await d.syncAccount();expect(c.calls.filter((p:string)=>p==='/series/KXNFLGAME')).toHaveLength(1);});
it('a matched market that has left your positions is still fetched until its result is stored',async()=>{
  const j=new MarketsJournal(':memory:'),c=fakeClient() as any,get=c.get;let settled=false;
  c.get=async(p:string)=>p.startsWith('/markets?tickers=')&&p.includes('KXNFLGAME-OLD-KC')?{markets:[market('KXNFLGAME-OLD-KC',{status:settled?'finalized':'closed',result:settled?'yes':'',expected_expiration_time:'2026-10-01T00:00:00Z'})]}:get(p);
  const d=new MarketsData(c,j,()=>{});j.upsertMarket(parseMarket(market('KXNFLGAME-OLD-KC',{expected_expiration_time:'2026-10-01T00:00:00Z'}),1),'Sports','sports');j.putRef('KXNFLGAME-OLD-KC','polymarket',1,.5);
  const now=Date.parse('2026-10-02T00:00:00Z');expect(j.awaitingResult(now)).toEqual(['KXNFLGAME-OLD-KC']);
  await d.settleCheck(now);expect(j.awaitingResult(now)).toEqual(['KXNFLGAME-OLD-KC']);settled=true;await d.settleCheck(now);expect(j.awaitingResult(now)).toEqual([]);});
