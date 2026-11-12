import {describe,it,expect} from 'vitest';
import {summarize,readBotRecord,type BotTrade} from '../src/bot/record';
const t=(time:number,contracts:number,price:number,pnl:number|null,edge:number|null=.05):BotTrade=>({time,ticker:'T'+time,side:'yes',contracts,price,fee:.01,q:.5,edge,secsLeft:300,result:pnl==null?null:pnl>0?'yes':'no',pnl});
describe('bot record',()=>{
  it('summarizes settled rounds per contract and keeps open positions at cost',()=>{
    const s=summarize([t(1,2,.2,1.58),t(2,1,.8,-.81),t(3,1,.25,null)],{cash:15.51,start:15,started:0,peak:16.58},4,99);
    expect(s.rounds).toBe(2);expect(s.wins).toBe(1);expect(s.open).toBe(1);expect(s.misses).toBe(4);
    expect(s.pnl).toBeCloseTo(.77);expect(s.contracts).toBe(3);
    expect(s.perContract).toBeCloseTo((.79-.81)/2);
    expect(s.perContractCi).toBeCloseTo(1.96*Math.sqrt(((.79+.01)**2+(-.81+.01)**2)/1/2));
    expect(s.equity).toBeCloseTo(15.51+.25+.01);
    expect(s.avgPrice).toBeCloseTo((.2*2+.8)/3);
    expect(s.curve.map(p=>p.pnl)).toEqual([1.58,expect.closeTo(.77)]);
    expect(s.trades[0].time).toBe(3);
  });
  it('gives no average or range before two rounds have settled',()=>{
    const none=summarize([],{cash:15,start:15,started:0,peak:15},0,1);
    expect(none.perContract).toBeNull();expect(none.perContractCi).toBeNull();expect(none.avgPrice).toBeNull();expect(none.equity).toBe(15);
    expect(summarize([t(1,1,.2,.79)],{cash:15.79,start:15,started:0,peak:15.79},0,1).perContractCi).toBeNull();
  });
  it('reports a missing ledger instead of throwing',()=>{
    const r=readBotRecord('data/does-not-exist.db','data/does-not-exist.json',5);
    expect(r.missing).toBe(true);expect(r.status).toBeNull();expect(r.rounds).toBe(0);
  });
});
