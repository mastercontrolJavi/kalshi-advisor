import {it,expect} from 'vitest';
import {buildPositions,summarize} from '../src/markets/state';
import {parseMarket} from '../src/markets/quotes';
import {baseFees} from '../src/engine/model/fees';
import {defaults} from '../src/engine/config';
const now=10_000;
const quotes=new Map([['KXNFLGAME-X-KC',parseMarket({ticker:'KXNFLGAME-X-KC',event_ticker:'KXNFLGAME-X',title:'KC vs LV Winner?',yes_sub_title:'Kansas City',status:'active',result:'',yes_bid_dollars:'.6',yes_ask_dollars:'.62',no_bid_dollars:'.38',no_ask_dollars:'.4'},now)]]);
const series=new Map([['KXNFLGAME',{category:'Sports',schedule:baseFees}]]);
const positions=[{ticker:'KXNFLGAME-X-KC',position_fp:'4',market_exposure_dollars:'2.4',fees_paid_dollars:'.06'},{ticker:'KXBTC15M-Y',position_fp:'3',market_exposure_dollars:'1.5'},{ticker:'KXNFLGAME-Z-LV',position_fp:'0.00',market_exposure_dollars:'0'}];
it('builds one card per open non-Bitcoin position with title, group and spark',()=>{
  const {cards,memory}=buildPositions({positions,quotes,series,open:new Map(),cfg:defaults,memory:new Map(),now,spark:()=>[{t:1,mid:.5}]});
  expect(cards).toHaveLength(1);expect(cards[0]).toMatchObject({title:'Kansas City',marketTitle:'KC vs LV Winner?',group:'sports',verdict:'HOLD',seriesTicker:'KXNFLGAME'});expect(cards[0].spark).toHaveLength(1);expect(memory.has('KXNFLGAME-X-KC')).toBe(true);});
it('a combo position gets its legs and is titled by leg count',()=>{
  const combo=parseMarket({ticker:'KXMVECROSSCATEGORY-S-A',event_ticker:'KXMVECROSSCATEGORY-S',title:'yes Kansas City',yes_sub_title:'yes Kansas City',status:'active',result:'',yes_bid_dollars:'.001',yes_ask_dollars:'.9',mve_selected_legs:[{event_ticker:'KXNFLGAME-X',market_ticker:'KXNFLGAME-X-KC',side:'yes'}]},now);
  const q=new Map(quotes);q.set(combo.ticker,combo);
  const {cards}=buildPositions({positions:[{ticker:combo.ticker,position_fp:'100',market_exposure_dollars:'.5',fees_paid_dollars:'.01'}],quotes:q,series:new Map([...series,['KXMVECROSSCATEGORY',{category:'Exotics',schedule:baseFees}]]),open:new Map(),cfg:defaults,memory:new Map(),now,spark:()=>[]});
  expect(cards[0].group).toBe('combos');expect(cards[0].title).toBe('1-leg combo');expect(cards[0].combo!.value).toBeCloseTo(.61);});
it('summary sums cost, sell and hold values, and today\'s realized P&L',()=>{
  const {cards}=buildPositions({positions,quotes,series,open:new Map(),cfg:defaults,memory:new Map(),now,spark:()=>[]});
  const s=summarize(cards,[{id:'a',time:5,ticker:'X',type:'fill',pnl:1.5,contracts:1},{id:'b',time:1,ticker:'X',type:'fill',pnl:-9,contracts:1}],'D',t=>t>=5?'D':'C');
  expect(s.count).toBe(1);expect(s.atRisk).toBeCloseTo(2.46);expect(s.holdAll).toBeCloseTo(2.44);expect(s.realizedToday).toBeCloseTo(1.5);});
import {snapshotRows,sparkKey} from '../src/markets/state';
it('snapshots every quote, plus each combo\'s leg value under its own key for the price line',()=>{
  const combo=parseMarket({ticker:'KXMVECROSSCATEGORY-S-A',event_ticker:'KXMVECROSSCATEGORY-S',status:'active',result:'',yes_bid_dollars:'.001',yes_ask_dollars:'.9',mve_selected_legs:[{event_ticker:'KXNFLGAME-X',market_ticker:'KXNFLGAME-X-KC',side:'yes'}]},now);
  const q=new Map(quotes);q.set(combo.ticker,combo);
  const {cards}=buildPositions({positions:[{ticker:combo.ticker,position_fp:'100',market_exposure_dollars:'.5'}],quotes:q,series,open:new Map(),cfg:defaults,memory:new Map(),now,spark:()=>[]});
  const rows=snapshotRows(q,cards,now);expect(rows.map(r=>r.ticker).sort()).toEqual(['KXMVECROSSCATEGORY-S-A','KXMVECROSSCATEGORY-S-A#legs','KXNFLGAME-X-KC']);
  const legs=rows.find(r=>r.ticker.endsWith('#legs'))!;expect(legs.last).toBeCloseTo(.61);expect(legs.yesBid).toBeNull();expect(rows.every(r=>r.held&&r.time===now)).toBe(true);
  expect(sparkKey(combo)).toBe('KXMVECROSSCATEGORY-S-A#legs');expect(sparkKey(quotes.get('KXNFLGAME-X-KC')!)).toBe('KXNFLGAME-X-KC');});
import {sparkCache} from '../src/markets/state';
it('the price line is read from SQLite at most once per 30 s per market, not on every 1-s build',()=>{
  const calls:string[]=[],read=sparkCache((t:string)=>{calls.push(t);return [{t:calls.length,mid:.5}];});
  read('A',0);read('A',1000);read('A',29999);expect(calls).toEqual(['A']);read('B',1000);expect(calls).toEqual(['A','B']);
  expect(read('A',30000)[0].t).toBe(3);expect(calls).toEqual(['A','B','A']);});
it('references reach single markets and combo legs',()=>{
  const ref={source:'polymarket' as const,prob:.5,time:now,stale:false,status:'auto' as const,title:'g',url:'u',refId:'r'};
  const {cards}=buildPositions({positions,quotes,series,open:new Map(),cfg:defaults,memory:new Map(),now,spark:()=>[],reference:t=>t==='KXNFLGAME-X-KC'?ref:null});
  expect(cards[0].probSource).toBe('reference');expect(cards[0].holdValue).toBeCloseTo(2);
  const combo=parseMarket({ticker:'KXMVECROSSCATEGORY-S-A',event_ticker:'KXMVECROSSCATEGORY-S',status:'active',result:'',yes_bid_dollars:'.001',yes_ask_dollars:'.9',mve_selected_legs:[{event_ticker:'KXNFLGAME-X',market_ticker:'KXNFLGAME-X-KC',side:'yes'}]},now);
  const q=new Map(quotes);q.set(combo.ticker,combo);
  const c=buildPositions({positions:[{ticker:combo.ticker,position_fp:'100',market_exposure_dollars:'.5'}],quotes:q,series,open:new Map(),cfg:defaults,memory:new Map(),now,spark:()=>[],reference:t=>t==='KXNFLGAME-X-KC'?ref:null}).cards[0];
  expect(c.combo!.refLegs).toBe(1);expect(c.winProb).toBeCloseTo(.5);});
