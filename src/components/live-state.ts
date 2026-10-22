import {SLOW_FIELDS} from '../engine/stream';
/** Delta packets may omit slow fields. Round history must never leak into a new market. */
export function mergeLiveState(previous:any,next:any){
  if(!next||typeof next!=='object'||Array.isArray(next)||!Number.isFinite(next.engineTime??next.time))return null;
  const merged={...next};
  for(const key of ['calibration',...SLOW_FIELDS])if(!(key in merged)&&previous&&key in previous)merged[key]=previous[key];
  if(!('history' in merged))merged.history=previous?.market?.ticker===next.market?.ticker?previous?.history??[]:[];
  return merged;
}
/** A socket receiving old packets is connected, but its advice is still stale. `skew` is this device's clock minus the
 * engine's (see clockSkew), so a phone whose clock is a few seconds off is not judged stale forever. */
export function liveFresh(connected:boolean,engineTime:number|undefined,received:number,now:number,skew=0){
  const engineNow=now-skew;
  return connected&&received>0&&Number.isFinite(engineTime)&&now-received<4000&&engineNow-engineTime!<4000&&engineTime!-engineNow<4000;
}
/** Device-minus-engine clock estimate: the smallest receive delay over recent packets (network delay ≥ 0, so the minimum is
 * closest to pure skew). A frozen engine replaying old states raises every delay above this floor and still reads stale. */
export function clockSkew(delays:number[]){return delays.length?Math.min(...delays):0;}
/** The page's sense of "now": its 1-s heartbeat or the last packet, whichever is later. Chrome slows timers in a window it
 *  treats as hidden (minimized or fully covered) while packets keep arriving, so the heartbeat alone fell behind and called
 *  current data stale ("Live positions unavailable"). Packets alone can't mark it fresh: liveFresh still checks engine time. */
export const deviceNow=(clock:number,received:number)=>Math.max(clock,received);
