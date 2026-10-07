import type {Config} from './config';
export interface RealEvent {id:string;time:number;ticker:string;type:'fill'|'settlement';pnl:number;outcomePnl?:number;closedContracts?:number;contracts:number;orderId?:string;side?:string;price?:number;action?:string;warnings?:string[]}
// Constructing Intl.DateTimeFormat costs ~0.3 ms; per-event construction made guardrails ~190 ms per loop.
const formatters=new Map<string,Intl.DateTimeFormat>();
export function dayKey(time:number,zone=process.env.SESSION_TIMEZONE??'America/Los_Angeles'){
  let f=formatters.get(zone);if(!f){f=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});formatters.set(zone,f);}
  return f.format(time);
}
export function guardrails(events:RealEvent[],startBalance:number,config:Config,now:number,overrideDay:string|null=null){
  const today=dayKey(now),todayEvents=events.filter(e=>dayKey(e.time)===today);
  const pnl=todayEvents.reduce((s,e)=>s+e.pnl,0);
  const closedOrders=new Map<string,{time:number;pnl:number}>();
  for(const e of events.filter(e=>e.type==='fill'&&(e.closedContracts??0)>0)){const id=e.orderId??e.id,prior=closedOrders.get(id);closedOrders.set(id,{time:Math.max(e.time,prior?.time??0),pnl:e.pnl+(prior?.pnl??0)});}
  const settled=[...events.filter(e=>e.type==='settlement'&&(e.contracts>0||!events.some(f=>f.type==='fill'&&f.ticker===e.ticker))),...[...closedOrders.values()]].sort((a,b)=>a.time-b.time);
  let streak=0,lastLoss=0;
  for(const e of settled){const p=e.pnl;if(p<0){streak=streak<0?streak-1:-1;lastLoss=e.time;}else if(p>0)streak=streak>0?streak+1:1;else streak=0;}
  const hourly=new Set(events.filter(e=>e.type==='fill'&&e.time>now-3600000).map(e=>e.orderId??e.id)).size;
  const trades=new Set(todayEvents.filter(e=>e.type==='fill').map(e=>e.orderId??e.id)).size;
  const results=settled.filter(e=>dayKey(e.time)===today);
  const wins=results.filter(e=>e.pnl>0).length;
  const dailyLocked=startBalance>0&&pnl<=-startBalance*config.dailyLossLimit&&overrideDay!==today;
  const cooldownUntil=streak<=-config.consecutiveLossLimit?lastLoss+config.cooldownMinutes*60000:0;
  const reason=dailyLocked?'Daily loss limit reached':cooldownUntil>now?'Consecutive-loss cooldown':hourly>=config.maxTradesPerHour?'Hourly trade limit reached':null;
  return {locked:!!reason,dailyLocked,reason,cooldownUntil,pnl,trades,winRate:results.length?wins/results.length:null,streak,hourly,startBalance,today};
}
export function fillWarnings(fill:RealEvent,suggested:number|null,priorPrices:{time:number;price:number}[],config:Config){
  const warnings:string[]=[];
  // A zero suggestion means sizing was unavailable (no account state), not a recommendation to compare against.
  if(suggested!==null&&suggested>0&&fill.contracts>suggested)warnings.push(`Oversize: ${+fill.contracts.toFixed(2)} filled vs ${suggested} suggested`);
  const prices=priorPrices.filter(p=>p.time>=fill.time-config.chaseSeconds*1000&&p.time<fill.time);
  if(prices.length&&fill.price!==undefined&&fill.price-prices[0].price>config.chaseMove)warnings.push(`Chase: price rose ${((fill.price-prices[0].price)*100).toFixed(1)}¢ before fill`);
  return warnings;
}
