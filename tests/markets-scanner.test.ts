import {it,expect} from 'vitest';
import {Scanner} from '../src/markets/scanner';
import {MarketsJournal} from '../src/markets/journal';
import type {Reference,HeldRef} from '../src/markets/references';
import type {FlagStats} from '../src/markets/scoring';
const NOW=Date.UTC(2026,9,10,18);
const mk=(ticker:string,bid:string,ask:string,vol24:string,extra:any={})=>({ticker,event_ticker:ticker.split('-').slice(0,2).join('-'),title:ticker+' Winner?',yes_sub_title:ticker.split('-').at(-1),status:'active',result:'',yes_bid_dollars:bid,yes_ask_dollars:ask,no_bid_dollars:(1-Number(ask)).toFixed(4),no_ask_dollars:(1-Number(bid)).toFixed(4),volume_24h_fp:vol24,volume_fp:'100000',close_time:'2026-10-12T00:00:00Z',expected_expiration_time:'2026-10-11T20:00:00Z',...extra});
function setup(o:{fail?:boolean}={}){
  const calls:string[]=[];let fail=false;
  const client={async get(p:string){calls.push(p);
    if(p.startsWith('/series?'))return {series:[{ticker:'KXNFLGAME',category:'Sports',volume_fp:'9e9'}]};
    if(p.startsWith('/markets?series_ticker=KXNFLGAME')){if(fail)throw new Error('Kalshi GET /markets: HTTP 503');return {markets:[mk('KXNFLGAME-26OCT11A-KC','0.60','0.62','5000'),mk('KXNFLGAME-26OCT11B-LV','0.40','0.42','10'),mk('KXNFLGAME-26OCT11C-NE','0.30','0.32','10'),mk('KXNFLGAME-26OCT11D-NO','0.03','0.04','80000')]};}
    if(p.startsWith('/markets?series_ticker='))return {markets:[]};throw new Error('unexpected '+p);}};
  const refreshed:HeldRef[][]=[];
  const refs={async refresh(list:HeldRef[]){refreshed.push(list);},reference:(t:string):Reference|null=>t==='KXNFLGAME-26OCT11A-KC'?{source:'polymarket',prob:.75,time:NOW,stale:false,status:'auto',title:'g',url:'u',refId:'r'}:null};
  const data={kalshiGame:async()=>({league:'nfl',expectedEnd:NOW,teams:[['a'],['b']] as [string[],string[]],yesTeam:0 as const,kind:'moneyline' as const,line:null,yesIsOver:null}),held:()=>[{ticker:'KXNFLGAME-26OCT11C-NE',position_fp:'2'}]};
  const j=new MarketsJournal(':memory:'),s=new Scanner(client,j,refs,data,()=>{});
  return {calls,j,s,refreshed,setFail:(v:boolean)=>{fail=v;}};
}
it('keeps liquid and held markets, snapshots them, and passes only sports matches to the references as scanned or held',async()=>{
  const {s,j,refreshed}=setup();await s.sweep(NOW);
  expect(s.count).toBe(3);expect(j.recentMids('KXNFLGAME-26OCT11B-LV',0)).toEqual([]);expect(j.recentMids('KXNFLGAME-26OCT11C-NE',0)).toHaveLength(1);
  const list=refreshed[0];expect(list.find(h=>h.ticker.endsWith('A-KC'))!.held).toBe(false);expect(list.find(h=>h.ticker.endsWith('C-NE'))!.held).toBe(true);});
it('raises a ref-gap flag once; the next sweep inside the cooldown does not duplicate it',async()=>{
  const {s,j}=setup();await s.sweep(NOW);await s.sweep(NOW+5*60e3);
  const f=j.flagRows().filter(r=>r.type==='ref-gap-yes');expect(f).toHaveLength(1);expect(f[0]).toMatchObject({ticker:'KXNFLGAME-26OCT11A-KC',side:'yes',price:.62});});
it('a failed sweep keeps the previous rows and says why',async()=>{
  const t=setup();await t.s.sweep(NOW);const before=t.s.rows(NOW,[]).length;t.setFail(true);await t.s.sweep(NOW+5*60e3);
  expect(t.s.error).toContain('503');expect(t.s.rows(NOW,[]).length).toBe(before);expect(t.s.updated).toBe(NOW);});
it('rows list flagged markets, a proven flag type first, with a Kalshi link',async()=>{
  const {s,j}=setup();await s.sweep(NOW);
  j.putFlags([{time:NOW,ticker:'KXNFLGAME-26OCT11D-NO',event:'KXNFLGAME-26OCT11D',group:'sports',type:'bias-no',side:'no',price:.97,fee:.002,edge:.6,context:{}}]);
  const proven:FlagStats={type:'bias-no',group:'sports',n:150,markets:150,mean:.02,low:.01,high:.03,first:.02,second:.02,proven:true};
  const rows=s.rows(NOW,[proven]);expect(rows.map(r=>r.ticker)).toEqual(['KXNFLGAME-26OCT11D-NO','KXNFLGAME-26OCT11A-KC']);
  expect(rows[0].flags[0].evidence!.proven).toBe(true);expect(rows[1].url).toBe('https://kalshi.com/markets/kxnflgame/x/kxnflgame-26oct11a');
  expect(rows[1].ref!.gap).toBeCloseTo(.75-.61);expect(s.rows(NOW,[]).map(r=>r.ticker)).toEqual(['KXNFLGAME-26OCT11A-KC','KXNFLGAME-26OCT11D-NO']);});
