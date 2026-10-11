/**
 * The compact backtest verdict the live app shows beside its signals. `npm run backtest` writes it to
 * data/backtest-verdict.json; the engine reloads it when the file changes. No Node imports: the UI formats it too.
 */
export const VERDICT_PATH='./data/backtest-verdict.json';
export interface RuleResult {n:number;mean:number;ci:[number,number];early:number;late:number}
export interface Verdict {
  generated:string;from:number;to:number;rounds:number;hours:number;
  buy15:RuleResult;buyHourly:RuleResult|null;
  /** The same rule on the raw diffusion model (Use quant forecast for signals off). */
  buy15Model?:RuleResult|null;
  exits:{fixed:{mean:number;ci:[number,number]};trailing:{mean:number;ci:[number,number]}};
  kalshiBetter:{fifteen:number;fifteenOf:number;hourly:number;hourlyOf:number};
  profitable:string[];strategies:number;
  /** Share of 100-trade runs that fell below 5% of the start, by stake per trade, for the BUY rule's trades. */
  ruin:{stake:number;ruined:number}[];
  /** Average return on money spent for contracts bought at ≤ 5¢ (15-minute, 5–14 min left) and hourly. */
  longshot:{fifteen:number|null;hourly:number|null};
  finalMinute:{rounds:number;trade:RuleResult|null}|null;
  /** Selling vs holding when the quant forecast is ≥ 3¢ below the net bid: 1–15 min left (history) and last 90 s (live journal). */
  sellTest?:{window:RuleResult;final:RuleResult|null}|null;
}
const c=(x:number)=>`${x>=0?'+':'−'}${Math.abs(x*100).toFixed(1)}¢`;
const date=(ts:number)=>new Date(ts*1000).toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'});
export const STALE_DAYS=14;
export function stale(v:Verdict,now=Date.now()){return now-Date.parse(v.generated)>STALE_DAYS*86400000;}
/** One sentence for a BUY signal: how the same rule did on past rounds, and whether that is an edge. */
export function ruleVerdict(v:Verdict|null,which:'15m'|'hourly',now=Date.now(),source:'quant'|'model'='quant'):{tone:'yes'|'warn'|'neutral';text:string}{
  if(!v)return {tone:'neutral',text:'Not backtested yet: run npm run backtest to see how this rule did on past rounds.'};
  const raw=which==='15m'&&source==='model',r=which==='15m'?raw?v.buy15Model??null:v.buy15:v.buyHourly;
  if(!r||!r.n)return {tone:'neutral',text:`Not backtested for ${which==='15m'?'15-minute':'hourly'} markets yet.`};
  const edge=r.ci[0]>0,loses=r.ci[1]<0;
  const text=`Backtest: this BUY rule${raw?' (raw model)':''} averaged ${c(r.mean)} per contract after fees over ${r.n.toLocaleString()} past ${which==='15m'?'rounds':'hours'} (${date(v.from)}–${date(v.to)}; likely range ${c(r.ci[0])} to ${c(r.ci[1])}) — ${edge?'a measurable edge so far':loses?'it lost money':'no proven edge'}.${stale(v,now)?' Results are over two weeks old; re-run npm run backtest.':''}`;
  return {tone:edge?'yes':'warn',text};
}
/**
 * Whether the final-minute study supports entries in the last minute. "proven" needs ≥ 100 trades, a 95% range above
 * zero and a positive first and second half, so one lucky stretch cannot switch anything on. The app only reports it;
 * acting on it is the user's Settings choice (finalMinuteSignals).
 */
export const FINAL_MIN_TRADES=100;
export function finalMinuteEvidence(v:Verdict|null):{status:'collecting'|'proven'|'losing'|'unclear';rounds:number;text:string}{
  const f=v?.finalMinute,t=f?.trade;if(!f||!t||!t.n)return {status:'collecting',rounds:f?.rounds??0,text:'Final-minute study: collecting data.'};
  const range=`${c(t.mean)} per contract over ${t.n} trades (likely range ${c(t.ci[0])} to ${c(t.ci[1])}), ${f.rounds} rounds`;
  if(t.n<FINAL_MIN_TRADES)return {status:'collecting',rounds:f.rounds,text:`Final-minute study: ${range} so far. Needs ${FINAL_MIN_TRADES}+ trades before it can show an edge.`};
  if(t.ci[0]>0&&t.early>0&&t.late>0)return {status:'proven',rounds:f.rounds,text:`Final-minute study: entries in the last minute made ${range}, and in both halves of the period.`};
  if(t.ci[1]<0)return {status:'losing',rounds:f.rounds,text:`Final-minute study: entries in the last minute lost money: ${range}.`};
  return {status:'unclear',rounds:f.rounds,text:`Final-minute study: no proven edge yet: ${range}.`};
}
/** The evidence behind an advise-mode label, in one line (null when there is nothing to cite). */
export function sellEvidence(v:Verdict|null,action:string):string|null{
  const t=v?.sellTest;if(!t)return null;const w=t.window,f=t.final;
  const fin=f&&f.n?`In the final 90 s, selling when the forecast sat 3¢+ below the bid made ${c(f.mean)} per contract versus holding over ${f.n} rounds (likely range ${c(f.ci[0])} to ${c(f.ci[1])})${f.ci[0]>0&&f.early>0&&f.late>0?'.':', not proven yet.'}`:'Final-90-second sells: still collecting rounds; not proven yet.';
  if(action==='SELL'||action==='SELL NOW')return fin;
  if(action==='HOLD'||action==='LET IT RIDE'||action==='TOO LATE')return `Selling with 1–15 min left when the forecast sat 3¢+ below the bid made ${c(w.mean)} per contract versus holding over ${w.n.toLocaleString()} past rounds (likely range ${c(w.ci[0])} to ${c(w.ci[1])}).`;
  return null;
}
export function exitVerdict(v:Verdict|null){
  if(!v)return null;const f=v.exits.fixed,t=v.exits.trailing;
  return `Backtest: versus holding the same entries, take-profit/stop-loss ${c(f.mean)} and the trailing plan ${c(t.mean)} per trade.`;
}
