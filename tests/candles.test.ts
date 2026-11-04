import {it,expect} from 'vitest';
import {aggregate,addPrice,kPoints,bucketOf,mergeSamples} from '../src/components/candles';
it('aggregates 1-s prices into OHLC buckets',()=>{
  const c=aggregate([[0,10],[4000,12],[9000,9],[15000,11],[16000,13]],15);
  expect(c).toEqual([{time:0,open:10,high:12,low:9,close:9},{time:15,open:11,high:13,low:11,close:13}]);});
it('a live price extends the last candle or opens the next from the last close; stale times are ignored',()=>{
  const c=aggregate([[0,10]],15);expect(addPrice(c,5000,14,15)).toEqual({time:0,open:10,high:14,low:10,close:14});
  expect(addPrice(c,15000,12,15)).toEqual({time:15,open:14,high:14,low:12,close:12});expect(addPrice(c,1000,99,15)).toBeNull();expect(c).toHaveLength(2);});
it('K is drawn only inside its round, with a gap between rounds',()=>{
  const c=aggregate([[0,1],[15000,1],[30000,1]],15),r=[{ticker:'A',open:0,close:15000,k:100},{ticker:'B',open:30000,close:45000,k:101}];
  expect(kPoints(r,c)).toEqual([{time:0,value:100},{time:15},{time:30,value:101}]);expect(bucketOf(59999,60)).toBe(0);});
it('a history refresh retains the high and low of ticks received while the request was in flight',()=>{
  const merged=mergeSamples([[0,100],[1000,101]],[[1000,101],[1250,110],[1500,95],[2000,102]],0);
  expect(merged).toHaveLength(5);
  expect(aggregate(merged,5)).toEqual([{time:0,open:100,high:110,low:95,close:102}]);
  expect(mergeSamples([[0,100],[1000,101]],[[2000,102]],1000)).toEqual([[1000,101],[2000,102]]);
});
it('rejects invalid times and avoids drawing movement across a missing interval',()=>{
  const c=aggregate([[1000,11],[0,10],[NaN,99]],15);expect(c[0].close).toBe(11);
  expect(addPrice(c,NaN,12,15)).toBeNull();expect(addPrice(c,2000,12,0)).toBeNull();
  expect(addPrice(c,60000,30,15)).toEqual({time:60,open:30,high:30,low:30,close:30});
});
import {fillMarks,groupMarks,markText} from '../src/components/candles';
it('real fills read as the buys and sells you placed: netting a held side away is a sale of it',()=>{
  // Bought 10 YES at 40¢, then sold 4 YES at 55¢ (Kalshi records it as acquiring NO at 45¢, closing 4).
  const m=fillMarks([{time:1000,side:'yes',price:.4,contracts:10,closedContracts:0},{time:5000,side:'no',price:.45,contracts:4,closedContracts:4}]);
  expect(m).toEqual([{time:1000,side:'yes',action:'buy',price:.4,contracts:10},{time:5000,side:'yes',action:'sell',price:.55,contracts:4}].map(x=>({...x,price:expect.closeTo(x.price,9)})));
  // A flip: closes 3 NO and opens 2 YES in one fill.
  expect(fillMarks([{time:0,side:'yes',price:.6,contracts:5,closedContracts:3}]).map(markText)).toEqual(['Sell NO 40¢ ×3','Buy YES 60¢ ×2']);
  expect(fillMarks([{time:0,side:'maybe',price:.5,contracts:1}])).toEqual([]);});
it('pieces of one order in a candle become one mark at the contract-weighted price',()=>{
  const g=groupMarks([{time:16000,side:'yes',action:'buy',price:.5,contracts:3},{time:1000,side:'yes',action:'buy',price:.4,contracts:1},{time:2000,side:'yes',action:'buy',price:.44,contracts:3},{time:3000,side:'no',action:'buy',price:.5}],15);
  expect(g.map(x=>[x.bucket,x.side,+x.price.toFixed(3),x.contracts])).toEqual([[0,'yes',.43,4],[0,'no',.5,undefined],[15,'yes',.5,3]]);
  expect(markText(g[0])).toBe('Buy YES 43¢ ×4');expect(markText({time:0,side:'no',action:'sell',price:.551,contracts:1.5})).toBe('Sell NO 55¢ ×1.5');});
