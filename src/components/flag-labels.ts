/** Plain names for scanner flag types, shared by the Scanner and Record tabs. */
export const FLAG_LABEL:Record<string,string>={'ref-gap-yes':'Outside price above the YES ask','ref-gap-no':'Outside price above the NO ask','move-follow':'1-hour move · follow','move-fade':'1-hour move · fade','bias-yes':'Price-band history · YES','bias-no':'Price-band history · NO','sharp-yes':'Sharp wallets · copy YES','sharp-no':'Sharp wallets · copy NO'};
const signedCents=(v:number)=>`${v>=0?'+':'−'}${Math.abs(v*100).toFixed(1)}¢`;
/** "+2.1¢ (0.4 to 3.9) · 140 settled · proven", or "unproven · 12 settled". */
export function evidenceText(e:{n:number;mean:number|null;low:number|null;high:number|null;proven:boolean}|null){
  if(!e||!e.n)return 'unproven · none settled yet';
  const range=e.low!=null&&e.high!=null?` (${signedCents(e.low)} to ${signedCents(e.high)})`:'';
  return `${e.mean!=null?signedCents(e.mean):'—'}${range} per contract · ${e.n} settled · ${e.proven?'proven':'unproven'}`;
}
