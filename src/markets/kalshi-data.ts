import {effectiveFees,type KalshiClient} from '../engine/feeds/kalshi';
import {baseFees,type FeeSchedule} from '../engine/model/fees';
import {normalizeAccount,type OpenCost} from '../engine/account';
import type {RealEvent} from '../engine/guardrails';
import type {MarketsJournal} from './journal';
import type {Quote} from './types';
import {parseMarket} from './quotes';
import {isBitcoin,groupOf,seriesOf} from './categories';
import {kalshiGameFrom,leagueOf,type KalshiEvent,type KalshiGame} from './match';
type Client=Pick<KalshiClient,'get'|'pages'|'authenticated'|'clockOffset'>;
const BATCH=50;
/** Read-only Kalshi data for Markets: your positions and fills, and quotes for every held market and combo leg. */
export class MarketsData {
  positions:any[]=[];quotes=new Map<string,Quote>();series=new Map<string,{category:string|null;schedule:FeeSchedule}>();open=new Map<string,OpenCost>();events:RealEvent[]=[];
  positionsUpdated=0;quotesUpdated=0;error:{account:string|null;quotes:string|null}={account:null,quotes:null};private busy=false;
  constructor(private client:Client,private journal:MarketsJournal,private log:(e:string,d:unknown)=>void){}
  private eventCache=new Map<string,KalshiEvent>();
  /** An event's title and team markets, fetched once (a failure is retried on the next call). */
  async eventInfo(eventTicker:string):Promise<KalshiEvent|null>{
    const hit=this.eventCache.get(eventTicker);if(hit)return hit;
    try{const r=await this.client.get('/events/'+encodeURIComponent(eventTicker));const ev={title:String(r.event?.title??''),markets:(r.markets??[]).map((m:any)=>({ticker:String(m.ticker),yes_sub_title:m.yes_sub_title}))};this.eventCache.set(eventTicker,ev);return ev;}
    catch(e){this.log('event-error',{eventTicker,message:(e as Error).message});return null;}
  }
  /** The sports-match description of a quote; totals borrow team names from the same game's GAME event. */
  async kalshiGame(q:Quote):Promise<KalshiGame|null>{
    if(!leagueOf(q.seriesTicker))return null;
    const ev=await this.eventInfo(q.eventTicker.replace(/^([A-Z0-9]+?)(TOTAL|SPREAD)-/,'$1GAME-'));return ev?kalshiGameFrom(q,ev):null;
  }
  /** Page group of any ticker: combos by structure, others by their series category (politics when unknown). */
  groupFor(ticker:string){return groupOf(this.series.get(seriesOf(ticker))?.category,ticker.startsWith('KXMVE'));}
  held(){return this.positions.filter(p=>!isBitcoin(String(p.ticker))&&Math.abs(Number(p.position_fp))>1e-9);}
  async syncAccount(){
    if(!this.client.authenticated||this.busy)return;this.busy=true;
    try{
      this.positions=await this.client.pages('/portfolio/positions','market_positions');this.positionsUpdated=Date.now();
      const fills=await this.client.pages('/portfolio/fills','fills');
      if(!this.journal.get('historicalBackfill',false))fills.push(...await this.client.pages('/historical/fills','fills'));
      const settlements=await this.client.pages('/portfolio/settlements','settlements');
      this.journal.putRaw(fills,settlements);this.journal.set('historicalBackfill',true);
      const raw=this.journal.raw(),open=new Map<string,OpenCost>();
      this.events=normalizeAccount(raw.fills,raw.settlements,t=>!isBitcoin(t),open);this.open=open;this.error.account=null;
      // The Record tab groups past trades by category: look up each traded series once.
      for(const t of new Set(raw.fills.map((f:any)=>String(f.ticker??f.market_ticker)).filter((t:string)=>!isBitcoin(t))))await this.seriesInfo(seriesOf(t),t.split('-').slice(0,2).join('-'));
    }catch(e){this.error.account=(e as Error).message;this.log('account-error',{message:this.error.account});}finally{this.busy=false;}
  }
  private async fetch(tickers:string[],now:number){
    for(let k=0;k<tickers.length;k+=BATCH){const chunk=tickers.slice(k,k+BATCH);
      const {markets}=await this.client.get('/markets?tickers='+encodeURIComponent(chunk.join(','))+'&limit='+BATCH);
      for(const m of markets??[]){const q=parseMarket(m,now);this.quotes.set(q.ticker,q);await this.seriesInfo(q.seriesTicker,q.eventTicker);
        const info=this.series.get(q.seriesTicker);this.journal.upsertMarket(q,info?.category??null,groupOf(info?.category,!!q.legs));}}
  }
  /** Category and fee type per series, fetched once. Per-event fee changes are not applied (stage 1). */
  private async seriesInfo(series:string,event:string){
    if(this.series.has(series))return;
    try{const {series:s}=await this.client.get('/series/'+encodeURIComponent(series));const schedule=effectiveFees(s,[],event,Date.now()+this.client.clockOffset);this.series.set(series,{category:s?.category??null,schedule:schedule.verified?schedule:baseFees});}
    catch(e){this.log('series-error',{series,message:(e as Error).message});this.series.set(series,{category:null,schedule:baseFees});}
  }
  /** Held markets first, then the legs of any held combo (known only once the combo's own quote arrives). */
  async pollQuotes(now:number){
    try{
      const held=this.held().map(p=>String(p.ticker));await this.fetch(held,now);
      const legs=[...new Set(held.flatMap(t=>this.quotes.get(t)?.legs??[]).map(l=>l.marketTicker))];await this.fetch(legs,now);
      this.quotesUpdated=now;this.error.quotes=null;
    }catch(e){this.error.quotes=(e as Error).message;this.log('quotes-error',{message:this.error.quotes});}
  }
}
