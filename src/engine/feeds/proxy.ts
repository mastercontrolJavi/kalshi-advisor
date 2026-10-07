import {ReconnectingSocket} from './socket';
import type {Sample} from '../model/math';
export interface Venue {name:string;mid:number|null;spread:number|null;updated:number;lag:number|null;status:string}
export function median(values:number[]){const s=[...values].sort((a,b)=>a-b);return s.length?s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2:null;}
export function healthy(v:Venue,now:number,staleMs=2000){return v.status==='connected'&&v.mid!==null&&now-v.updated<=staleMs&&now-v.updated>=0;}
export class ProxyFeed {
  venues:Record<string,Venue>={};history:Sample[]=[];private sockets:ReconnectingSocket[]=[];
  constructor(private log:(event:string,data:unknown)=>void=()=>{}){}
  private add(name:string,url:string,subscribe:()=>unknown[],parse:(m:any)=>[number,number,number|null]|null){
    const venue=this.venues[name]={name,mid:null,spread:null,updated:0,lag:null,status:'disconnected'};
    this.sockets.push(new ReconnectingSocket(url,subscribe,m=>{const p=parse(m);if(!p)return;const [bid,ask,ts]=p;if(!Number.isFinite(bid)||!Number.isFinite(ask)||bid<=0||ask<bid)return;venue.mid=(bid+ask)/2;venue.spread=ask-bid;venue.updated=Date.now();venue.lag=ts===null?null:Math.max(0,Date.now()-ts);},status=>{venue.status=status;this.log('feed-status',{name,status});}));
  }
  start(){
    this.add('Coinbase','wss://ws-feed.exchange.coinbase.com',()=>[{type:'subscribe',product_ids:['BTC-USD'],channels:['ticker','heartbeat']}],m=>m.type==='ticker'?[+m.best_bid,+m.best_ask,Date.parse(m.time)]:null);
    this.add('Kraken','wss://ws.kraken.com/v2',()=>[{method:'subscribe',params:{channel:'ticker',symbol:['BTC/USD'],event_trigger:'bbo',snapshot:true}}],m=>m.channel==='ticker'&&m.data?.[0]?[+m.data[0].bid,+m.data[0].ask,Date.parse(m.data[0].timestamp)]:null);
    this.add('Bitstamp','wss://ws.bitstamp.net',()=>[{event:'bts:subscribe',data:{channel:'order_book_btcusd'}}],m=>m.event==='data'&&m.data?.bids?.length&&m.data?.asks?.length?[+m.data.bids[0][0],+m.data.asks[0][0],m.data.microtimestamp?+m.data.microtimestamp/1000:+m.data.timestamp*1000]:null);
    this.add('Gemini','wss://ws.gemini.com',()=>[{method:'subscribe',params:['btcusd@bookTicker'],id:1}],m=>{const d=m.data??m;return d.s==='btcusd'&&d.b&&d.a?[+d.b,+d.a,d.E?+d.E/1e6:null]:null;});
    for(const s of this.sockets)s.start();
  }
  sample(time:number,staleMs=2000){
    const price=median(Object.values(this.venues).filter(v=>healthy(v,Date.now(),staleMs)).map(v=>v.mid!));
    if(price!==null && this.history.at(-1)?.time!==time)this.history.push({time,price});
    this.history=this.history.filter(s=>s.time>time-7200000);return price;
  }
  restart(){for(const v of Object.values(this.venues)){v.updated=0;v.mid=null;}for(const s of this.sockets)s.restart();}
  stop(){for(const s of this.sockets)s.stop();}
}
