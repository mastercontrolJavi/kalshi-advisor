import {randomUUID} from 'node:crypto';
import {quoteOrder,type Side} from './sim';
import type {MarketNow} from './paper';
/**
 * Real copy orders (2026-10-22, user: "copy the top traders with real money, one click, I confirm each, a fixed dollar
 * cap"). Two steps, both on the server: a quote fixes the exact order (contracts, the worst price it may pay, the total
 * with Kalshi's fee) for 30 s; only that quote can be sent, as an immediate-or-cancel limit order, so a moved price fills
 * less or nothing and never more expensively. Off until Settings → Real copy orders is on; capped per copy by the dollar
 * amount set there and by the Kalshi cash balance; blocked while the daily loss lock or a cooldown is on.
 */
export const QUOTE_TTL_MS=30000;
export interface RealQuote {token:string;ticker:string;side:Side;count:number;/** the worst price for the side bought */limit:number;avgPrice:number;fee:number;cost:number;cap:number;title:string|null;expires:number;context:Record<string,unknown>}
export interface RealLimits {enabled:boolean;cap:number;balance:number|null;lock:string|null;now:number}
export class RealCopy {
  private quotes=new Map<string,RealQuote>();
  quote(m:MarketNow,side:Side,dollars:number|undefined,o:RealLimits):RealQuote{
    if(!o.enabled)throw new Error('Real copy orders are off: switch them on in Settings → Real copy orders');
    if(o.lock)throw new Error(`Real orders are paused: ${o.lock}`);
    if(side!=='yes'&&side!=='no')throw new Error('Choose YES or NO');
    if(!m.active||m.tau<=1)throw new Error('This market is not open for trading');
    if(!m.book.valid||m.now-m.book.updated>m.bookStaleMs||m.delayed)throw new Error('Kalshi prices are not live right now; try again in a moment');
    if(o.balance===null)throw new Error('Kalshi balance not synced yet');
    const budget=Math.min(o.cap,o.balance,dollars!==undefined&&dollars>0?dollars:Infinity);
    if(!(budget>=1))throw new Error(`Not enough to buy anything: cap ${o.cap.toFixed(2)}, cash ${o.balance.toFixed(2)}`);
    const q=quoteOrder(m.book,side,'buy',{dollars:budget},m.schedule);
    if(!q.contracts)throw new Error('No offers on the book within your cap');
    this.prune(o.now);
    const quote:RealQuote={token:randomUUID(),ticker:m.ticker,side,count:q.contracts,limit:q.limit,avgPrice:q.price,fee:q.fee,cost:q.cash,cap:o.cap,
      title:typeof m.context.title==='string'?m.context.title:null,expires:o.now+QUOTE_TTL_MS,context:m.context};
    this.quotes.set(quote.token,quote);return quote;
  }
  /** The confirmed quote, once: a token cannot be sent twice, and an expired one must be quoted again. */
  take(token:unknown,now:number):RealQuote{
    const q=typeof token==='string'?this.quotes.get(token):undefined;if(!q)throw new Error('That quote is no longer valid; get a fresh one');
    this.quotes.delete(q.token);if(now>q.expires)throw new Error('The quote expired (30 s); get a fresh one');return q;
  }
  private prune(now:number){for(const [k,q] of this.quotes)if(now>q.expires)this.quotes.delete(k);}
}
/** Kalshi's V2 order for a quote: YES is a bid at the YES price; NO is an ask at 1 − the NO price (Kalshi nets the two). */
export function orderBody(q:RealQuote,clientOrderId:string){
  const yesPrice=q.side==='yes'?q.limit:1-q.limit;
  return {ticker:q.ticker,client_order_id:clientOrderId,side:q.side==='yes'?'bid':'ask',count:String(q.count),price:yesPrice.toFixed(4),
    time_in_force:'immediate_or_cancel',self_trade_prevention_type:'taker_at_cross',cancel_order_on_pause:true};
}
/** What Kalshi did with it, in plain words (average_fill_price is the YES price of the fills). */
export function describeFill(q:RealQuote,r:{fill_count?:string;average_fill_price?:string;average_fee_paid?:string}){
  const n=Number(r.fill_count??0),yes=Number(r.average_fill_price),price=Number.isFinite(yes)?(q.side==='yes'?yes:1-yes):null,fee=Number(r.average_fee_paid);
  if(!(n>0))return {filled:0,text:`Nothing filled: the price moved past ${(q.limit*100).toFixed(1)}¢. No money was spent.`};
  return {filled:n,text:`Bought ${n} ${q.side.toUpperCase()} on Kalshi${price!==null?` at ${(price*100).toFixed(1)}¢`:''}${Number.isFinite(fee)?` (fee $${(fee*n).toFixed(2)})`:''}${n<q.count?` · ${q.count-n} of ${q.count} were gone when the order arrived`:''}.`};
}
export const newClientOrderId=()=>randomUUID();
