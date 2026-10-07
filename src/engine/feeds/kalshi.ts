import {constants,createPrivateKey,sign,type KeyObject} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {ReconnectingSocket} from './socket';
import {Orderbook} from './orderbook';
import {baseFees,type FeeSchedule} from '../model/fees';
export const REST='https://external-api.kalshi.com/trade-api/v2';
export const WS='wss://external-api-ws.kalshi.com/trade-api/ws/v2';
export function signedHeaders(key:KeyObject,id:string,path:string,timestamp:number){
  const ts=String(Math.round(timestamp));
  return {'KALSHI-ACCESS-KEY':id,'KALSHI-ACCESS-TIMESTAMP':ts,'KALSHI-ACCESS-SIGNATURE':sign('sha256',Buffer.from(ts+'GET'+path.split('?')[0]),{key,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32}).toString('base64')};
}
export interface Market {ticker:string;event_ticker:string;open_time:string;close_time:string;floor_strike?:number;status:string;result?:string;expiration_value?:string;rules_primary?:string;rules_secondary?:string;price_ranges?:{start:string;end:string;step:string}[]}
export class KalshiClient {
  private key?:KeyObject;clockOffset=0;clockSynced=false;private tail:Promise<unknown>=Promise.resolve();limits:unknown=null;
  constructor(private id=process.env.KALSHI_API_KEY_ID??'',private keyPath=process.env.KALSHI_PRIVATE_KEY_PATH??''){
    if(id&&keyPath&&existsSync(keyPath)){this.key=createPrivateKey(readFileSync(keyPath));if(this.key.asymmetricKeyType!=='rsa')throw new Error('This v1 expects an RSA PEM key');}
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
    const task=this.tail.then(run,run);this.tail=task.catch(()=>{}).then(()=>new Promise(r=>setTimeout(r,100)));return task;
  }
  async pages(path:string,field:string){const result:any[]=[];let cursor='';const seen=new Set<string>();do{const page=await this.get(path+(path.includes('?')?'&':'?')+'limit=1000'+(cursor?'&cursor='+encodeURIComponent(cursor):''),true);result.push(...(page[field]??[]));cursor=page.cursor??'';if(cursor&&seen.has(cursor))throw new Error('Repeated pagination cursor');seen.add(cursor);}while(cursor);return result;}
  async schedule(event:string):Promise<FeeSchedule>{
    const {series}=await this.get('/series/KXBTC15M');const {event:ev}=await this.get('/events/'+encodeURIComponent(event));
    const type=ev.fee_type??ev.fee_type_override??series.fee_type,m=Number(ev.fee_multiplier??ev.fee_multiplier_override??series.fee_multiplier??1);
    return {...baseFees,takerMultiplier:m,makerMultiplier:type==='quadratic_with_maker_fees'?m:0,verified:['quadratic','quadratic_with_maker_fees'].includes(type)&&Number.isFinite(m)&&m>=0};
  }
}
export class KalshiFeed {
  markets:Market[]=[];books=new Map<string,Orderbook>();status='disconnected';lag:number|null=null;lastMessage=0;fees:FeeSchedule={...baseFees,verified:false};
  trades:{ticker:string;time:number;yesPrice:number;count:number;takerSide:string}[]=[];
  private socket?:ReconnectingSocket;private signature='';private refreshing=false;private polling=false;
  constructor(public client:KalshiClient,private log:(event:string,data:unknown)=>void,private onTrade:(t:any)=>void=()=>{},private onFill:()=>void=()=>{}){}
  async refresh(){
    if(this.refreshing)return;this.refreshing=true;
    try{
      const [open,next]=await Promise.all([this.client.get('/markets?series_ticker=KXBTC15M&status=open&limit=100'),this.client.get('/markets?series_ticker=KXBTC15M&status=unopened&limit=100')]);
      const now=Date.now()+this.client.clockOffset;
      this.markets=[...open.markets,...next.markets].filter((m:Market)=>Date.parse(m.close_time)>now).sort((a:Market,b:Market)=>Date.parse(a.open_time)-Date.parse(b.open_time)).slice(0,2);
      const sig=this.markets.map(m=>m.ticker).join(',');
      if(sig!==this.signature){this.signature=sig;for(const m of this.markets){this.books.set(m.ticker,new Orderbook());this.log('market-discovered',m);}if(this.markets[0])this.fees=await this.client.schedule(this.markets[0].event_ticker);this.connect();}
    }finally{this.refreshing=false;}
  }
  private connect(){
    this.socket?.stop();this.status=this.client.authenticated?'connecting':'REST fallback — missing credentials';
    if(!this.client.authenticated||!this.markets.length)return;
    const subscribe=()=>[...this.markets.map((m,i)=>({id:i+1,cmd:'subscribe',params:{channels:['orderbook_delta'],market_tickers:[m.ticker]}})),{id:3,cmd:'subscribe',params:{channels:['ticker','trade'],market_tickers:this.markets.map(m=>m.ticker)}},{id:4,cmd:'subscribe',params:{channels:['fill']}}];
    this.socket=new ReconnectingSocket(WS,subscribe,m=>{
      this.lastMessage=Date.now();this.lag=m.sending_ts_ms?Math.max(0,Date.now()+this.client.clockOffset-m.sending_ts_ms):null;
      const d=m.msg??{};const book=this.books.get(d.market_ticker);
      if(m.type==='error'){this.log('kalshi-ws-error',d);this.status='subscription error';return;}
      if(m.type==='orderbook_snapshot'&&book)book.snapshot(d.yes_dollars_fp??[],d.no_dollars_fp??[],m.seq);
      if(m.type==='orderbook_delta'&&book){if(!book.delta(m.seq,d.side,Number(d.price_dollars),Number(d.delta_fp))){this.log('book-gap',{ticker:d.market_ticker,seq:m.seq});this.recover();}}
      if(m.type==='trade'){const t={ticker:d.market_ticker,time:d.ts_ms??d.ts*1000,yesPrice:Number(d.yes_price_dollars),count:Number(d.count_fp),takerSide:d.taker_outcome_side??d.taker_side};this.trades.push(t);this.trades=this.trades.filter(t=>t.time>this.lastMessage+this.client.clockOffset-120000);this.onTrade(t);}
      if(m.type==='fill')this.onFill();
    },status=>{this.status=status;if(status!=='connected')for(const b of this.books.values())b.valid=false;this.log('kalshi-status',{status});},()=>this.client.headers('/trade-api/ws/v2'));
    this.socket.start();
  }
  async fallback(){if(this.polling)return;this.polling=true;try{for(const m of this.markets){const b=this.books.get(m.ticker)!;if(this.status==='connected'&&b.valid&&b.source==='ws')continue;const r=await this.client.get('/markets/'+encodeURIComponent(m.ticker)+'/orderbook');b.snapshot(r.orderbook_fp?.yes_dollars??[],r.orderbook_fp?.no_dollars??[],null,'rest');}}finally{this.polling=false;}}
  recover(){for(const b of this.books.values())b.valid=false;this.connect();void this.fallback().catch(e=>this.log('book-resync-error',{message:e.message}));}
  stop(){this.socket?.stop();}
}
