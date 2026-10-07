export type Level=[number,number];
// Kalshi numbers messages per subscription (sid), shared by every market and by acks on that sid.
export class SubscriptionSequence {
  last=new Map<number,number>();
  accept(sid:number,seq:number){const prev=this.last.get(sid);this.last.set(sid,seq);return prev===undefined||seq===prev+1;}
  reset(){this.last.clear();}
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
    const book=this[side],p=Math.round(price*10000),quantity=(book.get(p)??0)+delta;
    if(!Number.isFinite(quantity)||quantity<-.0001){this.valid=false;return false;}
    if(quantity<=0)book.delete(p);else book.set(p,quantity);
    this.updated=Date.now();return true;
  }
  levels(side:'yes'|'no'):Level[]{return [...this[side]].sort((a,b)=>b[0]-a[0]).map(([p,q])=>[p/10000,q]);}
  view(){const yes=this.levels('yes'),no=this.levels('no');return {yes,no,yesBid:yes[0]?.[0]??null,noBid:no[0]?.[0]??null,yesAsk:no[0]?1-no[0][0]:null,noAsk:yes[0]?1-yes[0][0]:null,yesDepth:no[0]?.[1]??0,noDepth:yes[0]?.[1]??0,valid:this.valid,updated:this.updated,source:this.source};}
  queue(side:'yes'|'no',price:number){return this.levels(side).filter(([p])=>p>=price-1e-8).reduce((s,[,q])=>s+q,0);}
}
