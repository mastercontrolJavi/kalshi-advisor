import type Database from 'better-sqlite3';
import {quote,scoreBy,simulate,summarize,median,sideAsk,edges,type Row,type Picker,type Score,type Summary} from './sim';
/**
 * Final-minute study from the live journal (data/advisor.db). The 1-minute history cannot see inside the last 60 s,
 * where the settlement average is partly locked and the live model knows it. The journal records every second of
 * every round the app watched (ticks are kept 30 days), so this answers the question as rounds accumulate.
 */
export const FINAL_BUCKETS=['50–59 s','40–50 s','30–40 s','20–30 s','10–20 s','1–10 s'];
const bucket=(tau:number)=>tau>=50?FINAL_BUCKETS[0]:tau>=40?FINAL_BUCKETS[1]:tau>=30?FINAL_BUCKETS[2]:tau>=20?FINAL_BUCKETS[3]:tau>=10?FINAL_BUCKETS[4]:FINAL_BUCKETS[5];
export function finalMinuteRows(db:Database.Database):Row[]{
  const rows=db.prepare(`SELECT t.ticker,t.time,t.tau,t.p,t.k,t.proxy,t.sigma,json_extract(t.context,'$.q') q,json_extract(t.context,'$.book.yesBid') yb,json_extract(t.context,'$.book.yesAsk') ya,o.result
    FROM ticks t JOIN outcomes o ON o.ticker=t.ticker WHERE t.tau>=1 AND t.tau<60 AND t.p IS NOT NULL ORDER BY t.ticker,t.time`).all() as any[];
  return rows.filter(r=>r.result==='yes'||r.result==='no').map(r=>{const q=quote({bid:r.yb,ask:r.ya});
    return {cluster:r.ticker,ticker:r.ticker,time:Math.round(r.time/1000),tau:r.tau,y:r.result==='yes'?1:0,strike:r.k??0,spot:r.proxy??0,sigma:r.sigma??0,basis:0,model:r.p,quant:typeof r.q==='number'?r.q:r.p,...q};});
}
/** Taker entry in the final minute when the forecast beats the ask by ≥ minEdge after the fee (the live gate forbids it). */
export function finalMinutePick(p:(r:Row)=>number,minEdge=.04,minTau=5,maxSpread=.06):Picker{
  return r=>{if(r.tau<minTau||r.bid===null||r.ask===null||r.ask-r.bid>maxSpread+1e-9)return null;const e=edges(r,p(r));
    const side=(e.yes??-1)>=(e.no??-1)?'yes':'no',edge=(side==='yes'?e.yes:e.no)??-1;return edge>=minEdge?{side,price:sideAsk(r,side)!,score:edge}:null;};
}
export interface FinalMinute {rounds:number;rows:number;from:number;to:number;accuracy:Score[];model:Summary;quant:Summary}
export function finalMinuteStudy(db:Database.Database):FinalMinute|null{
  const rows=finalMinuteRows(db);if(!rows.length)return null;
  const split=median(rows.map(r=>r.time));
  return {rounds:new Set(rows.map(r=>r.cluster)).size,rows:rows.length,from:Math.min(...rows.map(r=>r.time)),to:Math.max(...rows.map(r=>r.time)),
    accuracy:scoreBy(rows,r=>bucket(r.tau),FINAL_BUCKETS),model:summarize(simulate(rows,finalMinutePick(r=>r.model)),split),quant:summarize(simulate(rows,finalMinutePick(r=>r.quant)),split)};
}
