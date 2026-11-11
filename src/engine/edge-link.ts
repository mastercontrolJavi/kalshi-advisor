import {dayKey,type RealEvent} from './guardrails';
import {median} from './feeds/proxy';
/**
 * Link to the edge sidecar (edge/, Python, 127.0.0.1:EDGE_PORT; DECISIONS 75). Once per new second the engine posts a
 * snapshot to /tick and caches the reply on state.edge. Fire-and-forget with a 300 ms timeout: the loop never awaits
 * it. No good reply for 2 s = OFFLINE, and real KXBTC15M orders are blocked (fail closed). Other markets only see the
 * daily/weekly stop on your real P&L, from the last reply (stale allowed: stops are day-level).
 */
export const EDGE_TIMEOUT_MS=300,EDGE_OFFLINE_MS=2000,EDGE_STOP_MAX_AGE_MS=15*60000,EDGE_SERIES='KXBTC15M';
const ET='America/New_York';
export interface EdgeReply {action:'TRADE'|'NO_EDGE'|'BLOCKED'|'MODEL_DISAGREE';side:'yes'|'no'|null;ask:number|null;q:number|null;edge:number|null;contracts:number;reason:string;
  p_base:number|null;p_engine:number|null;regime:string|null;sigma:number|null;status:string;ticker:string;ts:number;
  /** The pure EV gate sized on the live Kalshi balance: what the real-order veto reads. A notional EDGE_BANKROLL only
   * changes shadow_gate and the top-level (paper) decision. */
  gate:{action:string;side:'yes'|'no'|null;ask:number|null;edge:number|null;contracts:number;reason:string};
  real_risk:{allowed:boolean;reason:string;stop_hit:boolean;stop_reason:string|null};unsettled?:string[];[k:string]:unknown}
/** ageMs: age of the last decision (/tick reply); aliveMs: time since the sidecar last answered anything (tick or health). */
export interface EdgeView extends Partial<EdgeReply> {status:string;receivedAt:number|null;ageMs:number|null;aliveMs:number|null;error:string|null;sent:number;failures:number}

/**
 * Spot for the edge layer: Kalshi's BRTI 1-s print when fresh, else the median of Coinbase/Kraken/Bitstamp (degraded).
 * spotTime is the print's own timestamp. About a third of the time the print for the current second has not arrived
 * when the tick goes out, so the newest print is last second's: the sidecar must know that, or it would treat a print
 * that has not happened yet as already known (PR #12 review). null for the proxy, which is never a settlement print.
 */
export function edgeSpot(brti:{time:number;price:number}|null,venues:{name:string;mid:number|null;healthy:boolean}[],time:number,basis=0){
  if(brti&&brti.price>0&&time-brti.time<=2000)return {spot:brti.price,source:'brti' as const,degraded:false,carried:brti.time<time-1000,venues:null as number|null,spotTime:brti.time as number|null};
  const mids=venues.filter(v=>v.healthy&&v.mid!==null&&['Coinbase','Kraken','Bitstamp'].includes(v.name)).map(v=>v.mid!),m=median(mids);
  return {spot:m===null?null:m+basis,source:'proxy' as const,degraded:true,carried:false,venues:mids.length,spotTime:null as number|null};
}

/** Monday of the ET week containing `day` (YYYY-MM-DD). */
const weeks=new Map<string,string>();
const weekOf=(day:string)=>{let w=weeks.get(day);if(w===undefined){const d=new Date(day+'T12:00:00Z'),dow=(d.getUTCDay()+6)%7;d.setUTCDate(d.getUTCDate()-dow);w=d.toISOString().slice(0,10);if(weeks.size>5000)weeks.clear();weeks.set(day,w);}return w;};
/**
 * Your real book for the governor, in US Eastern days/weeks: P&L, start-of-day/week account value, KXBTC15M windows
 * traded. `events` should be every market's P&L (Account.allMarketEvents) so a copied sports loss counts toward the stop.
 * `reserved`: KXBTC15M windows with a real order in flight or filled but not yet synced from Kalshi (WindowReservations).
 */
export function realBook(events:RealEvent[],accountValue:number|null,ticker:string|null,now:number,reserved:Iterable<string>=[]){
  const today=dayKey(now,ET),week=weekOf(today);let day=0,wk=0;const windows=new Set<string>();let inWindow=false;
  for(const e of events){const d=dayKey(e.time,ET);
    if(d===today)day+=e.pnl;if(weekOf(d)===week)wk+=e.pnl;
    if(e.type==='fill'&&(e.action??'buy')==='buy'&&e.ticker.startsWith(EDGE_SERIES)){if(d===today)windows.add(e.ticker);if(e.ticker===ticker)inWindow=true;}}
  for(const t of reserved){windows.add(t);if(t===ticker)inWindow=true;}
  const value=accountValue??0;
  return {day_pnl:day,week_pnl:wk,start_day:value-day,start_week:value-wk,windows_today:windows.size,in_window:inWindow};
}

export class EdgeLink {
  private last:EdgeReply|null=null;private receivedAt:number|null=null;private aliveAt:number|null=null;private error:string|null=null;private sent=0;private failures=0;private inFlight=false;
  constructor(readonly url:string,private log:(event:string,data:unknown)=>void=()=>{},private onReply:(r:EdgeReply)=>void=()=>{},private fetchFn:typeof fetch=fetch){}
  /** Never awaited by the loop; one request at a time (a slow sidecar skips seconds rather than piling up). */
  tick(snapshot:Record<string,unknown>){
    if(this.inFlight)return;this.inFlight=true;this.sent++;
    void this.fetchFn(this.url+'/tick',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot),signal:AbortSignal.timeout(EDGE_TIMEOUT_MS)})
      .then(async r=>{const body=await r.json();if(!r.ok)throw new Error(String(body?.error??r.status));this.last=body;this.receivedAt=this.aliveAt=Date.now();
        if(this.error){this.log('edge-online',{after:this.error});this.error=null;}this.onReply(body);})
      .catch(e=>{this.failures++;const message=(e as Error).name==='TimeoutError'?'timeout (300 ms)':(e as Error).message;
        if(this.error!==message)this.log('edge-error',{message});this.error=message;})
      .finally(()=>{this.inFlight=false;});
  }
  /** Between windows there is nothing to price: a /health ping keeps OFFLINE meaning "the sidecar is down". */
  ping(){
    if(this.inFlight)return;this.inFlight=true;
    void this.fetchFn(this.url+'/health',{signal:AbortSignal.timeout(EDGE_TIMEOUT_MS)}).then(r=>{if(!r.ok)throw new Error('health '+r.status);this.aliveAt=Date.now();
        if(this.error){this.log('edge-online',{after:this.error});this.error=null;}})
      .catch(e=>{this.failures++;const message=(e as Error).name==='TimeoutError'?'timeout (300 ms)':(e as Error).message;if(this.error!==message)this.log('edge-error',{message});this.error=message;})
      .finally(()=>{this.inFlight=false;});
  }
  settle(body:{ticker:string;result:'yes'|'no';expiration_value:number|null;proxy_avg:number|null}){
    void this.fetchFn(this.url+'/settle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(2000)})
      .then(r=>{if(!r.ok)throw new Error('settle '+r.status);}).catch(e=>this.log('edge-settle-error',{ticker:body.ticker,message:(e as Error).message}));
  }
  view(now=Date.now()):EdgeView{
    const age=this.receivedAt===null?null:now-this.receivedAt,alive=this.aliveAt===null?null:now-this.aliveAt,offline=alive===null||alive>EDGE_OFFLINE_MS;
    return {...(this.last??{}),status:offline?'OFFLINE':age!==null&&age<=EDGE_OFFLINE_MS?this.last?.status??'OK':'IDLE',receivedAt:this.receivedAt,ageMs:age,aliveMs:alive,error:this.error,sent:this.sent,failures:this.failures};
  }
}

/**
 * The veto in front of real orders (DECISIONS 75). KXBTC15M: the sidecar must be online with a decision for this market,
 * its EV gate must say TRADE on the same side, and the governor must allow your real book. Other markets: only the
 * daily/weekly stop on your real P&L. Returns the reason to refuse, or null.
 */
export function realOrderVeto(ticker:string,side:'yes'|'no',v:EdgeView,now=Date.now(),order?:{limit:number;count:number}):string|null{
  if(ticker.startsWith(EDGE_SERIES)){
    if(v.status==='OFFLINE')return `Edge layer offline${v.error?` (${v.error})`:''}: real KXBTC15M orders are blocked`;
    if(v.ticker!==ticker||v.ageMs===null||v.ageMs>EDGE_OFFLINE_MS)return 'Edge layer has no current decision for this market';
    if(!v.gate||v.gate.action!=='TRADE')return `Edge gate: ${v.gate?.action??'NO_EDGE'} · ${v.gate?.reason??v.reason??'no decision'}`;
    if(v.gate.side!==side)return `Edge gate favours ${String(v.gate.side).toUpperCase()}, not ${side.toUpperCase()}`;
    // The order must match what the gate approved: never a worse price (a walked book) or a bigger size.
    if(order){const ask=v.gate.ask,n=v.gate.contracts;
      if(typeof ask!=='number'||!Number.isFinite(ask)||order.limit>ask+1e-9)return `Edge gate priced ${side.toUpperCase()} at ${typeof ask==='number'&&Number.isFinite(ask)?(ask*100).toFixed(1):'?'}¢; this order could pay up to ${(order.limit*100).toFixed(1)}¢`;
      if(typeof n!=='number'||!Number.isFinite(n)||order.count>n)return `Edge gate sized this at ${n} contracts; this order is ${order.count}`;}
    if(!v.real_risk?.allowed)return `Risk governor: ${v.real_risk?.reason??'not allowed'}`;
    return null;
  }
  if(v.real_risk?.stop_hit&&v.receivedAt!==null&&now-v.receivedAt<=EDGE_STOP_MAX_AGE_MS)return `Risk governor: ${v.real_risk.stop_reason}`;
  return null;
}

/**
 * One real order per KXBTC15M window, enforced locally (PR #9 review): the governor learns of a fill only after Kalshi
 * reports it and the account syncs, so two quick confirmations could both pass the veto. A window is reserved
 * synchronously between the veto and the send; it is released only when Kalshi answers that nothing filled, and kept
 * (until the window is long closed) when anything filled or the send failed, since a timed-out order may still exist.
 * Reservations are persisted (PR #10 review) so an engine restart between Kalshi accepting an order and the fill
 * syncing cannot forget one; the engine also refuses KXBTC15M real orders until its first account sync after start.
 */
export const RESERVATION_MS=20*60000;
export interface ReservationStore {load():Record<string,number>;save(held:Record<string,number>):void}
export class WindowReservations {
  private held=new Map<string,number>();
  constructor(private store?:ReservationStore){
    const saved=store?.load()??{};
    for(const [t,at] of Object.entries(saved))if(typeof t==='string'&&Number.isFinite(at))this.held.set(t,at);
  }
  has(ticker:string,now=Date.now()){this.prune(now);return this.held.has(ticker);}
  /** False if the window is already reserved. Saved before returning, so the reservation survives a crash mid-send. */
  reserve(ticker:string,now=Date.now()){this.prune(now);if(this.held.has(ticker))return false;this.held.set(ticker,now);this.save();return true;}
  release(ticker:string){if(this.held.delete(ticker))this.save();}
  tickers(now=Date.now()){this.prune(now);return [...this.held.keys()];}
  private prune(now:number){let changed=false;for(const [t,at] of this.held)if(now-at>RESERVATION_MS){this.held.delete(t);changed=true;}if(changed)this.save();}
  private save(){this.store?.save(Object.fromEntries(this.held));}
}

/**
 * realBook costs ~3 ms over ~2,000 account events, too much for every second of the engine loop. Its inputs change
 * only when the account syncs (a new events array), the minute turns (day/week boundaries fall on minutes), the window
 * changes, the account value moves, or a reservation is made, so the result is reused until one of those does.
 */
export class RealBookMemo {
  private events:RealEvent[]|null=null;private key='';private value:ReturnType<typeof realBook>|null=null;
  get(events:RealEvent[],accountValue:number|null,ticker:string|null,now:number,reserved:string[]=[]){
    const key=`${accountValue}|${ticker}|${Math.floor(now/60000)}|${reserved.join(',')}`;
    if(this.value===null||events!==this.events||key!==this.key){this.value=realBook(events,accountValue,ticker,now,reserved);this.events=events;this.key=key;}
    return this.value;
  }
}
