import {monitorEventLoopDelay,performance,type IntervalHistogram,type EventLoopUtilization} from 'node:perf_hooks';
/** Seconds over which `busy` averages the event loop's utilization. */
export const BUSY_WINDOW_MS=5000;
/**
 * The worst event-loop stall of the last 10 s, and how busy the loop has been over the last 5 s. Every feed's messages
 * wait while the loop is blocked, so a long stall means this computer is holding the data back, whatever the network
 * does. A loop that is busy almost all the time does the same without any one long stall: on 2026-10-23 the Kalshi book
 * ran seconds behind with no stall over 1 s, and the dashboard blamed Kalshi. sample() runs once a second.
 */
export class LoopLag {
  ms=0;busy=0;private recent:{t:number;v:number;u:number}[]=[];private h:IntervalHistogram|null=null;private elu:EventLoopUtilization|null=null;
  start(){this.h=monitorEventLoopDelay({resolution:20});this.h.enable();this.elu=performance.eventLoopUtilization();}
  sample(now=Date.now(),window=10000,stallMs=this.h?this.h.max/1e6:0,utilization=this.utilization()){
    this.h?.reset();this.recent.push({t:now,v:stallMs,u:utilization});while(this.recent[0].t<now-window)this.recent.shift();
    this.ms=Math.max(...this.recent.map(r=>r.v));
    const last=this.recent.filter(r=>r.t>now-BUSY_WINDOW_MS);this.busy=last.reduce((s,r)=>s+r.u,0)/last.length;
    return this.ms;
  }
  /** Share of the time since the last sample the loop spent running code rather than waiting for events. */
  private utilization(){if(!this.elu)return 0;const next=performance.eventLoopUtilization(),used=performance.eventLoopUtilization(next,this.elu).utilization;this.elu=next;return used;}
  stop(){this.h?.disable();}
}
