import {it,expect} from 'vitest';
import {refGapFlags,moveFlags,biasFlags,type LastLookup} from '../src/markets/flags';
import {accuracyTables} from '../src/markets/record';
import type {BackfillRow} from '../src/markets/journal';
const NOW=Date.UTC(2026,9,10,18),H=3600e3,none:LastLookup=()=>null;
const m=(yesAsk:number|null,noAsk:number|null,group:any='sports')=>({ticker:'KXNFLGAME-A-KC',event:'KXNFLGAME-A',group,yesAsk,noAsk});
it('ref-gap: the outside chance beats the ask plus fee by 4¢ or more, on either side; nothing without an ask',()=>{
  const f=refGapFlags(m(.6,.42),.7,NOW,none);expect(f).toHaveLength(1);expect(f[0]).toMatchObject({type:'ref-gap-yes',side:'yes',price:.6});expect(f[0].edge).toBeCloseTo(.7-.6-f[0].fee,6);expect(f[0].fee).toBeGreaterThan(.01);
  expect(refGapFlags(m(.66,.36),.7,NOW,none)).toEqual([]);
  const no=refGapFlags(m(.6,.25),.6,NOW,none);expect(no.map(x=>x.type)).toEqual(['ref-gap-no']);expect(no[0].side).toBe('no');
  expect(refGapFlags(m(null,null),.9,NOW,none)).toEqual([]);});
it('ref-gap cooldown: not again within 6 h unless the edge grew by 2¢',()=>{
  const last=(edge:number,ago:number):LastLookup=>()=>({time:NOW-ago,edge});
  expect(refGapFlags(m(.6,.42),.7,NOW,last(.08,H))).toEqual([]);expect(refGapFlags(m(.6,.42),.72,NOW,last(.08,H))).toHaveLength(1);expect(refGapFlags(m(.6,.42),.7,NOW,last(.08,7*H))).toHaveLength(1);});
const mids=(from:number,to:number,v0:number,v1:number)=>[{t:NOW-60*60e3,mid:from,volume:v0},{t:NOW-30*60e3,mid:(from+to)/2,volume:(v0+v1)/2},{t:NOW,mid:to,volume:v1}];
it('1-hour move: ≥10¢ on ≥$500 traded gives a follow and a fade flag',()=>{
  const f=moveFlags(m(.53,.49),mids(.40,.52,1000,3000),null,NOW,none);expect(f.map(x=>[x.type,x.side,x.price])).toEqual([['move-follow','yes',.53],['move-fade','no',.49]]);
  const down=moveFlags(m(.29,.73),mids(.40,.28,1000,3000),null,NOW,none);expect(down.find(x=>x.type==='move-follow')!.side).toBe('no');});
it('no move flag when small, thin, explained by the outside price, in commodities, or without an hour-old snapshot',()=>{
  expect(moveFlags(m(.49,.53),mids(.40,.48,1000,3000),null,NOW,none)).toEqual([]);
  expect(moveFlags(m(.53,.49),mids(.40,.52,1000,1500),null,NOW,none)).toEqual([]);
  expect(moveFlags(m(.53,.49),mids(.40,.52,1000,3000),.06,NOW,none)).toEqual([]);
  expect(moveFlags(m(.53,.49,'commodities'),mids(.40,.52,1000,3000),null,NOW,none)).toEqual([]);
  expect(moveFlags(m(.53,.49),[{t:NOW-30*60e3,mid:.4,volume:1000},{t:NOW,mid:.52,volume:3000}],null,NOW,none)).toEqual([]);
  expect(moveFlags(m(.53,.49),mids(.40,.52,1000,3000),null,NOW,()=>({time:NOW-H,edge:.12}))).toEqual([]);});
const row=(i:number,p24:number,result:'yes'|'no',grp:any='sports'):BackfillRow=>({ticker:'T'+i,event:'E'+i,series:'S',grp,title:'',eventTs:1,settleTs:2,result,volume:1,p24,a24:p24+.01,p1:null,a1:null,vwap:null,priced:1});
it('price-band history: a band with n ≥ 200 whose YES return range excludes zero flags the other side; otherwise nothing',()=>{
  const losing=accuracyTables(Array.from({length:240},(_,i)=>row(i,.03,i%60===0?'yes':'no')));
  const f=biasFlags({...m(.04,.97),mid:.035,due:NOW+H},losing,NOW,none);expect(f.map(x=>[x.type,x.side,x.price])).toEqual([['bias-no','no',.97]]);
  expect(biasFlags({...m(.04,.97),mid:.035,due:NOW+H},accuracyTables(Array.from({length:120},(_,i)=>row(i,.03,i%60===0?'yes':'no'))),NOW,none)).toEqual([]);
  const coin=accuracyTables(Array.from({length:240},(_,i)=>row(i,.5,i%2?'yes':'no')));expect(biasFlags({...m(.51,.5),mid:.5,due:NOW+H},coin,NOW,none)).toEqual([]);
  expect(biasFlags({...m(.04,.97),mid:.035,due:NOW+H},losing,NOW,()=>({time:NOW-H,edge:.5}))).toEqual([]);expect(biasFlags({...m(.04,.97),mid:.035,due:NOW+H},null,NOW,none)).toEqual([]);});
it('price-band flags only for results due within 48 h (the history is prices 24 h before the result)',()=>{
  const losing=accuracyTables(Array.from({length:240},(_,i)=>row(i,.03,i%60===0?'yes':'no')));
  expect(biasFlags({...m(.04,.97),mid:.035,due:NOW+30*H},losing,NOW,none)).toHaveLength(1);
  expect(biasFlags({...m(.04,.97),mid:.035,due:NOW+3*24*H},losing,NOW,none)).toEqual([]);expect(biasFlags({...m(.04,.97),mid:.035,due:null},losing,NOW,none)).toEqual([]);});
