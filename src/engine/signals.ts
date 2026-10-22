import type {Config} from './config';
import {fee,type FeeSchedule} from './model/fees';
import type {Market} from './feeds/kalshi';
import {Orderbook,MAX_BOOK_DELAY_MS} from './feeds/orderbook';
export interface Idea {side:'yes'|'no';kind:'taker'|'maker'|'scalp'|'dip'|'hourly';target?:number;price:number;fee:number;edge:number;contracts:number;cost:number;maxLoss:number;queue:number;reason:string;belowMinSize?:boolean}
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
type Conditions={feedsHealthy:boolean;kConfirmed:boolean;lock:string|null;modelReady:boolean;accountReady:boolean;now:number;healthyFeeds?:number;totalFeeds?:number;bookDelayMs?:number};
const cents=(x:number)=>`${(x*100).toFixed(1)}¢`;
/** Every taker gate for the better-edge side, pass/fail with the observed value, so NO TRADE is explainable at a glance. */
export function gateChecklist(p:number,tau:number,book:Orderbook,market:Market,balance:number|null,config:Config,schedule:FeeSchedule,c:Conditions):Gate[]{
  const v=book.view(),yes=v.yesAsk===null?-Infinity:p-v.yesAsk-fee(v.yesAsk,1,'taker',schedule),no=v.noAsk===null?-Infinity:1-p-v.noAsk-fee(v.noAsk,1,'taker',schedule);
  const side=yes>=no?'yes':'no',edge=Math.max(yes,no),price=side==='yes'?v.yesAsk:v.noAsk,bid=side==='yes'?v.yesBid:v.noBid,depth=side==='yes'?v.yesDepth:v.noDepth;
  // Final-minute entries (5–59 s left) only when the user turns finalMinuteSignals on, e.g. after the study proves an edge.
  const minTau=config.finalMinuteSignals?5:60,inSweet=(tau>=config.sweetMinSeconds||tau>=minTau&&tau<60)&&tau<=config.sweetMaxSeconds,sizing=price!==null&&balance!==null?size(side==='yes'?p:1-p,price,balance,config,schedule):{contracts:0};
  // A book still updating but far behind Kalshi (FeedDelay) is as unusable as a silent one.
  const delayed=(c.bookDelayMs??0)>MAX_BOOK_DELAY_MS,bookLive=book.valid&&c.now-book.updated<=config.bookStaleMs&&!delayed;
  return [
    {key:'market',label:'Market open',ok:market.status==='active',detail:market.status},
    {key:'feeds',label:'Price feeds',ok:c.feedsHealthy,detail:c.totalFeeds?`${c.healthyFeeds}/${c.totalFeeds} live`:c.feedsHealthy?'live':'stale'},
    {key:'book',label:'Kalshi book',ok:bookLive&&schedule.verified,detail:!schedule.verified?'fees unverified':delayed?`${Math.round(c.bookDelayMs!/1000)} s behind Kalshi`:bookLive?v.source==='ws'?'live':'REST fallback':'stale'},
    {key:'k',label:'Opening K',ok:c.kConfirmed||config.allowEstimatedK,detail:c.kConfirmed?'confirmed':'estimated'},
    {key:'model',label:'Model',ok:c.modelReady,detail:c.modelReady?'warm':'warming'},
    {key:'account',label:'Account',ok:c.accountReady&&balance!==null,detail:c.accountReady?'synced':'unavailable'},
    {key:'guards',label:'Guardrails',ok:!c.lock,detail:c.lock??'clear'},
    {key:'edge',label:'Edge',ok:Number.isFinite(edge)&&edge>=config.minEdge,detail:Number.isFinite(edge)?`${side.toUpperCase()} ${cents(edge)} vs ${cents(config.minEdge)} min`:'no ask'},
    // Before the entry window and in the final minute, timing is a schedule, not a fault: show it as waiting.
    {key:'timing',label:'Timing',ok:tau>=minTau&&(inSweet||edge>=config.earlyEdge),wait:tau<minTau||tau>config.sweetMaxSeconds,detail:tau<minTau?(minTau===5?'closed for entries (last 5 s)':'closed for entries (final minute)'):inSweet?'in entry window':`opens in ${Math.floor((tau-config.sweetMaxSeconds)/60)}:${String(Math.floor((tau-config.sweetMaxSeconds)%60)).padStart(2,'0')} (or ${cents(config.earlyEdge)}+ edge now)`},
    {key:'spread',label:'Spread',ok:price!==null&&bid!==null&&price-bid<=config.maxSpread+1e-8,detail:price!==null&&bid!==null?`${cents(price-bid)} vs ${cents(config.maxSpread)} max`:'one-sided'},
    {key:'depth',label:'Depth',ok:depth>=config.minDepth,detail:`${Math.floor(depth)} vs ${config.minDepth} min`},
    // With signalBelowMinSize the size check informs the contract count but no longer blocks the signal or its paper trade.
    {key:'size',label:'Size',ok:sizing.contracts>=1,advisory:config.signalBelowMinSize,detail:sizing.contracts>=1?`${sizing.contracts} contracts`:config.signalBelowMinSize?'below 1 contract · paper only':'budget < 1 contract'}
  ];
}
export function evaluate(p:number,tau:number,book:Orderbook,market:Market,balance:number|null,config:Config,schedule:FeeSchedule,conditions:Conditions):Evaluation {
  const v=book.view(),edges={yes:v.yesAsk===null?null:p-v.yesAsk-fee(v.yesAsk,1,'taker',schedule),no:v.noAsk===null?null:1-p-v.noAsk-fee(v.noAsk,1,'taker',schedule)};
  const result:Evaluation={action:'NO TRADE',reason:'No positive edge',idea:null,makers:[],edges,gates:gateChecklist(p,tau,book,market,balance,config,schedule,conditions)};
  const common=market.status!=='active'?'Market not active':!conditions.modelReady?'Model warming or incomplete average':!schedule.verified?'Fee schedule unsupported':!book.valid||conditions.now-book.updated>config.bookStaleMs?'Orderbook unavailable or stale':(conditions.bookDelayMs??0)>MAX_BOOK_DELAY_MS?`Kalshi prices ${Math.round(conditions.bookDelayMs!/1000)} s behind`:!conditions.feedsHealthy?'One or more price feeds stale':!conditions.kConfirmed&&!config.allowEstimatedK?'K estimated or unavailable':conditions.lock;
  if(!common&&tau>=config.makerMinSeconds){for(const side of ['yes','no'] as const){const fair=side==='yes'?p:1-p,ask=side==='yes'?v.yesAsk:v.noAsk;if(ask===null)continue;const price=roundDownTick(Math.min(fair-config.makerMargin,ask-.001),market);if(price<=0)continue;const f=fee(price,1,'maker',schedule),edge=fair-price-f;if(edge>=config.minMakerEdge)result.makers.push({side,kind:'maker',price,fee:f,edge,queue:book.queue(side,price),...size(fair,price,balance??0,config,schedule,'maker'),reason:'Resting estimate; queue ahead includes better prices, adverse selection uncalibrated'});}}
  if(common){result.reason=common;return result;}
  if(!conditions.accountReady||balance===null){result.reason='Authenticated balance/history unavailable';return result;}
  const candidates=(['yes','no'] as const).map(side=>({side,edge:edges[side]??-Infinity})).sort((a,b)=>b.edge-a.edge);
  for(const {side,edge} of candidates){
    const price=side==='yes'?v.yesAsk:v.noAsk,depth=side==='yes'?v.yesDepth:v.noDepth,bid=side==='yes'?v.yesBid:v.noBid;
    const reasons:string[]=[];
    if(price===null||bid===null){result.reason='Book side missing';continue;}
    if(edge<config.minEdge)reasons.push(`edge ${(edge*100).toFixed(1)}¢ < ${(config.minEdge*100).toFixed(1)}¢ after ${(fee(price,1,'taker',schedule)*100).toFixed(2)}¢ fee`);
    const minTau=config.finalMinuteSignals?5:60,inWindow=(tau>=config.sweetMinSeconds||tau>=minTau&&tau<60)&&tau<=config.sweetMaxSeconds;
    if(tau<minTau||(!inWindow&&edge<config.earlyEdge))reasons.push('Outside entry window');
    if(price-bid>config.maxSpread+1e-8)reasons.push('Spread too wide');if(depth<config.minDepth)reasons.push('Insufficient top depth');
    const sizing=size(side==='yes'?p:1-p,price,balance,config,schedule),belowMinSize=sizing.contracts<1;if(belowMinSize&&!config.signalBelowMinSize)reasons.push('Risk budget below one contract');
    if(reasons.length){if(side===candidates[0].side)result.reason=reasons.join(' · ');continue;}
    const f=fee(price,1,'taker',schedule);result.action=`BUY ${side.toUpperCase()}`;result.reason=`Model ${((side==='yes'?p:1-p)*100).toFixed(1)}% vs ${side.toUpperCase()} ask ${(price*100).toFixed(1)}¢ + ${(f*100).toFixed(2)}¢ fee → +${(edge*100).toFixed(1)}¢ edge${belowMinSize?' · below 1 contract at your risk settings (paper only)':''}`;
    result.idea={side,kind:'taker',price,fee:f,edge,queue:0,...sizing,reason:result.reason,belowMinSize};return result;
  }return result;
}
/**
 * Firm signals (user request 2026-10-10: "not just flash for a millisecond"). On 242 live rounds the raw BUY flickered:
 * 1,445 separate BUY runs, a median of 10 per round, 45% of them gone within 2 s. The latch:
 *   - shows a BUY only after the same side has qualified for CONFIRM_MS (3 s). Entering at the third second instead of
 *     the first changed nothing on that data (+7.0¢ vs +6.8¢ per contract, clustered ranges overlapping);
 *   - then keeps it, with a fixed limit ("buy at L or less"), until the edge at the ask has stayed under 1¢ for 3 s or a
 *     hard gate fails (market, feeds, book, K, model, account, guardrails, final minute). Spread/depth blips do not
 *     release it;
 *   - moves the limit only when the forecast moves it by ≥ 2¢, so the number on screen does not twitch.
 */
export const LATCH={confirmMs:3000,releaseEdge:.01,weakMs:3000,limitStep:.02} as const;
export interface Latch {side:'yes'|'no'|null;confirmedAt:number|null;limit:number|null;weakSince:number|null;candidate:'yes'|'no'|null;candidateSince:number;id:number}
export const emptyLatch=(id=0):Latch=>({side:null,confirmedAt:null,limit:null,weakSince:null,candidate:null,candidateSince:0,id});
/** Highest whole-cent price at which `fair` still beats price + taker fee by `minEdge`; null if none. */
export function limitPrice(fair:number,minEdge:number,schedule:FeeSchedule){
  for(let c=99;c>=1;c--){const p=c/100;if(fair-p-fee(p,1,'taker',schedule)>=minEdge-1e-9)return p;}return null;
}
export interface FirmEvaluation extends Evaluation {firm?:{side:'yes'|'no';limit:number|null;heldMs:number;edgeNow:number|null;id:number}|null;forming?:{side:'yes'|'no';ms:number;needMs:number}|null}
/** `hardBlock`: a reason the advice must stop at once (null when only soft gates such as spread or depth fail). */
export function latchSignal(prev:Latch,ev:Evaluation,p:number,book:{yesAsk:number|null;noAsk:number|null},config:Config,schedule:FeeSchedule,balance:number|null,now:number,hardBlock:string|null):{latch:Latch;evaluation:FirmEvaluation}{
  const raw=ev.action==='BUY YES'?'yes':ev.action==='BUY NO'?'no':null,fair=(s:'yes'|'no')=>s==='yes'?p:1-p,ask=(s:'yes'|'no')=>s==='yes'?book.yesAsk:book.noAsk;
  const edgeAt=(s:'yes'|'no')=>{const a=ask(s);return a===null||a<=0||a>=1?null:fair(s)-a-fee(a,1,'taker',schedule);};
  const l:Latch={...prev};
  // The side that qualifies right now (other than the one shown) and for how long; reset whenever it changes or lapses.
  const want=raw&&raw!==l.side&&!hardBlock?raw:null;if(want!==l.candidate){l.candidate=want;l.candidateSince=now;}
  if(l.side){
    const e=edgeAt(l.side),weak=e===null||e<LATCH.releaseEdge;l.weakSince=weak?l.weakSince??now:null;
    if(hardBlock||weak&&now-l.weakSince!>=LATCH.weakMs){l.side=null;l.confirmedAt=null;l.limit=null;l.weakSince=null;}
  }
  if(!l.side&&l.candidate&&now-l.candidateSince>=LATCH.confirmMs){const side=l.candidate;Object.assign(l,{side,confirmedAt:now,limit:limitPrice(fair(side),config.minEdge,schedule),weakSince:null,candidate:null,candidateSince:now,id:l.id+1});}
  if(!l.side){
    const forming=l.candidate?{side:l.candidate,ms:now-l.candidateSince,needMs:LATCH.confirmMs}:null;
    return {latch:l,evaluation:{...ev,action:'NO TRADE',idea:null,reason:forming?`BUY ${forming.side.toUpperCase()} forming: confirms if it holds ${Math.max(1,Math.ceil((forming.needMs-forming.ms)/1000))} s more · ${ev.reason}`:hardBlock??ev.reason,firm:null,forming}};
  }
  // Latched: a fixed limit that only moves when the forecast moves it by ≥ 2¢.
  const side=l.side,next=limitPrice(fair(side),config.minEdge,schedule);
  if(next===null||l.limit===null||Math.abs(next-l.limit)>=LATCH.limitStep-1e-9)l.limit=next;
  const a=ask(side),e=edgeAt(side),f=a!==null&&a>0&&a<1?fee(a,1,'taker',schedule):0;
  const sizing=a!==null&&a>0&&a<1?size(fair(side),a,balance??0,config,schedule):{contracts:0,cost:0,maxLoss:0};
  const idea:Idea=ev.idea&&ev.idea.side===side?ev.idea:{side,kind:'taker',price:a??0,fee:f,edge:e??0,queue:0,...sizing,reason:'',belowMinSize:sizing.contracts<1};
  const lim=l.limit!==null?`${(l.limit*100).toFixed(0)}¢`:'—',held=Math.round((now-l.confirmedAt!)/1000);
  const reason=`Buy ${side.toUpperCase()} at ${lim} or less · model ${(fair(side)*100).toFixed(1)}%${a!==null?` vs ask ${(a*100).toFixed(1)}¢ (${e!==null?`${e>=0?'+':'−'}${Math.abs(e*100).toFixed(1)}¢ edge after fee`:'no edge'})`:''} · held ${held} s${a!==null&&l.limit!==null&&a>l.limit+1e-9?` · ask is above your limit: wait for ${lim}`:''}`;
  return {latch:l,evaluation:{...ev,action:`BUY ${side.toUpperCase()}`,reason,idea:{...idea,reason},firm:{side,limit:l.limit,heldMs:now-l.confirmedAt!,edgeNow:e,id:l.id},forming:null}};
}
