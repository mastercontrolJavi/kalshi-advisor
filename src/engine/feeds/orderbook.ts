export type Level=[number,number];
export class Orderbook {
  yes=new Map<number,number>();no=new Map<number,number>();seq:number|null=null;valid=false;updated=0;source='none';
  snapshot(yes:unknown[][]=[],no:unknown[][]=[],seq:number|null=null,source='ws'){
    const parse=(rows:unknown[][])=>new Map<number,number>(rows.map(([p,q]):[number,number]=>[Math.round(Number(p)*10000),Number(q)]).filter(([p,q])=>p>0&&p<10000&&q>0));
    this.yes=parse(yes);this.no=parse(no);this.seq=seq;this.valid=true;this.updated=Date.now();this.source=source;
  }
  delta(seq:number,side:'yes'|'no',price:number,delta:number){
    if(!this.valid||this.seq===null||seq!==this.seq+1){this.valid=false;return false;}
    const book=this[side],p=Math.round(price*10000),quantity=(book.get(p)??0)+delta;
    if(!Number.isFinite(quantity)||quantity<-.0001){this.valid=false;return false;}
    if(quantity<=0)book.delete(p);else book.set(p,quantity);
    this.seq=seq;this.updated=Date.now();return true;
  }
  levels(side:'yes'|'no'):Level[]{return [...this[side]].sort((a,b)=>b[0]-a[0]).map(([p,q])=>[p/10000,q]);}
  view(){const yes=this.levels('yes'),no=this.levels('no');return {yes,no,yesBid:yes[0]?.[0]??null,noBid:no[0]?.[0]??null,yesAsk:no[0]?1-no[0][0]:null,noAsk:yes[0]?1-yes[0][0]:null,yesDepth:no[0]?.[1]??0,noDepth:yes[0]?.[1]??0,valid:this.valid,updated:this.updated,source:this.source};}
  queue(side:'yes'|'no',price:number){return this.levels(side).filter(([p])=>p>=price-1e-8).reduce((s,[,q])=>s+q,0);}
}
