import {monitorEventLoopDelay,type IntervalHistogram} from 'node:perf_hooks';
/**
 * The worst event-loop stall of the last 10 s. Every feed's messages wait while the loop is blocked, so a long stall
 * means this computer is holding the data back, whatever the network does. sample() runs once a second.
 */
export class LoopLag {
  ms=0;private recent:{t:number;v:number}[]=[];private h:IntervalHistogram|null=null;
  start(){this.h=monitorEventLoopDelay({resolution:20});this.h.enable();}
  sample(now=Date.now(),window=10000,stallMs=this.h?this.h.max/1e6:0){
    this.h?.reset();this.recent.push({t:now,v:stallMs});while(this.recent[0].t<now-window)this.recent.shift();
    this.ms=Math.max(...this.recent.map(r=>r.v));return this.ms;
  }
  stop(){this.h?.disable();}
}
