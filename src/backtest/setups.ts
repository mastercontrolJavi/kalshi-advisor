/**
 * Chart setups (2026-10-17 pattern study, scripts/pattern-study.ts): the situations a trader reads off the BTC chart,
 * named the same way in the backtest and live so the dashboard can show how the setup on screen did on past rounds.
 * No Node imports: the UI formats these too.
 *  - coinflip: BTC within normal noise of the target (|z| < 0.35) — either side is about 50/50.
 *  - dip: BTC is past the target but its last minute moved back toward it by ≥ 0.5 of a normal minute's move.
 *  - strong: BTC is well past the target (|z| ≥ 1).
 *  - trend: past the target (0.35 ≤ |z| < 1), no dip.
 * z = log(BTC / target) ÷ (volatility × √seconds left): how many normal moves BTC would need to cross back.
 */
import type {RuleResult} from './verdict';
export type SetupKind='coinflip'|'dip'|'strong'|'trend';
export const SETUP_WINDOWS=[{key:'15–10',lo:601,hi:900},{key:'10–5',lo:300,hi:600},{key:'5–2',lo:120,hi:299}] as const;
export type SetupWindow=typeof SETUP_WINDOWS[number]['key'];
export const windowOf=(tau:number):SetupWindow|null=>SETUP_WINDOWS.find(w=>tau>=w.lo&&tau<=w.hi)?.key??null;
/** move1: the last minute's BTC move in normal-minute units; change1: the same in dollars; dist: BTC − target in dollars. */
export interface Setup {kind:SetupKind;side:'yes'|'no';z:number;move1:number|null;change1:number|null;dist:number;window:SetupWindow|null}
/** spot60: BTC 60 s ago (null if unknown); sigma: per-second log volatility. */
export function classifySetup(i:{tau:number;spot:number;k:number;sigma:number;spot60:number|null}):Setup|null{
  if(!(i.sigma>0)||!(i.tau>0)||!(i.spot>0)||!(i.k>0))return null;
  const z=Math.log(i.spot/i.k)/(i.sigma*Math.sqrt(i.tau)),sg=z>=0?1:-1,unit=i.spot*i.sigma*Math.sqrt(60);
  const move1=i.spot60!==null&&i.spot60>0?(i.spot-i.spot60)/unit:null;
  const kind:SetupKind=Math.abs(z)<.35?'coinflip':move1!==null&&sg*move1<=-.5?'dip':Math.abs(z)>=1?'strong':'trend';
  return {kind,side:z>=0?'yes':'no',z,move1,change1:i.spot60!==null&&i.spot60>0?i.spot-i.spot60:null,dist:i.spot-i.k,window:windowOf(i.tau)};
}
/** Buying one side at the ask, held to settlement: RuleResult plus how often it won and the average price paid. */
export interface SetupRecord extends RuleResult {win:number;paid:number}
/** with = the side BTC is on (for a dip: the trend side); against = the other side (for a dip: chasing the bounce). */
export interface SetupStats {window:SetupWindow;kind:SetupKind;with:SetupRecord|null;against:SetupRecord|null}
const c=(x:number)=>`${x>=0?'+':'−'}${Math.abs(x*100).toFixed(1)}¢`;
const proven=(r:SetupRecord)=>r.n>=100&&r.ci[0]>0&&r.early>0&&r.late>0;
const loses=(r:SetupRecord)=>r.ci[1]<0;
export const SETUP_TITLE:Record<SetupKind,string>={coinflip:'Coin flip',dip:'Dip in a trend',strong:'Strong trend',trend:'Trend'};
/** One-line verdict for a record: what it made, its range, and whether that is an edge, a loss or a fair price. */
export function recordText(r:SetupRecord|null,what:string){
  if(!r||!r.n)return `${what}: no past rounds yet.`;
  return `${what} won ${Math.round(r.win*100)}% at ${Math.round(r.paid*100)}¢ on average: ${c(r.mean)} per contract after fee over ${r.n.toLocaleString()} rounds (likely ${c(r.ci[0])} to ${c(r.ci[1])}) — ${proven(r)?'a small edge, in both halves of the record':loses(r)?'loses money':'about a fair price, no proven edge'}.`;
}
export function setupTone(st:SetupStats|null,kind:SetupKind):'yes'|'warn'|'neutral'{
  if(kind==='coinflip')return 'warn';const w=st?.with;return w&&proven(w)?'yes':w&&loses(w)?'warn':'neutral';
}
/** What to show for the live setup: a title, the plain-language situation, and the history lines. */
export function describeSetup(s:Setup,stats:SetupStats[]|null|undefined){
  const st=stats?.find(x=>x.window===s.window&&x.kind===s.kind)??null,up=s.side==='yes',dir=up?'UP':'DOWN',yes=up?'YES':'NO',no=up?'NO':'YES';
  const away=`BTC $${Math.abs(s.dist).toFixed(0)} ${up?'above':'below'} the target`;
  const title=s.kind==='coinflip'?'Coin flip':`${SETUP_TITLE[s.kind]} ${dir}`;
  const situation=s.kind==='coinflip'?`${away}, within normal noise. Either side is close to 50/50.`
    :s.kind==='dip'?`${away}, but it moved $${Math.abs(s.change1??0).toFixed(0)} back toward it in the last minute.`
    :s.kind==='strong'?`${away}, far enough that it would need an unusually big move to cross back.`:`${away} and holding.`;
  const lines=!s.window?['No past record for this much time left.']
    :s.kind==='coinflip'?[recordText(st?.with??null,`Past rounds, ${s.window} min left: buying ${yes}`),recordText(st?.against??null,`Buying ${no}`)]
    :s.kind==='dip'?[recordText(st?.with??null,`Past dips, ${s.window} min left: buying the trend (${yes})`),recordText(st?.against??null,`Chasing the bounce (${no})`)]
    :[recordText(st?.with??null,`Past rounds, ${s.window} min left: buying ${yes}`),recordText(st?.against??null,`Betting against it (${no})`)];
  return {title,situation,lines,tone:setupTone(st,s.kind)};
}
