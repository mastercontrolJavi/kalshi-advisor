import type {Config} from './config';
import {fee,type FeeSchedule} from './model/fees';
import type {Market} from './feeds/kalshi';
import {Orderbook} from './feeds/orderbook';
export interface Idea {side:'yes'|'no';kind:'taker'|'maker';price:number;fee:number;edge:number;contracts:number;cost:number;maxLoss:number;queue:number;reason:string}
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
export interface Evaluation {action:string;reason:string;idea:Idea|null;makers:Idea[];edges:{yes:number|null;no:number|null}}
export function evaluate(p:number,tau:number,book:Orderbook,market:Market,balance:number|null,config:Config,schedule:FeeSchedule,conditions:{feedsHealthy:boolean;kConfirmed:boolean;lock:string|null;modelReady:boolean;accountReady:boolean;now:number}):Evaluation {
  const v=book.view(),edges={yes:v.yesAsk===null?null:p-v.yesAsk-fee(v.yesAsk,1,'taker',schedule),no:v.noAsk===null?null:1-p-v.noAsk-fee(v.noAsk,1,'taker',schedule)};
  const result:Evaluation={action:'NO TRADE',reason:'No positive edge',idea:null,makers:[],edges};
  const common=!conditions.modelReady?'Model warming or incomplete average':!schedule.verified?'Fee schedule unsupported':!book.valid||conditions.now-book.updated>5000?'Orderbook unavailable or stale':!conditions.feedsHealthy?'One or more price feeds stale':!conditions.kConfirmed&&!config.allowEstimatedK?'K estimated or unavailable':conditions.lock;
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
    const sizing=size(side==='yes'?p:1-p,price,balance,config,schedule);if(sizing.contracts<1)reasons.push('Risk budget below one contract');
    if(reasons.length){if(side===candidates[0].side)result.reason=reasons.join(' · ');continue;}
    const f=fee(price,1,'taker',schedule);result.action=`BUY ${side.toUpperCase()}`;result.reason=`Model ${((side==='yes'?p:1-p)*100).toFixed(1)}% vs ${side.toUpperCase()} ask ${(price*100).toFixed(1)}¢ + ${(f*100).toFixed(2)}¢ fee → +${(edge*100).toFixed(1)}¢ edge`;
    result.idea={side,kind:'taker',price,fee:f,edge,queue:0,...sizing,reason:result.reason};return result;
  }return result;
}
