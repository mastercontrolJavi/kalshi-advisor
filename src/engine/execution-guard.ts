import {fee,type FeeSchedule} from './model/fees';
/**
 * Execution guardrails (2026-11-02, DECISIONS 70). The quant/ post-mortem of every real fill found +$545.55 before fees
 * against $894.42 of taker fees, the Oct 21 round lost on a book tens of seconds behind Kalshi, and the losses clustered at
 * 40–60¢ (the fee peak) and 9 PM–midnight PT.
 *
 * Stale-book breaker: trading stops the moment the Kalshi book or the BRTI index is more than 500 ms behind, the book is
 * resyncing after a missed sequence number, or a BRTI sequence number is skipped. It clears only after 1 s with every
 * check passing, so a feed hovering at the limit cannot flash the warning on and off. Measured on the journal (Oct 22 →
 * Nov 1): the Kalshi book was > 500 ms behind on 1.3% of seconds. BRTI is judged by arrival gaps (the 5 Hz stream sends
 * every 200 ms on 99.997% of messages) and by delay above its own 10-minute floor, not by its source-time age, which
 * carries the clock-sync error and read > 500 ms on 15% of seconds.
 */
export const BREAKER_MS=500,BREAKER_CLEAR_MS=1000,KALSHI_SILENT_MS=2000,BRTI_GAP_HOLD_MS=1000;
export interface FeedHealth {
  /** The round's book as the engine would trade on it (KalshiFeed.current); null between rounds. */
  kalshi:{status:string;bookValid:boolean;source:'stream'|'rest';delayMs:number;silentMs:number}|null;
  brti:{status:string;silentMs:number|null;delayMs:number;gapAgoMs:number|null};
}
export function staleReasons(h:FeedHealth,limit=BREAKER_MS):string[]{
  const r:string[]=[],k=h.kalshi,b=h.brti,ms=(x:number)=>`${Math.round(x)} ms`;
  if(k){
    if(k.source==='stream'&&k.status!=='connected')r.push(`Kalshi stream ${k.status}`);
    else if(!k.bookValid)r.push('Kalshi book resyncing after a missed update');
    else if(k.delayMs>limit)r.push(`Kalshi book ${ms(k.delayMs)} behind`);
    // Kalshi sends hundreds of messages a second on this series; seconds of silence on a connected socket is a dead link.
    if(k.source==='stream'&&k.status==='connected'&&k.silentMs>KALSHI_SILENT_MS)r.push(`no Kalshi message for ${(k.silentMs/1000).toFixed(1)} s`);
  }
  if(b.status!=='connected')r.push(`BRTI index ${b.status}`);
  else{
    if(b.silentMs===null)r.push('no BRTI value yet');else if(b.silentMs>limit)r.push(`no BRTI value for ${ms(b.silentMs)}`);
    if(b.delayMs>limit)r.push(`BRTI ${ms(b.delayMs)} later than usual`);
    if(b.gapAgoMs!==null&&b.gapAgoMs<BRTI_GAP_HOLD_MS)r.push('BRTI skipped a sequence number');
  }
  return r;
}
export interface BreakerView {stale:boolean;reasons:string[];sinceMs:number|null;clearing:boolean;trips:number}
/** Trips at once; clears only after BREAKER_CLEAR_MS with no reason. The last reasons stay on screen while clearing. */
export class StaleBreaker {
  stale=false;reasons:string[]=[];trips=0;private since:number|null=null;private clearSince:number|null=null;
  update(now:number,reasons:string[]):BreakerView{
    if(reasons.length){if(!this.stale){this.stale=true;this.since=now;this.trips++;}this.reasons=reasons;this.clearSince=null;}
    else if(this.stale){this.clearSince??=now;if(now-this.clearSince>=BREAKER_CLEAR_MS){this.stale=false;this.since=null;this.clearSince=null;this.reasons=[];}}
    return {stale:this.stale,reasons:this.reasons,sinceMs:this.since===null?null:now-this.since,clearing:this.stale&&this.clearSince!==null,trips:this.trips};
  }
}

/** The fee peak: the quadratic taker fee is 1.68–1.75¢ a contract from 40¢ to 60¢ (your fills there: −$432.58 net). */
export const PEAK_FEE_ZONE={low:.40,high:.60} as const;
/** 9 PM to midnight PT: your worst hours (−$651.13 net on 215 lots); 15-min BTC moves were 13–16 bp then vs 17.6 bp overall. */
export const LOW_VOL_HOURS={from:21,to:24,timeZone:'America/Los_Angeles'} as const;
const hourFormat=new Intl.DateTimeFormat('en-US',{timeZone:LOW_VOL_HOURS.timeZone,hour:'numeric',hourCycle:'h23'});
export const ptHour=(ms:number)=>Number(hourFormat.format(ms))%24;
export interface DangerBadges {peakFee:{mid:number;feePerContract:number}|null;lowVol:{hour:number}|null}
export function dangerBadges(mid:number|null,now:number,schedule:FeeSchedule):DangerBadges{
  const hour=ptHour(now),peak=mid!==null&&Number.isFinite(mid)&&mid>=PEAK_FEE_ZONE.low-1e-9&&mid<=PEAK_FEE_ZONE.high+1e-9;
  return {peakFee:peak?{mid:mid!,feePerContract:fee(mid!,100,'taker',schedule)/100}:null,lowVol:hour>=LOW_VOL_HOURS.from&&hour<LOW_VOL_HOURS.to?{hour}:null};
}
