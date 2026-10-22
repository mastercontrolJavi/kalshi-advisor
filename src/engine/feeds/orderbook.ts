export type Level=[number,number];
// Kalshi numbers messages per subscription (sid), shared by every market and by acks on that sid.
export class SubscriptionSequence {
  last=new Map<number,number>();
  accept(sid:number,seq:number){const prev=this.last.get(sid);this.last.set(sid,seq);return prev===undefined||seq===prev+1;}
  reset(){this.last.clear();}
}
/** A book more than this far behind Kalshi is not used for the forecast, entries or exit prices. */
export const MAX_BOOK_DELAY_MS=2000;
/**
 * How far behind Kalshi the stream is. Every Kalshi message carries its send time (sending_ts_ms); the delay is the
 * local receive time minus that, above the lowest value of the last 10 minutes. The floor absorbs the difference
 * between the two clocks and the normal network time, so no clock sync is needed. On 2026-10-21 the book fell ~50 s
 * behind in the final minute of a busy round while still updating every few seconds, so "updated recently" missed it.
 */
export class FeedDelay {
  private floor:{t:number;v:number}[]=[];ms=0;
  observe(sent:number,now=Date.now(),window=600000){
    if(!Number.isFinite(sent))return;const raw=now-sent,f=this.floor;
    while(f.length&&f[f.length-1].v>=raw)f.pop();f.push({t:now,v:raw});while(f[0].t<now-window)f.shift();
    this.ms=Math.max(0,raw-f[0].v);
  }
  get delayed(){return this.ms>MAX_BOOK_DELAY_MS;}
  reset(){this.floor=[];this.ms=0;}
}
export class Orderbook {
  yes=new Map<number,number>();no=new Map<number,number>();valid=false;updated=0;source='none';
  snapshot(yes:unknown[][]=[],no:unknown[][]=[],source='ws'){
    const parse=(rows:unknown[][])=>new Map<number,number>(rows.map(([p,q]):[number,number]=>[Math.round(Number(p)*10000),Number(q)]).filter(([p,q])=>p>0&&p<10000&&q>0));
    this.yes=parse(yes);this.no=parse(no);this.valid=true;this.updated=Date.now();this.source=source;
  }
  // Sequencing is checked per subscription by the feed; a REST snapshot never accepts WS deltas.
  delta(side:'yes'|'no',price:number,delta:number){
    if(!this.valid||this.source!=='ws'){this.valid=false;return false;}
    // Fixed-point quantities: round away float residue so emptied levels are deleted, not left as phantom bids.
    const book=this[side],p=Math.round(price*10000),quantity=Math.round(((book.get(p)??0)+delta)*1e6)/1e6;
    if(!Number.isFinite(quantity)||quantity<-.0001){this.valid=false;return false;}
    if(quantity<=0)book.delete(p);else book.set(p,quantity);
    this.updated=Date.now();return true;
  }
  levels(side:'yes'|'no'):Level[]{return [...this[side]].sort((a,b)=>b[0]-a[0]).map(([p,q])=>[p/10000,q]);}
  view(){const yes=this.levels('yes'),no=this.levels('no');return {yes,no,yesBid:yes[0]?.[0]??null,noBid:no[0]?.[0]??null,yesAsk:no[0]?1-no[0][0]:null,noAsk:yes[0]?1-yes[0][0]:null,yesDepth:no[0]?.[1]??0,noDepth:yes[0]?.[1]??0,valid:this.valid,updated:this.updated,source:this.source};}
  queue(side:'yes'|'no',price:number){return this.levels(side).filter(([p])=>p>=price-1e-8).reduce((s,[,q])=>s+q,0);}
}
