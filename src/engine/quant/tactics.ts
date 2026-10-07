import {fee,type FeeSchedule} from '../model/fees';
/**
 * Intra-window tactics, priced after fees.
 * Scalp: the market sells a side below fair value by enough that a quick partial reversion pays.
 *   Enter at the ask (taker fee); exit with a resting sell at the target (maker fee, zero on KXBTC15M today).
 *   Target = halfway to fair value, at least 2¢ above entry, never above fair − 1¢. If the target never fills the
 *   position is simply held, whose value is the ordinary taker edge.
 * Dip: a side's ask fell sharply in the last minute. If fair value did not fall with it, the drop looks like an
 * overreaction (buy the dip, target a half retrace); if fair value fell too, it is a real move (falling knife).
 */
export interface TacticsConfig {scalpMinEdge:number;scalpMinSeconds:number;scalpMaxSpread:number;dipMove:number;minDepth:number;minEdge:number}
export interface Quote {yesBid:number|null;yesAsk:number|null;noBid:number|null;noAsk:number|null;yesDepth:number;noDepth:number}
export interface Tactic {kind:'scalp'|'dip';side:'yes'|'no';price:number;target:number;fee:number;edge:number;profitAtTarget:number;stopBelow:number;reason:string}
export interface DipWatch {side:'yes'|'no';drop:number;from:number;to:number;fairDrop:number;verdict:'buy'|'knife'}
const cents=(x:number)=>`${(x*100).toFixed(1)}¢`;
const ceilCent=(x:number)=>Math.ceil(x*100-1e-9)/100;
function side(q:number,s:'yes'|'no',quote:Quote){const ask=s==='yes'?quote.yesAsk:quote.noAsk,bid=s==='yes'?quote.yesBid:quote.noBid;return {fair:s==='yes'?q:1-q,ask,bid,depth:s==='yes'?quote.yesDepth:quote.noDepth};}
export function scalp(q:number,tau:number,quote:Quote,schedule:FeeSchedule,c:TacticsConfig):Tactic|null{
  if(tau<c.scalpMinSeconds)return null;
  let best:Tactic|null=null;
  for(const s of ['yes','no'] as const){
    const {fair,ask,bid,depth}=side(q,s,quote);if(ask===null||bid===null||ask<=0||ask>=1||ask-bid>c.scalpMaxSpread+1e-9||depth<c.minDepth)continue;
    const f=fee(ask,1,'taker',schedule),edge=fair-ask-f;if(edge<c.scalpMinEdge)continue;
    const target=Math.min(ceilCent(fair-.01),ceilCent(Math.max(ask+.02,ask+(fair-ask)/2)));if(target<=ask||target>=1)continue;
    const profit=target-ask-f-fee(target,1,'maker',schedule);if(profit<.01)continue;
    const idea:Tactic={kind:'scalp',side:s,price:ask,target,fee:f,edge,profitAtTarget:profit,stopBelow:Math.max(.01,ask-(target-ask)),
      reason:`Buy ${s.toUpperCase()} ${cents(ask)}, rest a sell at ${cents(target)} → ${cents(profit)}/contract after fees; fair ${cents(fair)}. Bail if the bid drops to ${cents(Math.max(.01,ask-(target-ask)))} or the model falls below ${cents(ask)}.`};
    if(!best||idea.profitAtTarget>best.profitAtTarget)best=idea;
  }
  return best;
}
/** history: per-second samples (oldest first) of asks and the forecast within the current window. */
export function dips(history:{time:number;yesAsk:number|null;noAsk:number|null;q:number}[],now:number,q:number,quote:Quote,schedule:FeeSchedule,c:TacticsConfig,tau:number):{watch:DipWatch[];idea:Tactic|null}{
  const recent=history.filter(h=>h.time>=now-60000),watch:DipWatch[]=[];let idea:Tactic|null=null;
  for(const s of ['yes','no'] as const){
    const {fair,ask,bid,depth}=side(q,s,quote);if(ask===null)continue;
    const peak=recent.reduce<{price:number;q:number}|null>((m,h)=>{const a=s==='yes'?h.yesAsk:h.noAsk;return a!==null&&(!m||a>m.price)?{price:a,q:s==='yes'?h.q:1-h.q}:m;},null);
    if(!peak||peak.price-ask<c.dipMove)continue;
    const drop=peak.price-ask,fairDrop=peak.q-fair,f=fee(ask,1,'taker',schedule),edge=fair-ask-f;
    const verdict:'buy'|'knife'=fairDrop<.6*drop&&edge>=c.minEdge*.75?'buy':'knife';
    watch.push({side:s,drop,from:peak.price,to:ask,fairDrop,verdict});
    if(verdict==='buy'&&tau>=c.scalpMinSeconds&&bid!==null&&depth>=c.minDepth){
      const target=Math.min(ceilCent(fair-.01),ceilCent(ask+drop/2)),profit=target-ask-f-fee(target,1,'maker',schedule);
      if(target>ask&&profit>=.01&&(!idea||profit>idea.profitAtTarget))idea={kind:'dip',side:s,price:ask,target,fee:f,edge,profitAtTarget:profit,stopBelow:Math.max(.01,ask-drop/2),
        reason:`${s.toUpperCase()} fell ${cents(drop)} in a minute but fair value only moved ${cents(Math.max(0,fairDrop))}: buy ${cents(ask)}, target the half-retrace at ${cents(target)} (${cents(profit)} after fees).`};
    }
  }
  return {watch,idea};
}
