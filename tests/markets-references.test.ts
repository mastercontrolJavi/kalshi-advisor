import {it,expect} from 'vitest';
import {References,PM_STALE} from '../src/markets/references';
import {MarketsJournal} from '../src/markets/journal';
import {polymarketGames} from '../src/markets/sources/polymarket';
import {oddsGames} from '../src/markets/sources/odds';
import type {KalshiGame} from '../src/markets/match';
const NOW=Date.parse('2026-10-11T10:00:00Z');
const kg:KalshiGame={league:'nfl',expectedEnd:Date.parse('2026-10-11T16:30:00Z'),teams:[['PHI Eagles','Philadelphia','PHI'],['JAC Jaguars','Jacksonville','JAC']],yesTeam:0,kind:'moneyline',line:null,yesIsOver:null};
const pmEvent={slug:'nfl-phi-jax-2026-10-11',title:'Eagles vs. Jaguars',markets:[{id:'pm1',sportsMarketType:'moneyline',outcomes:'["Eagles", "Jaguars"]',outcomePrices:'["0.235", "0.765"]',bestBid:.23,bestAsk:.24,gameStartTime:'2026-10-11 13:30:00+00'},
  {id:'pm2',sportsMarketType:'totals',line:44.5,outcomes:'["Over", "Under"]',outcomePrices:'["0.52", "0.48"]',bestBid:.51,bestAsk:.53},{id:'pm3',sportsMarketType:'spreads',line:-3.5,outcomes:'["Eagles", "Jaguars"]',outcomePrices:'["0.5","0.5"]'}]};
const search={events:[{slug:'fed-october',title:'Fed decision in October?',markets:[{id:'m9',question:'Fed rate cut in October 2026?',outcomes:'["Yes", "No"]',outcomePrices:'["0.3", "0.7"]',bestBid:.29,bestAsk:.31}]}]};
function pm(){const calls:string[]=[];return {calls,fetchJson:async(u:string)=>{calls.push(u);
  if(u.includes('/events?'))return [pmEvent];if(u.includes('/public-search'))return search;if(u.includes('/markets/m9'))return {...search.events[0].markets[0],bestBid:.39,bestAsk:.41};throw new Error('unexpected '+u);}};}
const res=(status:number,body:any,remaining:string|null)=>({status,body,headers:{get:(k:string)=>k==='x-requests-remaining'?remaining:null}});
const oddsBody=[{id:'g1',commence_time:'2026-10-11T13:30:00Z',home_team:'Jacksonville Jaguars',away_team:'Philadelphia Eagles',bookmakers:[
  {key:'a',markets:[{key:'h2h',outcomes:[{name:'Jacksonville Jaguars',price:4.0},{name:'Philadelphia Eagles',price:1.27}]},{key:'totals',outcomes:[{name:'Over',price:1.91,point:44.5},{name:'Under',price:1.91,point:44.5}]}]},
  {key:'b',markets:[{key:'h2h',outcomes:[{name:'Jacksonville Jaguars',price:4.2},{name:'Philadelphia Eagles',price:1.25}]}]}]}];
const held=[{ticker:'KXNFLGAME-26OCT11PHIJAC-PHI',title:'PHI Eagles vs JAC Jaguars Winner?',kalshiGame:kg},{ticker:'KXFED-26OCT-CUT',title:'Will the Fed cut rates in October 2026?',kalshiGame:null}];
it('parses Polymarket games: moneyline outcome 1 is one minus the mid; totals keep their line; spreads are ignored',async()=>{
  const g=(await polymarketGames(pm().fetchJson,'nfl',NOW,NOW+86400e3))[0];expect(g.start).toBe(Date.parse('2026-10-11T13:30:00Z'));expect(g.teams[1]).toEqual(['Jaguars','jax']);
  const ml=g.markets.find(m=>m.kind==='moneyline')!;expect(ml.probs[0]).toBeCloseTo(.235);expect(ml.probs[1]).toBeCloseTo(.765);expect(g.markets.map(m=>m.kind)).toEqual(['moneyline','totals']);expect(g.markets[1].line).toBe(44.5);});
it('parses the Odds API into a de-vigged consensus with the requests left',async()=>{
  const r=await oddsGames(async()=>res(200,oddsBody,'412'),'nfl','KEY');expect(r.remaining).toBe(412);const ml=r.games[0].markets[0];expect(ml.outcomes).toEqual(['Jacksonville Jaguars','Philadelphia Eagles']);expect(ml.probs[1]).toBeGreaterThan(.75);expect(ml.probs[0]+ml.probs[1]).toBeCloseTo(1,9);
  expect(r.games[0].markets[1]).toMatchObject({kind:'totals',line:44.5});});
it('sports: an auto match gives a fresh trusted reference, snapshots at most every 5 min, and goes stale after 15 min',async()=>{
  const j=new MarketsJournal(':memory:'),p=pm(),r=new References(j,{fetchJson:p.fetchJson,log:()=>{}});await r.refresh(held,NOW);
  const ref=r.reference(held[0].ticker,NOW)!;expect(ref).toMatchObject({source:'polymarket',status:'auto',stale:false});expect(ref.prob).toBeCloseTo(.235);expect(ref.url).toContain('nfl-phi-jax');
  await r.refresh(held,NOW+60e3);expect(j.refSeries(held[0].ticker,'polymarket',0)).toHaveLength(1);expect(r.reference(held[0].ticker,NOW+PM_STALE+1)!.stale).toBe(true);
  expect(j.matchesFor(held[0].ticker)[0]).toMatchObject({status:'auto',method:'auto'});});
it('non-sports: a close Polymarket title is only suggested; a rejection is remembered across restarts',async()=>{
  const j=new MarketsJournal(':memory:');let r=new References(j,{fetchJson:pm().fetchJson,log:()=>{}});await r.refresh(held,NOW);
  const s=r.reference(held[1].ticker,NOW)!;expect(s.status).toBe('suggested');expect(s.refId).toBe('m9');expect(s.prob).toBeCloseTo(.3);
  j.decideMatch(held[1].ticker,'polymarket','m9','rejected',NOW);r=new References(j,{fetchJson:pm().fetchJson,log:()=>{}});await r.refresh(held,NOW+7*3600e3);expect(r.reference(held[1].ticker,NOW+7*3600e3)).toBeNull();});
it('a confirmed match is refreshed from its own market and trusted',async()=>{
  const j=new MarketsJournal(':memory:'),r=new References(j,{fetchJson:pm().fetchJson,log:()=>{}});await r.refresh(held,NOW);j.decideMatch(held[1].ticker,'polymarket','m9','confirmed',NOW);
  await r.refresh(held,NOW+PM_STALE);const c=r.reference(held[1].ticker,NOW+PM_STALE)!;expect(c.status).toBe('confirmed');expect(c.prob).toBeCloseTo(.4);});
it('Odds API: no key means no call; under 50 requests left means no call; a rejected key stops calls; sportsbooks win when both are fresh',async()=>{
  const calls:string[]=[],fetchRes=async(u:string)=>{calls.push(u);return res(200,oddsBody,'300');};
  const j=new MarketsJournal(':memory:');let r=new References(j,{fetchJson:pm().fetchJson,fetchRes,log:()=>{}});await r.refresh(held,NOW);expect(calls).toHaveLength(0);expect(r.health().find(h=>h.name==='Sportsbooks')!.detail).toBe('no key');
  r=new References(j,{fetchJson:pm().fetchJson,fetchRes,oddsKey:'KEY',log:()=>{}});await r.refresh(held,NOW);expect(calls).toHaveLength(1);expect(calls[0]).not.toContain('KEY ');
  const best=r.reference(held[0].ticker,NOW)!;expect(best.source).toBe('sportsbooks');expect(best.prob).toBeGreaterThan(.75);
  j.set('oddsRemaining',40);r=new References(j,{fetchJson:pm().fetchJson,fetchRes,oddsKey:'KEY',log:()=>{}});await r.refresh(held,NOW+7*3600e3);expect(calls).toHaveLength(1);
  j.set('oddsRemaining',300);const bad=async(u:string)=>{calls.push(u);return res(401,{message:'invalid key'},null);};
  r=new References(j,{fetchJson:pm().fetchJson,fetchRes:bad,oddsKey:'BAD',log:()=>{}});await r.refresh(held,NOW+7*3600e3);await r.refresh(held,NOW+14*3600e3);expect(calls).toHaveLength(2);expect(r.health().find(h=>h.name==='Sportsbooks')!.detail).toBe('key rejected');});
it('while a held game is in play, Polymarket is refreshed every minute instead of every 5',async()=>{
  const j=new MarketsJournal(':memory:'),p=pm(),r=new References(j,{fetchJson:p.fetchJson,log:()=>{}}),live=Date.parse('2026-10-11T15:00:00Z');
  await r.refresh(held,live);await r.refresh(held,live+61e3);expect(p.calls.filter(u=>u.includes('/events?')).length).toBe(2);
  const q=pm(),r2=new References(j,{fetchJson:q.fetchJson,log:()=>{}});await r2.refresh(held,NOW);await r2.refresh(held,NOW+61e3);expect(q.calls.filter(u=>u.includes('/events?')).length).toBe(1);});
it('the fresher trusted price wins: sportsbooks only beat Polymarket when they are within 5 minutes of it',async()=>{
  const live=Date.parse('2026-10-11T15:00:00Z'),j=new MarketsJournal(':memory:');
  const r=new References(j,{fetchJson:pm().fetchJson,fetchRes:async()=>res(200,oddsBody,'300'),oddsKey:'KEY',log:()=>{}});
  await r.refresh(held,live);expect(r.reference(held[0].ticker,live)!.source).toBe('sportsbooks');
  await r.refresh(held,live+20*60e3);expect(r.reference(held[0].ticker,live+20*60e3)!.source).toBe('polymarket');});
