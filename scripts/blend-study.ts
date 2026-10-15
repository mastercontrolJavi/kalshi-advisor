import {HistoryStore,SERIES15} from '../src/backtest/history';
import {spotSeries,basisTrack,buildRows,clusterCI} from '../src/backtest/sim';
import {fitWeights,predict,priorFit,type StackSample} from '../src/engine/quant/stack';
import {fee} from '../src/engine/model/fees';
// Exploratory: what model/Kalshi blend weight does the 1-minute history support, held out by time?
const store=new HistoryStore();
const markets=store.markets(SERIES15).filter(m=>m.strike!==null&&(m.result==='yes'||m.result==='no'));
const s=spotSeries(store.spot(markets[0].open_ts-4*3600,markets[markets.length-1].close_ts+3600));
const rows=buildRows(markets,store.allCandles(SERIES15),s,basisTrack(markets,s).at).filter(r=>r.mid!==null);
const split=markets[Math.floor(markets.length*.6)].close_ts;
const toS=(r:typeof rows[0]):StackSample=>({modelP:r.model,mid:r.mid,sigma:r.sigma,momentum30s:null,momentum120s:null,imbalance:null,tradeFlow30s:null,y:r.y,ticker:r.ticker,horizon:String(Math.round(r.tau/60))});
const train=rows.filter(r=>r.time<split),test=rows.filter(r=>r.time>=split);
const w=fitWeights(train.map(toS));
console.log('fitted weights (bias, confidence, kalshiShift, ...):',w.slice(0,3).map(x=>x.toFixed(3)).join(', '));
const score=(name:string,f:(r:typeof rows[0])=>number)=>{const b=test.reduce((a,r)=>a+(f(r)-r.y)**2,0)/test.length;
  // held-out BUY rule at ≥ 4¢ after fee, first per round, hold
  const g=new Map<string,{sum:number;n:number}>();for(const r of test){if(g.has(r.ticker)||r.ask===null||r.bid===null)continue;const p=f(r);
    if(p-r.ask-fee(r.ask)>=.04)g.set(r.ticker,{sum:r.y-r.ask-fee(r.ask),n:1});else if((1-p)-(1-r.bid)-fee(1-r.bid)>=.04)g.set(r.ticker,{sum:(1-r.y)-(1-r.bid)-fee(1-r.bid),n:1});}
  const v=[...g.values()],[lo,hi]=clusterCI(v);console.log(`${name.padEnd(34)} held-out Brier ${b.toFixed(5)} | BUY ≥4¢: ${v.length} trades, ${(100*v.reduce((a,x)=>a+x.sum,0)/(v.length||1)).toFixed(2)}¢ [${(lo*100).toFixed(2)} … ${(hi*100).toFixed(2)}]`);};
score('Kalshi mid',r=>r.mid!);
score('raw model',r=>r.model);
score('current prior blend (c = 0.5)',r=>predict(priorFit(),toS(r)).p);
score(`history-fitted blend (c = ${w[2].toFixed(2)})`,r=>predict({...priorFit(),weights:w},toS(r)).p);
for(const c of [.75,.9,1])score(`blend c = ${c}`,r=>predict({...priorFit(),weights:[0,1,c,0,0,0,0]},toS(r)).p);
