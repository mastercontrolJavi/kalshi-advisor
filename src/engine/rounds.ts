import type Database from 'better-sqlite3';
/**
 * Round history: every 15-minute window with the calls the app made in it and how they turned out, plus rolling
 * hit-rate and Brier trends so it is easy to see whether the calls are improving or drifting.
 */
export interface Call {direction:string;p:number;mid?:number|null}
export interface Round {ticker:string;open:number|null;close:number|null;result:'yes'|'no'|null;settle:number|null;
  opening:Call|null;live:Record<string,Call>;next:Record<string,Call>;userPnl:number|null}
const right=(c:Call|null|undefined,result:string|null)=>c&&result?(c.direction==='UP')===(result==='yes'):null;
export function buildRounds(db:Database.Database,limit=40):{rounds:Round[];trends:any}{
  const tickers=(db.prepare(`SELECT ticker,MAX(t) t FROM (SELECT ticker,time t FROM opening_calls UNION ALL SELECT ticker,time t FROM outcomes UNION ALL SELECT ticker,time t FROM live_calls) GROUP BY ticker ORDER BY t DESC LIMIT ?`).all(limit) as {ticker:string}[]).map(r=>r.ticker);
  const one=<T>(sql:string,t:string)=>db.prepare(sql).get(t) as T|undefined;
  const rounds=tickers.map(t=>{
    const o=one<any>('SELECT result,actual_average FROM outcomes WHERE ticker=?',t),m=one<any>("SELECT value FROM settings WHERE key=?",`market:${t}`),mk=m?JSON.parse(m.value):null;
    const oc=one<any>('SELECT direction,p,mid FROM opening_calls WHERE ticker=?',t);
    const live=Object.fromEntries((db.prepare('SELECT horizon,direction,p,mid FROM live_calls WHERE ticker=?').all(t) as any[]).map(r=>[String(r.horizon),{direction:r.direction,p:r.p,mid:r.mid}]));
    const next=Object.fromEntries((db.prepare('SELECT horizon,direction,p FROM next_calls WHERE ticker=?').all(t) as any[]).map(r=>[String(r.horizon),{direction:r.direction,p:r.p}]));
    const pnl=one<any>("SELECT context FROM real_trades WHERE ticker=? AND type='settlement'",t);
    return {ticker:t,open:mk?Date.parse(mk.open_time):null,close:mk?Date.parse(mk.close_time):null,result:o?.result??null,settle:o?.actual_average??null,
      opening:oc?{direction:oc.direction,p:oc.p,mid:oc.mid}:null,live,next,userPnl:pnl?JSON.parse(pnl.context).outcomePnl??null:null} as Round;
  });
  // Trends over settled rounds, oldest first: rolling 10-round hit rate per call type, and all-time totals.
  const settled=[...rounds].filter(r=>r.result).reverse();
  const kinds:{key:string;get:(r:Round)=>Call|null|undefined}[]=[{key:'opening',get:r=>r.opening},{key:'live300',get:r=>r.live['300']},{key:'live60',get:r=>r.live['60']},{key:'next5',get:r=>r.next['5']??r.next['10']}];
  const rolling=settled.map((r,i)=>{const w=settled.slice(Math.max(0,i-9),i+1);const row:any={ticker:r.ticker,close:r.close};
    for(const k of kinds){const hits=w.map(x=>right(k.get(x),x.result)).filter((h):h is boolean=>h!==null);row[k.key]=hits.length?hits.filter(Boolean).length/hits.length:null;}return row;});
  const totals=Object.fromEntries(kinds.map(k=>{const rs=settled.filter(r=>k.get(r));const hits=rs.filter(r=>right(k.get(r),r.result)).length;
    const brier=rs.length?rs.reduce((s,r)=>s+(k.get(r)!.p-(r.result==='yes'?1:0))**2,0)/rs.length:null;return [k.key,{n:rs.length,hits,rate:rs.length?hits/rs.length:null,brier,last10:rolling.at(-1)?.[k.key]??null}];}));
  return {rounds,trends:{rolling,totals}};
}
