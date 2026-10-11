import type {RefGame,RefMarket} from '../match';
import {similarity} from '../similarity';
/** Public Polymarket data (no key). Every request is a GET to this host only. */
export const GAMMA='https://gamma-api.polymarket.com';
export type FetchJson=(url:string)=>Promise<any>;
const MAX_SPREAD=.1;
const list=(v:unknown):any[]=>{if(Array.isArray(v))return v;try{const p=JSON.parse(String(v));return Array.isArray(p)?p:[];}catch{return [];}};
const num=(v:unknown)=>{const n=Number(v);return v===undefined||v===null||v===''||!Number.isFinite(n)?null:n;};
/** "2026-10-10 01:00:00+00" → ms. */
export const pmTime=(s:unknown)=>{if(typeof s!=='string')return NaN;return Date.parse(s.replace(' ','T').replace(/\+00$/,'Z'));};
/**
 * Chances of a market's outcomes. Polymarket quotes outcome 0; outcome 1 is its complement. A two-sided book wider than 10¢
 * is not a price; with no book at all, the last/outcome prices stand.
 */
export function pmProbs(m:any):{probs:number[];spread:number|null}{
  const outcomes=list(m.outcomes),bid=num(m.bestBid),ask=num(m.bestAsk);
  if(bid!==null&&ask!==null&&ask>bid&&bid>0){const spread=ask-bid;if(spread>MAX_SPREAD)return {probs:outcomes.map(()=>NaN),spread};const p=(bid+ask)/2;return {probs:outcomes.length===2?[p,1-p]:outcomes.map(()=>NaN),spread};}
  const prices=list(m.outcomePrices).map(Number);
  return {probs:prices.length===outcomes.length&&prices.every(p=>Number.isFinite(p)&&p>0&&p<1)?prices:outcomes.map(()=>NaN),spread:null};
}
/** Game events of a league (Polymarket tag slug) ending in [from, to]: moneyline and full-game totals only. */
export async function polymarketGames(fetchJson:FetchJson,league:string,from:number,to:number):Promise<RefGame[]>{
  const out:RefGame[]=[];
  for(let offset=0;offset<2000;offset+=500){
    const evs:any[]=await fetchJson(`${GAMMA}/events?active=true&closed=false&limit=500&offset=${offset}&tag_slug=${encodeURIComponent(league)}&end_date_min=${new Date(from).toISOString()}&end_date_max=${new Date(to).toISOString()}`);
    for(const e of evs??[]){
      const ml=(e.markets??[]).find((m:any)=>m.sportsMarketType==='moneyline');if(!ml)continue;
      const names=list(ml.outcomes).map(String),codes=String(e.slug??'').split('-').slice(1,3),start=pmTime(ml.gameStartTime??e.startDate);
      if(names.length!==2||!Number.isFinite(start))continue;
      const market=(m:any,kind:RefMarket['kind']):RefMarket=>{const {probs,spread}=pmProbs(m);return {id:String(m.id),kind,line:num(m.line),outcomes:list(m.outcomes).map(String),probs,spread,cond:m.conditionId?String(m.conditionId):undefined};};
      out.push({id:String(e.slug),league,start,teams:[[names[0],codes[0]??''],[names[1],codes[1]??'']],url:`https://polymarket.com/event/${e.slug}`,
        markets:[market(ml,'moneyline'),...(e.markets??[]).filter((m:any)=>m.sportsMarketType==='totals'&&num(m.line)!==null).map((m:any)=>market(m,'totals'))]});
    }
    if((evs?.length??0)<500)break;
  }
  return out;
}
export interface PmCandidate {id:string;title:string;prob:number;url:string;score:number}
/** Polymarket markets whose question reads like `q`, best first, with their YES chance. */
export async function polymarketSearch(fetchJson:FetchJson,q:string):Promise<PmCandidate[]>{
  const r=await fetchJson(`${GAMMA}/public-search?q=${encodeURIComponent(q)}&limit_per_type=10`),out:PmCandidate[]=[];
  for(const e of r?.events??[])for(const m of e.markets??[]){
    const outcomes=list(m.outcomes).map(String);if(outcomes.length!==2||outcomes[0].toLowerCase()!=='yes')continue;
    out.push({id:String(m.id),title:String(m.question??e.title),prob:pmProbs(m).probs[0],url:`https://polymarket.com/event/${e.slug}`,score:similarity(q,String(m.question??e.title))});
  }
  return out.sort((a,b)=>b.score-a.score);
}
/** Current YES chance of one Polymarket market (for a match you confirmed). */
export async function polymarketMarket(fetchJson:FetchJson,id:string):Promise<number>{return pmProbs(await fetchJson(`${GAMMA}/markets/${encodeURIComponent(id)}`)).probs[0];}
/**
 * Polymarket's 15-minute Bitcoin round that starts at `startSec` (slug btc-updown-15m-{start}). It runs on the same quarter
 * hours as Kalshi's KXBTC15M but settles differently: Chainlink's BTC/USD TWAP over the window vs its start price, where
 * Kalshi averages the last 60 s against the 60 s before the open. Related bets, not the same one.
 */
export async function btcRound(fetchJson:FetchJson,startSec:number):Promise<{slug:string;cond:string;title:string;upPrice:number|null;closed:boolean}|null>{
  const evs=await fetchJson(`${GAMMA}/events?slug=btc-updown-15m-${startSec}`),m=Array.isArray(evs)?evs[0]?.markets?.[0]:null;if(!m?.conditionId)return null;
  const outcomes=list(m.outcomes).map(String),up=outcomes.findIndex(o=>o.toLowerCase()==='up'),{probs}=pmProbs(m),p=up>=0?probs[up]:NaN;
  return {slug:String(evs[0].slug),cond:String(m.conditionId),title:String(evs[0].title??m.question??''),upPrice:Number.isFinite(p)?p:null,closed:!!m.closed};
}
