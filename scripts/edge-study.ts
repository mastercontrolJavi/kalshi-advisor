import {HistoryStore,SERIES15} from '../src/backtest/history';
import {spotSeries,basisTrack,spotAt,quote,modelP,clusterCI} from '../src/backtest/sim';
import {fee} from '../src/engine/model/fees';
/**
 * Exploratory: does anything know more than Kalshi's price? Logistic regression of the outcome on logit(mid) plus
 * candidate features, fitted on the first 60% of rounds and scored on the last 40% (never seen while fitting).
 * Then a held-out trading test: take the side where the fitted probability beats the ask by fee + margin.
 */
const L=(p:number)=>{const q=Math.min(.995,Math.max(.005,p));return Math.log(q/(1-q));};
const S=(x:number)=>1/(1+Math.exp(-x));
const store=new HistoryStore();
const markets=store.markets(SERIES15).filter(m=>m.strike!==null&&(m.result==='yes'||m.result==='no'));
const candles=store.allCandles(SERIES15);
const s=spotSeries(store.spot(markets[0].open_ts-4*3600,markets[markets.length-1].close_ts+3600));const basis=basisTrack(markets,s);
const split=markets[Math.floor(markets.length*.6)].close_ts;
interface R {cl:string;train:boolean;y:number;tau:number;mid:number;bid:number;ask:number;x:Record<string,number>}
const rows:R[]=[];
for(const m of markets){
  const cs=candles.get(m.ticker);if(!cs)continue;const y=m.result==='yes'?1:0;
  const byTs=new Map(cs.map(c=>[c.ts,c]));
  for(const c of cs){
    const tau=m.close_ts-c.ts;if(tau<60||c.ts<=m.open_ts)continue;
    const q=quote(c);if(q.mid===null||q.bid===null||q.ask===null)continue;
    const sp=spotAt(s,c.ts),b=basis.at(c.ts);if(!sp||b===null)continue;
    const model=modelP(sp.price,m.strike!,sp.sigma,tau,b);
    const back=(k:number)=>{const o=byTs.get(c.ts-60*k);return o?quote(o).mid:null;};
    const sp1=spotAt(s,c.ts-60),sp5=spotAt(s,c.ts-300);
    const lm=L(q.mid);const hour=new Date(c.ts*1000).getUTCHours();
    const m1=back(1),m3=back(3);
    rows.push({cl:m.ticker,train:m.close_ts<split,y,tau,mid:q.mid,bid:q.bid,ask:q.ask,x:{
      lmid:lm,
      lmid3:lm*lm*lm/10, // favourite/longshot curvature
      gap:L(model)-lm, // diffusion model's disagreement with Kalshi
      dmid1:m1===null?0:lm-L(m1), // market's own last-minute move (over/under-reaction)
      dmid3:m3===null?0:lm-L(m3),
      ret1:sp1?Math.log(sp.price/sp1.price)/(sp.sigma*Math.sqrt(60)):0, // BTC move vs normal, last 1 / 5 min
      ret5:sp5?Math.log(sp.price/sp5.price)/(sp.sigma*Math.sqrt(300)):0,
      volz:Math.log(sp.sigma/2.2e-5), // volatility regime
      us:hour>=13&&hour<21?1:0, // US cash session
      wknd:[0,6].includes(new Date(c.ts*1000).getUTCDay())?1:0,
      late:tau<300?lm:0, // different slope in the last 5 minutes
    }});
  }
}
function fit(rs:R[],keys:string[],ridge=1){
  const d=keys.length+1;let w=new Array(d).fill(0);w[1]=keys[0]==='lmid'?1:0;
  const X=rs.map(r=>[1,...keys.map(k=>r.x[k])]);
  for(let it=0;it<30;it++){
    const g=w.map((v,i)=>i?ridge*v-(keys[i-1]==='lmid'?ridge:0):0),H=Array.from({length:d},(_,i)=>Array.from({length:d},(_,j)=>i===j&&i?ridge:0));
    for(let n=0;n<rs.length;n++){const x=X[n],p=S(x.reduce((a,v,k)=>a+v*w[k],0)),e=p-rs[n].y,v=Math.max(p*(1-p),1e-6);
      for(let i=0;i<d;i++){g[i]+=e*x[i];for(let j=0;j<d;j++)H[i][j]+=v*x[i]*x[j];}}
    const M=H.map((r,i)=>[...r,g[i]]);
    for(let c=0;c<d;c++){let p=c;for(let r=c+1;r<d;r++)if(Math.abs(M[r][c])>Math.abs(M[p][c]))p=r;[M[c],M[p]]=[M[p],M[c]];const dv=M[c][c];for(let k=c;k<=d;k++)M[c][k]/=dv;for(let r=0;r<d;r++)if(r!==c){const f=M[r][c];for(let k=c;k<=d;k++)M[r][k]-=f*M[c][k];}}
    const step=M.map(r=>r[d]);w=w.map((v,k)=>v-step[k]);if(Math.max(...step.map(Math.abs))<1e-9)break;
  }
  return (r:R)=>S(w[0]+keys.reduce((a,k,i)=>a+w[i+1]*r.x[k],0));
}
const train=rows.filter(r=>r.train),test=rows.filter(r=>!r.train);
const brier=(rs:R[],f:(r:R)=>number)=>rs.reduce((a,r)=>a+(f(r)-r.y)**2,0)/rs.length;
const diffCI=(rs:R[],f:(r:R)=>number)=>{const g=new Map<string,{sum:number;n:number}>();for(const r of rs){const v=(f(r)-r.y)**2-(r.mid-r.y)**2;const x=g.get(r.cl)??{sum:0,n:0};x.sum+=v;x.n++;g.set(r.cl,x);}return clusterCI([...g.values()]);};
console.log(`rows ${rows.length} (train ${train.length}, test ${test.length}); split ${new Date(split*1000).toISOString().slice(0,10)}`);
console.log(`Held-out Brier, Kalshi mid alone: ${brier(test,r=>r.mid).toFixed(5)}`);
const sets:Record<string,string[]>={
  'recalibrated mid':['lmid','lmid3','late'],
  '+ diffusion model gap':['lmid','lmid3','late','gap'],
  '+ market momentum':['lmid','lmid3','late','dmid1','dmid3'],
  '+ BTC momentum':['lmid','lmid3','late','ret1','ret5'],
  '+ vol/session':['lmid','lmid3','late','volz','us','wknd'],
  'everything':['lmid','lmid3','late','gap','dmid1','dmid3','ret1','ret5','volz','us','wknd'],
};
for(const [name,keys] of Object.entries(sets)){
  const f=fit(train,keys),[lo,hi]=diffCI(test,f);
  console.log(`${name.padEnd(24)} held-out Brier ${brier(test,f).toFixed(5)}  vs mid ${(brier(test,f)-brier(test,r=>r.mid)>=0?'+':'')}${(brier(test,f)-brier(test,r=>r.mid)).toFixed(5)} [${lo.toFixed(5)} … ${hi.toFixed(5)}]`);
  // held-out trading: first minute per round where the fit beats the ask by fee + margin, hold to settlement
  for(const margin of [.01,.03,.05]){
    const g=new Map<string,{sum:number;n:number}>();
    for(const r of test){if(g.has(r.cl))continue;const p=f(r);
      const yes=p-r.ask-fee(r.ask),no=(1-p)-(1-r.bid)-fee(1-r.bid);
      if(yes>=margin)g.set(r.cl,{sum:r.y-r.ask-fee(r.ask),n:1});else if(no>=margin)g.set(r.cl,{sum:(1-r.y)-(1-r.bid)-fee(1-r.bid),n:1});}
    const v=[...g.values()],mean=v.reduce((a,x)=>a+x.sum,0)/(v.length||1),[a,b]=clusterCI(v);
    console.log(`    trade if edge ≥ ${margin*100}¢ after fee: ${String(v.length).padStart(5)} trades, avg ${(mean*100).toFixed(2)}¢ [${(a*100).toFixed(2)} … ${(b*100).toFixed(2)}]`);
  }
}
