import {teamMatches} from './teams';
/** A game on an outside venue, with its moneyline and full-game totals. probs[i] is outcome i's chance (NaN = unusable). */
export interface RefMarket {id:string;kind:'moneyline'|'totals';line:number|null;outcomes:string[];probs:number[];spread:number|null;cond?:string}
export interface RefGame {id:string;league:string;start:number;teams:[string[],string[]];url:string;markets:RefMarket[]}
/** What a Kalshi game market says about itself. teams: every name Kalshi gives each side (title part, sub-title, code). */
export interface KalshiGame {league:string;expectedEnd:number;teams:[string[],string[]];yesTeam:0|1|null;kind:'moneyline'|'totals';line:number|null;yesIsOver:boolean|null}
const H=3600000;
const LEAGUES:[string,string][]=[['KXNCAAMB','cbb'],['KXNCAAF','cfb'],['KXWNBA','wnba'],['KXNFL','nfl'],['KXMLB','mlb'],['KXNBA','nba'],['KXNHL','nhl']];
export const leagueOf=(series:string)=>LEAGUES.find(([p])=>series.startsWith(p))?.[1]??null;
/**
 * The one outside game that is this Kalshi game, or null. Kalshi's expected time is usually about the end of the game but is
 * sometimes a placeholder hours before kickoff (Minnesota–Purdue: 20:00Z vs a 00:00Z start), so the outside start must fall in
 * [end − 8 h, end + 6 h]. Both teams must pair up, in exactly one order, with exactly one candidate (a doubleheader is none):
 * anything ambiguous is no match rather than a guess.
 */
export function matchGame(k:KalshiGame,games:RefGame[]):{game:RefGame;swap:boolean}|null{
  const found:{game:RefGame;swap:boolean}[]=[];
  for(const g of games){
    if(g.league!==k.league||g.start<k.expectedEnd-8*H||g.start>k.expectedEnd+6*H)continue;
    const straight=teamMatches(k.teams[0],g.teams[0])&&teamMatches(k.teams[1],g.teams[1]),crossed=teamMatches(k.teams[0],g.teams[1])&&teamMatches(k.teams[1],g.teams[0]);
    if(straight!==crossed)found.push({game:g,swap:crossed});
  }
  return found.length===1?found[0]:null;
}
/** The outside chance of this Kalshi market's YES: its team's moneyline outcome, or Over/Under at exactly the same line. */
export function refProb(k:KalshiGame,m:{game:RefGame;swap:boolean}):{prob:number;market:RefMarket;yesOutcome:string}|null{
  let market:RefMarket|undefined,idx=-1;
  if(k.kind==='moneyline'&&k.yesTeam!==null){market=m.game.markets.find(x=>x.kind==='moneyline');idx=m.swap?1-k.yesTeam:k.yesTeam;}
  if(k.kind==='totals'&&k.line!==null&&k.yesIsOver!==null){market=m.game.markets.find(x=>x.kind==='totals'&&x.line===k.line);idx=market?market.outcomes.findIndex(o=>o.toLowerCase()===(k.yesIsOver?'over':'under')):-1;}
  const prob=market&&idx>=0?market.probs[idx]:NaN;
  return market&&Number.isFinite(prob)?{prob,market,yesOutcome:market.outcomes[idx]}:null;
}
/** A Kalshi event as kalshiGameFrom needs it: its title ("PHI Eagles vs JAC Jaguars") and its team markets. */
export interface KalshiEvent {title:string;markets:{ticker:string;yes_sub_title?:string}[]}
const codeOf=(ticker:string)=>ticker.split('-').at(-1)??'';
/**
 * The Kalshi side of a sports match: league, time, every name for each team, and what YES means. Moneyline for …GAME
 * series; full-game totals for …TOTAL series (pass the sibling GAME event for the team names). Spreads are not matched.
 */
export function kalshiGameFrom(q:{ticker:string;seriesTicker:string;yesLabel:string;expectedExpiration:number|null;closeTime:number|null},ev:KalshiEvent):KalshiGame|null{
  const league=leagueOf(q.seriesTicker),end=q.expectedExpiration??q.closeTime,kind=q.seriesTicker.endsWith('GAME')?'moneyline':q.seriesTicker.endsWith('TOTAL')?'totals':null;
  if(!league||end===null||!kind)return null;
  const parts=ev.title.replace(/^[^:]*:\s*/,'').split(/\s+vs\.?\s+/i);if(parts.length!==2)return null;
  const teams:[string[],string[]]=[[parts[0].trim()],[parts[1].trim()]];
  for(const m of ev.markets){const names=[m.yes_sub_title??'',codeOf(m.ticker)].filter(Boolean),hits=[0,1].filter(i=>teamMatches(names,teams[i]));if(hits.length===1)teams[hits[0]].push(...names);}
  if(kind==='moneyline'){const code=codeOf(q.ticker),yesTeam=teams[0].includes(code)?0:teams[1].includes(code)?1:null;return yesTeam===null?null:{league,expectedEnd:end,teams,yesTeam,kind,line:null,yesIsOver:null};}
  const line=Number(/(\d+(?:\.\d+)?)/.exec(q.yesLabel)?.[1]),over=/^over\b/i.test(q.yesLabel),under=/^under\b/i.test(q.yesLabel);
  return Number.isFinite(line)&&(over||under)?{league,expectedEnd:end,teams,yesTeam:null,kind,line,yesIsOver:over}:null;
}
