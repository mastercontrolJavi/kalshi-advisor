import type {RefGame,RefMarket} from '../match';
import {consensus} from '../devig';
/** The Odds API (free key, ~500 requests a month). The key is sent to this host only. */
export const ODDS_HOST='https://api.the-odds-api.com';
export const SPORT_KEYS:Record<string,string>={nfl:'americanfootball_nfl',cfb:'americanfootball_ncaaf',mlb:'baseball_mlb',nba:'basketball_nba',nhl:'icehockey_nhl',wnba:'basketball_wnba',cbb:'basketball_ncaab'};
export type FetchRes=(url:string)=>Promise<{status:number;body:any;headers:{get(name:string):string|null}}>;
/**
 * Sportsbook consensus per game: moneyline (h2h) and full-game totals, each the median across books after removing each
 * book's margin. One request costs 2 of the monthly quota (two markets, one region).
 */
export async function oddsGames(fetchRes:FetchRes,league:string,key:string):Promise<{games:RefGame[];remaining:number|null;status:number}>{
  const sport=SPORT_KEYS[league];if(!sport)return {games:[],remaining:null,status:0};
  const r=await fetchRes(`${ODDS_HOST}/v4/sports/${sport}/odds?regions=us&markets=h2h,totals&oddsFormat=decimal&apiKey=${encodeURIComponent(key)}`);
  const left=Number(r.headers.get('x-requests-remaining')),remaining=Number.isFinite(left)&&r.headers.get('x-requests-remaining')!==null?left:null;
  if(r.status!==200||!Array.isArray(r.body))return {games:[],remaining,status:r.status};
  const games:RefGame[]=[];
  for(const g of r.body){
    const names=[String(g.home_team),String(g.away_team)],start=Date.parse(g.commence_time);if(!Number.isFinite(start))continue;
    const h2h:number[][]=[],totals=new Map<number,number[][]>();
    for(const b of g.bookmakers??[])for(const m of b.markets??[]){
      if(m.key==='h2h'){const o=names.map(n=>Number(m.outcomes?.find((x:any)=>x.name===n)?.price));if(m.outcomes?.length===2&&o.every(Number.isFinite))h2h.push(o);}
      if(m.key==='totals'){const over=m.outcomes?.find((x:any)=>x.name==='Over'),under=m.outcomes?.find((x:any)=>x.name==='Under');
        if(over&&under&&over.point===under.point&&Number.isFinite(Number(over.point))){const line=Number(over.point),xs=totals.get(line)??[];xs.push([Number(over.price),Number(under.price)]);totals.set(line,xs);}}
    }
    const markets:RefMarket[]=[];const ml=consensus(h2h);
    if(ml)markets.push({id:`odds:${g.id}:h2h`,kind:'moneyline',line:null,outcomes:names,probs:ml,spread:0});
    for(const [line,books] of totals){const p=consensus(books);if(p)markets.push({id:`odds:${g.id}:totals:${line}`,kind:'totals',line,outcomes:['Over','Under'],probs:p,spread:0});}
    if(markets.length)games.push({id:`odds:${g.id}`,league,start,teams:[[names[0]],[names[1]]],url:'',markets});
  }
  return {games,remaining,status:r.status};
}
