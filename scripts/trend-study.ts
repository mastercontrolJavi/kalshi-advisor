import Database from 'better-sqlite3';
import {HistoryStore,SERIES15} from '../src/backtest/history';
import {spotSeries,spotAt,quote,clusterCI} from '../src/backtest/sim';
import {fee} from '../src/engine/model/fees';
/**
 * "Bet with the trend" study. At 10, 5, 3 and 2 minutes left in each KXBTC15M round: does the side the chart is
 * trending toward win, and does buying it at Kalshi's ask make money after the taker fee? Then the same for the
 * Polymarket sharps' Bitcoin lean, alone and when it agrees with the trend. One trade per round per rule, held to
 * settlement; 95% ranges resample rounds. `npx tsx scripts/trend-study.ts`
 */
const store=new HistoryStore();
const markets=store.markets(SERIES15).filter(m=>m.strike!==null&&(m.result==='yes'||m.result==='no'));
const candles=store.allCandles(SERIES15);
const s=spotSeries(store.spot(markets[0].open_ts-4*3600,markets[markets.length-1].close_ts+3600));
const EDT=-4*3600,day=(ts:number)=>new Date((ts+EDT)*1000).toISOString().slice(0,10);
type Side='yes'|'no';
interface Row {round:number;y:0|1;tau:number;bid:number;ask:number;mid:number;open:number;slope3:number;kslope3:number;sigma:number;day:string}
const rows:Row[]=[];
for(const m of markets){
  const cs=candles.get(m.ticker);if(!cs)continue;const by=new Map(cs.map(c=>[c.ts,c]));
  const open=spotAt(s,m.open_ts);if(!open)continue;
  for(const tau of [600,300,180,120]){
    const ts=m.close_ts-tau,c=by.get(ts),c3=by.get(ts-180);if(!c)continue;
    const q=quote(c),q3=c3?quote(c3):null;if(q.bid===null||q.ask===null||q.mid===null)continue;
    const now=spotAt(s,ts),back=spotAt(s,ts-180);if(!now||!back)continue;
    rows.push({round:m.open_ts,y:m.result==='yes'?1:0,tau,bid:q.bid,ask:q.ask,mid:q.mid,open:now.price-open.price,slope3:now.price-back.price,
      kslope3:q3?.mid!=null?q.mid-q3.mid:0,sigma:now.sigma,day:day(m.open_ts)});
  }
}
const askOf=(r:{bid:number;ask:number},side:Side)=>side==='yes'?r.ask:1-r.bid;
const sgn=(x:number):Side|null=>x>0?'yes':x<0?'no':null;
const vol=[...rows.map(r=>r.sigma)].sort((a,b)=>a-b),calmCut=vol[Math.floor(vol.length/3)],wildCut=vol[Math.floor(vol.length*2/3)];
const regime=(r:Row)=>r.sigma<=calmCut?'calm':r.sigma>=wildCut?'volatile':'normal';
const half=markets[Math.floor(markets.length/2)].open_ts;
interface T {round:number;side:Side;price:number;win:boolean;pnl:number}
const trade=(r:{round:number;y:0|1;bid:number;ask:number},side:Side|null):T|null=>{
  if(!side)return null;const price=askOf(r,side);if(price<=0.01||price>=0.99)return null;const win=(side==='yes')===(r.y===1);
  return {round:r.round,side,price,win,pnl:(win?1:0)-price-fee(price)};
};
function line(label:string,ts:(T|null)[]){
  const t=ts.filter((x):x is T=>x!==null);if(t.length<5)return console.log(`  ${label.padEnd(44)} n=${t.length}`);
  const g=t.map(x=>({sum:x.pnl,n:1})),mean=t.reduce((a,x)=>a+x.pnl,0)/t.length,[lo,hi]=clusterCI(g);
  const win=t.filter(x=>x.win).length/t.length,paid=t.reduce((a,x)=>a+x.price,0)/t.length;
  const h1=t.filter(x=>x.round<half),h2=t.filter(x=>x.round>=half),m=(a:T[])=>a.length?(a.reduce((s,x)=>s+x.pnl,0)/a.length*100).toFixed(1):'–';
  console.log(`  ${label.padEnd(44)} n=${String(t.length).padStart(5)}  won ${(win*100).toFixed(1).padStart(5)}%  paid ${(paid*100).toFixed(1).padStart(5)}¢  net ${(mean*100>=0?'+':'')+(mean*100).toFixed(2).padStart(5)}¢ [${(lo*100).toFixed(2)} … ${(hi*100).toFixed(2)}]  halves ${m(h1)} / ${m(h2)}`);
}
console.log(`${markets.length} rounds ${day(markets[0].open_ts)} → ${day(markets[markets.length-1].open_ts)}; "won" is how often the side won, "paid" is the average ask — the market's own odds.`);
console.log('Rules: trend = BTC now vs the round open (the target). slope = BTC over the last 3 min. Kalshi chart = YES mid over the last 3 min.\n');
for(const tau of [600,300,180,120]){
  const rs=rows.filter(r=>r.tau===tau);
  console.log(`— ${tau/60} min left (${rs.length} rounds) —`);
  line('trend since open',rs.map(r=>trade(r,sgn(r.open))));
  line('last-3-min slope',rs.map(r=>trade(r,sgn(r.slope3))));
  line('Kalshi chart rising/falling (3 min)',rs.map(r=>trade(r,sgn(r.kslope3))));
  line('trend AND slope agree',rs.map(r=>sgn(r.open)===sgn(r.slope3)?trade(r,sgn(r.open)):null));
  line('trend but slope against it (fade)',rs.map(r=>sgn(r.open)&&sgn(r.slope3)&&sgn(r.open)!==sgn(r.slope3)?trade(r,sgn(r.open)):null));
  for(const reg of ['calm','normal','volatile'])line(`trend AND slope agree, ${reg}`,rs.filter(r=>regime(r)===reg).map(r=>sgn(r.open)===sgn(r.slope3)?trade(r,sgn(r.open)):null));
  for(const [lo,hi] of [[.5,.7],[.7,.85],[.85,.99]])line(`trend side priced ${lo*100}–${hi*100}¢`,rs.map(r=>{const t=trade(r,sgn(r.open));return t&&t.price>=lo&&t.price<hi?t:null;}));
}
// What the user saw on the 15th (EDT): same rules, that day only.
for(const d of ['2026-10-15','2026-10-16']){
  console.log(`\n— ${d} only (EDT) —`);
  for(const tau of [600,300,180])line(`${tau/60} min left: trend AND slope agree`,rows.filter(r=>r.day===d&&r.tau===tau).map(r=>sgn(r.open)===sgn(r.slope3)?trade(r,sgn(r.open)):null));
}
// Sharps' lean (Polymarket "Up or Down" 15-min, ranked wallets, net $ toward Up), recorded live since Oct 10.
const lean=new Database('data/markets.db',{readonly:true}).prepare("SELECT round,horizon,time,sharp_net AS net,sharp_wallets AS w,yes_bid AS bid,yes_ask AS ask,result FROM btc_lean WHERE result IN ('yes','no') AND yes_bid IS NOT NULL AND yes_ask IS NOT NULL").all() as {round:number;horizon:number;time:number;net:number;w:number;bid:number;ask:number;result:string}[];
const trendAt=(round:number,timeMs:number)=>{const t=Math.floor(timeMs/60000)*60,o=spotAt(s,round),n=spotAt(s,t),b=spotAt(s,t-180);return o&&n&&b?{open:n.price-o.price,slope3:n.price-b.price}:null;};
console.log(`\n— Polymarket sharps' lean (${new Set(lean.map(r=>r.round)).size} rounds, ${day(Math.min(...lean.map(r=>r.round)))} → ${day(Math.max(...lean.map(r=>r.round)))}) —`);
for(const h of [600,300,120,60]){
  const xs=lean.filter(r=>r.horizon===h).map(r=>({...r,y:(r.result==='yes'?1:0) as 0|1,tr:trendAt(r.round,r.time)}));
  console.log(` ${h/60} min left`);
  line('sharps any lean',xs.map(r=>trade(r,sgn(r.net))));
  line('sharps lean ≥ $100',xs.map(r=>Math.abs(r.net)>=100?trade(r,sgn(r.net)):null));
  line('sharps agree with trend+slope',xs.map(r=>r.tr&&Math.abs(r.net)>=100&&sgn(r.net)===sgn(r.tr.open)&&sgn(r.net)===sgn(r.tr.slope3)?trade(r,sgn(r.net)):null));
  line('sharps against the trend',xs.map(r=>r.tr&&Math.abs(r.net)>=100&&sgn(r.tr.open)&&sgn(r.net)!==sgn(r.tr.open)?trade(r,sgn(r.net)):null));
  line('trend+slope, no sharp confirmation',xs.map(r=>r.tr&&sgn(r.tr.open)===sgn(r.tr.slope3)&&!(Math.abs(r.net)>=100&&sgn(r.net)===sgn(r.tr.open))?trade(r,sgn(r.tr.open)):null));
}
