import {it,expect} from 'vitest';
import {aggregate,addPrice,kPoints,bucketOf} from '../src/components/candles';
it('aggregates 1-s prices into OHLC buckets',()=>{
  const c=aggregate([[0,10],[4000,12],[9000,9],[15000,11],[16000,13]],15);
  expect(c).toEqual([{time:0,open:10,high:12,low:9,close:9},{time:15,open:11,high:13,low:11,close:13}]);});
it('a live price extends the last candle or opens the next from the last close; stale times are ignored',()=>{
  const c=aggregate([[0,10]],15);expect(addPrice(c,5000,14,15)).toEqual({time:0,open:10,high:14,low:10,close:14});
  expect(addPrice(c,15000,12,15)).toEqual({time:15,open:14,high:14,low:12,close:12});expect(addPrice(c,1000,99,15)).toBeNull();expect(c).toHaveLength(2);});
it('K is drawn only inside its round, with a gap between rounds',()=>{
  const c=aggregate([[0,1],[15000,1],[30000,1]],15),r=[{ticker:'A',open:0,close:15000,k:100},{ticker:'B',open:30000,close:45000,k:101}];
  expect(kPoints(r,c)).toEqual([{time:0,value:100},{time:15},{time:30,value:101}]);expect(bucketOf(59999,60)).toBe(0);});
