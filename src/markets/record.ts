import type {RealEvent} from '../engine/guardrails';
import {rollupMarkets} from '../engine/analytics';
import {wilson} from '../engine/model/opening';
import {takerFee} from '../engine/model/fees';
import {clusterCI} from '../backtest/sim';
import type {BackfillRow} from './journal';
export const ACCURACY_EDGES=[0,.05,.1,.2,.35,.5,.65,.8,.9,.95,1],ENTRY_EDGES=[0,.05,.2,.5,.8,1];
const ENTRY_LABELS=['0–5¢','5–20¢','20–50¢','50–80¢','80–100¢'];
export type Horizon='p1'|'p24'|'vwap';
export interface AccuracyBucket {lo:number;hi:number;n:number;events:number;price:number|null;win:number|null;low:number|null;high:number|null;ret:number|null;retLow:number|null;retHigh:number|null;noRet:number|null;noRetLow:number|null;noRetHigh:number|null}
const askOf=(r:BackfillRow,h:Horizon)=>h==='p1'?r.a1:h==='p24'?r.a24:null;
/** NO costs 1 − YES bid; the bid is 2 × mid − ask (the volume-weighted horizon has no book: 1 − the average price). */
const noAskOf=(r:BackfillRow,h:Horizon)=>{const mid=r[h],ask=askOf(r,h);if(mid===null)return null;const bid=ask===null?mid:2*mid-ask;return 1-bid;};
const ret=(won:boolean,ask:number)=>{const cost=ask+takerFee(ask);return ((won?1:0)-cost)/cost;};
/**
 * How often contracts priced in each band actually won (Wilson 95%), and what buying YES at the ask returned per $1 after the
 * taker fee (bootstrap 95% over events, because both sides of a game or the strikes of one ladder move together). The
 * volume-weighted horizon has no ask, so its return uses the average traded price.
 */
export function accuracy(rows:BackfillRow[],h:Horizon):AccuracyBucket[]{
  return ACCURACY_EDGES.slice(0,-1).map((lo,i)=>{
    const hi=ACCURACY_EDGES[i+1],last=i===ACCURACY_EDGES.length-2;
    const xs=rows.filter(r=>{const p=r[h];return p!==null&&p>=lo&&(p<hi||last&&p<=hi);});
    const wins=xs.filter(r=>r.result==='yes').length,w=wilson(wins,xs.length);
    // Each side scored on its own: YES at the ask, NO at 1 − bid, both after the taker fee, ranges resampling events.
    const side=(ask:(r:BackfillRow)=>number|null,won:(r:BackfillRow)=>boolean)=>{const clusters=new Map<string,{sum:number;n:number}>();let total=0,count=0;
      for(const r of xs){const a=ask(r);if(a===null||!(a>0&&a<1))continue;const x=ret(won(r),a),c=clusters.get(r.event)??{sum:0,n:0};c.sum+=x;c.n++;clusters.set(r.event,c);total+=x;count++;}
      const [lo,hi]=clusterCI([...clusters.values()]);return {mean:count?total/count:null,low:Number.isFinite(lo)?lo:null,high:Number.isFinite(hi)?hi:null};};
    const yes=side(r=>askOf(r,h)??r[h],r=>r.result==='yes'),no=side(r=>noAskOf(r,h),r=>r.result==='no');
    return {lo,hi,n:xs.length,events:new Set(xs.map(r=>r.event)).size,price:xs.length?xs.reduce((s,r)=>s+r[h]!,0)/xs.length:null,win:xs.length?wins/xs.length:null,low:w.low,high:w.high,
      ret:yes.mean,retLow:yes.low,retHigh:yes.high,noRet:no.mean,noRetLow:no.low,noRetHigh:no.high};
  });
}
export interface RecordLine {bucket:string;markets:number;wins:number;winRate:number|null;pnl:number;spent:number;ret:number|null}
const line=(bucket:string,ms:{pnl:number;spent:number}[]):RecordLine=>{
  const pnl=ms.reduce((s,m)=>s+m.pnl,0),spent=ms.reduce((s,m)=>s+m.spent,0),wins=ms.filter(m=>m.pnl>0).length;
  return {bucket,markets:ms.length,wins,winRate:ms.length?wins/ms.length:null,pnl,spent,ret:spent>0?pnl/spent:null};
};
/** Your settled non-Bitcoin markets: P&L, win rate and return on money spent (entry cost + fees), by group and entry price. */
export function yourRecord(events:RealEvent[],fills:any[],groupFor:(ticker:string)=>string){
  const fees=new Map<string,number>();for(const f of fills){const t=f.ticker??f.market_ticker;fees.set(t,(fees.get(t)??0)+(Number(f.fee_cost)||0));}
  const ms=rollupMarkets(events,fees,[]).filter(m=>m.status==='settled').map(m=>({...m,group:groupFor(m.ticker),spent:m.contracts*(m.avgEntry??0)+m.fees}));
  const groups=[...new Set(ms.map(m=>m.group))].sort();
  const entry=(xs:typeof ms)=>ENTRY_EDGES.slice(0,-1).map((lo,i)=>{const hi=ENTRY_EDGES[i+1];return line(ENTRY_LABELS[i],xs.filter(m=>m.avgEntry!==null&&m.avgEntry>=lo&&(m.avgEntry<hi||hi===1)));});
  return {byGroup:groups.map(g=>line(g,ms.filter(m=>m.group===g))),byEntry:entry(ms),entryBy:Object.fromEntries(groups.map(g=>[g,entry(ms.filter(m=>m.group===g))])) as Record<string,RecordLine[]>,total:line('All',ms)};
}
export type AccuracyTables=Record<'all'|'sports'|'politics'|'commodities',Record<Horizon,AccuracyBucket[]>>;
/** Every category × horizon table. Seconds of work on a large backfill, so the backfill process computes it once when it finishes. */
export function accuracyTables(rows:BackfillRow[]):AccuracyTables{
  const by=(xs:BackfillRow[])=>({p1:accuracy(xs,'p1'),p24:accuracy(xs,'p24'),vwap:accuracy(xs,'vwap')});
  return {all:by(rows),sports:by(rows.filter(r=>r.grp==='sports')),politics:by(rows.filter(r=>r.grp==='politics')),commodities:by(rows.filter(r=>r.grp==='commodities'))};
}
export interface RecordState {yours:ReturnType<typeof yourRecord>;accuracy:AccuracyTables;backfill:{markets:number;priced:number;from:number|null;to:number|null;finished:number|null}}
export function buildRecord(a:{accuracy:AccuracyTables|null;events:RealEvent[];fills:any[];groupFor:(t:string)=>string;stats:{markets:number;priced:number;from:number|null;to:number|null};finished:number|null}):RecordState{
  return {yours:yourRecord(a.events,a.fills,a.groupFor),accuracy:a.accuracy??accuracyTables([]),backfill:{...a.stats,finished:a.finished}};
}
export interface SourceComparison {source:string;n:number;brierKalshi:number;brierRef:number;diff:number;low:number|null;high:number|null}
/** Brier score (lower is better) of Kalshi vs each outside source on the same settled markets; diff = outside − Kalshi, with a bootstrap 95% range over markets. */
export function compareSources(pairs:{ticker:string;source:string;y:0|1;kalshi:number;ref:number}[]):SourceComparison[]{
  return [...new Set(pairs.map(p=>p.source))].map(source=>{const xs=pairs.filter(p=>p.source===source),n=xs.length;
    const bk=xs.reduce((s,p)=>s+(p.kalshi-p.y)**2,0)/n,br=xs.reduce((s,p)=>s+(p.ref-p.y)**2,0)/n,[l,u]=clusterCI(xs.map(p=>({sum:(p.ref-p.y)**2-(p.kalshi-p.y)**2,n:1})));
    return {source,n,brierKalshi:bk,brierRef:br,diff:br-bk,low:Number.isFinite(l)?l:null,high:Number.isFinite(u)?u:null};});
}
