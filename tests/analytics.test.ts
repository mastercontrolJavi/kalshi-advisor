import {it,expect} from 'vitest';
import {rollupMarkets,buildAnalytics} from '../src/engine/analytics';
import type {RealEvent} from '../src/engine/guardrails';
const fill=(ticker:string,time:number,side:string,contracts:number,price:number,pnl=0,closedContracts=0):RealEvent=>({id:ticker+time,ticker,type:'fill',time,pnl,contracts,side,price,closedContracts});
const settle=(ticker:string,time:number,outcomePnl:number):RealEvent=>({id:'s'+ticker,ticker,type:'settlement',time,pnl:0,outcomePnl,contracts:0});
const H=3600000;
it('rolls fills and settlements into one row per market with entry, fees, outcome and signal adherence',()=>{
  const events=[fill('A',1*H,'yes',10,.4),settle('A',1*H+900000,6),fill('B',2*H,'no',5,.6),fill('B',2*H+60000,'yes',5,.7,.5,5),settle('B',2*H+900000,.5),fill('C',3*H,'yes',2,.5)];
  const ms=rollupMarkets(events,new Map([['A',.17]]),[{ticker:'A',side:'yes',time:1*H-30000},{ticker:'B',side:'yes',time:2*H-1000}]);
  expect(ms.map(m=>m.ticker)).toEqual(['A','B','C']);
  expect(ms[0]).toMatchObject({side:'yes',contracts:10,avgEntry:.4,fees:.17,pnl:6,status:'settled',followed:true,exitedEarly:false});
  expect(ms[1]).toMatchObject({side:'no',pnl:.5,exitedEarly:true,followed:false});expect(ms[2].status).toBe('open');});
it('computes win rate, profit factor, drawdown, streaks and rolling trends over settled markets',()=>{
  const now=Date.parse('2026-10-07T20:00:00Z');
  const ms=[3,-1,-2,4,-1].map((p,i)=>({ticker:'M'+i,first:now-(5-i)*H,last:now-(5-i)*H+900000,side:'yes' as const,contracts:1,avgEntry:.5,fees:.02,pnl:p,status:'settled' as const,exitedEarly:false,followed:i%2===0,hour:12,holdSeconds:900}));
  const a=buildAnalytics(ms,[],now);
  expect(a.all).toMatchObject({markets:5,pnl:3,wins:2,losses:3,won:7,lost:4});expect(a.all.profitFactor).toBeCloseTo(1.75);expect(a.all.winRate).toBeCloseTo(.4);
  expect(a.maxDrawdown).toBeCloseTo(3);expect(a.streak).toBe(-1);expect(a.bestRun).toBe(1);expect(a.worstRun).toBe(-2);
  expect(a.curve.at(-1)!.pnl).toBeCloseTo(3);expect(a.rolling.at(-1)!.avgPnl).toBeCloseTo(.6);expect(a.byFollow.find(r=>r.bucket==='Advisor idea')!.pnl).toBeCloseTo(0);expect(a.byFollow.find(r=>r.bucket==='Own call')!.pnl).toBeCloseTo(3);});
