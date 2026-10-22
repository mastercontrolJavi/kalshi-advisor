import {it,expect} from 'vitest';
import {mergeLiveState,liveFresh,clockSkew,deviceNow} from '../src/components/live-state';
import {SLOW_FIELDS} from '../src/engine/stream';

it('retains omitted calibration but clears history immediately when the round changes',()=>{
  const previous={market:{ticker:'A'},calibration:{count:30},history:[{time:1,market:.9}]};
  expect(mergeLiveState(previous,{engineTime:2,market:{ticker:'A'}}).history).toEqual(previous.history);
  const rolled=mergeLiveState(previous,{engineTime:3,market:{ticker:'B'}});
  expect(rolled.history).toEqual([]);expect(rolled.calibration).toEqual(previous.calibration);
  expect(mergeLiveState(previous,{engineTime:3,market:null}).history).toEqual([]);
  expect(mergeLiveState(previous,{engineTime:3,market:{ticker:'A'},history:[]}).history).toEqual([]);
});
it('accepts the markets process timestamp and rejects malformed state packets',()=>{
  expect(mergeLiveState(null,{time:100,status:'live'}).time).toBe(100);
  for(const data of [null,[],{},'bad',{engineTime:'now'}])expect(mergeLiveState(null,data)).toBeNull();
});
it('fresh transport cannot revive stale engine advice',()=>{
  expect(liveFresh(true,10000,10000,11000)).toBe(true);
  expect(liveFresh(true,1000,10000,11000)).toBe(false);
  expect(liveFresh(true,11000,1000,11000)).toBe(false);
  expect(liveFresh(false,10000,10000,11000)).toBe(false);
  expect(liveFresh(true,undefined,10000,11000)).toBe(false);
  expect(liveFresh(true,20000,10000,11000)).toBe(false);
});
it('a device clock that is off by seconds stays fresh, while replayed old packets still read stale',()=>{
  // Phone clock 9 s ahead of the engine; packets arrive ~50 ms after they are sent.
  const delays=[9050,9040,9060],skew=clockSkew(delays);
  expect(liveFresh(true,100000,109050,109500)).toBe(false);
  expect(liveFresh(true,100000,109050,109500,skew)).toBe(true);
  // Same device, but the packet on screen is 6 s old in engine time.
  expect(liveFresh(true,100000,115050,115100,skew)).toBe(false);
  expect(clockSkew([])).toBe(0);
});
it('quarter-second updates without the slow fields keep the last copy; a new value replaces it',()=>{
  const full={engineTime:1,market:{ticker:'A'},exits:[{ticker:'A',contracts:5}],backtest:{generated:'d1'},hourly:{event:'H'},config:{exitMode:'advise'},mySetups:{rounds:3}};
  const fast=mergeLiveState(full,{engineTime:2,market:{ticker:'A'},exits:[{ticker:'A',contracts:5}]});
  for(const k of ['backtest','hourly','config','mySetups'])expect(fast[k]).toEqual((full as any)[k]);
  expect(mergeLiveState(fast,{engineTime:3,market:{ticker:'B'},backtest:{generated:'d2'},exits:[]}).backtest).toEqual({generated:'d2'});
  expect(mergeLiveState(null,{engineTime:1}).hourly).toBeUndefined();expect(SLOW_FIELDS).not.toContain('exits');expect(SLOW_FIELDS).not.toContain('book');
});
it('packets arriving while Chrome slows the page timer still count as fresh',()=>{
  // Heartbeat last ran at 50,000 (throttled); packets keep arriving, the latest at 61,000 stamped 60,950 by the engine.
  expect(liveFresh(true,60950,61000,50000)).toBe(false);
  expect(liveFresh(true,60950,61000,deviceNow(50000,61000))).toBe(true);
  // No packets for 10 s: the heartbeat alone still calls it stale.
  expect(liveFresh(true,50950,51000,deviceNow(61000,51000))).toBe(false);
});
