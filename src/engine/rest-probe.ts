import {Orderbook} from './feeds/orderbook';
import type {KalshiClient} from './feeds/kalshi';
type Quote={yesBid:number|null;yesAsk:number|null};
/**
 * Log-only check (2026-10-22): while the Kalshi stream is behind, is Kalshi's REST API current? REST goes over the same
 * Wi-Fi, so if its latest trade is newer than the stream's by about the stream's delay, the hold-up is the stream
 * itself and REST could serve as a backup price source. restLeadMs > 0 = REST knows about later trades than the stream.
 */
export function compareRest(serverNow:number,wsTradeTime:number|null,restTradeTime:number|null,rest:Quote,ws:Quote){
  return {restTradeAgeMs:restTradeTime===null?null:serverNow-restTradeTime,wsTradeAgeMs:wsTradeTime===null?null:serverNow-wsTradeTime,
    restLeadMs:restTradeTime!==null&&wsTradeTime!==null?restTradeTime-wsTradeTime:null,rest,ws,sameQuote:rest.yesBid===ws.yesBid&&rest.yesAsk===ws.yesAsk};
}
/**
 * Every 10 s while the stream is delayed (it was every 2 s until the REST backup, DECISIONS 64, began reading the book
 * each second), and once a minute otherwise as the normal baseline. Never affects trading.
 */
export class RestProbe {
  private busy=false;private last=0;
  constructor(private client:KalshiClient,private log:(event:string,data:unknown)=>void){}
  due(now:number,delayed:boolean){return !this.busy&&now-this.last>=(delayed?10000:60000);}
  async run(ticker:string,delayMs:number,wsTradeTime:number|null,ws:Quote,now=Date.now()){
    this.busy=true;this.last=now;
    try{
      // The client queues requests, so the round trip includes any wait behind other Kalshi calls.
      const started=Date.now(),q=encodeURIComponent(ticker);
      const [trades,book]=await Promise.all([this.client.get('/markets/trades?ticker='+q+'&limit=1'),this.client.get('/markets/'+q+'/orderbook')]);
      const rttMs=Date.now()-started,t=trades?.trades?.[0],restTradeTime=t?.created_time?Date.parse(t.created_time):null;
      const b=new Orderbook();b.snapshot(book?.orderbook_fp?.yes_dollars??[],book?.orderbook_fp?.no_dollars??[],'rest');const v=b.view();
      this.log('rest-probe',{ticker,delayed:delayMs>2000,wsDelayMs:Math.round(delayMs),rttMs,...compareRest(Date.now()+this.client.clockOffset,wsTradeTime,restTradeTime,{yesBid:v.yesBid,yesAsk:v.yesAsk},ws)});
    }catch(e){this.log('rest-probe-error',{ticker,message:(e as Error).message});}
    finally{this.busy=false;}
  }
}
