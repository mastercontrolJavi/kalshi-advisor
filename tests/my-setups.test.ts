import {it,expect} from 'vitest';
import {Journal} from '../src/engine/journal';
import {mySetups,tallyMySetups} from '../src/engine/my-setups';
import {classifySetup,describeSetup,myRecordText,type MySetups} from '../src/backtest/setups';
import type {RealEvent} from '../src/engine/guardrails';
// Same scale as setups.test.ts: sigma 1.5e-5/s at $80k, 400 s left → one z unit is ~$24, a normal minute ~$9.30.
const T0=1_792_000_000_000,sigma=1.5e-5;
const buy=(id:string,ticker:string,time:number,side:'yes'|'no',price:number,contracts:number):RealEvent=>({id,ticker,time,type:'fill',pnl:0,closedContracts:0,contracts,side,price,action:'buy'});
const settle=(ticker:string,time:number,pnl:number):RealEvent=>({id:'settlement:'+ticker,ticker,time,type:'settlement',pnl,contracts:1});
it('tallies your settled rounds by the setup at your first buy, with/against, flips, P&L and stake',()=>{
  const j=new Journal(':memory:'),tick=(ticker:string,time:number,proxy:number,tau:number,setup?:unknown)=>j.tick({time,ticker,proxy,K:80000,tau,sigma,p:.5,mid:.5,regime:'normal',...(setup?{setup}:{})});
  // A: older tick (no stored setup), BTC $15 above with 400 s left and flat over the minute → trend UP; you bought YES.
  tick('KXBTC15M-A',T0-60000,80014,460);tick('KXBTC15M-A',T0,80015,400);
  // B: same trend, but you bought NO (against) and later YES too (a flip), and lost.
  tick('KXBTC15M-B',T0+1e6-60000,80014,460);tick('KXBTC15M-B',T0+1e6,80015,400);
  // C: the stored setup wins over the columns: journaled as a coin flip in the 15–10 window.
  tick('KXBTC15M-C',T0+2e6,80015,400,{kind:'coinflip',side:'no',z:-.1,move1:0,change1:0,dist:-2,window:'15–10'});
  // D: not settled yet; E: settled but no journal tick; F: first buy with 60 s left (outside the windows).
  tick('KXBTC15M-D',T0+3e6,80015,400);tick('KXBTC15M-F',T0+5e6,80015,60);
  for(const t of ['A','B','C','D','E','F'])j.settle('KXBTC15M-'+t,'yes',T0+9e6,null,null,null,{});
  j.real([buy('a1','KXBTC15M-A',T0+500,'yes',.7,10),buy('a2','KXBTC15M-A',T0+30000,'yes',.75,4),settle('KXBTC15M-A',T0+6e5,4.1),
    buy('b1','KXBTC15M-B',T0+1e6+200,'no',.3,10),{...buy('b2','KXBTC15M-B',T0+1e6+9000,'yes',.6,10),action:'sell',side:'yes'},buy('b3','KXBTC15M-B',T0+1e6+20000,'yes',.8,10),
    settle('KXBTC15M-B',T0+1e6+6e5,-2),buy('c1','KXBTC15M-C',T0+2e6,'no',.5,20),settle('KXBTC15M-C',T0+2e6+6e5,-10),
    buy('d1','KXBTC15M-D',T0+3e6,'yes',.7,10),buy('e1','KXBTC15M-E',T0+4e6,'yes',.7,10),settle('KXBTC15M-E',T0+4e6+6e5,3),
    buy('f1','KXBTC15M-F',T0+5e6,'yes',.9,10),settle('KXBTC15M-F',T0+5e6+6e5,1),buy('h1','KXBTCD-26OCT1720-T80000',T0,'yes',.5,10)]);
  const m=mySetups(j,T0+1e7),cell=(w:string,k:string)=>m.cells.find(c=>c.window===w&&c.kind===k);
  expect([m.rounds,m.unclassified]).toEqual([3,2]);
  expect(cell('10–5','trend')!.with).toEqual({n:1,up:1,pnl:4.1,staked:7+3,flips:0,flipPnl:0});
  // The sale is not a stake or a flip; the later YES buy is the flip.
  expect(cell('10–5','trend')!.against).toMatchObject({n:1,up:0,pnl:-2,flips:1,flipPnl:-2});expect(cell('10–5','trend')!.against!.staked).toBeCloseTo(11);
  expect(cell('15–10','coinflip')).toMatchObject({with:{n:1,up:0,pnl:-10,staked:10},against:null});
  j.db.close();
});
it('a round counts only once both its settlement and its result are in',()=>{
  const ticks=()=>({proxy:80015,k:80000,tau:400,sigma,setup:null});
  const events=[buy('a','KXBTC15M-A',T0,'yes',.6,5),settle('KXBTC15M-A',T0+6e5,2)];
  expect(tallyMySetups(events,new Map(),ticks).rounds).toBe(0);
  expect(tallyMySetups(events.slice(0,1),new Map([['KXBTC15M-A','yes']]),ticks).rounds).toBe(0);
  expect(tallyMySetups(events,new Map([['KXBTC15M-A','yes']]),ticks).rounds).toBe(1);
});
it('writes one line for your record in the live setup, named the way the history lines are',()=>{
  const r=(n:number,up:number,pnl:number,staked:number,flips=0,flipPnl=0)=>({n,up,pnl,staked,flips,flipPnl});
  const mine:MySetups={updated:0,rounds:9,unclassified:0,cells:[{window:'10–5',kind:'trend',with:r(3,3,60,150),against:r(1,0,-4,30,1,-4)}]};
  const down=classifySetup({tau:400,k:80000,sigma,spot:79985,spot60:79986})!;
  expect(myRecordText(down,mine)).toBe('Your record here: 4 rounds, 3 up, +$56 on $180 staked — buying NO 3 (+$60), YES 1 (−$4). You flipped sides in 1 of them (−$4).');
  expect(myRecordText(classifySetup({tau:400,k:80000,sigma,spot:80003,spot60:80000})!,mine)).toBe('Your record here: none of your rounds yet.');
  expect(describeSetup(down,null,{...mine,cells:[{...mine.cells[0],against:null}]}).mine).toBe('Your record here: 3 rounds, 3 up, +$60 on $150 staked — buying NO.');
  expect(describeSetup(down,null).mine).toBeNull();
  expect(myRecordText(classifySetup({tau:60,k:80000,sigma,spot:79985,spot60:79986})!,mine)).toBeNull();
});
