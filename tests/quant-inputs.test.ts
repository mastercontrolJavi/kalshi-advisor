import {it,expect} from 'vitest';
import {usableMid} from '../src/engine/quant/quote';
import {stackSamples,lateSamples} from '../src/engine/quant/samples';
import {predict,priorFit} from '../src/engine/quant/stack';
import {Journal} from '../src/engine/journal';

it('a stale, invalid, crossed or wide book cannot affect the quant forecast',()=>{
  const book={valid:true,updated:1000,yesBid:.5,yesAsk:.52};
  expect(usableMid(book,2000,5000)).toBeCloseTo(.51);
  for(const b of [{...book,valid:false},{...book,updated:-10000},{...book,updated:3000},{...book,yesAsk:null},{...book,yesAsk:.8},{...book,yesAsk:.4},{...book,yesBid:NaN}]){
    const mid=usableMid(b,2000,5000);expect(mid).toBeNull();
    expect(predict(priorFit(),{modelP:.7,mid,sigma:.001,momentum30s:null,momentum120s:null,imbalance:null,tradeFlow30s:null}).p).toBeCloseTo(.7);
  }
});
it('late learning preserves exact missing quotes, validates legacy delay, and keeps settlement availability',()=>{
  const j=new Journal(':memory:');
  try{
    const book={valid:true,updated:1000,yesBid:.5,yesAsk:.52};
    for(const [ticker,extra] of [
      ['exact',{stackInputs:{mid:null}}],['lagged',{bookDelay:3000}],['rest',{bookDelay:100,kalshiDelay:20000}],['stale',{book:{...book,updated:-10000}}],['bad',{book:{...book,valid:false}}]
    ] as const){
      j.tick({time:1100,ticker,proxy:80000,K:80000,tau:30,sigma:.001,p:.7,mid:.51,regime:'normal',book,features:{momentum30s:.001},engineTime:1100,...extra});
      j.settle(ticker,'yes',50000,null,null,null,{});
    }
    const cache=new Map(),samples=lateSamples(j.db,cache);
    expect(samples).toHaveLength(5);expect(samples.find(s=>s.ticker==='rest')?.mid).toBeCloseTo(.51);
    for(const ticker of ['exact','lagged','stale','bad'])expect(samples.find(s=>s.ticker===ticker)?.mid).toBeNull();
    expect(samples.every(s=>s.time===1100&&s.settledTime===50000)).toBe(true);
    expect(lateSamples(j.db,cache)).toEqual(samples);
  }finally{j.db.close();}
});
it('training uses the exact live midpoint feature, including explicit null, with legacy fallback',()=>{
  const j=new Journal(':memory:');
  try{
    for(const [ticker,inputs] of [['null',{mid:null}],['usable',{mid:.6}],['legacy',{}]] as const){
      j.db.prepare('INSERT INTO opening_calls VALUES(?,?,?,?,?,?,?,?,?)').run(ticker,1,890,'UP',.6,.6,0,.9,JSON.stringify({inputs:{modelP:.65,sigma:.001,...inputs}}));
      j.settle(ticker,'yes',2,null,null,null,{});
    }
    const samples=stackSamples(j.db);
    expect(samples.find(s=>s.ticker==='null')!.mid).toBeNull();
    expect(samples.find(s=>s.ticker==='usable')!.mid).toBe(.6);
    expect(samples.find(s=>s.ticker==='legacy')!.mid).toBe(.9);
  }finally{j.db.close();}
});
