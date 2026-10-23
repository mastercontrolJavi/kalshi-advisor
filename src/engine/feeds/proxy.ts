import {ReconnectingSocket} from './socket';
import type {Sample} from '../model/math';
import {FeedDelay} from './orderbook';
/** delay: how far behind the exchange's own timestamps this feed runs (FeedDelay), see ProxyFeed.delay. */
export interface Venue {name:string;mid:number|null;spread:number|null;updated:number;alive:number;lag:number|null;status:string;delay:number}
export function median(values:number[]){const s=[...values].sort((a,b)=>a-b);return s.length?s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2:null;}
/**
 * Venues push quotes only when their book/trades change, so a quiet quote is not a stale one.
 * Healthy = connected, link alive (any frame or pong) within staleMs, and the last quote no older than maxQuoteMs.
 * Pings run every second, so a dead link is still detected within ~2 s.
 */
export function healthy(v:Venue,now:number,staleMs=2000,maxQuoteMs=15000){return v.status==='connected'&&v.mid!==null&&now-v.alive<=staleMs&&now-v.updated<=maxQuoteMs&&now-v.updated>=0;}
/** Venue symbols per coin. Every Kalshi 15-minute crypto series settles on the CF Benchmarks RTI for its coin (checked 2026-10-10). */
export const COINS={BTC:{coinbase:'BTC-USD',kraken:'BTC/USD',bitstamp:'btcusd',gemini:'btcusd'},ETH:{coinbase:'ETH-USD',kraken:'ETH/USD',bitstamp:'ethusd',gemini:'ethusd'},
  SOL:{coinbase:'SOL-USD',kraken:'SOL/USD',bitstamp:'solusd',gemini:'solusd'},XRP:{coinbase:'XRP-USD',kraken:'XRP/USD',bitstamp:'xrpusd',gemini:'xrpusd'},DOGE:{coinbase:'DOGE-USD',kraken:'DOGE/USD',bitstamp:'dogeusd',gemini:'dogeusd'}} as const;
export type Coin=keyof typeof COINS;
export class ProxyFeed {
  venues:Record<string,Venue>={};history:Sample[]=[];private sockets:ReconnectingSocket[]=[];private delays=new Map<string,FeedDelay>();
  constructor(private log:(event:string,data:unknown)=>void=()=>{},private coin:Coin='BTC'){}
  // sent: the exchange's send time for any message (Coinbase stamps its 1-s heartbeats too); defaults to the quote's time.
  private add(name:string,url:string,subscribe:()=>unknown[],parse:(m:any)=>[number,number,number|null]|null,sent?:(m:any)=>number|null){
    const venue:Venue=this.venues[name]={name,mid:null,spread:null,updated:0,alive:0,lag:null,status:'disconnected',delay:0},delay=new FeedDelay();this.delays.set(name,delay);
    this.sockets.push(new ReconnectingSocket(url,subscribe,m=>this.handle(venue,parse(m),sent?.(m)??null),status=>{venue.status=status;if(status==='connecting')delay.reset();this.log('feed-status',{name,status});},undefined,{pingMs:1000,onAlive:()=>{venue.alive=Date.now();}}));
  }
  handle(venue:Venue,p:[number,number,number|null]|null,sent:number|null,now=Date.now()){
    const delay=this.delays.get(venue.name);const ts=sent??p?.[2]??null;
    if(delay&&ts!==null&&Number.isFinite(ts)){delay.observe(ts,now);venue.delay=delay.ms;}
    if(!p)return;const [bid,ask,quoteTs]=p;if(!Number.isFinite(bid)||!Number.isFinite(ask)||bid<=0||ask<bid)return;venue.mid=(bid+ask)/2;venue.spread=ask-bid;venue.updated=now;venue.lag=quoteTs===null?null:Math.max(0,now-quoteTs);
  }
  /**
   * How far behind each exchange feed runs right now, and their median. A late message only shows its lateness when it
   * arrives, so a link that has gone quiet also counts as behind by its silence: every venue is pinged each second, so
   * no frame or pong for longer than that means at least that much delay. Only connected venues count.
   */
  delay(now=Date.now()){
    const each=Object.values(this.venues).filter(v=>v.status==='connected'&&v.alive>0).map(v=>({name:v.name,ms:Math.max(v.delay,now-v.alive-1000,0)}));
    return {median:median(each.map(v=>v.ms)),coinbase:each.find(v=>v.name==='Coinbase')?.ms??null,each};
  }
  start(){
    const c=COINS[this.coin];
    this.add('Coinbase','wss://ws-feed.exchange.coinbase.com',()=>[{type:'subscribe',product_ids:[c.coinbase],channels:['ticker','heartbeat']}],m=>m.type==='ticker'?[+m.best_bid,+m.best_ask,Date.parse(m.time)]:null,m=>(m.type==='ticker'||m.type==='heartbeat')&&m.time?Date.parse(m.time):null);
    this.add('Kraken','wss://ws.kraken.com/v2',()=>[{method:'subscribe',params:{channel:'ticker',symbol:[c.kraken],event_trigger:'bbo',snapshot:true}}],m=>m.channel==='ticker'&&m.data?.[0]?[+m.data[0].bid,+m.data[0].ask,Date.parse(m.data[0].timestamp)]:null);
    this.add('Bitstamp','wss://ws.bitstamp.net',()=>[{event:'bts:subscribe',data:{channel:'order_book_'+c.bitstamp}}],m=>m.event==='data'&&m.data?.bids?.length&&m.data?.asks?.length?[+m.data.bids[0][0],+m.data.asks[0][0],m.data.microtimestamp?+m.data.microtimestamp/1000:+m.data.timestamp*1000]:null);
    this.add('Gemini','wss://ws.gemini.com',()=>[{method:'subscribe',params:[c.gemini+'@bookTicker'],id:1}],m=>{const d=m.data??m;return d.s===c.gemini&&d.b&&d.a?[+d.b,+d.a,d.E?+d.E/1e6:null]:null;});
    for(const s of this.sockets)s.start();
  }
  sample(time:number,staleMs=2000){
    const price=median(Object.values(this.venues).filter(v=>healthy(v,Date.now(),staleMs)).map(v=>v.mid!));
    if(price!==null && this.history.at(-1)?.time!==time){this.history.push({time,price});this.history=this.history.filter(s=>s.time>time-7200000);}
    return price;
  }
  restart(){for(const v of Object.values(this.venues)){v.updated=0;v.mid=null;}for(const s of this.sockets)s.restart();}
  stop(){for(const s of this.sockets)s.stop();}
}
