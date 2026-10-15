import {signalEvidence,FINAL_MIN_TRADES,type Verdict} from '../backtest/verdict';
import type {FirmEvaluation} from './signals';
/**
 * Evidence gate (Settings → provenSignalsOnly, DECISIONS 56). A BUY, hourly idea or scalp/dip setup is shown, and
 * sounds, only when its rule has cleared the proven bar; otherwise the dashboard says what was hidden and why.
 * The gate changes only what is shown: every signal is still journaled and paper-traded, so a rule that starts
 * working proves itself and reappears without anyone touching a setting.
 */
export interface Hidden {side:'yes'|'no';text:string}
export function gateEvaluation(ev:FirmEvaluation,verdict:Verdict|null,source:'quant'|'model',on:boolean):FirmEvaluation&{hidden?:Hidden|null}{
  if(!on||!ev.firm&&!ev.forming)return ev;
  const e=signalEvidence(verdict,'15m',source);if(e.proven)return ev;
  if(!ev.firm)return {...ev,forming:null,reason:ev.reason.replace(/^BUY (YES|NO) forming: confirms if it holds \d+ s more · /,'')};
  return {...ev,action:'NO TRADE',idea:null,firm:null,forming:null,reason:`No proven edge — the BUY ${ev.firm.side.toUpperCase()} signal is hidden.`,hidden:{side:ev.firm.side,text:e.text}};
}
export function gateHourly<T>(ideas:T[],verdict:Verdict|null,on:boolean):{ideas:T[];hidden:string|null}{
  if(!on||!ideas.length)return {ideas,hidden:null};
  const e=signalEvidence(verdict,'hourly');return e.proven?{ideas,hidden:null}:{ideas:[],hidden:e.text};
}
/** Scalp/dip have no backtest (they need second-by-second fills), so their live paper record is the evidence. */
export interface PaperRecord {mean:number|null;low:number|null;high:number|null;count:number}
export const paperProven=(r:PaperRecord|null|undefined)=>!!r&&r.count>=FINAL_MIN_TRADES&&r.low!==null&&r.low>0;
const cents=(x:number|null)=>x===null?'—':`${x>=0?'+':'−'}${Math.abs(x*100).toFixed(1)}¢`;
export function gateTactics<I extends {kind:string},W extends {verdict:string}>(ideas:I[],watch:W[],paper:{scalp?:PaperRecord;dip?:PaperRecord}|null,on:boolean):{ideas:I[];watch:W[];hidden:string|null}{
  if(!on)return {ideas,watch,hidden:null};
  const ok=(kind:'scalp'|'dip')=>paperProven(paper?.[kind]);
  const note=(kind:'scalp'|'dip',label:string)=>{const r=paper?.[kind];return r&&r.count?`${label} ${cents(r.mean)} per contract over ${r.count.toLocaleString()} paper trades (likely range ${cents(r.low)} to ${cents(r.high)})`:`${label}: no paper record yet`;};
  const shown=ideas.filter(i=>i.kind==='scalp'?ok('scalp'):i.kind==='dip'?ok('dip'):true),shownWatch=ok('dip')?watch:watch.filter(w=>w.verdict!=='buy');
  // Say so only when something was actually held back, never on an empty panel.
  const held=new Set([...ideas.filter(i=>!shown.includes(i)).map(i=>i.kind),...(shownWatch.length<watch.length?['dip']:[])]);
  const hidden=(['scalp','dip'] as const).filter(k=>held.has(k)).map(k=>note(k,k==='scalp'?'scalps':'dips'));
  return {ideas:shown,watch:shownWatch,hidden:hidden.length?`A setup was hidden because it has no proven paper record: ${hidden.join('; ')}.`:null};
}
