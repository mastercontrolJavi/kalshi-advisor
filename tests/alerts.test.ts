import {it,expect} from 'vitest';
import {detectEvents,type AlertSnapshot} from '../src/components/alert-events';
const base:AlertSnapshot={ticker:'A',tau:400,entryAt:300,ideaKey:null,ideaSide:null,exits:{},pnl:-5,day:'2026-10-07',liveDir:'UP',unreliable:false,locked:false};
it('first snapshot is a silent baseline',()=>expect(detectEvents(null,{...base,exits:{A:'SELL NOW'}})).toEqual([]));
it('new trade signal plays its side once',()=>{const yes={...base,ideaKey:'A:yes:0.5',ideaSide:'yes'};expect(detectEvents(base,yes)).toEqual(['buyYes']);expect(detectEvents(yes,yes)).toEqual([]);expect(detectEvents(base,{...base,ideaKey:'A:no:0.4',ideaSide:'no'})).toEqual(['buyNo']);});
it('position alerts: SELL NOW on change, HOLD on a new position or after a sell alert',()=>{
  expect(detectEvents(base,{...base,exits:{A:'HOLD'}})).toEqual(['hold']);
  expect(detectEvents({...base,exits:{A:'HOLD'}},{...base,exits:{A:'SELL NOW'}})).toEqual(['sell']);
  expect(detectEvents({...base,exits:{A:'SELL NOW'}},{...base,exits:{A:'SELL NOW'}})).toEqual([]);
  expect(detectEvents({...base,exits:{A:'SELL NOW'}},{...base,exits:{A:'HOLD'}})).toEqual(['hold']);
  expect(detectEvents({...base,exits:{A:'HOLD'}},{...base,exits:{A:'HOLD'}})).toEqual([]);});
it('realized P&L up is a win, down is a loss, a new day resets silently',()=>{expect(detectEvents(base,{...base,pnl:-4})).toEqual(['win']);expect(detectEvents(base,{...base,pnl:-6})).toEqual(['loss']);expect(detectEvents(base,{...base,pnl:0,day:'2026-10-08'})).toEqual([]);expect(detectEvents(base,{...base,pnl:-4.999})).toEqual([]);});
it('timing: new window, entry window and final minute fire on crossing only',()=>{
  expect(detectEvents(base,{...base,ticker:'B',tau:899})).toEqual(['newWindow']);
  expect(detectEvents({...base,tau:301},{...base,tau:300})).toEqual(['entryWindow']);
  expect(detectEvents({...base,tau:61},{...base,tau:60})).toEqual(['closingUp']);expect(detectEvents({...base,tau:61,liveDir:'DOWN'},{...base,tau:60,liveDir:'DOWN'})).toEqual(['closingDown']);expect(detectEvents({...base,tau:61,liveDir:null},{...base,tau:60,liveDir:null})).toEqual(['finalMinute']);
  expect(detectEvents({...base,tau:59},{...base,tau:58})).toEqual([]);});
it('live call flips within a window, but not across windows',()=>{expect(detectEvents(base,{...base,liveDir:'DOWN'})).toEqual(['flipDown']);expect(detectEvents({...base,liveDir:'DOWN'},{...base,liveDir:'UP'})).toEqual(['flipUp']);expect(detectEvents(base,{...base,ticker:'B',liveDir:'DOWN'})).toEqual(['newWindow']);});
it('warnings on degradation and locks; simultaneous events are ordered by importance',()=>{expect(detectEvents(base,{...base,unreliable:true})).toEqual(['warning']);expect(detectEvents(base,{...base,locked:true})).toEqual(['lock']);
  expect(detectEvents({...base,exits:{A:'HOLD'}},{...base,exits:{A:'SELL NOW'},pnl:-4,tau:60,ideaKey:'A:no:0.3',ideaSide:'no'})).toEqual(['sell','buyNo','win','closingUp','entryWindow']);});
it('a new scalp/dip setup pings once',()=>{const s1={...base,setupKey:'A:scalp:yes'};expect(detectEvents(base,s1)).toEqual(['setup']);expect(detectEvents(s1,s1)).toEqual([]);});
