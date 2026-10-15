import {HistoryStore,SERIES15} from '../src/backtest/history';
import {spotSeries,basisTrack,spotAt,quote,modelP,quantP,clusterCI} from '../src/backtest/sim';
import {fee} from '../src/engine/model/fees';
/**
 * Exploratory: resting (maker) buys vs taking the ask, on the 1-minute history. KXBTC15M has no maker fee.
 * A resting buy at price P counts as filled only when the opposite best price later reaches P (YES: ask_lo ≤ P;
 * NO: YES bid_hi ≥ 1 − P), i.e. the whole level was cleared, so every counted fill is a certain one.
 */
const store=new HistoryStore();
const markets=store.markets(SERIES15).filter(m=>m.strike!==null&&(m.result==='yes'||m.result==='no'));
const candles=store.allCandles(SERIES15);
const first=markets[0].open_ts,last=markets[markets.length-1].close_ts;
const s=spotSeries(store.spot(first-4*3600,last+3600));const basis=basisTrack(markets,s);
const split=markets[Math.floor(markets.length*.6)].close_ts;
type T={cluster:string;pnl:number;half:'train'|'test'};
const acc=new Map<string,T[]>();const add=(k:string,t:T)=>{const l=acc.get(k);if(l)l.push(t);else acc.set(k,[t]);};
const offered=new Map<string,number>();const offer=(k:string)=>offered.set(k,(offered.get(k)??0)+1);
const band=(p:number)=>p<.1?'00-10':p<.3?'10-30':p<.5?'30-50':p<.7?'50-70':p<.9?'70-90':'90-100';
const tbucket=(tau:number)=>tau>=300?'5-14m':tau>=120?'2-5m':'1-2m';
const LIFE=Number(process.env.LIFE??2);
for(const m of markets){
  const cs=candles.get(m.ticker);if(!cs)continue;const y=m.result==='yes'?1:0,half=m.close_ts<split?'train':'test';
  const firsts=new Set<string>();
  for(let i=0;i<cs.length;i++){
    const c=cs[i],tau=m.close_ts-c.ts;if(tau<60||c.ts<=m.open_ts)continue;
    const q=quote(c);if(q.bid===null||q.ask===null)continue;
    const sp=spotAt(s,c.ts),b=basis.at(c.ts);
    const model=sp&&b!==null?modelP(sp.price,m.strike!,sp.sigma,tau,b):null,quant=model!==null&&sp?quantP(model,q.mid,sp.sigma):null;
    for(const side of ['yes','no'] as const){
      const bid=side==='yes'?q.bid:1-q.ask,ask=side==='yes'?q.ask:1-q.bid,win=side==='yes'?y:1-y,mid=(bid+ask)/2;
      let filled=false;
      for(let j=i+1;j<cs.length&&j<=i+LIFE;j++){const d=cs[j];
        if(side==='yes'?(d.ask_lo!==null&&d.ask_lo>0&&d.ask_lo<=bid+1e-9):(d.bid_hi!==null&&d.bid_hi<1&&d.bid_hi>=q.ask-1e-9)){filled=true;break;}}
      const key=`${tbucket(tau)} ${band(mid)}`;offer('all '+key);
      if(filled)add('maker '+key,{cluster:m.ticker,pnl:win-bid,half});
      add('taker '+key,{cluster:m.ticker,pnl:win-ask-fee(ask),half});
      // One-per-round strategies (first qualifying minute), maker vs taker on the same trigger.
      const strat=(name:string,cond:boolean)=>{if(!cond||firsts.has(name))return;firsts.add(name);
        add(`S taker  ${name}`,{cluster:m.ticker,pnl:win-ask-fee(ask),half});if(filled)add(`S maker  ${name}`,{cluster:m.ticker,pnl:win-bid,half});offer('S '+name);};
      strat('fav 80-97 5-14m',tau>=300&&mid>=.8&&mid<.97);
      strat('fav 90-97 5-14m',tau>=300&&mid>=.9&&mid<.97);
      strat('dog 10-30 1-5m',tau<300&&mid>=.1&&mid<.3);
      strat('dog 20-40 1-5m',tau<300&&mid>=.2&&mid<.4);
      if(quant!==null){const pq=side==='yes'?quant:1-quant;
        strat('quant edge>=2 vs bid (maker trigger)',pq-bid>=.02);
        strat('quant edge>=4 vs ask+fee (app rule)',pq-ask-fee(ask)>=.04);}
    }
  }
}
const stat=(rs:T[])=>{const g=new Map<string,{sum:number;n:number}>();for(const r of rs){const x=g.get(r.cluster)??{sum:0,n:0};x.sum+=r.pnl;x.n++;g.set(r.cluster,x);}
  const n=rs.length,mean=rs.reduce((a,r)=>a+r.pnl,0)/n,[lo,hi]=clusterCI([...g.values()]);return {n,mean,lo,hi};};
const f=(x:number)=>(x*100).toFixed(2).padStart(6);
console.log(`Rounds ${markets.length}, split at ${new Date(split*1000).toISOString().slice(0,10)}, order life ${LIFE} min`);
for(const k of [...acc.keys()].sort()){const rs=acc.get(k)!,a=stat(rs),tr=stat(rs.filter(r=>r.half==='train')),te=stat(rs.filter(r=>r.half==='test'));
  const off=offered.get(k.replace(/^maker |^taker /,'all ').replace(/^S (maker|taker)  /,'S '));
  console.log(`${k.padEnd(48)} n=${String(a.n).padStart(6)} ${off&&k.includes('maker')?`fill ${(100*a.n/off).toFixed(0).padStart(3)}% `:'          '}avg ${f(a.mean)}¢ [${f(a.lo)} … ${f(a.hi)}]  train ${f(tr.mean)} test ${f(te.mean)} [${f(te.lo)} … ${f(te.hi)}]`);}
