import {normalCDF} from '../model/math';
/**
 * Proxy→BRTI basis learned from settlements. basis_error = proxy closing average − official average, so the
 * correction added to proxy-based averages is −median(recent errors), shrunk toward 0 while evidence is thin.
 */
export function autoBasis(errors:number[],window=30,shrink=5){
  const recent=errors.filter(Number.isFinite).slice(-window);if(recent.length<3)return {correction:0,n:recent.length};
  const s=[...recent].sort((a,b)=>a-b),m=s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2;
  return {correction:-m*recent.length/(recent.length+shrink),n:recent.length};
}
/**
 * Next-window preview. The next window's K is the simple average of the same final 60 s that settle the current
 * window (A), and it opens at S_close. So its "head start" D = S_close − A is partly knowable now:
 *   τ > 60: E[D] = 0,  Var[D] = σ²S²·20
 *   τ ≤ 60: E[D] = (60−τ)/60 · (S − mean(locked)),  Var[D] = σ²S²·(τ − τ²/60 + τ³/10800)
 * At its open the next window still needs σ²S²·(840 + 20) of average variance, so
 *   P(next up) ≈ Φ( E[D] / sqrt(Var[D] + σ²S²·860) ).
 * Away from the final minute this is ≈50%: an honest "no information yet", not a guess.
 */
export function nextWindow(spot:number,sigma:number,tau:number,locked:number[],basis=0){
  if(!(spot>0)||!(sigma>0)||!(tau>=0))throw new Error('Invalid next-window inputs');
  const v=(sigma*spot)**2,t=Math.min(tau,60);
  const lockedMean=locked.length?locked.reduce((a,b)=>a+b,0)/locked.length:spot;
  const headStart=tau>60?0:(60-tau)/60*(spot-lockedMean);
  const varD=tau>60?20*v:v*(t-t*t/60+t**3/10800);
  const sd=Math.sqrt(varD+860*v),expectedK=(tau>60?spot:(locked.reduce((a,b)=>a+b,0)+tau*spot)/60)+basis;
  return {pUp:normalCDF(headStart/sd),headStart,headStartSd:Math.sqrt(varD),expectedK};
}
