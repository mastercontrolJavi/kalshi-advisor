import {baseFees,type FeeSchedule} from '../engine/model/fees';
import type {OpenCost} from '../engine/account';
import type {RealEvent} from '../engine/guardrails';
import type {ExitConfig} from '../engine/exits';
import type {Group,Quote} from './types';
import {comboView,type ComboView} from './combos';
import {positionView,type MarketMemory,type PositionView} from './holdsell';
import {groupOf,isBitcoin,seriesOf} from './categories';
import {sideLabel} from './quotes';
import type {Reference} from './references';
export interface PositionCard extends PositionView {title:string;marketTitle:string;group:Group;closeTime:number|null;expectedExpiration:number|null;combo:ComboView|null;spark:{t:number;mid:number}[];seriesTicker:string}
export interface MarketsState {time:number;status:'live'|'no-credentials'|'starting';error:string|null;positions:PositionCard[];bitcoin:number;summary:{count:number;atRisk:number;sellAll:number|null;holdAll:number|null;realizedToday:number|null};synced:{positions:number|null;quotes:number|null}}
/** One card per open non-Bitcoin position, most urgent first; returns the per-position memory for the next pass. */
export function buildPositions(a:{positions:any[];quotes:Map<string,Quote>;series:Map<string,{category:string|null;schedule:FeeSchedule}>;open:Map<string,OpenCost>;cfg:ExitConfig;memory:Map<string,MarketMemory>;now:number;spark:(ticker:string)=>{t:number;mid:number}[];reference?:(ticker:string)=>Reference|null}){
  const refFor=a.reference??(()=>null);
  const cards:PositionCard[]=[],memory=new Map<string,MarketMemory>();
  for(const p of a.positions){const ticker=String(p.ticker);if(isBitcoin(ticker))continue;
    const q=a.quotes.get(ticker)??null,info=a.series.get(seriesOf(ticker)),combo=q?.legs?comboView(q.legs,a.quotes,refFor):null;
    const r=positionView({position:p,quote:q,combo,open:a.open.get(ticker),schedule:info?.schedule??baseFees,cfg:a.cfg,memory:a.memory.get(ticker),now:a.now,reference:combo?null:refFor(ticker)});if(!r)continue;
    memory.set(ticker,r.memory);
    cards.push({...r.view,title:combo?`${combo.legs.length}-leg combo`:q?sideLabel(q,r.view.side):ticker,marketTitle:combo?combo.legs.map(l=>l.label).join(' · '):q?.title??'',
      group:groupOf(info?.category,!!q?.legs),closeTime:q?.closeTime??null,expectedExpiration:q?.expectedExpiration??null,combo,spark:a.spark(ticker),seriesTicker:seriesOf(ticker)});}
  // Most urgent first: a standing notice, then the largest amount at risk.
  cards.sort((x,y)=>Number(!!y.notice)-Number(!!x.notice)||(y.contracts*(y.avgCost??0))-(x.contracts*(x.avgCost??0)));
  return {cards,memory};
}
const sum=(xs:(number|null)[])=>xs.some(x=>x===null)?null:xs.reduce((s:number,x)=>s+(x as number),0);
export function summarize(cards:PositionCard[],events:RealEvent[],today:string,dayOf:(t:number)=>string):MarketsState['summary']{
  return {count:cards.length,atRisk:cards.reduce((s,c)=>s+c.contracts*(c.avgCost??0),0),sellAll:sum(cards.map(c=>c.verdict==='DEAD'?0:c.unrealized)),holdAll:sum(cards.map(c=>c.holdValue)),
    realizedToday:events.filter(e=>dayOf(e.time)===today).reduce((s,e)=>s+e.pnl,0)};
}
/** A combo's own book is nearly empty, so its price line tracks the legs' combined value, stored under `<ticker>#legs`. */
export const sparkKey=(q:Quote|undefined|null,ticker=q?.ticker??'')=>q?.legs?ticker+'#legs':ticker;
/** The 30-s snapshot: every polled quote (all are held markets or legs of held combos), plus each combo's leg value. */
export function snapshotRows(quotes:Map<string,Quote>,cards:PositionCard[],now:number){
  const rows=[...quotes.values()].map(q=>({ticker:q.ticker,time:now,yesBid:q.yesBid,yesAsk:q.yesAsk,last:q.last,volume24h:q.volume24h,held:true}));
  for(const c of cards)if(c.combo?.value!=null)rows.push({ticker:c.ticker+'#legs',time:now,yesBid:null,yesAsk:null,last:c.combo.value,volume24h:null,held:true});
  return rows;
}
/** The price line changes only with each 30-s snapshot; the 1-s build reads it from SQLite at most that often. */
export function sparkCache(read:(ticker:string)=>{t:number;mid:number}[],ttlMs=30000){
  const cache=new Map<string,{at:number;points:{t:number;mid:number}[]}>();
  return (ticker:string,now:number)=>{const hit=cache.get(ticker);if(hit&&now-hit.at<ttlMs)return hit.points;const points=read(ticker);cache.set(ticker,{at:now,points});return points;};
}
