import {it,expect} from 'vitest';
import {MarketsData} from '../src/markets/kalshi-data';
import {MarketsJournal} from '../src/markets/journal';
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
