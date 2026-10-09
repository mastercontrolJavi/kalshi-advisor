import {it,expect} from 'vitest';
import {effectiveFees} from '../src/engine/feeds/kalshi';
import {normalizeAccount,type OpenCost} from '../src/engine/account';
import {holdNotice,type ExitConfig} from '../src/engine/exits';
import {fee} from '../src/engine/model/fees';
const cfg:ExitConfig={exitMode:'hold',exitMargin:.02,makerMargin:.03,takeProfitPct:.25,stopLossPct:.5,stopWinProb:.25,trailGiveback:.5,trailFloor:.05};
it('combo series fee type is the quadratic taker fee (real fill: 2,777.77 at 0.33¢ paid $0.639559)',()=>{
  const s=effectiveFees({fee_type:'quadratic_with_combo_maker_fees',fee_multiplier:1},[],'E',Date.now());
  expect(s.verified).toBe(true);expect(fee(.0033,2777.77,'taker',s)).toBeCloseTo(.6396,3);});
it('normalizeAccount takes a ticker predicate and returns FIFO open cost with fees for non-Bitcoin markets',()=>{
  const fills=[{fill_id:'1',ticker:'KXNFLGAME-26OCT04KCLV-KC',outcome_side:'yes',action:'buy',count_fp:'4.62',yes_price_dollars:'0.6700',fee_cost:'0.07',created_time:'2026-10-04T09:30:00Z'},
    {fill_id:'2',ticker:'KXBTC15M-26OCT04-00',outcome_side:'yes',action:'buy',count_fp:'1',yes_price_dollars:'0.5',fee_cost:'0.02',created_time:'2026-10-04T09:31:00Z'}];
  const open=new Map<string,OpenCost>();const events=normalizeAccount(fills,[],t=>!t.startsWith('KXBTC'),open);
  expect(events).toHaveLength(1);expect(open.get('KXNFLGAME-26OCT04KCLV-KC')!.avgCost).toBeCloseTo(.67+.07/4.62,6);expect(open.has('KXBTC15M-26OCT04-00')).toBe(false);});
it('holdNotice uses the caller note instead of the Bitcoin backtest sentence',()=>{
  const n=holdNotice(-6,-.6,null,.25,.2,.6,.2,4,10,cfg,null,'Your call.')!;expect(n.kind).toBe('loss');expect(n.text.endsWith('Your call.')).toBe(true);expect(n.text).not.toContain('backtest');});
