import {FeedDelay} from './feeds/orderbook';
/**
 * Order flow & futures pulse (2026-11-02, DECISIONS 71): taker flow on Coinbase spot and the Binance / Bybit BTCUSDT
 * perpetuals, the perp-to-spot basis and the perp's short-term lead. Runs in flow-worker.ts, a worker thread with its own
 * sockets and its own database (data/flow.db): the engine thread only receives a ~2 KB pulse 4×/s.
 *
 * Unlike the Coinbase recorder it replaces (microstructure.ts, off since 2026-10-23), it keeps no order book: trades
 * plus Binance's top 5 levels at a fixed 10/s. That recorder pulled ~1 MB, 40,000-level snapshots through the engine
 * thread on every reconnect. Binance's bookTicker (≈170 msg/s quiet, far more in bursts) is replaced by depth5@100ms for
 * the same reason: a bounded rate.
 *
 * Nothing here has been tested against Kalshi yet. The pulse is shown, and the 250 ms bars are recorded for quant/.
 * Pure (no node: imports) so the dashboard can share flowAlignment.
 */
export const FLOW_BUCKET_MS=250,FLOW_WINDOWS=[5,15,60] as const,FLOW_KEEP_MS=300000,FLOW_VERSION='flow-v1';
export type FlowVenueId='coinbase'|'binance'|'bybit';
export const FLOW_VENUES:{id:FlowVenueId;label:string;kind:'spot'|'perp';col:string}[]=[
  {id:'coinbase',label:'Coinbase spot',kind:'spot',col:'cb'},{id:'binance',label:'Binance perp',kind:'perp',col:'bn'},{id:'bybit',label:'Bybit perp',kind:'perp',col:'by'}];
/** Taker-buy share at or beyond which a 60 s window counts as a vote (and its mirror for sells). */
export const FLOW_RATIO_VOTE=.55;
/** Minimum 60 s taker volume (BTC) before a side's ratio counts: one 0.01 BTC trade is not "flow". */
export const FLOW_MIN_VOLUME={spot:.25,perp:2};
/** 1 s perp lead over spot that counts as an impulse: ≥ 2 sd of its own last 5 minutes and ≥ $5 (a quiet tape makes the sd tiny). */
export const FLOW_IMPULSE_Z=2,FLOW_IMPULSE_MIN_USD=5;
/** The engine resends the worker's last pulse if the worker stalls; older than this, the dashboard treats it as not current. */
export const FLOW_PULSE_STALE_MS=1500;
/** A venue is unhealthy after this long without any frame, or with a feed delay above FLOW_MAX_DELAY_MS. */
export const FLOW_SILENT_MS=3000,FLOW_MAX_DELAY_MS=2000,FLOW_QUOTE_MS=1000;
export interface FlowTrade {venue:FlowVenueId;at:number;source:number|null;price:number;size:number;buy:boolean;id?:number|null}
export interface FlowQuote {at:number;source:number|null;bid:number;ask:number}
export interface FlowMark {at:number;source:number|null;mark:number;index:number;funding:number}
interface Bucket {t:number;buy:number;sell:number;n:number;last:number|null;lag:number|null}
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const num=(v:unknown)=>typeof v==='string'&&v.trim()!==''?Number(v):finite(v)?v:NaN;
const bucketOf=(t:number)=>Math.floor(t/FLOW_BUCKET_MS)*FLOW_BUCKET_MS;

/** Coinbase Exchange `match`: `side` is the maker's, so a maker sell is a taker buy. */
export function parseCoinbase(m:any,at:number):FlowTrade|null{
  if(m?.type!=='match'||m.product_id!=='BTC-USD')return null;const price=num(m.price),size=num(m.size),source=Date.parse(m.time);
  if(!(price>0)||!(size>0)||(m.side!=='buy'&&m.side!=='sell'))return null;
  return {venue:'coinbase',at,source:Number.isFinite(source)?source:null,price,size,buy:m.side==='sell',id:Number.isSafeInteger(m.trade_id)?m.trade_id:null};
}
/** Binance USDⓈ-M combined or raw stream: aggTrade (`m` = buyer is the maker, so true is a taker sell), depth5, markPrice. */
export function parseBinance(m:any,at:number):{trade?:FlowTrade;quote?:FlowQuote;mark?:FlowMark}|null{
  const d=m?.data??m;if(!d||d.s!=='BTCUSDT')return null;
  if(d.e==='aggTrade'){const price=num(d.p),size=num(d.q);if(!(price>0)||!(size>0)||typeof d.m!=='boolean')return null;
    return {trade:{venue:'binance',at,source:finite(d.T)?d.T:null,price,size,buy:!d.m,id:Number.isSafeInteger(d.a)?d.a:null}};}
  if(d.e==='depthUpdate'){const bid=num(d.b?.[0]?.[0]),ask=num(d.a?.[0]?.[0]);if(!(bid>0)||!(ask>=bid))return null;return {quote:{at,source:finite(d.E)?d.E:null,bid,ask}};}
  if(d.e==='markPriceUpdate'){const mark=num(d.p),index=num(d.i),funding=num(d.r);if(!(mark>0)||!(index>0))return null;return {mark:{at,source:finite(d.E)?d.E:null,mark,index,funding:Number.isFinite(funding)?funding:0}};}
  return null;
}
/** Bybit v5 linear publicTrade: `S` is the taker's side. Block trades (BT) are off-book and skipped. */
export function parseBybit(m:any,at:number):FlowTrade[]{
  if(m?.topic!=='publicTrade.BTCUSDT'||!Array.isArray(m.data))return [];
  return m.data.flatMap((t:any)=>{const price=num(t.p),size=num(t.v);if(t.BT||!(price>0)||!(size>0)||(t.S!=='Buy'&&t.S!=='Sell'))return [];
    return [{venue:'bybit' as const,at,source:finite(t.T)?t.T:null,price,size,buy:t.S==='Buy'}];});
}

export interface FlowWindow {seconds:number;buy:number|null;sell:number|null;cvd:number|null;ratio:number|null;trades:number|null}
export interface VenuePulse {id:FlowVenueId;label:string;kind:'spot'|'perp';status:string;healthy:boolean;price:number|null;ageMs:number|null;delayMs:number;gaps:number;windows:FlowWindow[]}
export interface FlowSide {cvd:number|null;volume:number|null;ratio:number|null;vote:1|-1|0|null}
export interface FlowPulse {
  version:string;time:number;healthy:boolean;venues:VenuePulse[];spot:number|null;perp:number|null;
  basis:{usd:number|null;bps:number|null;mean5m:number|null;change:number|null};
  mark:{mark:number;index:number;funding:number;premiumBps:number;ageMs:number}|null;
  /** perp move minus spot move over 1 s and 5 s ($); z = the 1 s lead in sd of the last 5 minutes. */
  lead:{perp1s:number|null;spot1s:number|null;lead1s:number|null;perp5s:number|null;spot5s:number|null;lead5s:number|null;sd1s:number|null;z:number|null;impulse:1|-1|0|null};
  flow:{spot:FlowSide;perp:FlowSide};
}
class VenueFlow {
  status='disconnected';connectedAt:number|null=null;alive=0;price:number|null=null;updated:number|null=null;gaps=0;lastId:number|null=null;
  delay=new FeedDelay();buckets:Bucket[]=[];
  constructor(readonly id:FlowVenueId){}
  /** The bucket for this time; null for a time before the newest bucket that has none (a clock step backwards). */
  bucket(at:number){const t=bucketOf(at);for(let i=this.buckets.length-1;i>=0;i--){const b=this.buckets[i];if(b.t===t)return b;if(b.t<t)break;}
    if((this.buckets.at(-1)?.t??-Infinity)>t)return null;const b:Bucket={t,buy:0,sell:0,n:0,last:null,lag:null};this.buckets.push(b);return b;}
  prune(now:number){const cut=now-FLOW_KEEP_MS;let i=0;while(i<this.buckets.length&&this.buckets[i].t<cut)i++;if(i)this.buckets.splice(0,i);}
}
export class FlowState {
  venues=new Map<FlowVenueId,VenueFlow>(FLOW_VENUES.map(v=>[v.id,new VenueFlow(v.id)]));
  quote:FlowQuote|null=null;markState:FlowMark|null=null;
  /** Per-bucket book top and mark for the bars, cleared as bars are drained. */
  private quotes=new Map<number,FlowQuote>();private marks=new Map<number,FlowMark>();private drained=0;
  status(id:FlowVenueId,status:string,at:number){const v=this.venues.get(id)!;
    if(status==='connected'&&v.status!=='connected'){v.connectedAt=at;v.alive=at;}
    if(status!=='connected'){v.connectedAt=null;v.delay.reset();v.lastId=null;if(id==='binance')this.quote=null;}
    v.status=status;}
  alive(id:FlowVenueId,at:number){this.venues.get(id)!.alive=at;}
  /** The engine's Kalshi clock offset changed: every venue's delay floor was learned on the old clock. On the first live
   *  run (2026-11-02) a 2.2 s step read as 2.2 s of delay on all three venues and marked them unhealthy for 10 minutes. */
  rebase(){for(const v of this.venues.values())v.delay.reset();}
  trade(t:FlowTrade){const v=this.venues.get(t.venue)!;v.alive=t.at;
    if(t.source!==null)v.delay.observe(t.source,t.at);
    if(t.id!=null){if(v.lastId!==null&&t.id<=v.lastId)return;if(v.lastId!==null&&t.id!==v.lastId+1)v.gaps++;v.lastId=t.id;}
    const b=v.bucket(t.at);if(!b)return;if(t.buy)b.buy+=t.size;else b.sell+=t.size;b.n++;b.last=t.price;b.lag=t.source===null?b.lag:Math.max(b.lag??-Infinity,t.at-t.source);
    v.price=t.price;v.updated=t.at;}
  book(q:FlowQuote){const v=this.venues.get('binance')!;v.alive=q.at;if(q.source!==null)v.delay.observe(q.source,q.at);this.quote=q;this.quotes.set(bucketOf(q.at),q);}
  mark(m:FlowMark){this.markState=m;this.marks.set(bucketOf(m.at),m);}
  private priceOf(id:FlowVenueId,now:number){const v=this.venues.get(id)!;
    // Binance: the depth5 mid, unless a trade has printed since (10 quotes/s can trail a fast tape).
    if(id==='binance'&&this.quote&&now-this.quote.at<=FLOW_QUOTE_MS&&this.quote.at>=(v.updated??0))return (this.quote.bid+this.quote.ask)/2;return v.price;}
  private healthy(v:VenueFlow,now:number){return v.status==='connected'&&now-v.alive<=FLOW_SILENT_MS&&v.price!==null&&v.delay.ms<=FLOW_MAX_DELAY_MS;}
  private window(v:VenueFlow,now:number,seconds:number):FlowWindow{
    const from=now-seconds*1000;if(v.connectedAt===null||v.connectedAt>from)return {seconds,buy:null,sell:null,cvd:null,ratio:null,trades:null};
    let buy=0,sell=0,n=0;for(let i=v.buckets.length-1;i>=0&&v.buckets[i].t>=from;i--){const b=v.buckets[i];if(b.t>now)continue;buy+=b.buy;sell+=b.sell;n+=b.n;}
    return {seconds,buy,sell,cvd:buy-sell,ratio:buy+sell>0?buy/(buy+sell):null,trades:n};}
  /** Last traded price at or before t, carried forward through quiet buckets (null if none in the kept history). */
  private priceAt(v:VenueFlow,t:number){for(let i=v.buckets.length-1;i>=0;i--){const b=v.buckets[i];if(b.t<=t&&b.last!==null)return b.last;}return null;}
  pulse(now:number):FlowPulse{
    for(const v of this.venues.values())v.prune(now);
    for(const map of [this.quotes,this.marks])for(const t of map.keys())if(t<now-FLOW_KEEP_MS)map.delete(t);
    const venues=FLOW_VENUES.map(meta=>{const v=this.venues.get(meta.id)!;
      return {id:meta.id,label:meta.label,kind:meta.kind,status:v.status,healthy:this.healthy(v,now),price:this.priceOf(meta.id,now),ageMs:v.updated===null?null:now-v.updated,delayMs:Math.round(v.delay.ms),gaps:v.gaps,windows:FLOW_WINDOWS.map(s=>this.window(v,now,s))};});
    const cb=this.venues.get('coinbase')!,bn=this.venues.get('binance')!,by=this.venues.get('bybit')!;
    const spotOk=venues[0].healthy,perpVenue=venues[1].healthy?bn:venues[2].healthy?by:null;
    const spot=spotOk?venues[0].price:null,perp=perpVenue?this.priceOf(perpVenue.id,now):null;
    // Basis history: carried-forward last trades every bucket of the kept 5 minutes (perp trades, not the quote, for both ends).
    const series:{t:number;perp:number;spot:number}[]=[];
    if(perpVenue&&spotOk){let pi=0,si=0,p:number|null=null,s:number|null=null;const pb=perpVenue.buckets,sb=cb.buckets;
      for(let t=bucketOf(now-FLOW_KEEP_MS);t<=now;t+=FLOW_BUCKET_MS){while(pi<pb.length&&pb[pi].t<=t){if(pb[pi].last!==null)p=pb[pi].last;pi++;}while(si<sb.length&&sb[si].t<=t){if(sb[si].last!==null)s=sb[si].last;si++;}if(p!==null&&s!==null)series.push({t,perp:p,spot:s});}}
    const usd=spot!==null&&perp!==null?perp-spot:null,mean5m=series.length>=240?series.reduce((a,x)=>a+x.perp-x.spot,0)/series.length:null;
    const step=1000/FLOW_BUCKET_MS,leads:number[]=[];for(let i=step;i<series.length;i++)leads.push((series[i].perp-series[i-step].perp)-(series[i].spot-series[i-step].spot));
    const sd=leads.length>=240?Math.sqrt(leads.reduce((a,x)=>a+x*x,0)/leads.length):null;
    const move=(v:VenueFlow,seconds:number,price:number|null)=>{if(price===null)return null;const then=this.priceAt(v,now-seconds*1000);return then===null?null:price-then;};
    const perpLast=perpVenue?.price??null,spotLast=spotOk?cb.price:null;
    const perp1s=perpVenue?move(perpVenue,1,perpLast):null,spot1s=move(cb,1,spotLast),perp5s=perpVenue?move(perpVenue,5,perpLast):null,spot5s=move(cb,5,spotLast);
    const lead1s=perp1s!==null&&spot1s!==null?perp1s-spot1s:null,lead5s=perp5s!==null&&spot5s!==null?perp5s-spot5s:null,z=lead1s!==null&&sd?lead1s/sd:null;
    const side=(ids:FlowVenueId[],min:number):FlowSide=>{const ws=venues.filter(v=>ids.includes(v.id)&&v.healthy).map(v=>v.windows[2]).filter(w=>w.buy!==null);
      if(!ws.length)return {cvd:null,volume:null,ratio:null,vote:null};const buy=ws.reduce((a,w)=>a+w.buy!,0),sell=ws.reduce((a,w)=>a+w.sell!,0),volume=buy+sell,ratio=volume>0?buy/volume:null;
      return {cvd:buy-sell,volume,ratio,vote:ratio===null||volume<min?0:ratio>=FLOW_RATIO_VOTE?1:ratio<=1-FLOW_RATIO_VOTE?-1:0};};
    const m=this.markState;
    return {version:FLOW_VERSION,time:now,healthy:spotOk&&!!perpVenue,venues,spot,perp,
      basis:{usd,bps:usd!==null&&spot?usd/spot*10000:null,mean5m,change:usd!==null&&mean5m!==null?usd-mean5m:null},
      mark:m&&venues[1].status==='connected'?{mark:m.mark,index:m.index,funding:m.funding,premiumBps:(m.mark-m.index)/m.index*10000,ageMs:now-m.at}:null,
      lead:{perp1s,spot1s,lead1s,perp5s,spot5s,lead5s,sd1s:sd,z,impulse:z===null?null:z>=FLOW_IMPULSE_Z&&lead1s!>=FLOW_IMPULSE_MIN_USD?1:z<=-FLOW_IMPULSE_Z&&lead1s!<=-FLOW_IMPULSE_MIN_USD?-1:0},
      flow:{spot:side(['coinbase'],FLOW_MIN_VOLUME.spot),perp:side(['binance','bybit'],FLOW_MIN_VOLUME.perp)}};
  }
  /** Completed 250 ms bars after the last drain, up to `upTo` (exclusive), one row per bucket that saw any data. */
  drain(upTo:number):FlowBar[]{
    const end=bucketOf(upTo),from=this.drained,rows=new Map<number,FlowBar>();
    const row=(t:number)=>{let r=rows.get(t);if(!r){r=emptyBar(t);rows.set(t,r);}return r;};
    for(const meta of FLOW_VENUES)for(const b of this.venues.get(meta.id)!.buckets){if(b.t<from||b.t>=end||!b.n)continue;const r=row(b.t) as any;
      r[meta.col+'_last']=b.last;r[meta.col+'_buy']=b.buy;r[meta.col+'_sell']=b.sell;r[meta.col+'_n']=b.n;r[meta.col+'_lag']=b.lag===null?null:Math.round(b.lag);}
    for(const [t,q] of this.quotes){if(t>=end)continue;this.quotes.delete(t);if(t<from)continue;const r=row(t);r.bn_bid=q.bid;r.bn_ask=q.ask;}
    for(const [t,m] of this.marks){if(t>=end)continue;this.marks.delete(t);if(t<from)continue;const r=row(t);r.bn_mark=m.mark;r.bn_index=m.index;r.bn_funding=m.funding;}
    this.drained=Math.max(from,end);return [...rows.values()].sort((a,b)=>a.t-b.t);
  }
}
export interface FlowBar {t:number;[column:string]:number|null}
const BAR_COLUMNS=[...FLOW_VENUES.flatMap(v=>['last','buy','sell','n','lag'].map(f=>`${v.col}_${f}`)),'bn_bid','bn_ask','bn_mark','bn_index','bn_funding'];
const emptyBar=(t:number):FlowBar=>Object.fromEntries([['t',t],...BAR_COLUMNS.map(c=>[c,null])]) as FlowBar;
/**
 * 250 ms bars in data/flow.db, keyed by bucket start in Kalshi's clock (local receive time + the engine's measured
 * offset), the same clock as the journal's ticks. *_last is the bucket's last trade (null when it had none), *_buy and
 * *_sell taker volume in BTC, *_lag the worst receive − exchange time in the bucket (includes clock error; compare
 * within a venue only). bn_bid/bn_ask: Binance's best quote at the bucket's last depth5 update.
 */
export const FLOW_SCHEMA=`CREATE TABLE IF NOT EXISTS flow_bars(t INTEGER PRIMARY KEY,${BAR_COLUMNS.map(c=>`${c} ${c.endsWith('_n')||c.endsWith('_lag')?'INTEGER':'REAL'}`).join(',')});
  CREATE TABLE IF NOT EXISTS flow_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`;
export const FLOW_INSERT=`INSERT OR REPLACE INTO flow_bars(t,${BAR_COLUMNS.join(',')}) VALUES(?${',?'.repeat(BAR_COLUMNS.length)})`;
export const barValues=(b:FlowBar)=>[b.t,...BAR_COLUMNS.map(c=>b[c]??null)];

export type FlowVerdict='confirmed'|'fighting'|'mixed'|'unknown';
export const FLOW_LABELS:Record<FlowVerdict,string>={confirmed:'FLOW CONFIRMED — HOLD TO SETTLEMENT',fighting:'FIGHTING THE FLOW',mixed:'FLOW MIXED',unknown:'FLOW UNKNOWN'};
/**
 * Does taker flow back a direction? Votes: Coinbase spot and the perps' 60 s taker-buy share (≥ 55% up, ≤ 45% down, on
 * enough volume) and the perp's 1 s impulse. Confirmed: spot and perps both agree and the impulse is not against.
 * Fighting: at least two votes against and none for. Untested rule; the wording is the user's (2026-11-02).
 */
export function flowAlignment(direction:string|null|undefined,p:FlowPulse|null|undefined):{verdict:FlowVerdict;label:string;votes:{spot:number|null;perp:number|null;impulse:number|null}}{
  const d=direction==='UP'||direction==='up'||direction==='yes'?1:direction==='DOWN'||direction==='down'||direction==='no'?-1:0;
  const votes={spot:p?.flow.spot.vote??null,perp:p?.flow.perp.vote??null,impulse:p?.lead.impulse??null};
  if(!p||!p.healthy||!d||votes.spot===null||votes.perp===null)return {verdict:'unknown',label:FLOW_LABELS.unknown,votes};
  const all=[votes.spot,votes.perp,votes.impulse??0],against=all.filter(v=>v===-d).length,support=all.filter(v=>v===d).length;
  const verdict:FlowVerdict=votes.spot===d&&votes.perp===d&&votes.impulse!==-d?'confirmed':against>=2&&support===0?'fighting':'mixed';
  return {verdict,label:FLOW_LABELS[verdict],votes};
}
