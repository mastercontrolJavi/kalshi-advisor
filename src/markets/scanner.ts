import type {KalshiClient} from '../engine/feeds/kalshi';
import type {MarketsJournal,FlagRow} from './journal';
import type {References,HeldRef} from './references';
import {trusted} from './references';
import type {KalshiGame} from './match';
import type {Quote,Group} from './types';
import {parseMarket,sideProb} from './quotes';
import {groupOf,isBitcoin,seriesOf} from './categories';
import {pickSeries} from './backfill';
import {refGapFlags,moveFlags,biasFlags,type Flag,type FlagType} from './flags';
import {evidence,type FlagStats} from './scoring';
import type {AccuracyTables} from './record';
type Client=Pick<KalshiClient,'get'>;
const SERIES_EVERY=6*3600000,MIN_DOLLARS=1000,MAX_MARKETS=2000,RECENT=6*3600000;
export interface ScanRow {ticker:string;event:string;series:string;title:string;yesLabel:string;group:Group;yesBid:number|null;yesAsk:number|null;spread:number|null;volume24h:number|null;dollarVolume:number;closeTime:number|null;
  ref:{source:string;prob:number;gap:number|null}|null;flags:{type:FlagType;side:'yes'|'no';edge:number;price:number;time:number;evidence:FlagStats|null}[];url:string;proven:boolean;score:number}
interface Entry {q:Quote;group:Group;volume:number|null;dollars:number;held:boolean}
async function pages(client:Client,path:string,field:string){
  const out:any[]=[];let cursor='';const seen=new Set<string>();
  do{const r=await client.get(path+(path.includes('?')?'&':'?')+'limit=1000'+(cursor?'&cursor='+encodeURIComponent(cursor):''));out.push(...(r[field]??[]));cursor=r.cursor??'';if(cursor&&seen.has(cursor))break;seen.add(cursor);}while(cursor);
  return out;
}
/** kalshi.com redirects /markets/{series}/{any slug}/{event} to the event page (checked 2026-10-10). */
export const kalshiUrl=(series:string,event:string)=>`https://kalshi.com/markets/${series.toLowerCase()}/x/${event.toLowerCase()}`;
/**
 * Every 5 min: the open markets of the busiest series in each category (plus the series you trade), kept when they traded
 * ≥ $1,000 in 24 h or you hold them (at most 2,000). They are snapshotted, sports ones are matched to Polymarket, and the
 * flag rules run; every flag is stored as a paper trade. A failed sweep keeps the last good list.
 */
export class Scanner {
  updated=0;error:string|null=null;private list:Entry[]=[];private series:{at:number;chosen:string[];category:Map<string,string|null>}|null=null;
  constructor(private client:Client,private journal:MarketsJournal,private refs:Pick<References,'refresh'|'reference'>,private data:{kalshiGame(q:Quote):Promise<KalshiGame|null>;held():any[]},private log:(e:string,d:unknown)=>void){}
  get count(){return this.list.length;}
  private async chosenSeries(now:number){
    if(this.series&&now-this.series.at<SERIES_EVERY)return this.series;
    const all=(await pages(this.client,'/series?include_volume=true','series')).map((s:any)=>({ticker:String(s.ticker),category:s.category??null,volume:Number(s.volume_fp)||0}));
    const traded=new Set(this.journal.raw().fills.map((f:any)=>String(f.ticker??f.market_ticker)).filter((t:string)=>!isBitcoin(t)&&!t.startsWith('KXMVE')).map(seriesOf));
    this.series={at:now,chosen:pickSeries(all,traded,20),category:new Map(all.map(s=>[s.ticker,s.category]))};return this.series;
  }
  async sweep(now:number){
    try{
      const {chosen,category}=await this.chosenSeries(now),held=new Set(this.data.held().map(p=>String(p.ticker))),found:Entry[]=[];
      for(const s of chosen)for(const m of await pages(this.client,`/markets?series_ticker=${encodeURIComponent(s)}&status=open&mve_filter=exclude`,'markets')){
        const q=parseMarket(m,now),mid=sideProb(q,'yes'),volume=Number(m.volume_fp);
        found.push({q,group:groupOf(category.get(s),false),volume:Number.isFinite(volume)?volume:null,dollars:mid===null?0:(q.volume24h??0)*mid,held:held.has(q.ticker)});
      }
      const kept=found.filter(e=>e.dollars>=MIN_DOLLARS||e.held).sort((a,b)=>b.dollars-a.dollars).slice(0,MAX_MARKETS);
      for(const e of kept)this.journal.upsertMarket(e.q,category.get(e.q.seriesTicker)??null,e.group);
      this.journal.snapshot(kept.map(e=>({ticker:e.q.ticker,time:now,yesBid:e.q.yesBid,yesAsk:e.q.yesAsk,last:e.q.last,volume24h:e.q.volume24h,held:e.held,volume:e.volume})));
      const sports:HeldRef[]=[];
      for(const e of kept.filter(x=>x.group==='sports')){const g=await this.data.kalshiGame(e.q);if(g)sports.push({ticker:e.q.ticker,title:e.q.title,kalshiGame:g,held:e.held});}
      try{await this.refs.refresh(sports,now);}catch(err){this.log('scanner-references-error',{message:(err as Error).message});}
      const tables=this.journal.get<AccuracyTables|null>('accuracy',null),last=(t:string,type:FlagType)=>this.journal.lastFlag(t,type),flags:Flag[]=[];
      for(const e of kept){
        const m={ticker:e.q.ticker,event:e.q.eventTicker,group:e.group,yesAsk:e.q.yesAsk,noAsk:e.q.noAsk},mid=sideProb(e.q,'yes'),ref=this.refs.reference(e.q.ticker,now);
        if(trusted(ref))flags.push(...refGapFlags(m,ref.prob,now,last));
        // An outside price that moved the same way explains a Kalshi move, so the move is not flagged.
        const hourAgo=ref?this.journal.refSeries(e.q.ticker,ref.source,now-65*60000)[0]:undefined;
        flags.push(...moveFlags(m,this.journal.recentMids(e.q.ticker,now-70*60000),ref&&hourAgo?ref.prob-hourAgo.prob:null,now,last));
        if(mid!==null)flags.push(...biasFlags({...m,mid},tables,now,last));
      }
      this.journal.putFlags(flags);this.list=kept;this.updated=now;this.error=null;
      if(flags.length)this.log('scanner-flags',{count:flags.length,types:[...new Set(flags.map(f=>f.type))]});
    }catch(e){this.error=(e as Error).message;this.log('scanner-error',{message:this.error});}
  }
  /** Flagged markets (flags from the last 6 h), proven flag types first, then by the size of the reason. */
  rows(now:number,stats:FlagStats[]):ScanRow[]{
    const recent=new Map<string,FlagRow[]>();for(const f of this.journal.flagsSince(now-RECENT))(recent.get(f.ticker)??recent.set(f.ticker,[]).get(f.ticker)!).push(f);
    const out:ScanRow[]=[];
    for(const e of this.list){
      const fs=recent.get(e.q.ticker);if(!fs?.length)continue;
      const latest=new Map<string,FlagRow>();for(const f of fs)if(!latest.has(f.type))latest.set(f.type,f);
      const flags=[...latest.values()].map(f=>({type:f.type as FlagType,side:f.side,edge:f.edge,price:f.price,time:f.time,evidence:evidence(stats,f.type,e.group)}));
      const proven=flags.some(f=>f.evidence?.proven),size=Math.max(...flags.map(f=>f.type.startsWith('bias')?f.edge*10:f.edge*100));
      const ref=this.refs.reference(e.q.ticker,now),mid=sideProb(e.q,'yes');
      out.push({ticker:e.q.ticker,event:e.q.eventTicker,series:e.q.seriesTicker,title:e.q.title,yesLabel:e.q.yesLabel,group:e.group,yesBid:e.q.yesBid,yesAsk:e.q.yesAsk,
        spread:e.q.yesBid!==null&&e.q.yesAsk!==null?e.q.yesAsk-e.q.yesBid:null,volume24h:e.q.volume24h,dollarVolume:e.dollars,closeTime:e.q.expectedExpiration??e.q.closeTime,
        ref:trusted(ref)?{source:ref.source,prob:ref.prob,gap:mid===null?null:ref.prob-mid}:null,flags,url:kalshiUrl(e.q.seriesTicker,e.q.eventTicker),proven,score:(proven?1000:0)+size});
    }
    return out.sort((a,b)=>b.score-a.score);
  }
}
