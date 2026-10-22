import type {SimRound,Side} from './sim';
import {SETUP_TITLE,type SetupKind,type SetupStats,type SetupWindow} from '../backtest/setups';
/**
 * The paper-trading coach (2026-10-22, user: "tell me what worked, what didn't, why, and how to fix it"). It judges each
 * settled paper round on the decision, not the result: a decision is sound when the price paid was at or under the quant
 * forecast after the fee, the chart setup is not one that loses over thousands of past rounds (verdict.setups), the bet
 * was ≤ 5% of the paper bankroll, and there was no flip. Sound + won = good call; sound + lost = unlucky; unsound + won =
 * lucky; unsound + lost = mistake. Across rounds it adds up what each habit cost and gives the fix. No Node imports: the
 * page renders these strings.
 */
export type Verdict='good'|'unlucky'|'lucky'|'mistake'|'open';
export type Cause='selection'|'price'|'sizing'|'flips'|'earlyExit'|'fees'|'tilt';
export interface RoundReview {ticker:string;time:number;side:Side;result:Side|null;pnl:number|null;staked:number;fees:number;stakePct:number|null;title:string|null;source:'btc'|'copy'|'market';group:string|null;
  entry:{tau:number|null;price:number;fair:number|null;edge:number|null;setup:{kind:SetupKind;window:SetupWindow|null;with:boolean}|null};
  verdict:Verdict;flags:Cause[];notes:string[]}
export interface Group {label:string;rounds:number;wins:number;net:number}
export interface CauseCost {cause:Cause;title:string;rounds:number;net:number;why:string;fix:string}
export interface CoachReport {settled:number;open:number;wins:number;net:number;fees:number;staked:number;roi:number|null;avgStakePct:number|null;maxStakePct:number|null;
  drawdown:number;verdicts:Record<Exclude<Verdict,'open'>,number>;working:Group[];notWorking:Group[];causes:CauseCost[];reviews:RoundReview[];headline:string}
export const MAX_STAKE=.05;
const usd=(x:number)=>`${x>=0?'+':'−'}$${Math.abs(x).toFixed(Math.abs(x)<10?2:0)}`;
const c=(x:number)=>`${x>=0?'+':'−'}${Math.abs(x*100).toFixed(1)}¢`;
const pct=(x:number)=>`${Math.round(x*100)}%`;
const mmss=(s:number)=>`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
function setupOf(ctx:any,side:Side){const s=ctx?.setup;return s&&s.kind?{kind:s.kind as SetupKind,window:(s.window??null) as SetupWindow|null,with:s.side===side}:null;}
function record(stats:SetupStats[]|null|undefined,setup:RoundReview['entry']['setup']){
  if(!setup?.window)return null;const cell=stats?.find(x=>x.window===setup.window&&x.kind===setup.kind);return (setup.with?cell?.with:cell?.against)??null;}
const setupLabel=(s:RoundReview['entry']['setup'])=>!s?'No setup recorded':s.kind==='coinflip'?'Coin flip':`${SETUP_TITLE[s.kind]}, ${s.kind==='dip'?(s.with?'bought the trend':'chased the bounce'):(s.with?'with it':'against it')}`;
/** One settled (or open) paper round, judged on the decision. */
export function reviewRound(r:SimRound,stats?:SetupStats[]|null):RoundReview{
  const buys=r.fills.filter(f=>f.action==='buy'),first=buys[0]??r.fills[0],ctx=first.context??{};
  const q=Number.isFinite(ctx.q)?ctx.q as number:null,fair=q===null?null:first.side==='yes'?q:1-q,feeEach=first.contracts?first.fee/first.contracts:0;
  const edge=fair===null?null:fair-first.price-feeEach,setup=setupOf(ctx,first.side),rec=record(stats,setup);
  const equity=Number.isFinite(ctx.equity)&&ctx.equity>0?ctx.equity as number:null,stakePct=equity?r.staked/equity:null;
  const flags:Cause[]=[],notes:string[]=[];
  if(rec&&rec.n>=100&&rec.ci[1]<0){flags.push('selection');notes.push(`${setupLabel(setup)}${setup?.window?` with ${setup.window} min left`:''}: this has lost ${c(rec.mean)} per contract over ${rec.n.toLocaleString()} past rounds.`);}
  if(edge!==null&&edge<-.005){flags.push('price');notes.push(`Paid ${(first.price*100).toFixed(1)}¢ when the forecast put it at ${(fair!*100).toFixed(1)}¢: ${c(edge)} per contract after the fee.`);}
  else if(edge!==null)notes.push(`Paid ${(first.price*100).toFixed(1)}¢ against a ${(fair!*100).toFixed(1)}¢ forecast: ${c(edge)} per contract after the fee.`);
  if(stakePct!==null&&stakePct>MAX_STAKE){flags.push('sizing');notes.push(`Bet ${pct(stakePct)} of the paper bankroll on one round (keep it under ${pct(MAX_STAKE)}).`);}
  if(r.flipped){flags.push('flips');notes.push('Bought both sides in the same round: the second buy sold the first at the bid and paid the fee twice.');}
  if(r.soldEarly&&r.holdPnl!==null&&r.pnl!==null){const d=r.pnl-r.holdPnl;notes.push(`Sold before the close: ${d>=0?'saved':'cost'} ${usd(Math.abs(d)).slice(1)} versus holding to settlement.`);if(d<0)flags.push('earlyExit');}
  if(ctx.copy)notes.unshift(`Copied ${ctx.copy.wallets} ranked wallet${ctx.copy.wallets===1?'':'s'} holding $${Math.round(ctx.copy.value).toLocaleString()}${ctx.copy.avgEntry!=null?` from ${Math.round(ctx.copy.avgEntry*100)}¢`:''}.`);
  else if(ctx.tau!=null&&(r.ticker.startsWith('KXBTC15M')||ctx.setup))notes.unshift(`${first.side.toUpperCase()} with ${mmss(ctx.tau)} left · ${setupLabel(setup)}.`);
  const sound=!flags.some(f=>f==='selection'||f==='price'||f==='sizing'||f==='flips');
  const verdict:Verdict=r.pnl===null?'open':r.pnl>0?(sound?'good':'lucky'):(sound?'unlucky':'mistake');
  const source=ctx.copy?'copy':r.ticker.startsWith('KXBTC15M')||ctx.setup?'btc':'market';
  return {ticker:r.ticker,time:first.time,side:first.side,result:r.result,pnl:r.pnl,staked:r.staked,fees:r.fees,stakePct,title:typeof ctx.title==='string'?ctx.title:null,source,group:typeof ctx.copy?.group==='string'?ctx.copy.group:null,entry:{tau:ctx.tau??null,price:first.price,fair,edge,setup},verdict,flags,notes};
}
const CAUSES:Record<Cause,{title:string;why:string;fix:string}>={
  selection:{title:'Trading setups that lose',why:'Coin flips, bets against the trend and chased bounces lose money over thousands of past rounds: Kalshi already prices what the chart shows.',fix:'Skip coin flips and trades against the trend. The Chart setup box shows each setup’s record before you buy.'},
  price:{title:'Paying more than it is worth',why:'Buying above the forecast after the fee means each contract is expected to lose, even when it wins this time.',fix:'Only buy when the ticket shows a positive edge after the fee; otherwise wait or skip the round.'},
  sizing:{title:'Bets too big for the bankroll',why:`Large bets turn ordinary losing streaks into big drawdowns. In the backtest, betting 25% per trade went broke in some 100-trade runs; 2–10% never did.`,fix:`Keep each round under ${pct(MAX_STAKE)} of the bankroll, and size from the bankroll, not from the last result.`},
  flips:{title:'Flipping sides mid-round',why:'Buying the other side sells your position at the bid and pays the fee twice; it locks in the loss of the first view.',fix:'Pick a side once. If the view changes, sell and sit out the rest of the round.'},
  earlyExit:{title:'Selling before the close',why:'An early sale pays a second fee at the bid; on these markets holding beat selling on the same entries.',fix:'Hold to settlement unless the final 90 s show a clear SELL.'},
  fees:{title:'Fees eating the gains',why:'Kalshi’s fee is largest near 50¢ (1.75¢ a contract) and is paid on every buy and every sale.',fix:'Trade less often, avoid round-trips, and favour fewer, better-priced entries.'},
  tilt:{title:'Bigger bets after a loss',why:'Raising the stake to win a loss back concentrates risk exactly when judgment is worst.',fix:'After a losing round keep the next bet the same size or smaller.'},
};
/** Every settled paper round reviewed, plus what worked, what did not, and what each habit cost. */
export function coach(rounds:SimRound[],stats?:SetupStats[]|null,bankroll?:number):CoachReport{
  const reviews=rounds.map(r=>reviewRound(r,stats)).sort((a,b)=>a.time-b.time),done=reviews.filter(r=>r.pnl!==null);
  const net=done.reduce((s,r)=>s+r.pnl!,0),staked=done.reduce((s,r)=>s+r.staked,0),fees=done.reduce((s,r)=>s+r.fees,0),stakes=done.map(r=>r.stakePct).filter((x):x is number=>x!==null);
  let peak=bankroll??0,eq=bankroll??0,drawdown=0;for(const r of done){eq+=r.pnl!;peak=Math.max(peak,eq);drawdown=Math.max(drawdown,peak-eq);}
  const verdicts={good:0,unlucky:0,lucky:0,mistake:0};for(const r of done)verdicts[r.verdict as keyof typeof verdicts]++;
  // Tilt: a round staked ≥ 1.5× the previous one right after a losing round.
  const tilt=new Set<string>();for(let i=1;i<done.length;i++)if(done[i-1].pnl!<0&&done[i].staked>=1.5*done[i-1].staked)tilt.add(done[i].ticker);
  const causes:CauseCost[]=(Object.keys(CAUSES) as Cause[]).map(cause=>{
    const xs=cause==='tilt'?done.filter(r=>tilt.has(r.ticker)):cause==='fees'?[]:done.filter(r=>r.flags.includes(cause));
    if(cause==='fees'){const gross=done.filter(r=>r.pnl!>0).reduce((s,r)=>s+r.pnl!+r.fees,0);return {cause,...CAUSES[cause],rounds:done.length,net:gross>0&&fees/gross>=.25?-fees:0};}
    const lost=cause==='earlyExit'?xs.reduce((s,r)=>s+r.pnl!-(rounds.find(x=>x.ticker===r.ticker)?.holdPnl??r.pnl!),0):xs.reduce((s,r)=>s+r.pnl!,0);
    return {cause,...CAUSES[cause],rounds:xs.length,net:lost};
  }).filter(x=>x.rounds>0&&x.net<0).sort((a,b)=>a.net-b.net);
  const groups=new Map<string,Group>();const add=(label:string,r:RoundReview)=>{const g=groups.get(label)??{label,rounds:0,wins:0,net:0};g.rounds++;if(r.pnl!>0)g.wins++;g.net+=r.pnl!;groups.set(label,g);};
  for(const r of done){if(r.source==='copy'){add(`Copied sharps${r.group?` · ${r.group}`:''}`,r);add('Copied sharps',r);}else if(r.source==='btc'){add(setupLabel(r.entry.setup),r);if(r.entry.setup?.window)add(`${r.entry.setup.window} min left`,r);}
    const p=r.entry.price;add(p<.3?'Long shots (under 30¢)':p<.6?'Near even (30–60¢)':p<.85?'Favourites (60–85¢)':'Heavy favourites (85¢+)',r);
    add(rounds.find(x=>x.ticker===r.ticker)?.soldEarly?'Sold before the close':'Held to settlement',r);}
  // A group holding every round only repeats the total, so it is not an insight.
  const all=[...groups.values()].filter(g=>g.rounds>=2&&g.rounds<done.length);
  const working=all.filter(g=>g.net>0).sort((a,b)=>b.net-a.net).slice(0,3),notWorking=all.filter(g=>g.net<0).sort((a,b)=>a.net-b.net).slice(0,3);
  const roi=staked>0?net/staked:null;
  const headline=!done.length?'Make a few paper trades: each settled round gets a review here.'
    :causes[0]?`${done.length} round${done.length===1?'':'s'}, ${usd(net)}. Biggest leak: ${CAUSES[causes[0].cause].title.toLowerCase()} (${usd(causes[0].net)} over ${causes[0].rounds} round${causes[0].rounds===1?'':'s'}).`
    :`${done.length} round${done.length===1?'':'s'}, ${usd(net)}, no costly habit found yet. ${done.length<20?'Keep going: 20+ rounds tell more than a few.':''}`.trim();
  return {settled:done.length,open:reviews.length-done.length,wins:done.filter(r=>r.pnl!>0).length,net,fees,staked,roi,avgStakePct:stakes.length?stakes.reduce((a,b)=>a+b,0)/stakes.length:null,maxStakePct:stakes.length?Math.max(...stakes):null,
    drawdown,verdicts,working,notWorking,causes,reviews:[...reviews].reverse(),headline};
}
