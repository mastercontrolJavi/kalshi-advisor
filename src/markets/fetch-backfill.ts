import type {KalshiClient} from '../engine/feeds/kalshi';
import type {MarketsJournal} from './journal';
import {parseCandle,eventTime,priceAt,vwap,pickSeries,candleGroups} from './backfill';
import {groupOf} from './categories';
const H=3600,DAY=86400;
type Client=Pick<KalshiClient,'get'>;
async function pages(client:Client,path:string){
  const out:any[]=[];let cursor='';const seen=new Set<string>();
  do{const r=await client.get(path+(path.includes('?')?'&':'?')+'limit=1000'+(cursor?'&cursor='+encodeURIComponent(cursor):''));out.push(...(r.markets??r.series??[]));cursor=r.cursor??'';if(cursor&&seen.has(cursor))break;seen.add(cursor);}while(cursor);
  return out;
}
/**
 * Settled non-Bitcoin markets for the Record tab, from public data. Lists the chosen series' markets settled since the last
 * run (2 days of overlap), or since Kalshi's historical cutoff on the first run, keeping those with ≥ minVolume contracts
 * (at most perSeries per series, by volume). Then prices every stored market still missing prices from hourly candles:
 * the YES mid and ask 24 h and 1 h before the event, and the volume-weighted price over those 24 h. Re-runnable and resumable.
 */
export async function runBackfill(client:Client,journal:MarketsJournal,o:{now:number;traded:Set<string>;log:(m:string)=>void;perGroup?:number;perSeries?:number;minVolume?:number}){
  // Heartbeat: the daily refresher (in the markets process) will not start a second run while this one is alive.
  const beat=()=>journal.set('backfillHeartbeat',Date.now());beat();
  const cutoff=Math.floor(Date.parse((await client.get('/historical/cutoff')).market_settled_ts)/1000);
  const last=journal.get<number|null>('backfillTo',null),from=Math.max(cutoff,last!==null?last-2*DAY:0);
  const series=(await pages(client,'/series?include_volume=true')).map((s:any)=>({ticker:String(s.ticker),category:s.category??null,volume:Number(s.volume_fp)||0}));
  const category=new Map(series.map(s=>[s.ticker,s.category])),chosen=pickSeries(series,o.traded,o.perGroup??20);
  o.log(`backfill: ${chosen.length} series, settled since ${new Date(from*1000).toISOString().slice(0,10)}`);
  let listed=0;
  for(const s of chosen){
    beat();
    try{
      const ms=(await pages(client,`/markets?series_ticker=${encodeURIComponent(s)}&status=settled&min_close_ts=${from}&max_close_ts=${o.now}`))
        .filter(m=>(m.result==='yes'||m.result==='no')&&(Number(m.volume_fp)||0)>=(o.minVolume??100)&&eventTime(m)!==null)
        .sort((a,b)=>Number(b.volume_fp)-Number(a.volume_fp)).slice(0,o.perSeries??4000);
      journal.putBackfill(ms.map(m=>({ticker:String(m.ticker),event:String(m.event_ticker),series:s,grp:groupOf(category.get(s),false),title:String(m.yes_sub_title||m.title||m.ticker),
        eventTs:eventTime(m)!,settleTs:Math.floor(Date.parse(m.settlement_ts??m.close_time)/1000),result:m.result,volume:Number(m.volume_fp)||0})));
      listed+=ms.length;
    }catch(e){o.log(`  ${s}: ${(e as Error).message}`);}
  }
  journal.set('backfillTo',o.now);
  let priced=0;const groups=candleGroups(journal.unpriced().map(r=>({ticker:r.ticker,event:r.eventTs})));
  for(let i=0;i<groups.length;i++){
    const g=groups[i],start=g[0].event-25*H,end=g.at(-1)!.event;if(i%10===0)beat();
    try{
      const r=await client.get(`/markets/candlesticks?market_tickers=${encodeURIComponent(g.map(x=>x.ticker).join(','))}&start_ts=${start}&end_ts=${end}&period_interval=60`);
      const got=new Map<string,any[]>((r.markets??[]).map((m:any)=>[m.market_ticker,m.candlesticks??[]]));
      for(const x of g){const cs=(got.get(x.ticker)??[]).map(parseCandle),p24=priceAt(cs,x.event-24*H),p1=priceAt(cs,x.event-H);
        journal.setPrices(x.ticker,{p24:p24?.mid??null,a24:p24?.ask??null,p1:p1?.mid??null,a1:p1?.ask??null,vwap:vwap(cs,x.event-24*H,x.event)});priced++;}
    }catch(e){o.log(`  candles batch ${i+1}/${groups.length}: ${(e as Error).message}`);}
    if(i%25===0)o.log(`  candles ${i+1}/${groups.length}`);
  }
  journal.set('backfillFinished',Date.now());o.log(`backfill done: ${listed} listed, ${priced} priced`);
  return {listed,priced};
}
