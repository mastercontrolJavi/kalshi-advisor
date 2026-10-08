import {it,expect} from 'vitest';
import {spotSeries,spotAt,basisTrack,quote,simulate,priceBuckets,clusterCI,appRule,atMinute,edges,bankroll,type Row} from '../src/backtest/sim';
import {candleRow,candleBatches,hourlyEvent,hourlyStrikes,hourlyTicker,HistoryStore,type MarketRow,type SpotRow} from '../src/backtest/history';
import {fee} from '../src/engine/model/fees';
const minute=(i:number,close:number,t0=1_000_020):SpotRow=>({ts:t0-20+i*60,open:close,high:close,low:close,close,volume:1});
it('spot at an instant is the close of the Coinbase minute ending then, and volatility uses only earlier returns',()=>{
  // Alternating ±0.1% returns: 1-minute variance = 1e-6, so per-second sigma = sqrt(1e-6/60).
  const rows=Array.from({length:200},(_,i)=>minute(i,100*Math.exp((i%2?1:0)*.001)));const s=spotSeries(rows,30,.25,120);
  const at=spotAt(s,rows[150].ts+60)!;expect(at.price).toBe(rows[150].close);expect(at.sigma).toBeCloseTo(Math.sqrt(1e-6/60),8);
  expect(spotAt(s,rows[10].ts+60)).toBeNull();// fewer than 30 returns: no volatility yet
  expect(spotAt(s,rows[150].ts+30)).toBeNull();});
it('basis at a time uses only rounds that had opened by then',()=>{
  const rows=Array.from({length:60},(_,i)=>minute(i,100,1_000_020));const s=spotSeries(rows);
  const mk=(open:number,strike:number):MarketRow=>({ticker:'M'+open,series:'KXBTC15M',event:null,open_ts:open,close_ts:open+900,strike,result:'yes',settle:null,volume:null,source:'live',candles:1});
  const t=basisTrack([mk(rows[10].ts+60,103),mk(rows[30].ts+60,107)],s);
  expect(t.at(rows[10].ts+59)).toBeNull();expect(t.at(rows[20].ts)).toBe(3);expect(t.at(rows[40].ts)).toBe(5);});
it('quotes need both sides; the mid needs a spread of at most 10¢',()=>{
  expect(quote({bid:0,ask:.4})).toEqual({bid:null,ask:null,mid:null});expect(quote({bid:.3,ask:1})).toEqual({bid:null,ask:null,mid:null});
  expect(quote({bid:.3,ask:.45}).mid).toBeNull();expect(quote({bid:.4,ask:.42}).mid).toBeCloseTo(.41);});
const row=(o:Partial<Row>):Row=>({cluster:'A',ticker:'A',time:0,tau:600,y:1,strike:100,spot:100,sigma:1e-5,basis:0,model:.5,quant:.5,bid:.49,ask:.51,mid:.5,...o});
it('one entry per round, held to settlement, pays $1 minus price and fee',()=>{
  const rows=[row({time:60,tau:840,quant:.6}),row({time:120,tau:780,quant:.7}),row({cluster:'B',ticker:'B',y:0,time:60,tau:840,quant:.6})];
  const t=simulate(rows,appRule(r=>r.quant));expect(t).toHaveLength(2);
  expect(t[0].tau).toBe(840);expect(t.find(x=>x.cluster==='A')!.pnl).toBeCloseTo(1-.51-fee(.51),9);expect(t.find(x=>x.cluster==='B')!.pnl).toBeCloseTo(-.51-fee(.51),9);});
it('the edge matches the live BUY arithmetic on both sides',()=>{
  const e=edges(row({bid:.3,ask:.32}),.4);expect(e.yes).toBeCloseTo(.4-.32-fee(.32),9);expect(e.no).toBeCloseTo(.6-.7-fee(.7),9);});
it('exits sell at a later bid minus the taker fee: take profit, cut loss, and trailing give-back',()=>{
  const entry=row({time:60,tau:840,bid:.48,ask:.5}),cost=.5+fee(.5);
  const tp=simulate([entry,row({time:120,tau:780,bid:.7,ask:.71})],atMinute(840,()=>'yes'),{tp:.25,sl:.5});
  expect(tp[0].exitReason).toBe('take profit');expect(tp[0].pnl).toBeCloseTo(.7-fee(.7)-cost,9);
  const sl=simulate([entry,row({time:120,tau:780,bid:.2,ask:.22,y:1})],atMinute(840,()=>'yes'),{tp:.25,sl:.5});
  expect(sl[0].exitReason).toBe('cut loss');expect(sl[0].pnl).toBeCloseTo(.2-fee(.2)-cost,9);
  // NO side sells at 1 − YES ask.
  const no=simulate([entry,row({time:120,tau:780,bid:.2,ask:.25,y:1})],atMinute(840,()=>'no'),{tp:.25,sl:.5});
  expect(no[0].exitReason).toBe('take profit');expect(no[0].pnl).toBeCloseTo(.75-fee(.75)-(.52+fee(.52)),9);
  const trail=simulate([entry,row({time:120,tau:780,bid:.8,ask:.81}),row({time:180,tau:720,bid:.9,ask:.91}),row({time:240,tau:660,bid:.6,ask:.61})],atMinute(840,()=>'yes'),{tp:.25,sl:.5,trail:{giveback:.5,floor:.05}});
  expect(trail[0].exitReason).toBe('trailing take profit');expect(trail[0].exitTau).toBe(660);
  expect(simulate([entry,row({time:120,tau:780,bid:.8,ask:.81})],atMinute(840,()=>'yes'),{tp:.25,trail:{giveback:.5,floor:.05}})[0].exitTau).toBeNull();});
it('price buckets count both sides of every quote with the fee',()=>{
  const b=priceBuckets([row({bid:.79,ask:.81,y:1})],[0,.5,1]);expect(b).toHaveLength(2);
  expect(b[1].pnl).toBeCloseTo(1-.81-fee(.81),9);expect(b[0].pnl).toBeCloseTo(-.21-fee(.21),9);});
it('confidence ranges resample whole clusters and are reproducible',()=>{
  const g=[{sum:10,n:10},{sum:-10,n:10},{sum:0,n:10},{sum:5,n:10}];expect(clusterCI(g,500,3)).toEqual(clusterCI(g,500,3));
  const [lo,hi]=clusterCI(g,500,3);expect(lo).toBeLessThan(.125);expect(hi).toBeGreaterThan(.125);expect(clusterCI([g[0]])[0]).toBeNaN();});
it('parses live and historical candle formats',()=>{
  const live=candleRow('T',{end_period_ts:60,yes_bid:{close_dollars:'0.4800',low_dollars:'0.29'},yes_ask:{close_dollars:'0.49'},price:{close_dollars:'0.48'},volume_fp:'10.00'});
  const old=candleRow('T',{end_period_ts:60,yes_bid:{close:'0.4800',low:'0.29'},yes_ask:{close:'0.49'},price:{close:null},volume:'10.00'});
  expect(live).toMatchObject({bid:.48,ask:.49,bid_lo:.29,price:.48,volume:10});expect(old).toMatchObject({bid:.48,ask:.49,bid_lo:.29,price:null,volume:10});});
it('hourly event tickers use Eastern time, including after the DST change',()=>{
  expect(hourlyEvent(Date.parse('2026-10-08T00:00:00Z')/1000)).toBe('KXBTCD-26OCT0720');
  expect(hourlyEvent(Date.parse('2026-12-01T05:00:00Z')/1000)).toBe('KXBTCD-26DEC0100');
  expect(hourlyTicker('KXBTCD-26OCT0720',83199.99)).toBe('KXBTCD-26OCT0720-T83199.99');
  const k=hourlyStrikes(83210,100);expect(k).toEqual([83149.99,83199.99,83249.99,83299.99]);});
it('candle batches stay under the tickers × window-minutes cap',()=>{
  const ms=Array.from({length:60},(_,i):MarketRow=>({ticker:'M'+String(i).padStart(2,'0'),series:'KXBTC15M',event:null,open_ts:i*900,close_ts:i*900+900,strike:1,result:'yes',settle:null,volume:null,source:'live',candles:0}));
  const groups=candleBatches(ms);expect(groups.flat()).toHaveLength(60);
  for(const g of groups)expect(g.length*(Math.floor((Math.max(...g.map(m=>m.close_ts))-Math.min(...g.map(m=>m.open_ts)))/60)+1)).toBeLessThanOrEqual(9900);
  expect(groups[0].length).toBe(25);});
it('the history store resumes: candles mark markets done, even when none exist',()=>{
  const s=new HistoryStore(':memory:');s.putMarkets([{ticker:'X',series:'KXBTCD',event:'E',open_ts:0,close_ts:3600,strike:1,result:'yes',settle:2,volume:null,source:'planned',candles:0}]);
  s.putCandles('X',[]);expect(s.markets('KXBTCD')[0].candles).toBe(-1);});
it('bankroll: staking everything is wiped out by the first loss; a small stake survives the same trades',()=>{
  const t=(pnl:number)=>({cluster:'c',ticker:'c',time:0,tau:600,side:'yes' as const,price:.5,cost:.5175,exitTau:null,exitReason:null,pnl,win:pnl>0});
  const trades=[t(.4825),t(.4825),t(-.5175)];
  expect(bankroll(trades,1,40,50,500).ruined).toBe(1);const small=bankroll(trades,.02,40,50,500);expect(small.ruined).toBe(0);expect(small.median).toBeGreaterThan(40);});
import {ruleVerdict,exitVerdict,ruinVerdict,type Verdict} from '../src/backtest/verdict';
import {finalMinuteStudy} from '../src/backtest/live';
import {Journal} from '../src/engine/journal';
const verdict=(o:Partial<Verdict>={}):Verdict=>({generated:new Date().toISOString(),from:Date.parse('2026-07-10')/1000,to:Date.parse('2026-10-08')/1000,rounds:8529,hours:1407,
  buy15:{n:2483,mean:-.0064,ci:[-.0218,.0086],early:-.002,late:-.012},buyHourly:null,exits:{fixed:{mean:-.0128,ci:[-.0246,-.0009]},trailing:{mean:-.009,ci:[-.019,.0007]}},
  kalshiBetter:{fifteen:13,fifteenOf:14,hourly:7,hourlyOf:7},profitable:[],strategies:32,ruin:[{stake:1,ruined:1},{stake:.02,ruined:0}],longshot:{fifteen:-.25,hourly:-.54},finalMinute:null,...o});
it('the BUY verdict states the backtest result and calls an interval spanning zero "no proven edge"',()=>{
  expect(ruleVerdict(null,'15m').text).toContain('npm run backtest');
  const v=ruleVerdict(verdict(),'15m');expect(v.tone).toBe('warn');expect(v.text).toContain('−0.6¢ per contract');expect(v.text).toContain('2,483 past rounds');expect(v.text).toContain('no proven edge');
  expect(ruleVerdict(verdict({buy15:{n:500,mean:.02,ci:[.005,.03],early:.02,late:.02}}),'15m').tone).toBe('yes');
  expect(ruleVerdict(verdict({buy15:{n:500,mean:-.02,ci:[-.03,-.01],early:0,late:0}}),'15m').text).toContain('it lost money');
  expect(ruleVerdict(verdict(),'hourly').text).toContain('Not backtested for hourly');
  expect(ruleVerdict(verdict({buy15Model:{n:6765,mean:-.012,ci:[-.021,-.002],early:0,late:0}}),'15m',Date.now(),'model').text).toMatch(/raw model.*−1\.2¢.*it lost money/);
  expect(ruleVerdict(verdict(),'15m',Date.now(),'model').text).toContain('Not backtested');
  expect(ruleVerdict(verdict({generated:'2026-09-01T00:00:00Z'}),'15m',Date.parse('2026-10-08')).text).toContain('over two weeks old');
  expect(exitVerdict(verdict())).toContain('−1.3¢');expect(ruinVerdict(verdict())).toContain('staking everything fell below $2 in 100% of runs');});
it('final-minute study reads settled rounds from the live journal, one entry per round',()=>{
  const j=new Journal(':memory:'),close=Date.parse('2026-10-08T00:30:00Z');
  for(const [ticker,result,p] of [['A','yes',.97],['B','no',.95]] as const){
    for(let tau=59;tau>=1;tau--)j.tick({time:close-tau*1000,ticker,proxy:100,K:99,tau,sigma:1e-5,p,q:p,mid:.85,regime:'calm',book:{yesBid:.84,yesAsk:.86}});
    j.db.prepare('INSERT INTO outcomes VALUES(?,?,?,?,?,?,?,?)').run(ticker,close,result,null,null,null,null,'{}');}
  const f=finalMinuteStudy(j.db)!;expect(f.rounds).toBe(2);expect(f.model.n).toBe(2);
  // A: buy YES at 86¢ and win; B: buy YES at 86¢ and lose.
  expect(f.model.mean).toBeCloseTo(((1-.86-fee(.86))+(-.86-fee(.86)))/2,9);expect(f.accuracy.length).toBeGreaterThan(0);
  expect(finalMinuteStudy(new Journal(':memory:').db)).toBeNull();});
