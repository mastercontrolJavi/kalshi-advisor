export interface FeeSchedule { takerMultiplier:number; makerMultiplier:number; precision:number; verified:boolean }
export const baseFees: FeeSchedule = {takerMultiplier:1,makerMultiplier:0,precision:.0001,verified:true};
/** Independent buy fill: model rounds to 6dp, then premium + fee aligns to balance precision. */
export function fee(price:number, count=1, kind:'taker'|'maker'='taker', schedule=baseFees):number {
  if(!Number.isFinite(price)||price<0||price>1||!Number.isFinite(count)||count<0) throw new Error('Invalid price/count');
  if(count===0) return 0;
  const multiplier = kind==='taker'?schedule.takerMultiplier:schedule.makerMultiplier;
  const model = Math.ceil(((kind==='taker'?.07:.0175)*multiplier*count*price*(1-price)-1e-12)*1e6)/1e6;
  return Math.max(0,Math.round((Math.ceil((price*count+model-1e-12)/schedule.precision)*schedule.precision-price*count)*1e6)/1e6);
}
export const takerFee=(p:number,c=1,s=baseFees)=>fee(p,c,'taker',s);
export const makerFee=(p:number,c=1,s=baseFees)=>fee(p,c,'maker',s);
