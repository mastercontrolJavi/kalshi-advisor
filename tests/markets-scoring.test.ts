import {it,expect} from 'vitest';
import {flagStats,evidence} from '../src/markets/scoring';
import {MarketsJournal} from '../src/markets/journal';
import {parseMarket} from '../src/markets/quotes';
import type {Flag} from '../src/markets/flags';
const f=(ticker:string,time:number,side:'yes'|'no',price:number,o:Partial<Flag>={}):Flag=>({time,ticker,event:ticker.split('-')[0]+'-E',group:'sports',type:'ref-gap-yes',side,price,fee:.01,edge:.05,context:{},...o});
it('settles flags with paper P&L; a market without a yes/no result is never scored',()=>{
  const j=new MarketsJournal(':memory:');j.putFlags([f('A-1',1,'yes',.6),f('A-1',2,'no',.38,{type:'ref-gap-no'}),f('B-1',3,'yes',.5)]);
  expect(j.openFlagTickers().sort()).toEqual(['A-1','B-1']);j.settleFlags('A-1','yes',10);
  const rows=j.flagRows();expect(rows.find(r=>r.ticker==='A-1'&&r.side==='yes')!.pnl).toBeCloseTo(1-.6-.01);expect(rows.find(r=>r.ticker==='A-1'&&r.side==='no')!.pnl).toBeCloseTo(-.39);
  expect(j.openFlagTickers()).toEqual(['B-1']);const s=flagStats(rows);expect(s.find(x=>x.type==='ref-gap-yes'&&x.group==='sports')!.n).toBe(1);
  expect(j.lastFlag('A-1','ref-gap-yes')).toEqual({time:1,edge:.05});expect(j.lastFlag('Z','ref-gap-yes')).toBeNull();j.db.close();});
it('proven needs 100 settled, a range above zero and both halves positive; ranges resample events',()=>{
  const j=new MarketsJournal(':memory:'),flags:Flag[]=[];
  for(let i=0;i<120;i++)flags.push(f(`E${i}-M`,i,'yes',.5,{event:'E'+i}));j.putFlags(flags);
  for(let i=0;i<120;i++)j.settleFlags(`E${i}-M`,i%100<55?'yes':'no',1000);
  let s=evidence(flagStats(j.flagRows()),'ref-gap-yes','sports')!;expect(s.n).toBe(120);expect(s.mean!).toBeGreaterThan(0);expect(s.low!).toBeGreaterThan(-1);
  const proven=flagStats(j.flagRows().map((r,i)=>({...r,pnl:i%4===0?-.2:.2})));expect(evidence(proven,'ref-gap-yes','sports')!.proven).toBe(true);
  const late=flagStats(j.flagRows().map((r,i)=>({...r,pnl:i<60?.3:-.1})));expect(evidence(late,'ref-gap-yes','sports')!.proven).toBe(false);
  const few=flagStats(j.flagRows().slice(0,90).map(r=>({...r,pnl:.2})));expect(evidence(few,'ref-gap-yes','sports')!.proven).toBe(false);expect(evidence(few,'ref-gap-yes','all')!.n).toBe(90);j.db.close();});
it('flagged markets past their close wait for a result; snapshots carry cumulative volume',()=>{
  const j=new MarketsJournal(':memory:');j.upsertMarket(parseMarket({ticker:'A-1',event_ticker:'A',status:'closed',result:'',close_time:'2026-10-01T00:00:00Z'},1),'Sports','sports');j.putFlags([f('A-1',1,'yes',.5)]);
  expect(j.awaitingResult(Date.parse('2026-10-02T00:00:00Z'))).toEqual(['A-1']);
  j.snapshot([{ticker:'A-1',time:5,yesBid:.4,yesAsk:.42,last:null,volume24h:10,held:false,volume:1234}]);const r=j.recentMids('A-1',0);expect(r).toHaveLength(1);expect(r[0]).toMatchObject({t:5,volume:1234});expect(r[0].mid).toBeCloseTo(.41,9);j.db.close();});
