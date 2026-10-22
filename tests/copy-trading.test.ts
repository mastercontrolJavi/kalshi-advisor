import {it,expect} from 'vitest';
import {copyRecord} from '../src/markets/scoring';
import {PaperDesk,type MarketNow} from '../src/engine/paper';
import {Journal} from '../src/engine/journal';
import {baseFees} from '../src/engine/model/fees';
const row=(time:number,event:string,group:string,type:string,price:number,pnl:number|null)=>({id:time,time,ticker:event+'-T',event,group,type,side:'yes',price,fee:.01,edge:0,result:pnl===null?null:pnl>0?'yes':'no',pnl});
it('counts one result per game when copying the sharps, by category and overall',()=>{
  const rows=[row(1,'G1','sports','sharp-yes',.5,.49),row(2,'G1','sports','sharp-yes',.55,.44),row(3,'G2','sports','sharp-no',.4,-.41),row(4,'G3','politics','sharp-yes',.6,.39),
    row(5,'G4','sports','scanner',.3,.69),row(6,'G5','sports','sharp-yes',.5,null)];
  const r=Object.fromEntries(copyRecord(rows as any).map(x=>[x.group,x]));
  // G1 counts once (its first flag); the scanner flag and the unsettled G5 do not count.
  expect(r.all).toMatchObject({n:3,wins:2});expect(r.all.implied).toBeCloseTo(.5+.4+.6,9);expect(r.all.mean).toBeCloseTo((.49-.41+.39)/3,9);
  expect(r.sports).toMatchObject({n:2,wins:1});expect(r.politics.n).toBe(1);expect(r.all.proven).toBe(false);expect(r.all.low).toBeLessThan(r.all.mean);
});
it('paper-trades any Kalshi market and settles it on Kalshi’s result',()=>{
  const j=new Journal(':memory:'),desk=new PaperDesk(j),now=Date.now();desk.reset(1000,now);
  const book={yes:[[.41,500]] as [number,number][],no:[[.57,500]] as [number,number][],valid:true,updated:now};
  const m:MarketNow={ticker:'KXNBAGAME-26OCT22LALBOS-LAL',tau:86400,active:true,book,delayed:false,delayMs:0,schedule:baseFees,bookStaleMs:5000,now,
    context:{title:'Lakers at Celtics · Lakers win',url:'https://kalshi.com/markets/kxnbagame',copy:{wallets:4,value:12000,avgEntry:.42,group:'sports'}}};
  const res=desk.order({side:'yes',action:'buy',dollars:40},m);// $40 at a 43¢ ask buys 89 once the fee is counted.
  expect(res.fills[0]).toMatchObject({side:'yes',contracts:89});
  expect(desk.openTickers()).toEqual(['KXNBAGAME-26OCT22LALBOS-LAL']);
  const open=desk.summary(()=>({bid:.45,fair:null}));expect(open.positions![0]).toMatchObject({title:'Lakers at Celtics · Lakers win',copy:true,bid:.45});
  desk.setResult('KXNBAGAME-26OCT22LALBOS-LAL','yes',now+5e6);
  expect(desk.openTickers()).toEqual([]);const rep=desk.report(null),review=rep.coach!.reviews[0];
  expect(review).toMatchObject({source:'copy',group:'sports',title:'Lakers at Celtics · Lakers win',verdict:'good'});expect(review.pnl).toBeGreaterThan(0);
  expect(review.notes[0]).toMatch(/Copied 4 ranked wallets holding \$12,000 from 42¢/);
  expect(rep.coach!.working.map(g=>g.label)).toEqual([]);
});
