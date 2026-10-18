import Database from 'better-sqlite3';
import {HistoryStore,SERIES15} from '../src/backtest/history';
import {spotSeries,spotAt,quote,clusterCI} from '../src/backtest/sim';
import {fee} from '../src/engine/model/fees';
/**
 * Pattern study (2026-10-17): the setups traders read off the chart, on every KXBTC15M round, with 10→5 min left.
 *  - trend: BTC is past the target and still moving that way over the last 3 min → buy the trend side.
 *  - dip: BTC is past the target but just bounced against it (last 1 min) → buy the trend side cheaper.
 *  - chase the spike: same moment, buy the bounce side instead.
 *  - coin flip: BTC within noise of the target (|z| < 0.35) → either side.
 * Then Polymarket's Up price vs Kalshi's, and your own fills by setup (live journal). `npx tsx scripts/pattern-study.ts`
 */
const store=new HistoryStore();
const markets=store.markets(SERIES15).filter(m=>m.strike!==null&&(m.result==='yes'||m.result==='no'));
const candles=store.allCandles(SERIES15);
const s=spotSeries(store.spot(markets[0].open_ts-4*3600,markets[markets.length-1].close_ts+3600));
type Side='yes'|'no';
const half=markets[Math.floor(markets.length/2)].open_ts;
interface T {round:number;price:number;win:boolean;pnl:number}
const buy=(round:number,y:0|1,bid:number,ask:number,side:Side):T|null=>{const price=side==='yes'?ask:1-bid;if(price<=.02||price>=.98)return null;const win=(side==='yes')===(y===1);return {round,price,win,pnl:(win?1:0)-price-fee(price)};};
function line(label:string,t:T[]){
  if(t.length<10)return console.log(`  ${label.padEnd(46)} n=${t.length}`);
  const mean=t.reduce((a,x)=>a+x.pnl,0)/t.length,[lo,hi]=clusterCI(t.map(x=>({sum:x.pnl,n:1})));
  const win=t.filter(x=>x.win).length/t.length,paid=t.reduce((a,x)=>a+x.price,0)/t.length,m=(a:T[])=>a.length?(a.reduce((q,x)=>q+x.pnl,0)/a.length*100).toFixed(1):'–';
  console.log(`  ${label.padEnd(46)} n=${String(t.length).padStart(5)}  won ${(win*100).toFixed(1).padStart(5)}%  paid ${(paid*100).toFixed(1).padStart(5)}¢  net ${(mean>=0?'+':'')+(mean*100).toFixed(2)}¢ [${(lo*100).toFixed(2)} … ${(hi*100).toFixed(2)}]  halves ${m(t.filter(x=>x.round<half))} / ${m(t.filter(x=>x.round>=half))}`);
}
// Per round: walk minutes 10→5 left; each rule takes the FIRST minute it triggers (one trade per round per rule).
const rules:Record<string,T[]>={};const add=(k:string,t:T|null)=>{if(t)(rules[k]??=[]).push(t);};
for(const m of markets){
  const cs=candles.get(m.ticker);if(!cs)continue;const by=new Map(cs.map(c=>[c.ts,c]));const open=spotAt(s,m.open_ts);if(!open)continue;const y=m.result==='yes'?1:0;
  const done=new Set<string>();const once=(k:string,t:T|null)=>{if(t&&!done.has(k)){done.add(k);add(k,t);}};
  for(let tau=600;tau>=300;tau-=60){
    const ts=m.close_ts-tau,c=by.get(ts);if(!c)continue;const q=quote(c);if(q.bid===null||q.ask===null||q.mid===null)continue;
    const now=spotAt(s,ts),b1=spotAt(s,ts-60),b3=spotAt(s,ts-180);if(!now||!b1||!b3)continue;
    const dist=now.price-open.price,z=Math.log(now.price/open.price)/(now.sigma*Math.sqrt(tau)),unit=now.price*now.sigma*Math.sqrt(60);
    const mv1=(now.price-b1.price)/unit,mv3=(now.price-b3.price)/unit,tr:Side=dist>0?'yes':'no',sg=dist>0?1:-1,other:Side=tr==='yes'?'no':'yes';
    const T_=(side:Side)=>buy(m.open_ts,y,q.bid!,q.ask!,side);
    if(Math.abs(z)<.35){once('coin flip: buy YES',T_('yes'));once('coin flip: buy NO',T_('no'));
      once(`coin flip: follow last-3-min move`,mv3!==0?T_(mv3>0?'yes':'no'):null);continue;}
    once('any trend: buy trend side',T_(tr));
    if(sg*mv3>0)once('trend: still moving that way (3 min)',T_(tr));
    if(sg*mv3>0&&sg*mv1>0)once('trend: moving that way (3 min and 1 min)',T_(tr));
    for(const k of [.5,1,1.5])if(sg*mv1<=-k){once(`dip ≥ ${k}σ against trend: buy trend side`,T_(tr));once(`dip ≥ ${k}σ against trend: chase the spike`,T_(other));}
    for(const [lo,hi] of [[.35,1],[1,2],[2,99]])if(Math.abs(z)>=lo&&Math.abs(z)<hi)once(`trend side, |z| ${lo}–${hi===99?'∞':hi}`,T_(tr));
  }
}
console.log(`${markets.length} rounds; one trade per round per rule, first minute it triggers with 10→5 min left; per contract after taker fee.\n`);
for(const [k,t] of Object.entries(rules))line(k,t);

// Polymarket's Up price vs Kalshi's mid at the same moment (btc_lean, recorded live since Oct 10).
const lean=new Database('data/markets.db',{readonly:true}).prepare("SELECT round,horizon,up_price AS up,sharp_net AS net,yes_bid AS bid,yes_ask AS ask,result FROM btc_lean WHERE result IN ('yes','no') AND yes_bid IS NOT NULL AND yes_ask IS NOT NULL AND up_price IS NOT NULL").all() as {round:number;horizon:number;up:number;net:number;bid:number;ask:number;result:string}[];
console.log(`\nPolymarket Up price vs Kalshi (${lean.length} snapshots, ${new Set(lean.map(r=>r.round)).size} rounds). Buy on Kalshi the side Polymarket prices higher:`);
for(const h of [600,300,120]){const xs=lean.filter(r=>r.horizon===h);
  const corr=(()=>{const a=xs.map(r=>r.up),b=xs.map(r=>(r.bid+r.ask)/2),ma=a.reduce((p,x)=>p+x,0)/a.length,mb=b.reduce((p,x)=>p+x,0)/b.length;let c=0,va=0,vb=0;a.forEach((x,i)=>{c+=(x-ma)*(b[i]-mb);va+=(x-ma)**2;vb+=(b[i]-mb)**2;});return c/Math.sqrt(va*vb);})();
  console.log(` ${h/60} min left — correlation of the two prices ${corr.toFixed(2)}`);
  for(const g of [.03,.08,.15])line(`Polymarket ≥ ${g*100}¢ more confident`,xs.flatMap(r=>{const gap=r.up-(r.bid+r.ask)/2;if(Math.abs(gap)<g)return [];const t=buy(r.round,r.result==='yes'?1:0,r.bid,r.ask,gap>0?'yes':'no');return t?[t]:[];}));
}

// Your fills since Oct 4, first buy per round, classified the same way from the 1-second live journal.
const a=new Database('data/advisor.db',{readonly:true});
const fills=a.prepare("SELECT time,ticker,pnl,context FROM real_trades ORDER BY time").all() as {time:number;ticker:string;pnl:number;context:string}[];
const res=new Map((a.prepare('SELECT ticker,result FROM outcomes').all() as {ticker:string;result:string}[]).map(r=>[r.ticker,r.result]));
const tick=a.prepare('SELECT time,proxy,k,tau,sigma,mid FROM ticks WHERE ticker=? AND time<=? ORDER BY time DESC LIMIT 1');
const rounds=new Map<string,{first:any;pnl:number;buys:number;flips:boolean;cost:number}>();
for(const f of fills){const c=JSON.parse(f.context);const r=rounds.get(f.ticker)??{first:null,pnl:0,buys:0,flips:false,cost:0};r.pnl+=f.pnl;
  if(c.action==='buy'){r.buys++;r.cost+=c.price*(c.contracts??0);if(!r.first)r.first={...c,time:f.time};else if(c.side!==r.first.side)r.flips=true;}rounds.set(f.ticker,r);}
const mine:Record<string,{n:number;won:number;pnl:number;cost:number}>={};
for(const [t,r] of rounds){if(!r.first||!res.has(t))continue;const k=tick.get(t,r.first.time) as any,k1=tick.get(t,r.first.time-60000) as any,k3=tick.get(t,r.first.time-180000) as any;
  let label='no journal';
  if(k&&k.proxy&&k.k&&k.sigma){const tau=k.tau,z=Math.log(k.proxy/k.k)/(k.sigma*Math.sqrt(Math.max(1,tau))),unit=k.proxy*k.sigma*Math.sqrt(60),tr=k.proxy>k.k?'yes':'no',sg=tr==='yes'?1:-1;
    const mv1=k1?.proxy?(k.proxy-k1.proxy)/unit:0,mv3=k3?.proxy?(k.proxy-k3.proxy)/unit:0,with_=r.first.side===tr,price=r.first.price;
    label=price<=.15?'longshot (≤15¢)':Math.abs(z)<.35?'coin flip near target':!with_?'against the trend':sg*mv1<=-1?'dip in trend (with trend)':sg*mv3>0?'trend still moving (with trend)':'with trend, stalling';
    label+=tau>600?' · >10 min left':tau>=300?' · 10–5 min left':' · <5 min left';}
  if(r.flips)label+=' · flipped sides';
  const x=mine[label]??={n:0,won:0,pnl:0,cost:0};x.n++;x.pnl+=r.pnl;x.cost+=r.cost;if(r.pnl>0)x.won++;}
console.log(`\nYour rounds since Oct 4 by the setup of your first buy (P&L as the app records it):`);
for(const [k,v] of Object.entries(mine).sort((p,q)=>q[1].n-p[1].n))console.log(`  ${k.padEnd(58)} ${String(v.n).padStart(3)} rounds  ${v.won} up  net ${v.pnl>=0?'+':'−'}$${Math.abs(v.pnl).toFixed(2)}  staked $${v.cost.toFixed(0)}`);
