import type {Config} from './config';
import {fee,type FeeSchedule} from './model/fees';
import type {Market} from './feeds/kalshi';
import {Orderbook} from './feeds/orderbook';
export interface Idea {side:'yes'|'no';kind:'taker'|'maker'|'scalp'|'dip';target?:number;price:number;fee:number;edge:number;contracts:number;cost:number;maxLoss:number;queue:number;reason:string;belowMinSize?:boolean}
export function size(prob:number,price:number,balance:number,config:Config,schedule:FeeSchedule,kind:'taker'|'maker'='taker'){
  if(!Number.isFinite(balance)||balance<=0||price<=0||price>=1||prob<=price)return {contracts:0,cost:0,maxLoss:0};
  const cost=price+fee(price,1,kind,schedule),fraction=Math.max(0,(prob-cost)/(1-cost))*config.kellyFraction;
  const budget=Math.min(balance*fraction,balance*config.maxRiskPerTrade);
  let n=Math.min(config.maxContracts,Math.floor(budget/price));
  while(n>0&&n*price+fee(price,n,kind,schedule)>budget+1e-8)n--;
  const total=n*price+fee(price,n,kind,schedule);return {contracts:n,cost:total,maxLoss:total};
}
export function roundDownTick(price:number,market:Market){
  const ranges=market.price_ranges??[{start:'0',end:'1',step:'.01'}];
  let candidate=0;
  for(const r of ranges){const lo=Number(r.start),hi=Number(r.end),step=Number(r.step);if(step<=0||price<lo)continue;const p=lo+Math.floor((Math.min(price,hi)-lo+1e-10)/step)*step;if(p<=price+1e-9)candidate=Math.max(candidate,p);}
  return Math.round(Math.min(.999,Math.max(0,candidate))*10000)/10000;
}
export interface Gate {key:string;label:string;ok:boolean;detail:string;advisory?:boolean;wait?:boolean}
export interface Evaluation {action:string;reason:string;idea:Idea|null;makers:Idea[];edges:{yes:number|null;no:number|null};gates?:Gate[]}
type Conditions={feedsHealthy:boolean;kConfirmed:boolean;lock:string|null;modelReady:boolean;accountReady:boolean;now:number;healthyFeeds?:number;totalFeeds?:number};
const cents=(x:number)=>`${(x*100).toFixed(1)}¢`;
/** Every taker gate for the better-edge side, pass/fail with the observed value, so NO TRADE is explainable at a glance. */
export function gateChecklist(p:number,tau:number,book:Orderbook,market:Market,balance:number|null,config:Config,schedule:FeeSchedule,c:Conditions):Gate[]{
  const v=book.view(),yes=v.yesAsk===null?-Infinity:p-v.yesAsk-fee(v.yesAsk,1,'taker',schedule),no=v.noAsk===null?-Infinity:1-p-v.noAsk-fee(v.noAsk,1,'taker',schedule);
  const side=yes>=no?'yes':'no',edge=Math.max(yes,no),price=side==='yes'?v.yesAsk:v.noAsk,bid=side==='yes'?v.yesBid:v.noBid,depth=side==='yes'?v.yesDepth:v.noDepth;
  const inSweet=tau>=config.sweetMinSeconds&&tau<=config.sweetMaxSeconds,sizing=price!==null&&balance!==null?size(side==='yes'?p:1-p,price,balance,config,schedule):{contracts:0};
  const bookLive=book.valid&&c.now-book.updated<=config.bookStaleMs;
  return [
    {key:'market',label:'Market open',ok:market.status==='active',detail:market.status},
    {key:'feeds',label:'Price feeds',ok:c.feedsHealthy,detail:c.totalFeeds?`${c.healthyFeeds}/${c.totalFeeds} live`:c.feedsHealthy?'live':'stale'},
    {key:'book',label:'Kalshi book',ok:bookLive&&schedule.verified,detail:!schedule.verified?'fees unverified':bookLive?v.source==='ws'?'live':'REST fallback':'stale'},
    {key:'k',label:'Opening K',ok:c.kConfirmed||config.allowEstimatedK,detail:c.kConfirmed?'confirmed':'estimated'},
    {key:'model',label:'Model',ok:c.modelReady,detail:c.modelReady?'warm':'warming'},
    {key:'account',label:'Account',ok:c.accountReady&&balance!==null,detail:c.accountReady?'synced':'unavailable'},
    {key:'guards',label:'Guardrails',ok:!c.lock,detail:c.lock??'clear'},
    {key:'edge',label:'Edge',ok:Number.isFinite(edge)&&edge>=config.minEdge,detail:Number.isFinite(edge)?`${side.toUpperCase()} ${cents(edge)} vs ${cents(config.minEdge)} min`:'no ask'},
    // Before the entry window and in the final minute, timing is a schedule, not a fault: show it as waiting.
    {key:'timing',label:'Timing',ok:tau>=60&&(inSweet||edge>=config.earlyEdge),wait:tau<60||tau>config.sweetMaxSeconds,detail:tau<60?'closed for entries (final minute)':inSweet?'in entry window':`opens in ${Math.floor((tau-config.sweetMaxSeconds)/60)}:${String(Math.floor((tau-config.sweetMaxSeconds)%60)).padStart(2,'0')} (or ${cents(config.earlyEdge)}+ edge now)`},
    {key:'spread',label:'Spread',ok:price!==null&&bid!==null&&price-bid<=config.maxSpread+1e-8,detail:price!==null&&bid!==null?`${cents(price-bid)} vs ${cents(config.maxSpread)} max`:'one-sided'},
    {key:'depth',label:'Depth',ok:depth>=config.minDepth,detail:`${Math.floor(depth)} vs ${config.minDepth} min`},
    // With signalBelowMinSize the size check informs the contract count but no longer blocks the signal or its paper trade.
    {key:'size',label:'Size',ok:sizing.contracts>=1,advisory:config.signalBelowMinSize,detail:sizing.contracts>=1?`${sizing.contracts} contracts`:config.signalBelowMinSize?'below 1 contract · paper only':'budget < 1 contract'}
  ];
}
export function evaluate(p:number,tau:number,book:Orderbook,market:Market,balance:number|null,config:Config,schedule:FeeSchedule,conditions:Conditions):Evaluation {
  const v=book.view(),edges={yes:v.yesAsk===null?null:p-v.yesAsk-fee(v.yesAsk,1,'taker',schedule),no:v.noAsk===null?null:1-p-v.noAsk-fee(v.noAsk,1,'taker',schedule)};
  const result:Evaluation={action:'NO TRADE',reason:'No positive edge',idea:null,makers:[],edges,gates:gateChecklist(p,tau,book,market,balance,config,schedule,conditions)};
  const common=market.status!=='active'?'Market not active':!conditions.modelReady?'Model warming or incomplete average':!schedule.verified?'Fee schedule unsupported':!book.valid||conditions.now-book.updated>config.bookStaleMs?'Orderbook unavailable or stale':!conditions.feedsHealthy?'One or more price feeds stale':!conditions.kConfirmed&&!config.allowEstimatedK?'K estimated or unavailable':conditions.lock;
  if(!common&&tau>=config.makerMinSeconds){for(const side of ['yes','no'] as const){const fair=side==='yes'?p:1-p,ask=side==='yes'?v.yesAsk:v.noAsk;if(ask===null)continue;const price=roundDownTick(Math.min(fair-config.makerMargin,ask-.001),market);if(price<=0)continue;const f=fee(price,1,'maker',schedule),edge=fair-price-f;if(edge>=config.minMakerEdge)result.makers.push({side,kind:'maker',price,fee:f,edge,queue:book.queue(side,price),...size(fair,price,balance??0,config,schedule,'maker'),reason:'Resting estimate; queue ahead includes better prices, adverse selection uncalibrated'});}}
  if(common){result.reason=common;return result;}
  if(!conditions.accountReady||balance===null){result.reason='Authenticated balance/history unavailable';return result;}
  const candidates=(['yes','no'] as const).map(side=>({side,edge:edges[side]??-Infinity})).sort((a,b)=>b.edge-a.edge);
  for(const {side,edge} of candidates){
    const price=side==='yes'?v.yesAsk:v.noAsk,depth=side==='yes'?v.yesDepth:v.noDepth,bid=side==='yes'?v.yesBid:v.noBid;
    const reasons:string[]=[];
    if(price===null||bid===null){result.reason='Book side missing';continue;}
    if(edge<config.minEdge)reasons.push(`edge ${(edge*100).toFixed(1)}¢ < ${(config.minEdge*100).toFixed(1)}¢ after ${(fee(price,1,'taker',schedule)*100).toFixed(2)}¢ fee`);
    if(tau<60||(!(tau>=config.sweetMinSeconds&&tau<=config.sweetMaxSeconds)&&edge<config.earlyEdge))reasons.push('Outside entry window');
    if(price-bid>config.maxSpread+1e-8)reasons.push('Spread too wide');if(depth<config.minDepth)reasons.push('Insufficient top depth');
    const sizing=size(side==='yes'?p:1-p,price,balance,config,schedule),belowMinSize=sizing.contracts<1;if(belowMinSize&&!config.signalBelowMinSize)reasons.push('Risk budget below one contract');
    if(reasons.length){if(side===candidates[0].side)result.reason=reasons.join(' · ');continue;}
    const f=fee(price,1,'taker',schedule);result.action=`BUY ${side.toUpperCase()}`;result.reason=`Model ${((side==='yes'?p:1-p)*100).toFixed(1)}% vs ${side.toUpperCase()} ask ${(price*100).toFixed(1)}¢ + ${(f*100).toFixed(2)}¢ fee → +${(edge*100).toFixed(1)}¢ edge${belowMinSize?' · below 1 contract at your risk settings (paper only)':''}`;
    result.idea={side,kind:'taker',price,fee:f,edge,queue:0,...sizing,reason:result.reason,belowMinSize};return result;
  }return result;
}
