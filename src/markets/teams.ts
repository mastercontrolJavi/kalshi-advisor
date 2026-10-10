/** Words that say nothing about which team or event it is. */
const STOP=new Set(['vs','the','fc','game','winner','st','state','university','of','at','and']);
export function normTokens(s:string):string[]{return s.toLowerCase().split(/[^a-z0-9]+/).filter(t=>t.length>=2&&!STOP.has(t));}
// Names of teams: generic place words say nothing; modifiers must agree (Iowa ≠ Iowa State, Michigan ≠ Central Michigan).
const DROP=new Set(['vs','the','fc','game','winner','university','college','of','at','and','los','las','san','saint','fort','city']);
const MODS=new Set(['state','tech','am','christian','poly','international','north','south','east','west','northern','southern','eastern','western','central','new']);
function nameTokens(s:string){const raw=s.toLowerCase().replace(/&/g,'').split(/[^a-z0-9]+/).filter(Boolean);return raw.map((t,i)=>t==='st'?(i===raw.length-1?'state':'saint'):t).filter(t=>t.length>=2&&!DROP.has(t));}
/** A bare code: Kalshi ticker codes (PHI, SCST) are upper case, Polymarket slug codes (phi, scst) lower case. */
const isCode=(s:string)=>/^[A-Za-z]{2,6}$/.test(s)&&(s===s.toUpperCase()||s===s.toLowerCase());
/**
 * Whether two descriptions of one team agree. Venues name teams differently (Kalshi "Chicago WS" / "PHI Eagles" / code JAC,
 * Polymarket "Chicago White Sox" / "Eagles" / code jax, sportsbooks "Iowa Hawkeyes"). A match is any of:
 * - the same code on both sides;
 * - the same modifiers (State, Tech, Central, Southern…) and one side's core name contained in the other's
 *   ("Eagles" in "PHI Eagles", "Iowa" in "Iowa Hawkeyes", but not "Iowa" in "Iowa State");
 * - a Kalshi abbreviation that is the initials of consecutive words ("WS" = White Sox).
 * Generic place words never count: on 2026-10-10 "South Carolina St. vs Charleston Southern" was paired with "Southern
 * Illinois vs South Dakota" through "South"/"Southern". A game still needs both teams to pair uniquely (see matchGame).
 */
export function teamMatches(kalshi:string[],ref:string[]):boolean{
  const kc=new Set(kalshi.filter(isCode).map(s=>s.toLowerCase()));if(ref.filter(isCode).some(c=>kc.has(c.toLowerCase())))return true;
  // A code written as a word of the other name: Kalshi "JAC" in the title part "JAC Jaguars".
  if(ref.some(s=>s.toLowerCase().split(/[^a-z0-9]+/).some(w=>kc.has(w))))return true;
  for(const a of kalshi.filter(s=>!isCode(s)))for(const b of ref.filter(s=>!isCode(s))){
    const ta=nameTokens(a),tb=nameTokens(b),ma=ta.filter(t=>MODS.has(t)).sort().join(),mb=tb.filter(t=>MODS.has(t)).sort().join();
    const ca=ta.filter(t=>!MODS.has(t)),cb=tb.filter(t=>!MODS.has(t));
    if(ma===mb&&ca.length&&cb.length&&(ca.every(t=>cb.includes(t))||cb.every(t=>ca.includes(t))))return true;
  }
  for(const a of kalshi)for(const abbr of a.split(/\s+/).filter(w=>/^[A-Z]{2,4}$/.test(w)).map(w=>w.toLowerCase()))for(const b of ref){
    const words=b.toLowerCase().split(/[^a-z]+/).filter(Boolean);for(let i=0;i+abbr.length<=words.length;i++)if(words.slice(i,i+abbr.length).map(w=>w[0]).join('')===abbr)return true;
  }
  return false;
}
