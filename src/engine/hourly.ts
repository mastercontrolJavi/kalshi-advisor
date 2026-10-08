import type {KalshiClient,Market} from './feeds/kalshi';
import {fee,type FeeSchedule} from './model/fees';
import {probability} from './model/math';
import {predict,priorFit} from './quant/stack';
import {size} from './signals';
import type {Config} from './config';
/**
 * Hourly Bitcoin (Kalshi KXBTCD, "Bitcoin price Above/below"): each hour has a ladder of strikes $100 apart, and a
 * strike resolves YES when the simple average of BRTI over the 60 s before the top of the hour (ET) is above it —
 * the same settlement mechanics as KXBTC15M, with fixed strikes instead of an opening average. The diffusion model
 * therefore applies unchanged per strike. "Up this hour" is measured against the proxy average of the 60 s before
 * the hour opened (what a 15-minute style opening reference would be); Kalshi's own view of it is interpolated
 * from the strike ladder around that reference.
 */
export const HOURLY_SERIES='KXBTCD';
export const HOURLY_HORIZONS=[2700,1800,900,300,60];
export interface HourlyMarket extends Market {yes_bid_dollars?:string;yes_ask_dollars?:string;yes_bid_size_fp?:string;yes_ask_size_fp?:string;volume_fp?:string;expiration_value?:string}
export interface Rung {ticker:string;strike:number;yesBid:number|null;yesAsk:number|null;noBid:number|null;noAsk:number|null;bidSize:number;askSize:number;mid:number|null;model:number|null;quant:number|null;edgeYes:number|null;edgeNo:number|null}
export interface HourlyIdea {ticker:string;strike:number;side:'yes'|'no';price:number;fee:number;edge:number;fair:number;contracts:number;cost:number;maxLoss:number;belowMinSize:boolean;reason:string}
const num=(v:unknown)=>{const n=Number(v);return v===undefined||v===null||v===''||!Number.isFinite(n)?null:n;};
/** Kalshi's implied P(A > k): linear interpolation of strike mids (YES = above strike) around k. */
export function impliedAbove(rungs:{strike:number;mid:number|null}[],k:number):number|null{
  const pts=rungs.filter(r=>r.mid!==null).sort((a,b)=>a.strike-b.strike);if(pts.length<2)return null;
  const hi=pts.findIndex(r=>r.strike>=k);if(hi<=0)return null;const a=pts[hi-1],b=pts[hi],w=(k-a.strike)/(b.strike-a.strike);
  return Math.min(.99,Math.max(.01,a.mid!+(b.mid!-a.mid!)*w));
}
export interface HourlyInputs {spot:number|null;sigma:number;tau:number;locked:number[]|null;basis:number;kHour:number|null;modelReady:boolean}
/** Price every strike near the money: model, quant blend with Kalshi, and net edges after the taker fee. */
export function ladder(markets:HourlyMarket[],i:HourlyInputs,schedule:FeeSchedule,band=1600):Rung[]{
  return markets.map(m=>{
    const strike=num(m.floor_strike),yesBid=num(m.yes_bid_dollars),yesAsk=num(m.yes_ask_dollars);
    if(strike===null)return null;
    const yb=yesBid!==null&&yesBid>0?yesBid:null,ya=yesAsk!==null&&yesAsk>0&&yesAsk<1?yesAsk:null;
    const noBid=ya!==null?+(1-ya).toFixed(4):null,noAsk=yb!==null?+(1-yb).toFixed(4):null,mid=yb!==null&&ya!==null&&ya-yb<=.1?(yb+ya)/2:null;
    const near=i.spot!==null&&Math.abs(strike-i.spot)<=band;
    const model=near&&i.modelReady&&i.spot!==null&&i.locked!==null?probability(i.spot,strike,i.sigma,i.tau,i.locked,i.basis).p:null;
    const quant=model!==null?predict(priorFit(),{modelP:model,mid,sigma:i.sigma,momentum30s:null,momentum120s:null,imbalance:null,tradeFlow30s:null}).p:null;
    return {ticker:m.ticker,strike,yesBid:yb,yesAsk:ya,noBid,noAsk,bidSize:num(m.yes_bid_size_fp)??0,askSize:num(m.yes_ask_size_fp)??0,mid,model,quant,
      edgeYes:quant!==null&&ya!==null?quant-ya-fee(ya,1,'taker',schedule):null,edgeNo:quant!==null&&noAsk!==null?(1-quant)-noAsk-fee(noAsk,1,'taker',schedule):null};
  }).filter((r):r is Rung=>!!r&&(i.spot===null||Math.abs(r.strike-i.spot)<=band)).sort((a,b)=>b.strike-a.strike);
}
/** Ideas that pass the same gates as the 15-minute taker signal (edge, spread, depth, time, data, guardrails). */
export function hourlyIdeas(rungs:Rung[],tau:number,balance:number|null,config:Config,schedule:FeeSchedule,blocked:string|null):{ideas:HourlyIdea[];reason:string}{
  if(blocked)return {ideas:[],reason:blocked};
  if(tau<60)return {ideas:[],reason:'Final minute — closed for entries'};
  const ideas:HourlyIdea[]=[];let best=-Infinity;
  for(const r of rungs)for(const side of ['yes','no'] as const){
    const edge=side==='yes'?r.edgeYes:r.edgeNo,price=side==='yes'?r.yesAsk:r.noAsk,bid=side==='yes'?r.yesBid:r.noBid,depth=side==='yes'?r.askSize:r.bidSize;
    if(edge===null||price===null||bid===null||r.quant===null)continue;best=Math.max(best,edge);
    if(edge<config.minEdge||price-bid>config.maxSpread+1e-8||depth<config.minDepth||price<.03||price>.97)continue;
    const fair=side==='yes'?r.quant:1-r.quant,f=fee(price,1,'taker',schedule),sz=size(fair,price,balance??0,config,schedule);
    ideas.push({ticker:r.ticker,strike:r.strike,side,price,fee:f,edge,fair,...sz,belowMinSize:sz.contracts<1,
      reason:`${side==='yes'?'Above':'Not above'} $${Math.round(r.strike).toLocaleString()}: quant ${(fair*100).toFixed(1)}% vs ask ${(price*100).toFixed(1)}¢ + ${(f*100).toFixed(2)}¢ fee → +${(edge*100).toFixed(1)}¢`});
  }
  ideas.sort((a,b)=>b.edge-a.edge);
  return {ideas:ideas.slice(0,4),reason:ideas.length?ideas[0].reason:Number.isFinite(best)?`Best edge ${(best*100).toFixed(1)}¢ < ${(config.minEdge*100).toFixed(1)}¢ after fees`:'No priced strikes yet'};
}
/** Polls the current and next KXBTCD events (one request returns every strike) and settles finished hours. */
export class HourlyBoard {
  markets:HourlyMarket[]=[];updated=0;error='';upcoming:{event:string;open:number;close:number}|null=null;private busy=false;private upcomingChecked=0;
  constructor(private client:KalshiClient){}
  async refresh(nowMs:number){
    if(this.busy)return;this.busy=true;
    try{const from=Math.floor(nowMs/1000),{markets}=await this.client.get(`/markets?series_ticker=${HOURLY_SERIES}&min_close_ts=${from}&max_close_ts=${from+7300}&limit=1000`);
      this.markets=markets as HourlyMarket[];this.updated=Date.now();this.error='';
      // Kalshi lists no hourly markets for several hours around its Thursday 3–5 AM ET maintenance (and occasionally
      // otherwise). Then say when the next one opens: the soonest unopened event, checked once a minute.
      if(!this.events(nowMs).current&&Date.now()-this.upcomingChecked>60000){this.upcomingChecked=Date.now();
        const {events}=await this.client.get(`/events?series_ticker=${HOURLY_SERIES}&status=unopened&limit=5`);
        const close=(events??[]).map((e:any)=>({event:e.event_ticker,close:Date.parse(e.strike_date)})).filter((e:any)=>Number.isFinite(e.close)&&e.close>nowMs).sort((a:any,b:any)=>a.close-b.close)[0];
        this.upcoming=close?{event:close.event,open:close.close-3600000,close:close.close}:null;}
      else if(this.events(nowMs).current)this.upcoming=null;}
    catch(e){this.error=(e as Error).message;}finally{this.busy=false;}
  }
  events(nowMs:number){
    const byEvent=new Map<string,HourlyMarket[]>();for(const m of this.markets)(byEvent.get(m.event_ticker)??byEvent.set(m.event_ticker,[]).get(m.event_ticker)!).push(m);
    const list=[...byEvent].map(([event,ms])=>({event,open:Date.parse(ms[0].open_time),close:Date.parse(ms[0].close_time),markets:ms})).sort((a,b)=>a.close-b.close);
    return {current:list.find(e=>e.open<=nowMs&&e.close>nowMs)??null,next:list.find(e=>e.open>nowMs)??null};
  }
}
