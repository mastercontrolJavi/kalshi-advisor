import type {KalshiClient} from '../engine/feeds/kalshi';
import type {MarketsJournal} from './journal';
import type {Group,Quote} from './types';
import {parseMarket} from './quotes';
import {groupOf} from './categories';
import {words,similarSets} from './similarity';
const LINK_MIN=.8;
import {sharpLeaderboard,type FalconPost,type SharpWallet} from './sources/falcon';
import {walletPositions,cryptoLeaders,marketTrades,type FetchJson,type PmPosition,type PmTrade} from './sources/pmdata';
import {btcRound} from './sources/polymarket';
import {aggregate,kalshiSide,sharpFlags,lean,kalshiBtcTicker,leanStats,LEAN_HORIZONS,type SharpBet,type LeanStats} from './sharps';
import type {Flag} from './flags';
type Client=Pick<KalshiClient,'get'>;
const H=3600000,WALLETS_EVERY=6*H,POSITIONS_EVERY=10*60000,SNAP_EVERY=30*60000,FALCON_WALLETS=100,SHOWN=80;
export interface Health {name:string;ok:boolean;updated:number|null;error:string|null;detail:string}
export interface BetLink {ticker:string;side:'yes'|'no';status:string;title:string;yesBid:number|null;yesAsk:number|null;noAsk:number|null;url:string}
export interface BetView extends SharpBet {links:BetLink[];url:string}
export interface BtcView {round:number;ticker:string;slug:string|null;tau:number;upPrice:number|null;sharpNet:number;allNet:number;sharpWallets:number;sharpTrades:number;trades:number;updated:number|null;error:string|null;stats:LeanStats[]}
export interface SharpsState {updated:number|null;wallets:SharpWallet[];bets:BetView[];btc:BtcView|null;sources:Health[];counts:{wallets:number;crypto:number;positions:number;bets:number}}
/** Your side of a market you hold, as sharp wallets see it: on your side, against it. */
export interface SharpSummary {wallets:number;value:number;against:number;againstValue:number;side:'yes'|'no'}
/**
 * Sharp money, inside the markets process: Falcon's ranked traders every 6 h, their open Polymarket positions every 10 min,
 * the current 15-minute Bitcoin round's trades every 20 s. Polymarket positions are tied to Kalshi markets through the
 * existing sports matches (automatic) or a title link you confirm; copy flags are paper-scored like scanner flags, and the
 * Bitcoin lean is recorded at 10, 5, 2 and 1 minutes left and scored against Kalshi's result.
 */
export class SharpFeed {
  private wallets:SharpWallet[]=[];private crypto:SharpWallet[]=[];private positions:PmPosition[]=[];private bets:BetView[]=[];private byTicker=new Map<string,SharpSummary>();
  private at={wallets:0,positions:0,snap:0};private falcon={updated:null as number|null,error:null as string|null};private pm={updated:null as number|null,error:null as string|null};
  // Every open Kalshi market outside sports, crypto, financials, weather and mention markets (~40k), reloaded every 6 h,
  // for suggesting which Kalshi market a Polymarket one is. The local markets table only holds the scanner's busiest.
  private catalog:{at:number;rows:{ticker:string;title:string;words:Set<string>}[]}={at:0,rows:[]};
  private round:{start:number;info:Awaited<ReturnType<typeof btcRound>>;trades:PmTrade[];updated:number|null;error:string|null}|null=null;private busy=false;
  constructor(private journal:MarketsJournal,private o:{falcon?:FalconPost;pmData:FetchJson;gamma:FetchJson;client:Client;log:(e:string,d:unknown)=>void}){
    for(const w of journal.walletRows() as SharpWallet[])(w.source==='crypto'?this.crypto:this.wallets).push(w);this.at.wallets=journal.walletsUpdated()??0;
  }
  private get sharpSet(){return new Set([...this.wallets,...this.crypto].map(w=>w.address));}
  async refreshWallets(now:number){
    if(now-this.at.wallets<WALLETS_EVERY&&(this.wallets.length||!this.o.falcon))return;
    if(this.o.falcon){try{this.wallets=await sharpLeaderboard(this.o.falcon,FALCON_WALLETS);this.falcon={updated:now,error:null};}catch(e){this.falcon.error=(e as Error).message;this.o.log('falcon-error',{message:this.falcon.error});}}
    try{this.crypto=(await cryptoLeaders(this.o.pmData)).filter(w=>!this.wallets.some(x=>x.address===w.address));this.pm={updated:now,error:null};}catch(e){this.pm.error=(e as Error).message;this.o.log('pmdata-error',{message:this.pm.error});}
    this.journal.putWallets([...this.wallets,...this.crypto].map(w=>({address:w.address,source:w.source,rank:w.rank,tier:w.tier,context:w})),now);this.at.wallets=now;
    this.o.log('sharp-wallets',{falcon:this.wallets.length,crypto:this.crypto.length});
  }
  /** Positions of the Falcon-ranked wallets (the crypto list trades 15-minute rounds, which are covered by refreshBtc). */
  async refreshPositions(now:number){
    if(this.busy||now-this.at.positions<POSITIONS_EVERY||!this.wallets.length)return;this.busy=true;
    try{
      const all:PmPosition[]=[];let failed=0;
      for(const w of this.wallets){try{all.push(...await walletPositions(this.o.pmData,w.address));}catch{failed++;}}
      if(failed>this.wallets.length/2)throw new Error(`positions failed for ${failed} of ${this.wallets.length} wallets`);
      this.positions=all;this.pm={updated:now,error:null};this.at.positions=now;
      const bets=aggregate(all,new Map(this.wallets.map(w=>[w.address,w]))),shown=bets.filter(b=>b.wallets>=2).slice(0,SHOWN);
      await this.suggestLinks(shown,now);
      const tickers=[...new Set(shown.flatMap(b=>this.journal.linksForCond(b.cond).map(l=>l.ticker)))],quotes=await this.quotes(tickers,now);
      const flags:Flag[]=[],byTicker=new Map<string,SharpSummary>();
      this.bets=shown.map(b=>{
        const links=this.journal.linksForCond(b.cond).flatMap(l=>{const q=quotes.get(l.ticker);if(!q||q.result)return [];const side=kalshiSide(l.yesOutcome,b.outcome);
          const group:Group=groupOf(this.journal.categoryOf(q.seriesTicker),false),ask=side==='yes'?q.yesAsk:q.noAsk;
          flags.push(...sharpFlags(b,{ticker:q.ticker,event:q.eventTicker,group,side,ask,status:l.status},now,(t,type)=>this.journal.lastFlag(t,type)));
          const prev=byTicker.get(q.ticker),mine=prev??{wallets:0,value:0,against:0,againstValue:0,side:'yes' as const};
          // Per Kalshi ticker, sharp wallets and dollars on its YES vs its NO.
          if(side==='yes'){mine.wallets+=b.wallets;mine.value+=b.value;}else{mine.against+=b.wallets;mine.againstValue+=b.value;}byTicker.set(q.ticker,mine);
          return [{ticker:q.ticker,side,status:l.status,title:`${q.title}${q.yesLabel&&q.yesLabel!==q.title?` · ${q.yesLabel}`:''}`,yesBid:q.yesBid,yesAsk:q.yesAsk,noAsk:q.noAsk,url:`https://kalshi.com/markets/${q.seriesTicker.toLowerCase()}/x/${q.eventTicker.toLowerCase()}`}];});
        return {...b,links,url:b.eventSlug?`https://polymarket.com/event/${b.eventSlug}`:'https://polymarket.com'};});
      this.byTicker=byTicker;
      if(flags.length){this.journal.putFlags(flags);this.o.log('sharp-flags',{count:flags.length,tickers:flags.map(f=>f.ticker)});}
      if(now-this.at.snap>=SNAP_EVERY){this.at.snap=now;this.journal.putSharpSnaps(now,this.bets.map(b=>({cond:b.cond,outcome:b.outcome,title:b.title,wallets:b.wallets,value:b.value,avgEntry:b.avgEntry,curPrice:b.curPrice,against:b.against.wallets,ticker:b.links[0]?.ticker??null,side:b.links[0]?.side??null})));}
    }catch(e){this.pm.error=(e as Error).message;this.o.log('sharp-positions-error',{message:this.pm.error});}finally{this.busy=false;}
  }
  /** Yes/No Polymarket markets with no Kalshi tie yet: suggest the most similar open Kalshi market (politics, economics, other), once. */
  private async suggestLinks(bets:SharpBet[],now:number){
    const todo=bets.filter(b=>['yes','no'].includes(b.outcome.toLowerCase())&&!this.journal.linksForCond(b.cond).length&&!this.journal.hasLink(b.cond));if(!todo.length)return;
    await this.loadCatalog(now);
    for(const b of todo){const w=words(b.title);let best:{ticker:string;title:string;score:number}|null=null;
      for(const m of this.catalog.rows){const score=similarSets(w,m.words);if(!best||score>best.score)best={ticker:m.ticker,title:m.title,score};}
      // Higher bar than outside-price suggestions: a near miss here can invert the side ("controls the House" vs "loses majority").
      if(best&&best.score>=LINK_MIN)this.journal.suggestLink({cond:b.cond,ticker:best.ticker,yesOutcome:'Yes',score:best.score,title:best.title});}
  }
  private async loadCatalog(now:number){
    if(now-this.catalog.at<WALLETS_EVERY&&this.catalog.rows.length)return;
    const skip=new Set(['Sports','Crypto','Financials','Climate and Weather','Mentions']),rows:{ticker:string;title:string;words:Set<string>}[]=[];let cursor='',pages=0;
    try{do{const r=await this.o.client.get(`/events?status=open&with_nested_markets=true&limit=200${cursor?'&cursor='+encodeURIComponent(cursor):''}`);pages++;
        for(const e of r.events??[]){if(skip.has(e.category))continue;for(const m of e.markets??[]){const title=`${m.title??e.title}${m.yes_sub_title&&!String(m.title??'').includes(m.yes_sub_title)?` · ${m.yes_sub_title}`:''}`;rows.push({ticker:String(m.ticker),title,words:words(title)});}}
        cursor=r.cursor??'';}while(cursor&&pages<120);
      this.catalog={at:now,rows};this.o.log('kalshi-catalog',{markets:rows.length,pages});}
    catch(e){this.o.log('kalshi-catalog-error',{message:(e as Error).message});}
  }
  private async quotes(tickers:string[],now:number){
    const out=new Map<string,Quote>();
    for(let k=0;k<tickers.length;k+=50){const chunk=tickers.slice(k,k+50);try{const {markets}=await this.o.client.get('/markets?tickers='+encodeURIComponent(chunk.join(','))+'&limit=50');
      for(const m of markets??[]){const q=parseMarket(m,now);out.set(q.ticker,q);const cat=this.journal.categoryOf(q.seriesTicker);this.journal.upsertMarket(q,cat,groupOf(cat,false));}}catch(e){this.o.log('sharp-quotes-error',{message:(e as Error).message});}}
    return out;
  }
  /** The current 15-minute Bitcoin round on Polymarket: who is buying Up or Down, recorded at fixed times and scored on Kalshi. */
  async refreshBtc(nowMs:number){
    const now=Math.floor(nowMs/1000),start=Math.floor(now/900)*900,tau=start+900-now;
    try{
      if(!this.round||this.round.start!==start)this.round={start,info:null,trades:[],updated:null,error:null};
      // Re-read each time: the round's Up price comes with it.
      this.round.info=await btcRound(this.o.gamma,start)??this.round.info;
      if(!this.round.info){this.round.error='Polymarket round not listed yet';return;}
      this.round.trades=await marketTrades(this.o.pmData,this.round.info.cond);this.round.updated=nowMs;this.round.error=null;
      const due=LEAN_HORIZONS.find(h=>tau<=h&&tau>h-30&&!this.journal.leanHorizons(start).has(h));
      if(due!==undefined){const ticker=kalshiBtcTicker(start),l=lean(this.round.trades,this.sharpSet,now);let yesBid:number|null=null,yesAsk:number|null=null;
        try{const {market}=await this.o.client.get('/markets/'+encodeURIComponent(ticker));const q=parseMarket(market,nowMs);yesBid=q.yesBid;yesAsk=q.yesAsk;}catch(e){this.o.log('btc-lean-quote-error',{ticker,message:(e as Error).message});}
        this.journal.putLean({round:start,horizon:due,time:nowMs,ticker,upPrice:this.round.info.upPrice,sharpNet:l.sharpNet,allNet:l.allNet,sharpWallets:l.sharpWallets,yesBid,yesAsk});}
    }catch(e){if(this.round)this.round.error=(e as Error).message;this.o.log('btc-lean-error',{message:(e as Error).message});}
  }
  /** Kalshi's result for recorded rounds (public market data), so the lean can be scored. */
  async scoreBtc(now:number){
    for(const t of this.journal.unscoredLean(now)){try{const {market}=await this.o.client.get('/markets/'+encodeURIComponent(t));if(market?.result==='yes'||market?.result==='no')this.journal.scoreLean(t,market.result);}catch(e){this.o.log('btc-lean-score-error',{ticker:t,message:(e as Error).message});}}
  }
  /** Your ✓ / ✗ on a suggested link shows at once; a newly confirmed link can flag from the next positions refresh. */
  decided(cond:string,ticker:string,status:'confirmed'|'rejected'){
    this.bets=this.bets.map(b=>b.cond!==cond?b:{...b,links:status==='rejected'?b.links.filter(l=>l.ticker!==ticker):b.links.map(l=>l.ticker===ticker?{...l,status}:l)});
  }
  forTicker(ticker:string):SharpSummary|null{return this.byTicker.get(ticker)??null;}
  health(now=Date.now()):Health[]{
    return [{name:'Falcon',ok:!!this.o.falcon&&!this.falcon.error,updated:this.falcon.updated??(this.wallets.length?this.at.wallets:null),error:this.falcon.error,detail:!this.o.falcon?'no key':this.wallets.length?`${this.wallets.length} ranked traders`:'waiting for first use'},
      {name:'Polymarket wallets',ok:!this.pm.error,updated:this.pm.updated,error:this.pm.error,detail:this.at.positions?`positions ${Math.round((now-this.at.positions)/60000)} min ago`:'waiting for first use'}];
  }
  state(now=Date.now()):SharpsState{
    const r=this.round,info=r?.info,l=r&&info?lean(r.trades,this.sharpSet,Math.floor(now/1000)):null;
    const btc:BtcView|null=r?{round:r.start,ticker:kalshiBtcTicker(r.start),slug:info?.slug??null,tau:Math.max(0,r.start+900-Math.floor(now/1000)),upPrice:info?.upPrice??null,sharpNet:l?.sharpNet??0,allNet:l?.allNet??0,sharpWallets:l?.sharpWallets??0,sharpTrades:l?.sharpTrades??0,trades:r.trades.length,updated:r.updated,error:r.error,stats:leanStats(this.journal.leanRows())}:null;
    return {updated:this.at.positions||null,wallets:[...this.wallets.slice(0,30),...this.crypto.slice(0,10)],bets:this.bets,btc,sources:this.health(now),counts:{wallets:this.wallets.length,crypto:this.crypto.length,positions:this.positions.length,bets:this.bets.length}};
  }
}
