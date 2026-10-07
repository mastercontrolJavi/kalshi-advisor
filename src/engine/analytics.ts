import type {RealEvent} from './guardrails';
import {dayKey} from './guardrails';
/** Per-market rollup and performance analytics over the user's actual KXBTC15M fills and settlements. */
export interface MarketTrade {ticker:string;first:number;last:number;side:'yes'|'no';contracts:number;avgEntry:number|null;fees:number;pnl:number;status:'settled'|'open';exitedEarly:boolean;followed:boolean;hour:number;holdSeconds:number}
export interface SignalRef {ticker:string;side:string;time:number}
const mean=(a:number[])=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
const sum=(a:number[])=>a.reduce((s,x)=>s+x,0);
const hourOf=(t:number,zone:string)=>Number(new Intl.DateTimeFormat('en-US',{timeZone:zone,hour:'numeric',hourCycle:'h23'}).format(t));
export function rollupMarkets(events:RealEvent[],feesByTicker:Map<string,number>,signals:SignalRef[],zone='America/Los_Angeles'):MarketTrade[]{
  const byTicker=new Map<string,RealEvent[]>();for(const e of events)(byTicker.get(e.ticker)??byTicker.set(e.ticker,[]).get(e.ticker)!).push(e);
  const out:MarketTrade[]=[];
  for(const [ticker,es] of byTicker){
    const fills=es.filter(e=>e.type==='fill').sort((a,b)=>a.time-b.time),settlement=es.find(e=>e.type==='settlement');
    if(!fills.length&&!settlement)continue;
    const opening=fills.filter(f=>(f.closedContracts??0)===0),first=(fills[0]??settlement!).time,last=Math.max(...es.map(e=>e.time));
    const side=(fills[0]?.side??'yes') as 'yes'|'no',contracts=sum(opening.map(f=>f.contracts));
    const avgEntry=contracts>0?sum(opening.map(f=>f.contracts*(f.price??0)))/contracts:null;
    const pnl=settlement?.outcomePnl??sum(es.map(e=>e.pnl));
    const followed=signals.some(s=>s.ticker===ticker&&s.side===side&&s.time<=first&&s.time>=first-180000);
    out.push({ticker,first,last,side,contracts,avgEntry,fees:feesByTicker.get(ticker)??0,pnl,status:settlement?'settled':'open',exitedEarly:fills.some(f=>(f.closedContracts??0)>0),followed,hour:hourOf(first,zone),holdSeconds:Math.max(0,(last-first)/1000)});
  }
  return out.sort((a,b)=>a.first-b.first);
}
function stats(ms:MarketTrade[]){
  const wins=ms.filter(m=>m.pnl>0),losses=ms.filter(m=>m.pnl<0),gross=sum(wins.map(m=>m.pnl)),lost=-sum(losses.map(m=>m.pnl));
  return {markets:ms.length,pnl:sum(ms.map(m=>m.pnl)),wins:wins.length,losses:losses.length,winRate:ms.length?wins.length/ms.length:null,
    avgWin:mean(wins.map(m=>m.pnl)),avgLoss:mean(losses.map(m=>m.pnl)),won:gross,lost,profitFactor:lost>0?gross/lost:null,expectancy:mean(ms.map(m=>m.pnl)),
    fees:sum(ms.map(m=>m.fees)),avgContracts:mean(ms.map(m=>m.contracts)),avgEntry:mean(ms.map(m=>m.avgEntry).filter((x):x is number=>x!==null))};
}
export function buildAnalytics(markets:MarketTrade[],balances:{time:number;balance:number;portfolio:number|null}[],now=Date.now(),zone='America/Los_Angeles'){
  const closed=markets.filter(m=>m.status==='settled'),today=dayKey(now,zone),since=(days:number)=>closed.filter(m=>m.last>=now-days*86400000);
  let cum=0,peak=0,maxDrawdown=0;const curve=closed.map(m=>{cum+=m.pnl;peak=Math.max(peak,cum);maxDrawdown=Math.max(maxDrawdown,peak-cum);return {time:m.last,pnl:+cum.toFixed(4)};});
  const rolling=closed.map((m,i)=>{const w=closed.slice(Math.max(0,i-9),i+1);return {time:m.last,avgPnl:mean(w.map(x=>x.pnl)),winRate:w.filter(x=>x.pnl>0).length/w.length,n:w.length};});
  const days=new Map<string,{day:string;pnl:number;markets:number;wins:number}>();for(const m of closed){const d=dayKey(m.last,zone),r=days.get(d)??{day:d,pnl:0,markets:0,wins:0};r.pnl+=m.pnl;r.markets++;if(m.pnl>0)r.wins++;days.set(d,r);}
  let streak=0;for(const m of [...closed].reverse()){if(m.pnl===0)break;const s=m.pnl>0?1:-1;if(streak===0||Math.sign(streak)===s)streak+=s;else break;}
  let bestRun=0,worstRun=0,run=0;for(const m of closed){run=m.pnl>0?(run>0?run+1:1):m.pnl<0?(run<0?run-1:-1):0;bestRun=Math.max(bestRun,run);worstRun=Math.min(worstRun,run);}
  const group=(key:(m:MarketTrade)=>string,order?:string[])=>{const g=new Map<string,MarketTrade[]>();for(const m of closed)(g.get(key(m))??g.set(key(m),[]).get(key(m))!).push(m);
    const rows=[...g].map(([bucket,ms])=>({bucket,...stats(ms)}));return order?rows.sort((a,b)=>order.indexOf(a.bucket)-order.indexOf(b.bucket)):rows;};
  const priceBucket=(m:MarketTrade)=>m.avgEntry===null?'unknown':m.avgEntry<.3?'< 30¢':m.avgEntry<.5?'30–50¢':m.avgEntry<.7?'50–70¢':'≥ 70¢';
  const hourBucket=(m:MarketTrade)=>{const h=m.hour;return h<6?'12–6 AM':h<12?'6 AM–12 PM':h<18?'12–6 PM':'6 PM–12 AM';};
  return {updated:now,all:stats(closed),today:stats(closed.filter(m=>dayKey(m.last,zone)===today)),week:stats(since(7)),month:stats(since(30)),
    open:markets.filter(m=>m.status==='open').length,best:closed.reduce<MarketTrade|null>((b,m)=>!b||m.pnl>b.pnl?m:b,null),worst:closed.reduce<MarketTrade|null>((b,m)=>!b||m.pnl<b.pnl?m:b,null),
    maxDrawdown,streak,bestRun,worstRun,curve,rolling,daily:[...days.values()],
    bySide:group(m=>m.side==='yes'?'YES':'NO',['YES','NO']),byPrice:group(priceBucket,['< 30¢','30–50¢','50–70¢','≥ 70¢','unknown']),byHour:group(hourBucket,['12–6 AM','6 AM–12 PM','12–6 PM','6 PM–12 AM']),
    byFollow:group(m=>m.followed?'Advisor idea':'Own call',['Advisor idea','Own call']),byExit:group(m=>m.exitedEarly?'Sold before close':'Held to settlement',['Held to settlement','Sold before close']),
    balances:balances.map(b=>({time:b.time,balance:b.balance,portfolio:b.portfolio})),recent:[...markets].reverse().slice(0,60)};
}
