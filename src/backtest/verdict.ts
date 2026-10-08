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
export function exitVerdict(v:Verdict|null){
  if(!v)return null;const f=v.exits.fixed,t=v.exits.trailing;
  return `Backtest: versus holding the same entries, take-profit/stop-loss ${c(f.mean)} and the trailing plan ${c(t.mean)} per trade.`;
}
export function ruinVerdict(v:Verdict|null){
  if(!v?.ruin?.length)return null;const pct=(x:number)=>`${Math.round(x*100)}%`;
  return `Backtest, 100 trades from $40: ${v.ruin.map(r=>`staking ${r.stake===1?'everything':pct(r.stake)} fell below $2 in ${pct(r.ruined)} of runs`).join(' · ')}.`;
}
