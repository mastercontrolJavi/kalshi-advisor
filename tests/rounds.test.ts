import {it,expect} from 'vitest';
import {Journal} from '../src/engine/journal';
import {buildRounds} from '../src/engine/rounds';
import {openingCall} from '../src/engine/model/opening';
it('lists each round with its calls, result and correctness trends, newest first',()=>{
  const j=new Journal(':memory:'),call=(p:number)=>openingCall({modelP:p,sigma:.00003,momentum30s:0,momentum120s:0,imbalance:0,tradeFlow30s:0});
  ['A','B','C'].forEach((t,i)=>{j.set('market:'+t,{open_time:new Date(1e12+i*9e5).toISOString(),close_time:new Date(1e12+(i+1)*9e5).toISOString()});
    j.saveOpeningCall(t,1e12+i*9e5,900,call(i===1?.4:.6),.5);j.saveLiveCall(t,300,1e12+i*9e5+6e5,300,call(.8),.7);});
  j.settle('A','yes',1e12+9e5,83000,null,null,{});j.settle('B','yes',1e12+18e5,83000,null,null,{});
  const {rounds,trends}=buildRounds(j.db);
  expect(rounds.map(r=>r.ticker)).toEqual(['C','B','A']);expect(rounds[0].result).toBeNull();expect(rounds[2]).toMatchObject({result:'yes',opening:{direction:'UP'}});
  expect(rounds[1].opening!.direction).toBe('DOWN');expect(rounds[1].live['300'].direction).toBe('UP');
  expect(trends.totals.opening).toMatchObject({n:2,hits:1,rate:.5});expect(trends.totals.live300).toMatchObject({n:2,hits:2,rate:1});expect(trends.rolling).toHaveLength(2);});
