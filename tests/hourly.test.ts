import {it,expect} from 'vitest';
import {impliedAbove,ladder,hourlyIdeas} from '../src/engine/hourly';
import {defaults} from '../src/engine/config';
import {baseFees} from '../src/engine/model/fees';
const mk=(strike:number,bid:string,ask:string,size='500')=>({ticker:'KXBTCD-X-T'+strike,event_ticker:'KXBTCD-X',open_time:'',close_time:'',status:'active',floor_strike:strike,yes_bid_dollars:bid,yes_ask_dollars:ask,yes_bid_size_fp:size,yes_ask_size_fp:size});
it("Kalshi's implied chance of finishing above a reference interpolates the strike ladder",()=>{
  const r=[{strike:83099.99,mid:.7},{strike:83199.99,mid:.5},{strike:83299.99,mid:.3}];
  expect(impliedAbove(r,83199.99)).toBeCloseTo(.5);expect(impliedAbove(r,83149.99)).toBeCloseTo(.6);expect(impliedAbove(r,82000)).toBeNull();expect(impliedAbove(r,84000)).toBeNull();});
it('prices strikes near the money with the settlement-average model and nets the taker fee',()=>{
  const ms=[mk(83299.99,'.08','.10'),mk(83199.99,'.45','.47'),mk(83099.99,'.88','.90'),mk(80099.99,'.99','1')];
  const rows=ladder(ms as any,{spot:83200,sigma:.00003,tau:1800,locked:[],basis:0,kHour:83150,modelReady:true},baseFees);
  expect(rows.map(r=>Math.round(r.strike))).toEqual([83300,83200,83100]);
  const atm=rows[1];expect(atm.model!).toBeGreaterThan(.48);expect(atm.model!).toBeLessThan(.52);expect(atm.noAsk).toBeCloseTo(.55);
  expect(atm.edgeYes!).toBeCloseTo(atm.quant!-.47-.0175,3);expect(rows[0].model!).toBeLessThan(atm.model!);});
it('ideas pass the same gates as 15-minute signals and are sorted by edge',()=>{
  const ms=[mk(83199.99,'.30','.32'),mk(83099.99,'.88','.90')];
  const rows=ladder(ms as any,{spot:83400,sigma:.00002,tau:1200,locked:[],basis:0,kHour:null,modelReady:true},baseFees);
  const {ideas}=hourlyIdeas(rows,1200,1000,defaults,baseFees,null);expect(ideas[0].side).toBe('yes');expect(ideas[0].strike).toBeCloseTo(83199.99);expect(ideas[0].edge).toBeGreaterThan(defaults.minEdge);
  expect(hourlyIdeas(rows,30,1000,defaults,baseFees,null).ideas).toHaveLength(0);expect(hourlyIdeas(rows,1200,1000,defaults,baseFees,'Daily loss limit reached').reason).toContain('Daily');
  const thin=ladder([mk(83199.99,'.30','.32','5')] as any,{spot:83400,sigma:.00002,tau:1200,locked:[],basis:0,kHour:null,modelReady:true},baseFees);expect(hourlyIdeas(thin,1200,1000,defaults,baseFees,null).ideas).toHaveLength(0);});
it('with no hourly market open, the board finds when the next one opens; once one is open it clears',async()=>{
  const {HourlyBoard}=await import('../src/engine/hourly');const now=Date.parse('2026-10-08T06:00:00Z');let markets:any[]=[];
  const client:any={get:async(path:string)=>path.startsWith('/events')?{events:[{event_ticker:'KXBTCD-26OCT0807',strike_date:'2026-10-08T11:00:00Z'},{event_ticker:'KXBTCD-26OCT0806',strike_date:'2026-10-08T10:00:00Z'}]}:{markets}};
  const board=new HourlyBoard(client);await board.refresh(now);
  expect(board.upcoming).toEqual({event:'KXBTCD-26OCT0806',open:Date.parse('2026-10-08T09:00:00Z'),close:Date.parse('2026-10-08T10:00:00Z')});
  markets=[{ticker:'KXBTCD-26OCT0806-T1',event_ticker:'KXBTCD-26OCT0806',open_time:'2026-10-08T05:00:00Z',close_time:'2026-10-08T07:00:00Z'}];
  await board.refresh(now);expect(board.events(now).current?.event).toBe('KXBTCD-26OCT0806');expect(board.upcoming).toBeNull();});
it('closure messages: Eastern and local opening time, and the Thursday maintenance note only then',async()=>{
  const {opensAt,maintenanceNote}=await import('../src/components/format');
  expect(opensAt(Date.parse('2026-10-08T09:00:00Z'))).toContain('5:00 AM');
  expect(maintenanceNote(Date.parse('2026-10-08T06:00:00Z'))).toContain('Thursday');// 2 AM ET Thursday
  expect(maintenanceNote(Date.parse('2026-10-07T18:00:00Z'))).toBeNull();// Wednesday afternoon
  expect(maintenanceNote(Date.parse('2026-10-08T18:00:00Z'))).toBeNull();});// Thursday afternoon
