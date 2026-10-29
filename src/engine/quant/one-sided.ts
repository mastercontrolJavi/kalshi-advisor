import {MAX_BOOK_DELAY_MS,type Level} from '../feeds/orderbook';

/** Bounds of the diffusion model's probability (model/math.ts). A value on a bound is censored: the unclipped value may be
 * far more extreme, so it cannot price a 0.1¢ longshot. On 2026-10-28 all 262 one-sided checkpoints sat exactly on a bound. */
export const PROBABILITY_CLIP={low:.01,high:.99} as const;
/** Highest bid recorded on KXBTC15M (0.1¢ ticks near the extremes). The market's tick structure is not recorded, so a book bid
 * at a lower ceiling (1¢ ticks) is classed as one-sided rather than pinned, the conservative label. */
export const PRICE_CEILING=.999;
export type BookSides='two-sided'|'pinned'|'one-sided'|'empty';
export interface BookSidesView {kind:BookSides;present:'yes'|'no'|null;executable:'yes'|'no'|null;bestBid:number|null}

/** Kalshi books are two bid ladders and buying a side consumes the other side's bids, so with one ladder only the opposite
 * side can be bought. Pinned: that ladder's best bid is at the ceiling, so no bid on the other side can rest without crossing
 * it and trading at once. The empty ladder is then structurally absent, not missing data (2026-10-28 study). */
export function bookSides(book:{yes:readonly Level[];no:readonly Level[]},ceiling=PRICE_CEILING):BookSidesView{
  const best=(levels:readonly Level[])=>levels.length?Math.max(...levels.map(l=>l[0])):null,yesBid=best(book.yes),noBid=best(book.no);
  if(yesBid!==null&&noBid!==null)return {kind:'two-sided',present:null,executable:null,bestBid:null};
  if(yesBid===null&&noBid===null)return {kind:'empty',present:null,executable:null,bestBid:null};
  const present=yesBid!==null?'yes':'no',bestBid=(yesBid??noBid)!;
  return {kind:bestBid>=ceiling-1e-9?'pinned':'one-sided',present,executable:present==='yes'?'no':'yes',bestBid};
}
export const censoredProbability=(p:number)=>p<=PROBABILITY_CLIP.low+1e-12||p>=PROBABILITY_CLIP.high-1e-12;

export interface CapturedBook {time:number;valid:boolean;delayMs:number|null;clockOffset:number;yes:Level[];no:Level[]}
/** One public Kalshi trade. time is the exchange's created_time; takerSide is the side the taker bought. */
export interface PublicTrade {time:number;yesPrice:number;takerSide:'yes'|'no';count:number}
export interface PinnedRun {present:'yes'|'no';from:number;to:number;snapshots:number}
/** Consecutive pinned captures on the same side, in exchange time (capture time + clock offset − transport delay), shrunk by
 * marginMs at both ends for capture spacing and delay error. A gap over maxGapMs ends a run: nothing is assumed in between. */
export function pinnedRuns(books:readonly CapturedBook[],marginMs=500,maxGapMs=1500,ceiling=PRICE_CEILING):PinnedRun[]{
  const runs:PinnedRun[]=[];let start:CapturedBook|null=null,last:CapturedBook|null=null,present:'yes'|'no'|null=null,count=0;
  const close=()=>{if(start&&last&&present){const from=start.time+start.clockOffset-start.delayMs!+marginMs,to=last.time+last.clockOffset-last.delayMs!-marginMs;if(to>from)runs.push({present,from,to,snapshots:count});}start=last=present=null;count=0;};
  for(const b of [...books].sort((a,b)=>a.time-b.time)){
    const usable=b.valid&&b.delayMs!==null&&Number.isFinite(b.delayMs)&&b.delayMs>=0&&b.delayMs<=MAX_BOOK_DELAY_MS&&Number.isFinite(b.clockOffset)&&Number.isFinite(b.time);
    const view=usable?bookSides(b,ceiling):null,side=view?.kind==='pinned'?view.present:null;
    if(start&&(side!==present||b.time-last!.time>maxGapMs))close();
    if(side){if(!start){start=b;present=side;}last=b;count++;}
  }
  close();return runs;
}
export interface TapeCheck {runs:number;pinnedSeconds:number;trades:number;longshotTaker:number;belowCeiling:number;favouriteTaker:number;favouriteContracts:number}
/** Against a pinned book the only possible trade is a taker buying the longshot from the favourite's bids, at the ceiling or
 * deeper when it sweeps. A taker buying the favourite needs a resting longshot bid, so the book was not pinned at that moment.
 * The tape only shows liquidity that traded: a quote cancelled before anyone hit it cannot be detected this way. */
export function tapeCheck(runs:readonly PinnedRun[],trades:readonly PublicTrade[],ceiling=PRICE_CEILING):TapeCheck{
  const result:TapeCheck={runs:runs.length,pinnedSeconds:runs.reduce((s,r)=>s+(r.to-r.from)/1000,0),trades:0,longshotTaker:0,belowCeiling:0,favouriteTaker:0,favouriteContracts:0};
  for(const t of trades){
    const run=runs.find(r=>t.time>=r.from&&t.time<=r.to);if(!run||!Number.isFinite(t.yesPrice)||(t.takerSide!=='yes'&&t.takerSide!=='no'))continue;
    result.trades++;
    if(t.takerSide===run.present){result.favouriteTaker++;result.favouriteContracts+=Number.isFinite(t.count)?t.count:0;continue;}
    result.longshotTaker++;if((run.present==='yes'?t.yesPrice:1-t.yesPrice)<ceiling-1e-9)result.belowCeiling++;
  }
  result.pinnedSeconds=Math.round(result.pinnedSeconds*1000)/1000;result.favouriteContracts=Math.round(result.favouriteContracts*100)/100;
  return result;
}
