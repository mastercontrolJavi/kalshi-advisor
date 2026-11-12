import {it,expect} from 'vitest';
import {gateEvaluation,gateTactics,paperProven} from '../src/engine/evidence';
import {ruleProven,signalEvidence,type Verdict,type RuleResult} from '../src/backtest/verdict';
const rule=(over:Partial<RuleResult>={}):RuleResult=>({n:2661,mean:-.004,ci:[-.02,.011],early:-.004,late:-.005,...over});
const verdict=(buy15:RuleResult):Verdict=>({generated:new Date().toISOString(),from:0,to:1,rounds:9182,buy15,
  exits:{fixed:{mean:0,ci:[0,0]},trailing:{mean:0,ci:[0,0]}},kalshiBetter:{fifteen:13,fifteenOf:14},profitable:[],strategies:32,ruin:[],longshot:{fifteen:null},finalMinute:null});
const proven=rule({mean:.02,ci:[.005,.035],early:.02,late:.018});
const firm={action:'BUY YES',reason:'Buy YES at 52¢ or less',idea:{side:'yes',kind:'taker',price:.5,fee:.0175,edge:.05,contracts:3,cost:1.5,maxLoss:1.55,queue:0,reason:''},makers:[],edges:{yes:.05,no:-.1},
  firm:{side:'yes' as const,limit:.52,heldMs:4000,edgeNow:.05,id:7},forming:null} as any;

it('a rule is proven only with 100+ trades, a 95% range above zero and a profit in both halves',()=>{
  expect(ruleProven(proven)).toBe(true);
  expect(ruleProven(rule())).toBe(false);
  expect(ruleProven({...proven,n:99})).toBe(false);
  expect(ruleProven({...proven,late:-.001})).toBe(false);
  expect(ruleProven(null)).toBe(false);
  expect(signalEvidence(verdict(rule()),'15m').text).toContain('2,661 past rounds');
  expect(signalEvidence(null,'15m').text).toContain('backtested');
  // A stale verdict never counts as proof, even for a rule that cleared the bar.
  const old=Date.parse(verdict(proven).generated)+15*86400000;
  expect(signalEvidence(verdict(proven),'15m','quant').proven).toBe(true);
  expect(signalEvidence(verdict(proven),'15m','quant',old)).toEqual({proven:false,text:expect.stringContaining('out of date')});});

it('an unproven firm BUY is hidden from the dashboard with the evidence; a proven one, or the gate off, passes through',()=>{
  const hidden=gateEvaluation(firm,verdict(rule()),'quant',true);
  expect(hidden.action).toBe('NO TRADE');expect(hidden.idea).toBeNull();expect(hidden.firm).toBeNull();
  expect(hidden.hidden?.side).toBe('yes');expect(hidden.hidden?.text).toContain('no proven edge');
  expect(gateEvaluation(firm,verdict(proven),'quant',true)).toBe(firm);
  expect(gateEvaluation(firm,verdict(rule()),'quant',false)).toBe(firm);
  // The raw-model rule is judged on its own record.
  const v={...verdict(proven),buy15Model:rule()};expect(gateEvaluation(firm,v,'model',true).action).toBe('NO TRADE');
  // A forming signal does not count down toward a BUY that will never show.
  const forming={...firm,action:'NO TRADE',idea:null,firm:null,forming:{side:'no',ms:1000,needMs:3000},reason:'BUY NO forming: confirms if it holds 2 s more · edge 5.0¢'};
  const g=gateEvaluation(forming,verdict(rule()),'quant',true);expect(g.forming).toBeNull();expect(g.reason).toBe('edge 5.0¢');
  const quiet={...firm,action:'NO TRADE',idea:null,firm:null,forming:null};expect(gateEvaluation(quiet,verdict(rule()),'quant',true)).toBe(quiet);});
it('scalp and dip setups need a proven paper record; a dip "buy" hint is hidden with them, a falling-knife warning is not',()=>{
  const ideas=[{kind:'scalp'},{kind:'dip'}],watch=[{verdict:'buy'},{verdict:'knife'}];
  const losing={scalp:{mean:-.031,low:-.051,high:-.013,count:4433},dip:{mean:-.092,low:-.165,high:-.025,count:713}};
  const g=gateTactics(ideas,watch,losing,true);
  expect(g.ideas).toEqual([]);expect(g.watch).toEqual([{verdict:'knife'}]);expect(g.hidden).toContain('4,433 paper trades');
  const scalpOk={...losing,scalp:{mean:.02,low:.004,high:.03,count:150}};
  expect(gateTactics(ideas,watch,scalpOk,true).ideas).toEqual([{kind:'scalp'}]);
  expect(gateTactics(ideas,watch,losing,false)).toEqual({ideas,watch,hidden:null});
  expect(gateTactics(ideas,watch,null,true).hidden).toContain('no paper record yet');
  expect(gateTactics([],[{verdict:'knife'}],losing,true).hidden).toBeNull();
  expect(gateTactics([{kind:'scalp'}],[],losing,true).hidden).not.toContain('dips');
  expect(paperProven({mean:.02,low:.004,high:.03,count:99})).toBe(false);});
