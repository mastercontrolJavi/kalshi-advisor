import {constants,createPrivateKey,sign,type KeyObject} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {ReconnectingSocket} from './socket';
import {Orderbook,SubscriptionSequence,FeedDelay} from './orderbook';
import {baseFees,type FeeSchedule} from '../model/fees';
export const REST='https://external-api.kalshi.com/trade-api/v2';
export const WS='wss://external-api-ws.kalshi.com/trade-api/ws/v2';
export const bookPrice=(side:'yes'|'no',yesPrice:number)=>side==='no'?1-yesPrice:yesPrice;
export function effectiveFees(series:any,changes:any[],event:string,now:number):FeeSchedule {
  const change=changes.filter(c=>c.event_ticker===event&&Date.parse(c.scheduled_ts)<=now).sort((a,b)=>Date.parse(b.scheduled_ts)-Date.parse(a.scheduled_ts))[0];
  const type=change?.fee_type_override??series.fee_type,m=Number(change?.fee_multiplier_override??series.fee_multiplier??1);
  // Combo series (quadratic_with_combo_maker_fees) charge the same quadratic taker fee; verified on a real fill (2,777.77 at 0.33¢ paid $0.639559).
  const quadratic=['quadratic','quadratic_with_maker_fees','quadratic_with_combo_maker_fees'];
  return {...baseFees,takerMultiplier:m,makerMultiplier:type==='quadratic_with_maker_fees'||type==='quadratic_with_combo_maker_fees'?m:0,verified:quadratic.includes(type)&&Number.isFinite(m)&&m>=0};
}
export function signedHeaders(key:KeyObject,id:string,path:string,timestamp:number){
  const ts=String(Math.round(timestamp));
  const text=Buffer.from(ts+'GET'+path.split('?')[0]);
  const signature=key.asymmetricKeyType==='ed25519'?sign(null,text,key):sign('sha256',text,{key,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32});
  return {'KALSHI-ACCESS-KEY':id,'KALSHI-ACCESS-TIMESTAMP':ts,'KALSHI-ACCESS-SIGNATURE':signature.toString('base64')};
}
export interface Market {ticker:string;event_ticker:string;open_time:string;close_time:string;floor_strike?:number;status:string;result?:string;expiration_value?:string;rules_primary?:string;rules_secondary?:string;price_ranges?:{start:string;end:string;step:string}[]}
export class KalshiClient {
  private key?:KeyObject;clockOffset=0;clockSynced=false;private tail:Promise<unknown>=Promise.resolve();limits:unknown=null;
  constructor(private id=process.env.KALSHI_API_KEY_ID??'',private keyPath=process.env.KALSHI_PRIVATE_KEY_PATH??'',private spacingMs=100){
    if(id&&keyPath&&existsSync(keyPath)){this.key=createPrivateKey(readFileSync(keyPath));if(!['rsa','ed25519'].includes(this.key.asymmetricKeyType??''))throw new Error('Kalshi keys must be Ed25519 or RSA PEM');}
  }
  get authenticated(){return !!this.key&&!!this.id;}
  headers(path:string){if(!this.key)throw new Error('Kalshi key unavailable');return signedHeaders(this.key,this.id,path,Date.now()+this.clockOffset);}
  get(path:string,auth=false):Promise<any>{
    if(!path.startsWith('/')||path.startsWith('//')||path.includes('://'))throw new Error('Invalid Kalshi API path');
    const run=async()=>{
      for(let attempt=0;attempt<5;attempt++){
        if(auth&&!this.clockSynced)throw new Error('Server clock not synchronized');
        const started=Date.now();
        const response=await fetch(REST+path,{headers:auth?this.headers('/trade-api/v2'+path):{},redirect:'error',signal:AbortSignal.timeout(10000)});
        const server=response.headers.get('date');if(server){const offset=Date.parse(server)+500-(started+Date.now())/2;if(!this.clockSynced||Math.abs(offset-this.clockOffset)>2000)this.clockOffset=offset;this.clockSynced=Number.isFinite(this.clockOffset);}
        if(response.status===429){await new Promise(r=>setTimeout(r,Math.min(8000,300*2**attempt)));continue;}
        if(!response.ok)throw new Error(`Kalshi GET ${path.split('?')[0]}: HTTP ${response.status}`);
        return response.json();
      }throw new Error('Kalshi rate limit exhausted retries');
    };
    const task=this.tail.then(run,run);this.tail=task.catch(()=>{}).then(()=>new Promise(r=>setTimeout(r,this.spacingMs)));return task;
  }
  async pages(path:string,field:string){const result:any[]=[];let cursor='';const seen=new Set<string>();do{const page=await this.get(path+(path.includes('?')?'&':'?')+'limit=1000'+(cursor?'&cursor='+encodeURIComponent(cursor):''),true);result.push(...(page[field]??[]));cursor=page.cursor??'';if(cursor&&seen.has(cursor))throw new Error('Repeated pagination cursor');seen.add(cursor);}while(cursor);return result;}
  async schedule(event:string):Promise<FeeSchedule>{
    const {series}=await this.get('/series/KXBTC15M');let cursor='';const changes:any[]=[];
    do {const page=await this.get('/events/fee_changes?limit=1000'+(cursor?'&cursor='+encodeURIComponent(cursor):''));changes.push(...(page.event_fee_changes??[]));cursor=page.cursor??'';}while(cursor);
    return effectiveFees(series,changes,event,Date.now()+this.clockOffset);
  }
}
export class KalshiFeed {
  markets:Market[]=[];books=new Map<string,Orderbook>();status='disconnected';lag:number|null=null;lastMessage=0;fees:FeeSchedule={...baseFees,verified:false};
  trades:{ticker:string;time:number;yesPrice:number;count:number;takerSide:string}[]=[];delay=new FeedDelay();
  private socket?:ReconnectingSocket;private generation=0;private pruned=0;private bookSid:number|null=null;private sequence=new SubscriptionSequence();private signature='';private refreshing=false;private polling=false;private feesUpdated=0;
  constructor(public client:KalshiClient,private log:(event:string,data:unknown)=>void,private onTrade:(t:any)=>void=()=>{},private onFill:()=>void=()=>{}){}
  async refresh(){
    if(this.refreshing)return;this.refreshing=true;
    try{
      // Ask for markets closing within the next hour: the current one and the next few. status=unopened returns the
      // furthest-future markets first (a day ahead), so the very next round was often missing from its first page.
      const now=Date.now()+this.client.clockOffset,from=Math.floor(now/1000);
      // Look 6 h ahead while nothing is open (Kalshi closes Thursdays 3–5 AM ET), so the next round is known in advance.
      const ahead=this.markets.some(m=>Date.parse(m.close_time)>now)?3600:6*3600;
      const {markets:windowed}=await this.client.get(`/markets?series_ticker=KXBTC15M&min_close_ts=${from}&max_close_ts=${from+ahead}&limit=100`);
      // Keep markets we already know until they close: around the open Kalshi briefly lists the new market as neither
      // 'open' nor 'unopened', and replacing the list dropped the live market for 12–28 s at 3 of 7 rollovers.
      const unique=new Map<string,Market>();for(const m of [...this.markets,...windowed])unique.set(m.ticker,m);
      this.markets=[...unique.values()].filter((m:Market)=>Date.parse(m.close_time)>now).sort((a:Market,b:Market)=>Date.parse(a.open_time)-Date.parse(b.open_time)).slice(0,2);
      const sig=this.markets.map(m=>m.ticker).join(',');
      if(sig!==this.signature){this.signature=sig;for(const m of this.markets){this.books.set(m.ticker,new Orderbook());this.log('market-discovered',m);}this.fees.verified=false;this.feesUpdated=0;this.connect();}
      if(this.markets[0]&&Date.now()-this.feesUpdated>30000){try{this.fees=await this.client.schedule(this.markets[0].event_ticker);this.feesUpdated=Date.now();}catch(e){this.fees.verified=false;throw e;}}
    }finally{this.refreshing=false;}
  }
  private connect(){
    this.socket?.stop();const generation=++this.generation;this.bookSid=null;this.sequence.reset();this.delay.reset();
    this.status=this.client.authenticated?'connecting':'REST fallback — missing credentials';
    if(!this.client.authenticated||!this.markets.length)return;
    const tickers=this.markets.map(m=>m.ticker);
    const subscribe=()=>[{id:1,cmd:'subscribe',params:{channels:['orderbook_delta'],market_tickers:tickers,use_yes_price:true}},{id:2,cmd:'subscribe',params:{channels:['ticker','trade'],market_tickers:tickers}},{id:3,cmd:'subscribe',params:{channels:['fill']}}];
    this.socket=new ReconnectingSocket(WS,subscribe,m=>{if(generation===this.generation)this.handle(m);},status=>{
      if(generation!==this.generation)return;
      this.status=status;if(status!=='connected'){for(const b of this.books.values())b.valid=false;this.bookSid=null;this.sequence.reset();}this.log('kalshi-status',{status});
    },()=>this.client.headers('/trade-api/ws/v2'));
    this.socket.start();
  }
  handle(m:any){
    this.lastMessage=Date.now();this.lag=m.sending_ts_ms?Math.max(0,Date.now()+this.client.clockOffset-m.sending_ts_ms):null;this.delay.observe(m.sending_ts_ms,this.lastMessage);
    const d=m.msg??{};const book=this.books.get(d.market_ticker);
    if(m.type==='error'){this.log('kalshi-ws-error',d);this.status='subscription error';return;}
    if(m.type==='subscribed'&&d.channel==='orderbook_delta')this.bookSid=d.sid;
    if(this.bookSid!==null&&m.sid===this.bookSid&&Number.isFinite(m.seq)&&!this.sequence.accept(m.sid,m.seq)){this.log('book-gap',{sid:m.sid,seq:m.seq,ticker:d.market_ticker});this.recover();return;}
    if(m.type==='orderbook_snapshot'&&book)book.snapshot(d.yes_dollars_fp??[],(d.no_dollars_fp??[]).map(([p,q]:string[])=>[String(bookPrice('no',Number(p))),q]));
    if(m.type==='orderbook_delta'&&book&&!book.delta(d.side,bookPrice(d.side,Number(d.price_dollars)),Number(d.delta_fp))){this.log('book-invalid',{ticker:d.market_ticker,seq:m.seq});this.recover();return;}
    if(m.type==='trade'){const t={ticker:d.market_ticker,time:d.ts_ms??d.ts*1000,yesPrice:Number(d.yes_price_dollars),count:Number(d.count_fp),takerSide:d.taker_outcome_side??d.taker_side};this.trades.push(t);
      // Keep 2 min of trades, pruned once a second: filtering the whole list on every trade was quadratic and took ~45%
      // of the engine's CPU at 1,000 trades/s, enough to put the book tens of seconds behind in a busy final minute.
      if(t.time-this.pruned>=1000){this.pruned=t.time;this.trades=this.trades.filter(x=>x.time>t.time-120000);}
      this.onTrade(t);}
    if(m.type==='fill')this.onFill();
  }
  async fallback(){if(this.polling)return;this.polling=true;try{for(const m of this.markets){const b=this.books.get(m.ticker)!;if(this.status==='connected'&&b.valid&&b.source==='ws')continue;const r=await this.client.get('/markets/'+encodeURIComponent(m.ticker)+'/orderbook');if(b.valid&&b.source==='ws')continue;b.snapshot(r.orderbook_fp?.yes_dollars??[],r.orderbook_fp?.no_dollars??[],'rest');}}finally{this.polling=false;}}
  recover(){for(const b of this.books.values())b.valid=false;this.connect();void this.fallback().catch(e=>this.log('book-resync-error',{message:e.message}));}
  stop(){this.socket?.stop();}
}
