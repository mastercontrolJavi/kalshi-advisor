import {it,expect} from 'vitest';
import {parseMarket,sideBid,sideProb,sideLabel} from '../src/markets/quotes';
import {groupOf,isBitcoin,seriesOf} from '../src/markets/categories';
const game={ticker:'KXNCAAFGAME-26OCT09IOWAWASH-IOWA',event_ticker:'KXNCAAFGAME-26OCT09IOWAWASH',title:'Iowa vs Washington Winner?',yes_sub_title:'Iowa',status:'active',result:'',yes_bid_dollars:'0.4200',yes_ask_dollars:'0.4300',no_bid_dollars:'0.5700',no_ask_dollars:'0.5800',last_price_dollars:'0.4300',volume_24h_fp:'1200.00',close_time:'2026-10-12T01:00:00Z',expected_expiration_time:'2026-10-10T04:00:00Z'};
it('parses a market into a quote with dollars as numbers and empty values as null',()=>{
  const q=parseMarket(game,1000);expect(q.seriesTicker).toBe('KXNCAAFGAME');expect(q.yesBid).toBe(.42);expect(q.noAsk).toBe(.58);expect(q.result).toBeNull();expect(q.legs).toBeNull();expect(q.closeTime).toBe(Date.parse('2026-10-12T01:00:00Z'));expect(q.updated).toBe(1000);
  const settled=parseMarket({...game,status:'finalized',result:'yes',yes_bid_dollars:'0.0000',yes_ask_dollars:'1.0000'},1);expect(settled.result).toBe('yes');expect(settled.yesBid).toBeNull();});
it('reads combo legs from mve_selected_legs',()=>{
  const q=parseMarket({...game,ticker:'KXMVECROSSCATEGORY-S1-A',event_ticker:'KXMVECROSSCATEGORY-S1',mve_selected_legs:[{event_ticker:'E1',market_ticker:'E1-X',side:'yes'}]},1);
  expect(q.legs).toEqual([{eventTicker:'E1',marketTicker:'E1-X',side:'yes'}]);});
it('side prices: NO bids are Kalshi no_bid; probability is the two-sided mid, else last; labels say Not X',()=>{
  const q=parseMarket(game,1);expect(sideBid(q,'no')).toBe(.57);expect(sideProb(q,'yes')).toBeCloseTo(.425);expect(sideProb(q,'no')).toBeCloseTo(.575);
  expect(sideProb(parseMarket({...game,yes_bid_dollars:'0',yes_ask_dollars:'0'},1),'yes')).toBeCloseTo(.43);
  expect(sideProb(parseMarket({...game,yes_bid_dollars:'0',yes_ask_dollars:'0',last_price_dollars:'0'},1),'yes')).toBeNull();
  expect(sideLabel(q,'yes')).toBe('Iowa');expect(sideLabel(q,'no')).toBe('Not Iowa');});
it('groups by Kalshi category; combos win over category; Bitcoin series are excluded',()=>{
  expect(groupOf('Sports',false)).toBe('sports');expect(groupOf('Exotics',true)).toBe('combos');expect(groupOf('Elections',false)).toBe('politics');expect(groupOf('Crypto',false)).toBe('commodities');expect(groupOf('Commodities',false)).toBe('commodities');expect(groupOf(null,false)).toBe('politics');
  expect(isBitcoin('KXBTCD-26OCT0912-T60000')).toBe(true);expect(isBitcoin('KXBTC15M-X')).toBe(true);expect(isBitcoin('KXSOL15M-X')).toBe(false);expect(seriesOf('KXNFLGAME-A-B')).toBe('KXNFLGAME');});
