import {it,expect} from 'vitest';
import {normTokens,teamMatches} from '../src/markets/teams';
import {matchGame,refProb,leagueOf,type RefGame,type KalshiGame} from '../src/markets/match';
const T=(iso:string)=>Date.parse(iso);
const game=(id:string,league:string,start:string,a:string[],b:string[],markets:RefGame['markets']=[]):RefGame=>({id,league,start:T(start),teams:[a,b],url:'u/'+id,markets});
const ml=(probs:number[],outcomes:string[]):RefGame['markets'][number]=>({id:'ml',kind:'moneyline',line:null,outcomes,probs,spread:.01});
const kg=(o:Partial<KalshiGame>):KalshiGame=>({league:'nfl',expectedEnd:T('2026-10-11T16:30:00Z'),teams:[['PHI Eagles','Philadelphia','PHI'],['JAC Jaguars','Jacksonville','JAC']],yesTeam:0,kind:'moneyline',line:null,yesIsOver:null,...o});
it('normalizes names and matches teams by code, shared word or initials',()=>{
  expect(normTokens('Florida St. vs Louisville')).toEqual(['florida','louisville']);
  expect(teamMatches(['PHI Eagles'],['Eagles'])).toBe(true);expect(teamMatches(['CWS','Chicago WS'],['Chicago White Sox','cws'])).toBe(true);
  expect(teamMatches(['Chicago WS'],['White Sox'])).toBe(true);expect(teamMatches(['Philadelphia'],['Jaguars','jax'])).toBe(false);});
it('matches the NFL game in the time window and maps the YES team to its outcome',()=>{
  const games=[game('nfl-phi-jax','nfl','2026-10-11T13:30:00Z',['Eagles','phi'],['Jaguars','jax'],[ml([.235,.765],['Eagles','Jaguars'])]),game('nfl-cin-mia','nfl','2026-10-11T17:00:00Z',['Bengals','cin'],['Dolphins','mia'])];
  const m=matchGame(kg({}),games)!;expect(m.game.id).toBe('nfl-phi-jax');expect(m.swap).toBe(false);expect(refProb(kg({}),m)!.prob).toBeCloseTo(.235);
  expect(refProb(kg({yesTeam:1}),m)!.prob).toBeCloseTo(.765);});
it('crossed team order is a swap; the other league or a start outside the window does not match',()=>{
  const g=game('x','nfl','2026-10-11T13:30:00Z',['Jaguars','jax'],['Eagles','phi'],[ml([.7,.3],['Jaguars','Eagles'])]);
  const m=matchGame(kg({}),[g])!;expect(m.swap).toBe(true);expect(refProb(kg({}),m)!.prob).toBeCloseTo(.3);
  expect(matchGame(kg({}),[{...g,league:'cfb'}])).toBeNull();expect(matchGame(kg({}),[{...g,start:T('2026-10-11T03:00:00Z')}])).toBeNull();expect(matchGame(kg({}),[{...g,start:T('2026-10-11T22:31:00Z')}])).toBeNull();});
it('Kalshi times can be placeholders: a game starting up to 6 h after the Kalshi time still matches (Minnesota–Purdue, 2026-10-10)',()=>{
  const k=kg({league:'cfb',expectedEnd:T('2026-10-10T20:00:00Z'),teams:[['Minnesota','MINN'],['Purdue','PUR']]});
  expect(matchGame(k,[game('cfb-minnst-pur-2026-10-10','cfb','2026-10-11T00:00:00Z',['Minnesota','minnst'],['Purdue','pur'])])?.game.id).toBe('cfb-minnst-pur-2026-10-10');
  const dh=[game('a','mlb','2026-10-11T17:00:00Z',['Cubs','chc'],['Cardinals','stl']),game('b','mlb','2026-10-11T21:00:00Z',['Cubs','chc'],['Cardinals','stl'])];
  expect(matchGame(kg({league:'mlb',expectedEnd:T('2026-10-11T20:00:00Z'),teams:[['Chicago C','CHC'],['St. Louis','STL']]}),dh)).toBeNull();});
it('a shared word in two games never makes a wrong pairing: both teams must match one game uniquely',()=>{
  const games=[game('iowa-wash','cfb','2026-10-10T01:00:00Z',['Iowa','iowa'],['Washington','wash']),game('iowast-byu','cfb','2026-10-10T01:30:00Z',['Iowa State','iowast'],['BYU','byu'])];
  const k=kg({league:'cfb',expectedEnd:T('2026-10-10T04:00:00Z'),teams:[['Iowa','IOWA'],['Washington','WASH']]});
  expect(matchGame(k,games)!.game.id).toBe('iowa-wash');expect(matchGame({...k,teams:[['Iowa','IOWA'],['Nebraska','NEB']]},games)).toBeNull();
  expect(matchGame(kg({league:'mlb',expectedEnd:T('2026-10-11T03:00:00Z'),teams:[['Chicago WS','CWS'],['Cleveland','CLE']]}),[game('cws-cle','mlb','2026-10-11T00:00:00Z',['Chicago White Sox','cws'],['Cleveland Guardians','cle']),game('chc-stl','mlb','2026-10-11T00:10:00Z',['Chicago Cubs','chc'],['St. Louis Cardinals','stl'])])!.game.id).toBe('cws-cle');});
it('totals match only on an equal line, and YES is Over',()=>{
  const tot=(line:number,over:number)=>({id:'t'+line,kind:'totals' as const,line,outcomes:['Over','Under'],probs:[over,1-over],spread:.01});
  const g=game('ga-ala','cfb','2026-10-10T19:30:00Z',['Georgia','ga'],['Alabama','ala'],[tot(49.5,.555),tot(51.5,.485),tot(53.5,.44)]);
  const k=kg({league:'cfb',expectedEnd:T('2026-10-10T23:00:00Z'),teams:[['Georgia','UGA'],['Alabama','ALA']],kind:'totals',line:51.5,yesIsOver:true,yesTeam:null});
  const m=matchGame(k,[g])!;expect(refProb(k,m)!.prob).toBeCloseTo(.485);expect(refProb({...k,line:52},m)).toBeNull();});
it('a reference with no usable probability is no reference',()=>{
  const g=game('x','nfl','2026-10-11T13:30:00Z',['Eagles','phi'],['Jaguars','jax'],[ml([NaN,NaN],['Eagles','Jaguars'])]);expect(refProb(kg({}),matchGame(kg({}),[g])!)).toBeNull();});
it('maps Kalshi series to leagues',()=>{expect(leagueOf('KXNCAAFTOTAL')).toBe('cfb');expect(leagueOf('KXNFLGAME')).toBe('nfl');expect(leagueOf('KXMLBTOTAL')).toBe('mlb');expect(leagueOf('KXATPMATCH')).toBeNull();});
import {kalshiGameFrom} from '../src/markets/match';
import {parseMarket} from '../src/markets/quotes';
const q=(ticker:string,label:string,exp='2026-10-11T16:30:00Z')=>parseMarket({ticker,event_ticker:ticker.split('-').slice(0,2).join('-'),yes_sub_title:label,status:'active',result:'',expected_expiration_time:exp},1);
it('builds the Kalshi side of a match from the event title and its team markets',()=>{
  const ev={title:'PHI Eagles vs JAC Jaguars',markets:[{ticker:'KXNFLGAME-26OCT11PHIJAC-JAC',yes_sub_title:'Jacksonville'},{ticker:'KXNFLGAME-26OCT11PHIJAC-PHI',yes_sub_title:'Philadelphia'}]};
  const g=kalshiGameFrom(q('KXNFLGAME-26OCT11PHIJAC-PHI','Philadelphia'),ev)!;expect(g).toMatchObject({league:'nfl',kind:'moneyline',yesTeam:0,expectedEnd:Date.parse('2026-10-11T16:30:00Z')});
  expect(g.teams[0]).toEqual(expect.arrayContaining(['PHI Eagles','Philadelphia','PHI']));expect(g.teams[1]).toEqual(expect.arrayContaining(['JAC Jaguars','Jacksonville','JAC']));
  expect(kalshiGameFrom(q('KXNFLGAME-26OCT11PHIJAC-JAC','Jacksonville'),ev)!.yesTeam).toBe(1);
  const mlb=kalshiGameFrom(q('KXMLBGAME-26OCT102000CWSCLE-CWS','Chicago WS'),{title:'Game 5: Chicago WS vs Cleveland',markets:[{ticker:'KXMLBGAME-26OCT102000CWSCLE-CWS',yes_sub_title:'Chicago WS'},{ticker:'KXMLBGAME-26OCT102000CWSCLE-CLE',yes_sub_title:'Cleveland'}]})!;
  expect(mlb.teams[0][0]).toBe('Chicago WS');expect(mlb.yesTeam).toBe(0);});
it('totals take the line and side from the YES label and the teams from the game event; spreads and unknown leagues are not matched',()=>{
  const game={title:'Georgia vs Alabama',markets:[{ticker:'KXNCAAFGAME-26OCT10UGAALA-UGA',yes_sub_title:'Georgia'},{ticker:'KXNCAAFGAME-26OCT10UGAALA-ALA',yes_sub_title:'Alabama'}]};
  const t=kalshiGameFrom(q('KXNCAAFTOTAL-26OCT10UGAALA-52','Over 51.5 points'),game)!;expect(t).toMatchObject({league:'cfb',kind:'totals',line:51.5,yesIsOver:true,yesTeam:null});expect(t.teams[1]).toContain('Alabama');
  expect(kalshiGameFrom(q('KXNFLSPREAD-26OCT11PHIJAC-PHI7','Philadelphia wins by over 6.5 points'),game)).toBeNull();
  expect(kalshiGameFrom(q('KXATPMATCH-26OCT10AB-A','A'),{title:'A vs B',markets:[]})).toBeNull();});
it('generic place words never pair teams: South Carolina St. vs Charleston Southern is not Southern Illinois vs South Dakota (live false match, 2026-10-10)',()=>{
  const k=kg({league:'cfb',expectedEnd:T('2026-10-10T23:00:00Z'),teams:[['South Carolina St.','South Carolina St.','SCST'],['Charleston Southern','Charleston Southern','CHSO']]});
  expect(matchGame(k,[game('cfb-sill-sdak-2026-10-10','cfb','2026-10-10T19:00:00Z',['Southern Illinois','sill'],['South Dakota','sdak'])])).toBeNull();
  expect(matchGame(k,[game('cfb-scst-chso','cfb','2026-10-10T19:00:00Z',['South Carolina State','scst'],['Charleston Southern','chso'])])).not.toBeNull();});
it('modifiers must agree (Iowa ≠ Iowa State, Michigan ≠ Michigan St., Florida ≠ Florida St.); nicknames still match',()=>{
  expect(teamMatches(['Iowa'],['Iowa State'])).toBe(false);expect(teamMatches(['Iowa'],['Iowa Hawkeyes'])).toBe(true);
  expect(teamMatches(['Michigan St.'],['Michigan'])).toBe(false);expect(teamMatches(['Michigan St.'],['Michigan State Spartans'])).toBe(true);
  expect(teamMatches(['Florida St.'],['Florida'])).toBe(false);expect(teamMatches(['Florida St.'],['Florida State'])).toBe(true);
  expect(teamMatches(['Philadelphia','PHI Eagles'],['Philadelphia Eagles'])).toBe(true);expect(teamMatches(['Chicago WS'],['Chicago Cubs'])).toBe(false);
  expect(teamMatches(['Los Angeles D','LAD'],['Los Angeles Dodgers'])).toBe(true);expect(teamMatches(['USC'],['USC'])).toBe(true);});
