/** Words that say nothing about which team or event it is. */
const STOP=new Set(['vs','the','fc','game','winner','st','state','university','of','at','and']);
export function normTokens(s:string):string[]{return s.toLowerCase().split(/[^a-z0-9]+/).filter(t=>t.length>=2&&!STOP.has(t));}
const initials=(tokens:string[],n:number)=>tokens.slice(0,tokens.length-n+1).map((_,i)=>tokens.slice(i,i+n).map(t=>t[0]).join(''));
/**
 * Whether two descriptions of one team agree. Venues name teams differently (Kalshi "Chicago WS" / "PHI Eagles" / code JAC,
 * Polymarket "Chicago White Sox" / "Eagles" / code jax), so any of: the same short code, a shared word of 3+ letters, or a
 * Kalshi abbreviation that is the initials of consecutive words ("WS" = White Sox). Loose on purpose: a game only matches
 * when both of its teams pair up with exactly one game (see matchGame), which is what keeps a loose word match safe.
 */
export function teamMatches(kalshi:string[],ref:string[]):boolean{
  const rs=ref.map(normTokens);
  for(const k of kalshi){const kt=normTokens(k);
    for(const r of rs){
      if(kt.some(t=>t.length>=3&&r.includes(t)))return true;
      if(kt.length===1&&kt[0].length<=4&&r.length===1&&r[0]===kt[0])return true;
      for(const t of kt)if(t.length>=2&&t.length<=4&&r.length>=t.length&&initials(r,t.length).includes(t))return true;
    }}
  return false;
}
