import {it,expect} from 'vitest';
import {mergeLiveState,liveFresh,clockSkew} from '../src/components/live-state';

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
