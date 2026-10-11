import {it,expect} from 'vitest';
import {positionView,type PositionInput} from '../src/markets/holdsell';
import {parseMarket} from '../src/markets/quotes';
import {baseFees} from '../src/engine/model/fees';
import type {ExitConfig} from '../src/engine/exits';
import type {ComboView} from '../src/markets/combos';
const cfg:ExitConfig={exitMode:'hold',exitMargin:.02,makerMargin:.03,takeProfitPct:.25,stopLossPct:.5,stopWinProb:.25,trailGiveback:.5,trailFloor:.05};
const quote=(bid:string,ask:string,extra:any={},now=1000)=>parseMarket({ticker:'KXNFLGAME-X-KC',event_ticker:'KXNFLGAME-X',yes_sub_title:'Kansas City',status:'active',result:'',yes_bid_dollars:bid,yes_ask_dollars:ask,no_bid_dollars:(1-Number(ask)).toFixed(4),no_ask_dollars:(1-Number(bid)).toFixed(4),...extra},now);
const input=(over:Partial<PositionInput>={}):PositionInput=>({position:{ticker:'KXNFLGAME-X-KC',position_fp:'10',market_exposure_dollars:'6.00',fees_paid_dollars:'0.15'},quote:quote('.66','.68'),combo:null,
  open:{ticker:'KXNFLGAME-X-KC',side:'yes',contracts:10,avgCost:.615},schedule:baseFees,cfg,memory:undefined,now:1000,...over});
it('single market: cost from fills, sell value at the bid after the fee, hold value at the mid, LET IT RIDE as the 67% favourite',()=>{
  const {view}=positionView(input())!;expect(view.side).toBe('yes');expect(view.costSource).toBe('fills');expect(view.winProb).toBeCloseTo(.67);expect(view.probSource).toBe('market');
  expect(view.sellValue!).toBeCloseTo(10*.66-view.sellFee!,6);expect(view.holdValue!).toBeCloseTo(6.7);expect(view.unrealized!).toBeCloseTo(view.sellValue!-6.15,6);expect(view.verdict).toBe('LET IT RIDE');expect(view.stale).toBe(false);});
it('before fills sync, cost is exposure plus fees paid, labelled estimate',()=>{
  const {view}=positionView(input({open:undefined}))!;expect(view.costSource).toBe('estimate');expect(view.avgCost!).toBeCloseTo(.615);});
it('a NO position uses the NO bid and 1 − mid',()=>{
  const {view}=positionView(input({position:{ticker:'KXNFLGAME-X-KC',position_fp:'-5',market_exposure_dollars:'1.70',fees_paid_dollars:'0.05'},open:undefined}))!;
  expect(view.side).toBe('no');expect(view.bid).toBeCloseTo(.32);expect(view.winProb).toBeCloseTo(.33);});
it('a settled market shows SETTLING with the payout, not sell math',()=>{
  const {view}=positionView(input({quote:quote('0','1',{status:'finalized',result:'yes'})}))!;expect(view.verdict).toBe('SETTLING');expect(view.holdValue).toBe(10);expect(view.reason).toContain('$10.00');});
it('a quote older than 30 s is stale and says so',()=>{
  const {view}=positionView(input({now:1000+31000}))!;expect(view.stale).toBe(true);expect(view.reason).toContain('old');});
it('no price at all: NO PRICE',()=>{
  const {view}=positionView(input({quote:quote('0','0')}))!;expect(view.verdict).toBe('NO PRICE');});
it('SELL only when the bid nets more than the hold value by the margin',()=>{
  const combo:ComboView={legs:[],value:.002,won:7,lost:0,pending:1,unknown:0,dead:false,oneLeft:true,correlated:false,refValue:null,refLegs:0};
  const cq=quote('.03','.05');const {view}=positionView(input({quote:cq,combo,open:{ticker:'KXNFLGAME-X-KC',side:'yes',contracts:10,avgCost:.004}}))!;
  expect(view.probSource).toBe('legs');expect(view.winProb).toBeCloseTo(.002);expect(view.verdict).toBe('SELL');
  expect(positionView(input({quote:quote('.0021','.05'),combo,open:{ticker:'KXNFLGAME-X-KC',side:'yes',contracts:10,avgCost:.004}}))!.view.verdict).toBe('HOLD');});
it('combo notices: dead stops everything; a newly won leg is announced; first sight is a silent baseline',()=>{
  const base:ComboView={legs:[{ticker:'L1',side:'yes',label:'Iowa',status:'won',p:1,bid:null,ask:null,game:'g1',ref:null,refSource:null},{ticker:'L2',side:'yes',label:'USC',status:'pending',p:.5,bid:.49,ask:.51,game:'g2',ref:null,refSource:null},{ticker:'L3',side:'yes',label:'Ohio',status:'pending',p:.5,bid:.49,ask:.51,game:'g3',ref:null,refSource:null},{ticker:'L4',side:'yes',label:'Utah',status:'pending',p:.5,bid:.49,ask:.51,game:'g4',ref:null,refSource:null}],value:.125,won:1,lost:0,pending:3,unknown:0,dead:false,oneLeft:false,correlated:false,refValue:null,refLegs:0};
  const first=positionView(input({combo:base,quote:quote('.001','.9')}))!;expect(first.view.notice).toBeNull();expect(first.memory.legsWon).toBe(1);
  const won={...base,legs:[base.legs[0],{...base.legs[1],status:'won' as const,p:1},base.legs[2],base.legs[3]],won:2,pending:2,value:.25};
  const second=positionView(input({combo:won,quote:quote('.001','.9'),memory:first.memory,now:2000}))!;expect(second.view.notice?.kind).toBe('leg-won');
  expect(positionView(input({combo:won,quote:quote('.001','.9'),memory:second.memory,now:2000+11*60000}))!.view.notice).toBeNull();
  const oneLeft={...won,legs:[won.legs[0],won.legs[1],{...won.legs[2],status:'won' as const,p:1},won.legs[3]],won:3,pending:1,value:.5,oneLeft:true};
  const third=positionView(input({combo:oneLeft,quote:quote('.001','.9'),memory:second.memory,now:3000}))!;expect(third.view.notice?.kind).toBe('one-left');expect(third.view.notice?.text).toContain('Utah');
  const dead=positionView(input({combo:{...oneLeft,dead:true,lost:1,value:0,legs:[...oneLeft.legs.slice(0,3),{...oneLeft.legs[3],status:'lost' as const,p:0}]},quote:quote('.001','.9'),memory:third.memory,now:4000}))!;
  expect(dead.view.verdict).toBe('DEAD');expect(dead.view.notice?.kind).toBe('dead');expect(dead.view.notice?.text).toContain('Utah');expect(dead.view.holdValue).toBe(0);});
it('single-market notices come from holdNotice with a neutral closing note',()=>{
  const {view}=positionView(input({quote:quote('.20','.22'),open:{ticker:'KXNFLGAME-X-KC',side:'yes',contracts:10,avgCost:.6}}))!;
  expect(view.notice?.kind).toBe('loss');expect(view.notice?.text).not.toContain('backtest');expect(view.notice?.text).toContain('Your call.');});
it('a flat position is nothing',()=>{expect(positionView(input({position:{ticker:'KXNFLGAME-X-KC',position_fp:'0.00'}}))).toBeNull();});
import type {Reference} from '../src/markets/references';
const refOf=(prob:number,o:Partial<Reference>={}):Reference=>({source:'polymarket',prob,time:1000,stale:false,status:'auto',title:'nfl-x',url:'u',refId:'r',...o});
it('a trusted outside reference becomes the win chance; the verdict compares the bid with it',()=>{
  const {view}=positionView(input({reference:refOf(.55)}))!;expect(view.winProb).toBeCloseTo(.55);expect(view.marketProb).toBeCloseTo(.67);expect(view.probSource).toBe('reference');
  expect(view.holdValue).toBeCloseTo(5.5);expect(view.verdict).toBe('SELL');expect(view.reason).toContain('Polymarket 55.0%');expect(view.reason).toContain('Kalshi 67.0%');});
it('a suggested or stale reference changes nothing, and the reason says why',()=>{
  const s=positionView(input({reference:refOf(.3,{status:'suggested'})}))!.view;expect(s.winProb).toBeCloseTo(.67);expect(s.probSource).toBe('market');expect(s.reason).toContain('not confirmed');
  const st=positionView(input({reference:refOf(.3,{stale:true})}))!.view;expect(st.winProb).toBeCloseTo(.67);expect(st.reason).toContain('stale');});
it('a NO position uses one minus the reference',()=>{
  expect(positionView(input({position:{ticker:'KXNFLGAME-X-KC',position_fp:'-5',market_exposure_dollars:'1.70'},open:undefined,reference:refOf(.55,{source:'sportsbooks'})}))!.view.winProb).toBeCloseTo(.45);});
