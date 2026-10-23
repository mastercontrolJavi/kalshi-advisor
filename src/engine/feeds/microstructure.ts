import {randomUUID} from 'node:crypto';
import {ReconnectingSocket} from './socket';

export const COINBASE_MICROSTRUCTURE_URL='wss://ws-feed.exchange.coinbase.com';
export const MICROSTRUCTURE_WINDOW_MS=30000;
export type MicrostructureLevel=[price:number,size:number];
export type MicrostructureChange=[side:'buy'|'sell',price:number,size:number];
interface EventBase {version:1;venue:'coinbase';product:'BTC-USD';sessionId:string;ordinal:number;receivedAt:number;sourceTime:number|null}
/** Only public market fields are retained; no maker/taker order identifiers. Snapshot time is genuinely absent. */
export type MicrostructureEvent=EventBase&(
  |{kind:'reset';reason:string}
  |{kind:'gap';stream:'book'|'trades'|'heartbeat'|'clock'|'ofi';reason:string}
  |{kind:'snapshot';bids:MicrostructureLevel[];asks:MicrostructureLevel[]}
  |{kind:'l2update';changes:MicrostructureChange[]}
  |{kind:'trade';tradeId:number;sequence:number|null;makerSide:'buy'|'sell';takerSide:'buy'|'sell';price:number;size:number;accepted:boolean;reason:string|null}
  |{kind:'heartbeat';lastTradeId:number;sequence:number|null;accepted:boolean}
  |{kind:'trade_baseline';tradeId:number});
type EventPayload=MicrostructureEvent extends infer E?E extends MicrostructureEvent?Omit<E,keyof EventBase>:never:never;
export interface MicrostructureSnapshot {
  venue:'coinbase';product:'BTC-USD';time:number;sessionId:string;status:string;
  bookHealthy:boolean;flowHealthy:boolean;ofiHealthy:boolean;issues:string[];
  bookSourceTime:number|null;bookReceivedAt:number|null;heartbeatSourceTime:number|null;heartbeatReceivedAt:number|null;
  tradeSourceTime:number|null;tradeReceivedAt:number|null;bookAgeMs:number|null;sourceLagMs:number|null;
  bid:number|null;ask:number|null;bidSize:number|null;askSize:number|null;mid:number|null;spreadBps:number|null;
  microprice:number|null;micropriceBps:number|null;bidDepth10:number|null;askDepth10:number|null;depthImbalance10:number|null;
  ofi30s:number|null;ofiImbalance30s:number|null;takerBuy30s:number|null;takerSell30s:number|null;
  takerNet30s:number|null;takerVolume30s:number|null;takerImbalance30s:number|null;tradeCount30s:number|null;
  bookWindowMs:number;tradeWindowMs:number;gapCount:number;rejected:number;sinkErrors:number;
  bookLevels:{bids:number;asks:number};buffered:{trades:number;ofi:number};
}
export interface MicrostructureOptions {
  onEvent?:(event:MicrostructureEvent)=>void;onStatus?:(status:string)=>void;now?:()=>number;
  /** Override is useful for a local fixture server; production needs no credentials. */
  url?:string;maxBookLevels?:number;maxWindowEvents?:number;maxSourceLagMs?:number;futureToleranceMs?:number;
  staleMs?:number;heartbeatGapGraceMs?:number;
}
type Flow={sourceTime:number;receivedAt:number;size:number;buy:boolean};
type Ofi={sourceTime:number;receivedAt:number;value:number};
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const number=(v:unknown)=>typeof v==='string'&&v.trim()!==''?Number(v):finite(v)?v:NaN;
const integer=(v:unknown)=>{const n=number(v);return Number.isSafeInteger(n)&&n>=0?n:null;};
const timestamp=(v:unknown)=>typeof v==='string'?Date.parse(v):NaN;
const imbalance=(bid:number,ask:number)=>(bid+ask)>0?(bid-ask)/(bid+ask):0;
const best=(book:Map<number,number>,buy:boolean)=>{let value:number|null=null;for(const p of book.keys())if(value===null||(buy?p>value:p<value))value=p;return value;};
const topDepth=(book:Map<number,number>,buy:boolean)=>{const top:MicrostructureLevel[]=[];for(const [p,s] of book){let i=0;while(i<top.length&&(buy?top[i][0]>p:top[i][0]<p))i++;if(i<10){top.splice(i,0,[p,s]);if(top.length>10)top.pop();}}return top.reduce((sum,l)=>sum+l[1],0);};
/** Best-quote OFI, evaluated once per atomic 50 ms batch, in BTC. Positive means pressure toward buys. */
export function quoteOfi(previous:{bid:number;ask:number;bidSize:number;askSize:number},next:{bid:number;ask:number;bidSize:number;askSize:number}){
  return (next.bid>=previous.bid?next.bidSize:0)-(next.bid<=previous.bid?previous.bidSize:0)
    -(next.ask<=previous.ask?next.askSize:0)+(next.ask>=previous.ask?previous.askSize:0);
}

/** Independent, public BTC spot research feed. No trading methods, auth, strategy weights or promotion. */
export class CoinbaseMicrostructureFeed {
  private readonly now:()=>number;private readonly maxBookLevels:number;private readonly maxWindowEvents:number;
  private readonly staleMs:number;private readonly maxSourceLagMs:number;private readonly futureToleranceMs:number;private readonly heartbeatGapGraceMs:number;
  private socket?:ReconnectingSocket;private running=false;private generation=0;
  private status='idle';private sessionId=randomUUID();private ordinal=0;
  private bids=new Map<number,number>();private asks=new Map<number,number>();private bid:number|null=null;private ask:number|null=null;
  private synced=false;private bookSourceTime:number|null=null;private bookReceivedAt:number|null=null;private bookSince:number|null=null;
  private heartbeatSourceTime:number|null=null;private heartbeatReceivedAt:number|null=null;
  private tradeSourceTime:number|null=null;private tradeReceivedAt:number|null=null;private tradeSince:number|null=null;private lastTradeId:number|null=null;
  private heartbeatAhead:{id:number;since:number}|null=null;private lastReceivedAt:number|null=null;
  private trades:Flow[]=[];private ofi:Ofi[]=[];private gapCount=0;private rejected=0;private sinkErrors=0;
  constructor(private options:MicrostructureOptions={}){
    this.now=options.now??Date.now;this.maxBookLevels=options.maxBookLevels??50000;this.maxWindowEvents=options.maxWindowEvents??20000;
    this.staleMs=options.staleMs??3000;this.maxSourceLagMs=options.maxSourceLagMs??3000;this.futureToleranceMs=options.futureToleranceMs??500;this.heartbeatGapGraceMs=options.heartbeatGapGraceMs??1000;
    for(const v of [this.maxBookLevels,this.maxWindowEvents])if(!Number.isSafeInteger(v)||v<1)throw new Error('Invalid microstructure memory limit');
    for(const v of [this.staleMs,this.maxSourceLagMs,this.futureToleranceMs,this.heartbeatGapGraceMs])if(!Number.isFinite(v)||v<0)throw new Error('Invalid microstructure time limit');
  }
  private notify(status:string){try{this.options.onStatus?.(status);}catch{/* A UI callback cannot break feed processing. */}}
  private emit(payload:EventPayload,receivedAt:number,sourceTime:number|null=null){
    const event={version:1 as const,venue:'coinbase' as const,product:'BTC-USD' as const,sessionId:this.sessionId,ordinal:++this.ordinal,receivedAt,sourceTime,...payload} as MicrostructureEvent;
    try{this.options.onEvent?.(event);}catch{this.sinkErrors++;this.notify('event sink failed');}
  }
  private clear(){
    this.bids.clear();this.asks.clear();this.bid=null;this.ask=null;this.synced=false;this.bookSourceTime=null;this.bookReceivedAt=null;this.bookSince=null;
    this.heartbeatSourceTime=null;this.heartbeatReceivedAt=null;this.tradeSourceTime=null;this.tradeReceivedAt=null;this.tradeSince=null;this.lastTradeId=null;this.heartbeatAhead=null;this.lastReceivedAt=null;this.trades=[];this.ofi=[];
  }
  private begin(status:string,time:number){this.clear();this.sessionId=randomUUID();this.ordinal=0;this.status=status;this.emit({kind:'reset',reason:status},time);}
  start(){
    if(this.running)return;this.running=true;const generation=++this.generation;
    this.socket=new ReconnectingSocket(this.options.url??COINBASE_MICROSTRUCTURE_URL,
      ()=>[{type:'subscribe',product_ids:['BTC-USD'],channels:['level2_batch','matches','heartbeat']}],
      message=>{if(this.running&&this.generation===generation)this.handle(message,this.now());},
      status=>{if(!this.running||this.generation!==generation)return;
        if(status==='connecting')this.begin('connecting',this.now());
        else if(status==='connected')this.status='connected';
        else if(status==='disconnected'||status==='connection error'||status==='connection failed'){this.clear();this.status='disconnected';this.emit({kind:'reset',reason:status},this.now());}
        this.notify(status);
      },undefined,{pingMs:1000});
    this.socket.start();
  }
  stop(){this.running=false;this.generation++;this.socket?.stop();this.socket=undefined;this.clear();this.status='stopped';this.emit({kind:'reset',reason:'stopped'},this.now());this.notify('stopped');}
  restart(){this.stop();this.start();}
  private gap(stream:'book'|'trades'|'heartbeat'|'clock'|'ofi',reason:string,time:number,sourceTime:number|null=null){
    this.gapCount++;this.emit({kind:'gap',stream,reason},time,sourceTime);
    if(stream==='trades'){this.trades=[];this.tradeSince=time;this.heartbeatAhead=null;}
    else if(stream==='heartbeat'){this.heartbeatSourceTime=null;this.heartbeatReceivedAt=null;this.trades=[];this.tradeSince=time;this.ofi=[];this.bookSince=time;}
    else if(stream==='ofi'){this.ofi=[];this.bookSince=time;}
    else {this.clear();this.status=this.running?'resyncing':'replaying';this.socket?.socket?.terminate();}
    this.notify(`${stream}: ${reason}`);
  }
  private validTime(sourceTime:number,receivedAt:number){return Number.isFinite(sourceTime)&&sourceTime>0&&sourceTime<=receivedAt+this.futureToleranceMs&&receivedAt-sourceTime<=this.maxSourceLagMs;}
  private quote(){return this.bid===null||this.ask===null?null:{bid:this.bid,ask:this.ask,bidSize:this.bids.get(this.bid)!,askSize:this.asks.get(this.ask)!};}
  private prune(now:number){const cutoff=now-MICROSTRUCTURE_WINDOW_MS;this.trades=this.trades.filter(t=>t.sourceTime>cutoff&&t.receivedAt<=now);this.ofi=this.ofi.filter(t=>t.sourceTime>cutoff&&t.receivedAt<=now);}
  private checkHeartbeatGap(now:number){if(this.heartbeatAhead&&now-this.heartbeatAhead.since>=this.heartbeatGapGraceMs){const id=this.heartbeatAhead.id;this.gap('trades','heartbeat reports missing trades',now);this.lastTradeId=id;}}
  /** Direct calls support deterministic fixtures/replay; normal live use is start/stop. Unknown channels are ignored. */
  handle(message:unknown,receivedAt=this.now()){
    if(!finite(receivedAt)||receivedAt<0||this.status==='stopped'||message===null||typeof message!=='object')return;
    if(this.status==='idle')this.begin('replaying',receivedAt);
    const m=message as Record<string,unknown>;if(m.type==='error'){this.rejected++;this.gap('book','subscription error',receivedAt);return;}
    if(m.product_id!=='BTC-USD'||!['snapshot','l2update','match','last_match','heartbeat'].includes(String(m.type)))return;
    if(this.lastReceivedAt!==null&&receivedAt<this.lastReceivedAt){this.rejected++;this.gap('clock','receive clock moved backwards',receivedAt);return;}this.lastReceivedAt=receivedAt;
    this.checkHeartbeatGap(receivedAt);this.prune(receivedAt);
    if(m.type==='snapshot'){
      const parse=(raw:unknown):MicrostructureLevel[]|null=>{
        if(!Array.isArray(raw)||raw.length===0||raw.length>this.maxBookLevels)return null;const result:MicrostructureLevel[]=[],prices=new Set<number>();
        for(const pair of raw){if(!Array.isArray(pair)||pair.length!==2)return null;const p=number(pair[0]),s=number(pair[1]);if(!(p>0)||!(s>0)||!Number.isFinite(p)||!Number.isFinite(s)||prices.has(p))return null;prices.add(p);result.push([p,s]);}return result;
      };
      const bids=parse(m.bids),asks=parse(m.asks);if(!bids||!asks){this.rejected++;this.gap('book','invalid or oversized snapshot',receivedAt);return;}
      const bidMap=new Map(bids),askMap=new Map(asks),bid=best(bidMap,true)!,ask=best(askMap,false)!;
      if(bid>=ask){this.rejected++;this.gap('book','crossed snapshot',receivedAt);return;}
      this.bids=bidMap;this.asks=askMap;this.bid=bid;this.ask=ask;this.synced=true;this.bookSince=receivedAt;this.bookReceivedAt=receivedAt;this.bookSourceTime=null;this.ofi=[];
      // The Exchange snapshot has no event time. Never substitute receipt time as the source timestamp.
      this.emit({kind:'snapshot',bids,asks},receivedAt);return;
    }
    if(m.type==='last_match'){
      const id=integer(m.trade_id);if(id===null){this.rejected++;return;}
      if(this.lastTradeId===null){this.lastTradeId=id;this.tradeSince=receivedAt;this.emit({kind:'trade_baseline',tradeId:id},receivedAt,Number.isFinite(timestamp(m.time))?timestamp(m.time):null);}return;
    }
    const sourceTime=timestamp(m.time);
    if(!this.validTime(sourceTime,receivedAt)){
      this.rejected++;this.gap(m.type==='l2update'?'book':m.type==='heartbeat'?'heartbeat':'trades','invalid, future or delayed source time',receivedAt,Number.isFinite(sourceTime)?sourceTime:null);return;
    }
    if(m.type==='heartbeat'){
      const id=integer(m.last_trade_id);if(id===null){this.rejected++;this.gap('heartbeat','invalid heartbeat trade ID',receivedAt,sourceTime);return;}
      if(this.heartbeatSourceTime!==null&&sourceTime<this.heartbeatSourceTime){this.rejected++;this.emit({kind:'heartbeat',lastTradeId:id,sequence:integer(m.sequence),accepted:false},receivedAt,sourceTime);return;}
      if(this.heartbeatReceivedAt!==null&&receivedAt-this.heartbeatReceivedAt>this.staleMs)this.gap('heartbeat','heartbeat continuity lost',receivedAt,sourceTime);
      this.heartbeatSourceTime=sourceTime;this.heartbeatReceivedAt=receivedAt;
      if(this.lastTradeId===null){this.lastTradeId=id;this.tradeSince=receivedAt;}
      else if(id>this.lastTradeId){if(!this.heartbeatAhead)this.heartbeatAhead={id,since:receivedAt};else this.heartbeatAhead.id=Math.max(this.heartbeatAhead.id,id);}
      this.emit({kind:'heartbeat',lastTradeId:id,sequence:integer(m.sequence),accepted:true},receivedAt,sourceTime);return;
    }
    if(m.type==='match'){
      const id=integer(m.trade_id),price=number(m.price),size=number(m.size),side=m.side;
      if(id===null||!(price>0)||!(size>0)||!Number.isFinite(price)||!Number.isFinite(size)||(side!=='buy'&&side!=='sell')){this.rejected++;this.gap('trades','invalid trade',receivedAt,sourceTime);return;}
      const event={kind:'trade' as const,tradeId:id,sequence:integer(m.sequence),makerSide:side as 'buy'|'sell',takerSide:side==='sell'?'buy' as const:'sell' as const,price,size};
      if(this.lastTradeId!==null&&id<=this.lastTradeId){this.emit({...event,accepted:false,reason:'duplicate or old trade ID'},receivedAt,sourceTime);return;}
      if(this.tradeSourceTime!==null&&sourceTime<this.tradeSourceTime){this.rejected++;this.gap('trades','out-of-order trade time',receivedAt,sourceTime);this.lastTradeId=id;this.emit({...event,accepted:false,reason:'out-of-order trade time'},receivedAt,sourceTime);return;}
      if(this.lastTradeId!==null&&id!==this.lastTradeId+1)this.gap('trades','trade ID gap',receivedAt,sourceTime);
      if(this.tradeSince===null)this.tradeSince=receivedAt;
      this.lastTradeId=id;this.tradeSourceTime=sourceTime;this.tradeReceivedAt=receivedAt;
      if(this.heartbeatAhead&&id>=this.heartbeatAhead.id)this.heartbeatAhead=null;
      if(this.trades.length>=this.maxWindowEvents)this.gap('trades','trade window capacity exceeded',receivedAt,sourceTime);
      this.trades.push({sourceTime,receivedAt,size,buy:side==='sell'});this.emit({...event,accepted:true,reason:null},receivedAt,sourceTime);return;
    }
    if(!this.synced){this.rejected++;return;}
    if(this.bookSourceTime!==null&&sourceTime<this.bookSourceTime){this.rejected++;this.gap('book','out-of-order book time',receivedAt,sourceTime);return;}
    if(!Array.isArray(m.changes)||m.changes.length>2*this.maxBookLevels){this.rejected++;this.gap('book','invalid or oversized update',receivedAt,sourceTime);return;}
    const changes:MicrostructureChange[]=[];
    for(const row of m.changes){if(!Array.isArray(row)||row.length!==3){this.rejected++;this.gap('book','invalid update',receivedAt,sourceTime);return;}
      const [side,p,s]=row,price=number(p),size=number(s);if((side!=='buy'&&side!=='sell')||!(price>0)||size<0||!Number.isFinite(price)||!Number.isFinite(size)){this.rejected++;this.gap('book','invalid price or size',receivedAt,sourceTime);return;}changes.push([side,price,size]);}
    const previous=this.quote()!;
    for(const [side,price,size] of changes){const book=side==='buy'?this.bids:this.asks;if(size===0)book.delete(price);else book.set(price,size);
      if(side==='buy'&&(this.bid===null||price>this.bid)&&size>0)this.bid=price;
      if(side==='sell'&&(this.ask===null||price<this.ask)&&size>0)this.ask=price;}
    if(this.bid===null||!this.bids.has(this.bid))this.bid=best(this.bids,true);if(this.ask===null||!this.asks.has(this.ask))this.ask=best(this.asks,false);
    if(this.bid===null||this.ask===null||this.bid>=this.ask||this.bids.size>this.maxBookLevels||this.asks.size>this.maxBookLevels){this.rejected++;this.gap('book','empty, crossed or oversized book',receivedAt,sourceTime);return;}
    if(this.bookReceivedAt!==null&&receivedAt-this.bookReceivedAt>this.staleMs)this.gap('ofi','book update continuity lost',receivedAt,sourceTime);
    this.bookSourceTime=sourceTime;this.bookReceivedAt=receivedAt;
    if(this.ofi.length>=this.maxWindowEvents)this.gap('ofi','OFI window capacity exceeded',receivedAt,sourceTime);
    this.ofi.push({sourceTime,receivedAt,value:quoteOfi(previous,this.quote()!)});this.emit({kind:'l2update',changes},receivedAt,sourceTime);
  }
  snapshot(now=this.now()):MicrostructureSnapshot {
    const validNow=Number.isFinite(now)&&now>=0&&(this.lastReceivedAt===null||now>=this.lastReceivedAt);
    if(validNow){this.checkHeartbeatGap(now);this.prune(now);}
    const fresh=(t:number|null,max=this.staleMs)=>validNow&&t!==null&&now-t>=-this.futureToleranceMs&&now-t<=max;
    const connected=this.status==='connected'||this.status==='replaying',heartbeatHealthy=connected&&fresh(this.heartbeatReceivedAt)&&fresh(this.heartbeatSourceTime,this.maxSourceLagMs);
    const bookHealthy=heartbeatHealthy&&this.synced&&fresh(this.bookReceivedAt)&&fresh(this.bookSourceTime,this.maxSourceLagMs);
    const bookWindowMs=this.bookSince===null?0:Math.max(0,Math.min(MICROSTRUCTURE_WINDOW_MS,now-this.bookSince));
    const tradeWindowMs=this.tradeSince===null?0:Math.max(0,Math.min(MICROSTRUCTURE_WINDOW_MS,now-this.tradeSince));
    const ofiHealthy=bookHealthy&&bookWindowMs>=MICROSTRUCTURE_WINDOW_MS;
    const flowHealthy=heartbeatHealthy&&this.heartbeatAhead===null&&tradeWindowMs>=MICROSTRUCTURE_WINDOW_MS;
    const issues:string[]=[];if(!connected)issues.push('not connected');if(!validNow)issues.push('invalid snapshot clock');if(!this.synced)issues.push('waiting for snapshot');
    if(this.synced&&this.bookSourceTime===null)issues.push('snapshot source timestamp unavailable; waiting for timed update');
    if(!heartbeatHealthy)issues.push('heartbeat stale or unavailable');if(!bookHealthy)issues.push('book unavailable or stale');if(!ofiHealthy)issues.push('OFI window incomplete');if(!flowHealthy)issues.push('trade window incomplete or gap');if(this.sinkErrors)issues.push('event sink has failed');
    const q=bookHealthy?this.quote():null,mid=q?(q.bid+q.ask)/2:null,microprice=q?(q.ask*q.bidSize+q.bid*q.askSize)/(q.bidSize+q.askSize):null;
    const bidDepth=q?topDepth(this.bids,true):null,askDepth=q?topDepth(this.asks,false):null;
    const ofi=this.ofi.reduce((s,r)=>s+r.value,0),absoluteOfi=this.ofi.reduce((s,r)=>s+Math.abs(r.value),0);
    const buy=this.trades.reduce((s,t)=>s+(t.buy?t.size:0),0),sell=this.trades.reduce((s,t)=>s+(t.buy?0:t.size),0);
    return {venue:'coinbase',product:'BTC-USD',time:now,sessionId:this.sessionId,status:this.status,bookHealthy,flowHealthy,ofiHealthy,issues,
      bookSourceTime:this.bookSourceTime,bookReceivedAt:this.bookReceivedAt,heartbeatSourceTime:this.heartbeatSourceTime,heartbeatReceivedAt:this.heartbeatReceivedAt,tradeSourceTime:this.tradeSourceTime,tradeReceivedAt:this.tradeReceivedAt,
      bookAgeMs:this.bookReceivedAt===null?null:Math.max(0,now-this.bookReceivedAt),sourceLagMs:this.bookSourceTime===null||this.bookReceivedAt===null?null:this.bookReceivedAt-this.bookSourceTime,
      bid:q?.bid??null,ask:q?.ask??null,bidSize:q?.bidSize??null,askSize:q?.askSize??null,mid,spreadBps:q?(q.ask-q.bid)/mid!*10000:null,microprice,micropriceBps:microprice===null?null:(microprice-mid!)/mid!*10000,
      bidDepth10:bidDepth,askDepth10:askDepth,depthImbalance10:bidDepth===null||askDepth===null?null:imbalance(bidDepth,askDepth),
      ofi30s:ofiHealthy?ofi:null,ofiImbalance30s:ofiHealthy?(absoluteOfi?ofi/absoluteOfi:0):null,takerBuy30s:flowHealthy?buy:null,takerSell30s:flowHealthy?sell:null,
      takerNet30s:flowHealthy?buy-sell:null,takerVolume30s:flowHealthy?buy+sell:null,takerImbalance30s:flowHealthy?imbalance(buy,sell):null,tradeCount30s:flowHealthy?this.trades.length:null,
      bookWindowMs,tradeWindowMs,gapCount:this.gapCount,rejected:this.rejected,sinkErrors:this.sinkErrors,bookLevels:{bids:this.bids.size,asks:this.asks.size},buffered:{trades:this.trades.length,ofi:this.ofi.length}};
  }
}
