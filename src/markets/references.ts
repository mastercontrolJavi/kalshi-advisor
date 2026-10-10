import type {MarketsJournal} from './journal';
import {matchGame,refProb,type KalshiGame,type RefGame} from './match';
import {polymarketGames,polymarketSearch,polymarketMarket,type FetchJson} from './sources/polymarket';
import {oddsGames,type FetchRes} from './sources/odds';
import {SUGGEST_MIN} from './similarity';
export type Source='polymarket'|'sportsbooks';
/** An outside chance for a Kalshi market's YES. Trusted only when auto-matched (sports) or confirmed by you, and fresh. */
export interface Reference {source:Source;prob:number;time:number;stale:boolean;status:'auto'|'confirmed'|'suggested';title:string;url:string;refId:string}
export interface HeldRef {ticker:string;title:string;kalshiGame:KalshiGame|null}
export interface SourceHealth {name:string;ok:boolean;updated:number|null;error:string|null;detail:string}
export const PM_STALE=15*60000,ODDS_STALE=2*3600000,PM_EVERY=5*60000,SNAP_EVERY=5*60000,SEARCH_EVERY=6*3600000;
// In play, prices move by the minute: refresh Polymarket every minute while a held game is on.
const PM_EVERY_LIVE=60000,ODDS_SOON=30*60000,ODDS_LATER=6*3600000,ODDS_MIN_LEFT=50,H=3600000;
export const trusted=(r:Reference|null|undefined):r is Reference=>!!r&&!r.stale&&(r.status==='auto'||r.status==='confirmed')&&Number.isFinite(r.prob);
const nextMonth=(now:number)=>{const d=new Date(now);return Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1);};
/**
 * Keeps an outside reference for every held market and combo leg:
 * - sports: Polymarket games every 5 min, and the Odds API on a monthly budget (only leagues you hold; every 30 min when a
 *   held game is near, else every 6 h; never below 50 requests left). Matches are automatic (see matchGame).
 * - anything else: a Polymarket title search, stored only as a suggestion until you confirm it; a rejection is permanent.
 * Trusted references are snapshotted every 5 min, so their accuracy can be compared with Kalshi's once markets settle.
 */
export class References {
  private latest=new Map<string,Map<Source,Reference>>();private games=new Map<string,{at:number;games:RefGame[]}>();
  private snapped=new Map<string,number>();private searched=new Map<string,number>();private refreshed=new Map<string,number>();
  private pm={updated:null as number|null,error:null as string|null};private odds={updated:null as number|null,error:null as string|null,rejected:false};
  constructor(private journal:MarketsJournal,private o:{fetchJson:FetchJson;fetchRes?:FetchRes;oddsKey?:string;log:(e:string,d:unknown)=>void}){}
  private put(ticker:string,r:Reference){(this.latest.get(ticker)??this.latest.set(ticker,new Map()).get(ticker)!).set(r.source,r);
    const key=ticker+'|'+r.source;if((r.status==='auto'||r.status==='confirmed')&&r.time-(this.snapped.get(key)??-Infinity)>=SNAP_EVERY){this.journal.putRef(ticker,r.source,r.time,r.prob);this.snapped.set(key,r.time);}}
  private async pmGames(league:string,now:number,live=false){
    const key='pm:'+league,hit=this.games.get(key);if(hit&&now-hit.at<(live?PM_EVERY_LIVE:PM_EVERY))return hit.games;
    try{const games=await polymarketGames(this.o.fetchJson,league,now-12*H,now+8*24*H);this.games.set(key,{at:now,games});this.pm={updated:now,error:null};return games;}
    catch(e){this.pm.error=(e as Error).message;this.o.log('polymarket-error',{league,message:this.pm.error});return hit?.games??[];}
  }
  private async oddsGames(league:string,held:HeldRef[],now:number){
    const key='odds:'+league,hit=this.games.get(key);if(!this.o.oddsKey||!this.o.fetchRes||this.odds.rejected)return hit?.games??[];
    const left=this.journal.get<number|null>('oddsRemaining',null),resetAt=this.journal.get<number>('oddsResetAt',0);
    if(left!==null&&left<ODDS_MIN_LEFT&&now<resetAt)return hit?.games??[];
    const fetched=this.journal.get<Record<string,number>>('oddsFetched',{}),soon=held.some(h=>h.kalshiGame?.league===league&&h.kalshiGame.expectedEnd-now<6*H&&h.kalshiGame.expectedEnd>now-H);
    if(now-(fetched[league]??-Infinity)<(soon?ODDS_SOON:ODDS_LATER))return hit?.games??[];
    try{
      const r=await oddsGames(this.o.fetchRes,league,this.o.oddsKey);this.journal.set('oddsFetched',{...fetched,[league]:now});
      if(r.remaining!==null){this.journal.set('oddsRemaining',r.remaining);this.journal.set('oddsResetAt',nextMonth(now));}
      if(r.status===401){this.odds.rejected=true;this.odds.error='key rejected';this.o.log('odds-key-rejected',{});return [];}
      if(r.status!==200){this.odds.error=`HTTP ${r.status}`;return hit?.games??[];}
      this.games.set(key,{at:now,games:r.games});this.odds.updated=now;this.odds.error=null;return r.games;
    }catch(e){this.odds.error=(e as Error).message;this.o.log('odds-error',{league,message:this.odds.error});return hit?.games??[];}
  }
  async refresh(held:HeldRef[],now:number){
    for(const league of new Set(held.map(h=>h.kalshiGame?.league).filter((l):l is string=>!!l))){
      const sports=held.filter(h=>h.kalshiGame?.league===league),live=sports.some(h=>now>=h.kalshiGame!.expectedEnd-4*H&&now<=h.kalshiGame!.expectedEnd+2*H);
      for(const [source,games] of [['polymarket',await this.pmGames(league,now,live)],['sportsbooks',await this.oddsGames(league,held,now)]] as [Source,RefGame[]][]){
        const at=source==='polymarket'?this.games.get('pm:'+league)?.at:this.games.get('odds:'+league)?.at;
        for(const h of sports){const m=matchGame(h.kalshiGame!,games),p=m?refProb(h.kalshiGame!,m):null;if(!m||!p)continue;
          this.journal.setMatch({ticker:h.ticker,source,refId:p.market.id,method:'auto',status:'auto',score:null,title:m.game.id,url:m.game.url});
          this.put(h.ticker,{source,prob:p.prob,time:at??now,stale:false,status:'auto',title:m.game.id,url:m.game.url,refId:p.market.id});}
      }
    }
    for(const h of held.filter(x=>!x.kalshiGame)){
      const rows=this.journal.matchesFor(h.ticker).filter(r=>r.source==='polymarket'),open=rows.find(r=>r.status==='confirmed')??rows.find(r=>r.status==='suggested');
      try{
        if(open){if(now-(this.refreshed.get(h.ticker)??-Infinity)>=PM_EVERY){const prob=await polymarketMarket(this.o.fetchJson,open.refId);this.refreshed.set(h.ticker,now);this.pm={updated:now,error:null};
            this.put(h.ticker,{source:'polymarket',prob,time:now,stale:false,status:open.status as 'confirmed'|'suggested',title:open.title,url:open.url,refId:open.refId});}}
        else if(now-(this.searched.get(h.ticker)??-Infinity)>=SEARCH_EVERY){
          this.searched.set(h.ticker,now);const best=(await polymarketSearch(this.o.fetchJson,h.title)).find(c=>c.score>=SUGGEST_MIN&&!this.journal.isRejected(h.ticker,'polymarket',c.id));this.pm={updated:now,error:null};
          if(best){this.journal.setMatch({ticker:h.ticker,source:'polymarket',refId:best.id,method:'suggested',status:'suggested',score:best.score,title:best.title,url:best.url});this.refreshed.set(h.ticker,now);
            this.put(h.ticker,{source:'polymarket',prob:best.prob,time:now,stale:false,status:'suggested',title:best.title,url:best.url,refId:best.id});}
        }
      }catch(e){this.pm.error=(e as Error).message;this.o.log('polymarket-error',{ticker:h.ticker,message:this.pm.error});}
    }
  }
  /** Best reference: the freshest trusted one (sportsbooks win ties within 5 min), else a suggested or stale one for display only. */
  reference(ticker:string,now:number):Reference|null{
    const rows=[...(this.latest.get(ticker)?.values()??[])].map(r=>{
      // A match decided since the last refresh (✓/✗) takes effect at once.
      const row=this.journal.matchesFor(ticker).find(m=>m.source===r.source&&m.refId===r.refId);if(row?.status==='rejected')return null;
      const status=row?.status==='confirmed'?'confirmed':r.status;
      return {...r,status,stale:now-r.time>(r.source==='sportsbooks'?ODDS_STALE:PM_STALE)} as Reference;}).filter((r):r is Reference=>!!r);
    // Trusted first; among trusted the newest wins, with sportsbooks (more books, no single venue) preferred within 5 min.
    // In play a 30-min-old book price must not outrank a 1-min-old Polymarket one.
    const fresh=(r:Reference)=>r.time+(r.source==='sportsbooks'?5*60000:0);
    return rows.sort((a,b)=>Number(trusted(b))-Number(trusted(a))||fresh(b)-fresh(a))[0]??null;
  }
  health(now=Date.now()):SourceHealth[]{
    const left=this.journal.get<number|null>('oddsRemaining',null),resetAt=this.journal.get<number>('oddsResetAt',0);
    const detail=!this.o.oddsKey?'no key':this.odds.rejected?'key rejected':left!==null&&left<ODDS_MIN_LEFT&&now<resetAt?`budget reached, resets ${new Date(resetAt).toISOString().slice(0,10)}`:left!==null?`${left} requests left this month`:'waiting for first use';
    return [{name:'Polymarket',ok:!this.pm.error,updated:this.pm.updated,error:this.pm.error,detail:this.pm.updated?'':'waiting for first use'},
      {name:'Sportsbooks',ok:!!this.o.oddsKey&&!this.odds.rejected&&!this.odds.error,updated:this.odds.updated,error:this.odds.error,detail}];
  }
}
