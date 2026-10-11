import {it,expect} from 'vitest';
import {aggregate,kalshiSide,sharpFlags,lean,kalshiBtcTicker,leanStats} from '../src/markets/sharps';
import type {SharpWallet} from '../src/markets/sources/falcon';
import type {PmPosition} from '../src/markets/sources/pmdata';
import type {LeanRow} from '../src/markets/journal';
const w=(a:string,rank=1):SharpWallet=>({address:a,rank,tier:'Elite',score:80,roi:.1,winRate:.55,sharpe:1,trades:100,markets:50,pnl:1000,volume:1e4,trajectory:'stable',source:'falcon',name:null});
const pos=(wallet:string,outcome:string,value:number,avgPrice=.5,curPrice=.55,cond='C1'):PmPosition=>({wallet,cond,outcome,outcomeIndex:outcome==='Yes'?0:1,title:'Will X happen?',eventSlug:'x',size:value/curPrice,avgPrice,curPrice,value,cost:value*avgPrice/curPrice,endDate:'2026-11-01',redeemable:false});
const wallets=new Map(['a','b','c','d','e'].map((a,i)=>[a,w(a,i+1)]));
it('groups sharp positions by market and outcome, and counts sharp money on the other side',()=>{
  const bets=aggregate([pos('a','Yes',1000,.4),pos('b','Yes',3000,.5),pos('c','Yes',500,.45),pos('d','No',200),pos('x','Yes',9999),pos('e','Yes',50),pos('e','Yes',500,.5,.99,'C2')],wallets);
  expect(bets).toHaveLength(2);const yes=bets[0];expect(yes.outcome).toBe('Yes');expect(yes.wallets).toBe(3);expect(yes.value).toBe(4500);
  expect(yes.avgEntry!).toBeCloseTo((1000/.55*.4+3000/.55*.5+500/.55*.45)/(4500/.55),6);expect(yes.against).toEqual({wallets:1,value:200,outcomes:['No']});
  // not a sharp wallet, under $100, and a decided (99¢) market are all left out
  expect(bets.some(b=>b.cond==='C2')).toBe(false);});
it('maps a Polymarket outcome to the Kalshi side that pays on it',()=>{expect(kalshiSide('Hurricanes','Hurricanes')).toBe('yes');expect(kalshiSide('Hurricanes','Flyers')).toBe('no');expect(kalshiSide('Yes','No')).toBe('no');});
it('copy flags need 3+ wallets, $3,000, little money against, a trusted link and a price near the sharps\' entry',()=>{
  const bet=aggregate([pos('a','Yes',1000,.5),pos('b','Yes',1500,.5),pos('c','Yes',800,.5)],wallets)[0];const none=()=>null;
  const link={ticker:'K',event:'E',group:'politics' as const,side:'yes' as const,ask:.52,status:'confirmed'};
  const f=sharpFlags(bet,link,1000,none);expect(f).toHaveLength(1);expect(f[0].type).toBe('sharp-yes');expect(f[0].edge).toBe(3);
  expect(sharpFlags(bet,{...link,status:'suggested'},1000,none)).toHaveLength(0);
  expect(sharpFlags(bet,{...link,ask:.56},1000,none)).toHaveLength(0);
  expect(sharpFlags(bet,link,1000,()=>({time:0,edge:3}))).toHaveLength(0);expect(sharpFlags(bet,link,1000,()=>({time:0,edge:2}))).toHaveLength(1);
  const small=aggregate([pos('a','Yes',1000),pos('b','Yes',1000)],wallets)[0];expect(sharpFlags(small,link,1000,none)).toHaveLength(0);});
it('lean: net dollars on Up from buys and sells of either outcome, sharp wallets apart',()=>{
  const t=(wallet:string,side:'BUY'|'SELL',outcome:string,size:number,price:number,time=10)=>({wallet,side,outcome,size,price,time});
  const l=lean([t('a','BUY','Up',100,.5),t('a','SELL','Down',100,.4),t('z','BUY','Down',100,.6),t('b','BUY','Down',10,.5,99)],new Set(['a','b']),50);
  expect(l.sharpNet).toBeCloseTo(90);expect(l.allNet).toBeCloseTo(30);expect(l.sharpWallets).toBe(1);});
it('builds the Kalshi 15-minute ticker from New York time',()=>{
  expect(kalshiBtcTicker(Date.parse('2026-10-10T21:00:00Z')/1000)).toBe('KXBTC15M-26OCT101715-15');
  expect(kalshiBtcTicker(Date.parse('2026-10-11T03:45:00Z')/1000)).toBe('KXBTC15M-26OCT110000-00');});
it('scores the lean by hit rate and by paper P&L of buying the sharps\' side on Kalshi',()=>{
  const row=(round:number,net:number,result:'yes'|'no',yesBid=.5,yesAsk=.52):LeanRow=>({round,horizon:300,time:0,ticker:'T'+round,upPrice:.5,sharpNet:net,allNet:0,sharpWallets:2,yesBid,yesAsk,result});
  const s=leanStats([row(1,500,'yes'),row(2,-500,'no'),row(3,500,'no'),row(4,50,'yes')]).find(x=>x.horizon===300)!;
  expect(s.calls).toBe(3);expect(s.hits).toBe(2);expect(s.paper.n).toBe(3);expect(s.proven).toBe(false);});
import {ruleOk} from '../src/markets/crypto';
import {eiaFor} from '../src/markets/sources/eia';
it('crypto rounds are modelled only when their rule is the Bitcoin 15-minute settlement; EIA context only for oil and gas',()=>{
  expect(ruleOk("If the simple average of the sixty seconds of CF Benchmarks' SOLUSDRTI before 3:00 AM EDT on Oct 11, 2026 is at least the simple average of the sixty seconds of CF Benchmarks' SOLUSDRTI before 2:45 AM EDT on October 11, 2026, then the market resolves to Yes.")).toBe(true);
  expect(ruleOk("If the CF Benchmarks' SOLUSDRTI at 3:00 AM is above 110, then the market resolves to Yes.")).toBe(false);expect(ruleOk(undefined)).toBe(false);
  expect(eiaFor('KXWTI')).toBe('WTI spot');expect(eiaFor('KXAAAGASD')).toBe('US regular gasoline');expect(eiaFor('KXNFLGAME')).toBeNull();});
