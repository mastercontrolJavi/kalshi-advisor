import {KalshiClient,WS} from './kalshi';
import {ReconnectingSocket} from './socket';
import {FeedDelay,SubscriptionSequence} from './orderbook';
import type {Sample} from '../model/math';

export type BenchmarkChannel='cfbenchmarks_value'|'cfbenchmarks_value_5hz';
export interface BenchmarkTick extends Sample {channel:BenchmarkChannel;received:number;raw:string}
export const BENCHMARK_MAX_AGE_MS=2500;
/** Parse the documented upstream value frame, never a trailing average or a contract price. */
export function parseBenchmark(message:any,received=Date.now()):BenchmarkTick|null {
  if(!['cfbenchmarks_value','cfbenchmarks_value_5hz'].includes(message?.type)||message?.msg?.index_id!=='BRTI')return null;
  const d=message.msg;let raw:any;
  try{raw=typeof d.data==='string'?JSON.parse(d.data):d.data;}catch{return null;}
  if(raw?.id!=='BRTI'||raw?.type!=='value')return null;
  const time=Number(raw.time),price=Number(raw.value);
  if(!Number.isSafeInteger(time)||time<=0||!Number.isFinite(price)||price<=0||!Number.isFinite(received))return null;
  // Conflicting parsed fields are corrupt input, not an alternative source of truth.
  if(d.source_ts_ms!=null&&Number(d.source_ts_ms)!==time||d.value_usd!=null&&Number(d.value_usd)!==price)return null;
  if(message.type==='cfbenchmarks_value'&&time%1000!==0)return null;
  return {channel:message.type,time,price,received,raw:JSON.stringify(message)};
}

/** Separate authenticated socket: reference data and book reconnections cannot invalidate each other. */
export class BenchmarkFeed {
  status='disconnected';error:string|null=null;history:Sample[]=[];
  /** 5 Hz delivery delay above its own 10-minute floor (clock offset cancels out), the last arrival, the last skipped seq. */
  delay=new FeedDelay();lastFast:number|null=null;lastGap:number|null=null;gaps=0;
  private socket?:ReconnectingSocket;
  private sequence=new SubscriptionSequence();
  private latest=new Map<BenchmarkChannel,BenchmarkTick>();
  private recent=new Map<BenchmarkChannel,BenchmarkTick[]>();
  constructor(private client:KalshiClient,private log:(event:string,data:unknown)=>void=()=>{},private onTick:(tick:BenchmarkTick)=>void=()=>{}){}
  start(){
    if(!this.client.authenticated){this.status='unavailable — missing credentials';return;}
    this.socket?.stop();
    this.socket=new ReconnectingSocket(WS,()=>[
      {id:1,cmd:'subscribe',params:{channels:['cfbenchmarks_value'],index_ids:['BRTI']}},
      {id:2,cmd:'subscribe',params:{channels:['cfbenchmarks_value_5hz'],index_ids:['BRTI']}}
    ],m=>this.handle(m),status=>{this.status=status;if(status==='connecting'){this.latest.clear();this.recent.clear();this.error=null;this.sequence.reset();this.delay.reset();this.lastFast=null;}this.log('benchmark-status',{status});},()=>this.client.headers('/trade-api/ws/v2'),{pingMs:1000});
    this.socket.start();
  }
  handle(message:any,received=Date.now()){
    if(message?.type==='error'){this.error=String(message.msg?.msg??message.msg?.message??'Reference subscription unavailable');this.log('benchmark-subscription-error',{message:this.error});return;}
    const tick=parseBenchmark(message,received);if(!tick)return false;
    // Kalshi numbers each subscription's messages; a skipped number is a lost index value (execution-guard.ts).
    if(Number.isFinite(message.sid)&&Number.isFinite(message.seq)&&!this.sequence.accept(message.sid,message.seq)){this.lastGap=received;this.gaps++;this.log('benchmark-gap',{sid:message.sid,seq:message.seq,channel:tick.channel});}
    if(tick.channel==='cfbenchmarks_value_5hz'){this.lastFast=received;this.delay.observe(tick.time,received);}
    if(tick.time>received+this.client.clockOffset+1000)return false;
    const previous=this.latest.get(tick.channel);if(previous&&tick.time<=previous.time)return false;
    this.latest.set(tick.channel,tick);
    this.recent.set(tick.channel,[...(this.recent.get(tick.channel)??[]),tick].slice(-10));
    if(tick.channel==='cfbenchmarks_value'){
      // Keep the original source-second grid; no interpolation or proxy splicing.
      const last=this.history.at(-1);
      if(!last||tick.time>last.time)this.history.push({time:tick.time,price:tick.price});
      this.history=this.history.filter(s=>s.time>tick.time-7200000);
    }
    this.onTick(tick);return true;
  }
  current(now=Date.now(),channel:BenchmarkChannel='cfbenchmarks_value'){
    if(this.status!=='connected')return null;
    // HTTP Date clock synchronization has subsecond uncertainty. If the newest tick appears in the
    // future, use the preceding genuinely observed fresh tick rather than flickering or looking ahead.
    return [...(this.recent.get(channel)??[])].reverse().find(t=>{
      const age=now+this.client.clockOffset-t.time,receivedAge=now-t.received;
      return age>=0&&age<=BENCHMARK_MAX_AGE_MS&&receivedAge>=0&&receivedAge<=BENCHMARK_MAX_AGE_MS;
    })??null;
  }
  snapshot(now=Date.now()){
    const second=this.current(now),fast=this.current(now,'cfbenchmarks_value_5hz'),latest=fast&&(!second||fast.time>second.time)?fast:second;
    return {status:this.status,error:this.error,available:!!second,price:latest?.price??null,sourceTime:latest?.time??null,
      ageMs:latest?Math.round(now+this.client.clockOffset-latest.time):null,transportMs:latest?Math.max(0,Math.round(latest.received+this.client.clockOffset-latest.time)):null,
      secondTime:second?.time??null,highFrequency:!!fast,samples:this.history.length};
  }
  /** For the stale-book breaker: time since the last 5 Hz value, its delivery delay, and how long ago a seq was skipped. */
  health(now=Date.now()){return {status:this.status,silentMs:this.lastFast===null?null:now-this.lastFast,delayMs:this.delay.ms,gapAgoMs:this.lastGap===null?null:now-this.lastGap};}
  stop(){this.socket?.stop();this.status='disconnected';}
  restart(){this.stop();this.start();}
}
