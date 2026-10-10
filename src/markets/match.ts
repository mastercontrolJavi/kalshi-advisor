import {teamMatches} from './teams';
/** A game on an outside venue, with its moneyline and full-game totals. probs[i] is outcome i's chance (NaN = unusable). */
export interface RefMarket {id:string;kind:'moneyline'|'totals';line:number|null;outcomes:string[];probs:number[];spread:number|null}
export interface RefGame {id:string;league:string;start:number;teams:[string[],string[]];url:string;markets:RefMarket[]}
/** What a Kalshi game market says about itself. teams: every name Kalshi gives each side (title part, sub-title, code). */
export interface KalshiGame {league:string;expectedEnd:number;teams:[string[],string[]];yesTeam:0|1|null;kind:'moneyline'|'totals';line:number|null;yesIsOver:boolean|null}
const H=3600000;
const LEAGUES:[string,string][]=[['KXNCAAMB','cbb'],['KXNCAAF','cfb'],['KXWNBA','wnba'],['KXNFL','nfl'],['KXMLB','mlb'],['KXNBA','nba'],['KXNHL','nhl']];
export const leagueOf=(series:string)=>LEAGUES.find(([p])=>series.startsWith(p))?.[1]??null;
/**
 * The one outside game that is this Kalshi game, or null. Kalshi's expected time is about the end of the game, so the outside
 * start must fall in [end − 8 h, end + 1 h]. Both teams must pair up, in exactly one order, with exactly one candidate:
 * anything ambiguous is no match rather than a guess.
 */
export function matchGame(k:KalshiGame,games:RefGame[]):{game:RefGame;swap:boolean}|null{
  const found:{game:RefGame;swap:boolean}[]=[];
  for(const g of games){
    if(g.league!==k.league||g.start<k.expectedEnd-8*H||g.start>k.expectedEnd+H)continue;
    const straight=teamMatches(k.teams[0],g.teams[0])&&teamMatches(k.teams[1],g.teams[1]),crossed=teamMatches(k.teams[0],g.teams[1])&&teamMatches(k.teams[1],g.teams[0]);
    if(straight!==crossed)found.push({game:g,swap:crossed});
  }
  return found.length===1?found[0]:null;
}
/** The outside chance of this Kalshi market's YES: its team's moneyline outcome, or Over/Under at exactly the same line. */
export function refProb(k:KalshiGame,m:{game:RefGame;swap:boolean}):{prob:number;market:RefMarket}|null{
  let market:RefMarket|undefined,idx=-1;
  if(k.kind==='moneyline'&&k.yesTeam!==null){market=m.game.markets.find(x=>x.kind==='moneyline');idx=m.swap?1-k.yesTeam:k.yesTeam;}
  if(k.kind==='totals'&&k.line!==null&&k.yesIsOver!==null){market=m.game.markets.find(x=>x.kind==='totals'&&x.line===k.line);idx=market?market.outcomes.findIndex(o=>o.toLowerCase()===(k.yesIsOver?'over':'under')):-1;}
  const prob=market&&idx>=0?market.probs[idx]:NaN;
  return market&&Number.isFinite(prob)?{prob,market}:null;
}
