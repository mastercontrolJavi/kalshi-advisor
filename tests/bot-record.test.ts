import {describe,it,expect} from 'vitest';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {summarize,readBotRecord,readSwitch,setSwitch,switchLive,sameOrigin,replaceFile,readFeatures,setFeature,featuresShown,type BotTrade} from '../src/bot/record';
const t=(time:number,contracts:number,price:number,pnl:number|null,edge:number|null=.05):BotTrade=>({time,ticker:'T'+time,side:'yes',contracts,price,fee:.01,q:.5,edge,secsLeft:300,result:pnl==null?null:pnl>0?'yes':'no',pnl});
describe('bot record',()=>{
  it('summarizes settled rounds per contract and keeps open positions at cost',()=>{
    const s=summarize([t(1,2,.2,1.58),t(2,1,.8,-.81),t(3,1,.25,null)],{cash:15.51,start:15,started:0,peak:16.58},4,99);
    expect(s.rounds).toBe(2);expect(s.wins).toBe(1);expect(s.open).toBe(1);expect(s.misses).toBe(4);
    expect(s.pnl).toBeCloseTo(.77);expect(s.contracts).toBe(3);
    expect(s.perContract).toBeCloseTo((.79-.81)/2);
    expect(s.perContractCi).toBeCloseTo(1.96*Math.sqrt(((.79+.01)**2+(-.81+.01)**2)/1/2));
    expect(s.equity).toBeCloseTo(15.51+.25+.01);
    expect(s.avgPrice).toBeCloseTo((.2*2+.8)/3);
    expect(s.curve.map(p=>p.pnl)).toEqual([1.58,expect.closeTo(.77)]);
    expect(s.trades[0].time).toBe(3);
  });
  it('gives no average or range before two rounds have settled',()=>{
    const none=summarize([],{cash:15,start:15,started:0,peak:15},0,1);
    expect(none.perContract).toBeNull();expect(none.perContractCi).toBeNull();expect(none.avgPrice).toBeNull();expect(none.equity).toBe(15);
    expect(summarize([t(1,1,.2,.79)],{cash:15.79,start:15,started:0,peak:15.79},0,1).perContractCi).toBeNull();
  });
  it('reports a missing ledger instead of throwing',()=>{
    const r=readBotRecord('data/does-not-exist.db','data/does-not-exist.json',5);
    expect(r.missing).toBe(true);expect(r.status).toBeNull();expect(r.rounds).toBe(0);expect(r.live).toBe(false);expect(r.switch).toBeNull();expect(r.switchLive).toBe(false);
  });
  it('switches real trading on only for a running live bot, and off always',()=>{
    const dir=mkdtempSync(join(tmpdir(),'bot-switch-')),path=join(dir,'bot-live.json');
    try{
      expect(readSwitch(path).armed).toBe(false);                                   // no file = off
      expect(()=>setSwitch(true,null,1,path)).toThrow(/not running/);
      expect(()=>setSwitch(true,{running:true,mode:'paper'},1,path)).toThrow(/not running in real-money mode/);
      expect(()=>setSwitch(true,{running:false,mode:'live'},1,path)).toThrow();
      expect(()=>setSwitch('true',{running:true,mode:'live'},1,path)).toThrow(/true or false/);
      expect(()=>setSwitch(true,{running:true,mode:'live'},1,path)).toThrow(/boot id/);  // a bot from before 2026-11-18: nothing to arm for
      expect(readSwitch(path).armed).toBe(false);
      expect(()=>setSwitch(true,{running:true,mode:'live',bootId:'b1',auditPending:true},1,path)).toThrow(/still checking/);   // the start-up comparison is running
      expect(()=>setSwitch(true,{running:true,mode:'live',bootId:'b1'},1,path)).toThrow(/still checking/);                      // ... or its state is unknown
      expect(readSwitch(path).armed).toBe(false);
      const bot={running:true,mode:'live',bootId:'b1',auditPending:false},H=3600000;
      expect(setSwitch(true,bot,7,path)).toEqual({armed:true,time:7,by:'user',note:'',expires_at:7+10*H,boot_id:'b1'});   // for this run, 10 hours at most
      expect(readSwitch(path)).toEqual({armed:true,time:7,by:'user',note:'',expires_at:7+10*H,boot_id:'b1'});
      expect(setSwitch(true,{...bot,armMaxHours:1},7,path).expires_at).toBe(7+H);    // the bot's own shorter limit
      expect(setSwitch(true,{...bot,armMaxHours:12},7,path).expires_at).toBe(7+10*H); // never longer than 10 hours from the page
      expect(setSwitch(false,null,9,path).armed).toBe(false);                       // off needs nothing
      expect(readSwitch(path)).toEqual({armed:false,time:9,by:'user',note:'',expires_at:null,boot_id:null});
      writeFileSync(path,'{"armed":"yes"}');expect(readSwitch(path).armed).toBe(false);
      const status=join(dir,'status.json');writeFileSync(status,JSON.stringify({time:100,mode:'live',bootId:'b2'}));writeFileSync(path,JSON.stringify({armed:true}));
      const r=readBotRecord(join(dir,'none.db'),status,105,path);
      expect(r.live).toBe(true);expect(r.switch?.armed).toBe(true);expect(r.missing).toBe(true);
      expect(r.switchLive).toBe(false);                                             // on in the file, but for no run and with no end: not on
      writeFileSync(path,JSON.stringify({armed:true,boot_id:'b1',expires_at:500}));
      expect(readBotRecord(join(dir,'none.db'),status,105,path).switchLive).toBe(false);   // armed for the run before a restart
      writeFileSync(path,JSON.stringify({armed:true,boot_id:'b2',expires_at:500}));
      expect(readBotRecord(join(dir,'none.db'),status,105,path).switchLive).toBe(true);
      expect(switchLive(readSwitch(path),{bootId:'b2'},500)).toBe(false);           // run out
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
});
it('compares Origin to Host without throwing on junk',()=>{
  expect(sameOrigin('http://127.0.0.1:3000','127.0.0.1:3000')).toBe(true);
  for(const o of [undefined,'','null','not a url','http://evil.example','http://127.0.0.1:3001'])expect(sameOrigin(o,'127.0.0.1:3000')).toBe(false);
  expect(sameOrigin('http://127.0.0.1:3000',undefined)).toBe(false);
});
it('counts early sales of an open round out of its value, as the bot does',()=>{
  const sold={...t(3,2,.25,null),exitCash:.3};                                       // 2 bought for 51c; one sold early for 30c
  expect(summarize([sold],{cash:15-.51+.3,start:15,started:0,peak:15},0,1).equity).toBeCloseTo(15-.51+.3+(.51-.3));
  expect(summarize([{...sold,exitCash:.9}],{cash:15-.51+.9,start:15,started:0,peak:15},0,1).equity).toBeCloseTo(15-.51+.9);  // never below zero
});
it('retries the switch file replace while it is held open, and only then',()=>{
  const busy=(code:string,n:number)=>{let calls=0;return {fn:(_a:string,_b:string)=>{if(++calls<=n)throw Object.assign(new Error(code),{code});},calls:()=>calls};};
  const locked=busy('EPERM',2);replaceFile('a','b',locked.fn);expect(locked.calls()).toBe(3);
  const stuck=busy('EBUSY',99);expect(()=>replaceFile('a','b',stuck.fn,3)).toThrow('EBUSY');expect(stuck.calls()).toBe(3);
  const other=busy('ENOENT',1);expect(()=>replaceFile('a','b',other.fn)).toThrow('ENOENT');expect(other.calls()).toBe(1);
});
it('sets one feature switch at a time and shows the file over what the bot reports',()=>{
  const dir=mkdtempSync(join(tmpdir(),'bot-features-')),path=join(dir,'bot-features.json');
  try{
    expect(readFeatures(path)).toEqual({});                                         // no file: the bot's own settings stand
    expect(()=>setFeature('armed',true,1,path)).toThrow(/Unknown feature/);         // never the real-money switch
    expect(()=>setFeature('__proto__',true,1,path)).toThrow(/Unknown feature/);
    expect(()=>setFeature('scalp','yes',1,path)).toThrow(/true or false/);
    expect(readFeatures(path)).toEqual({});
    expect(setFeature('scalp',true,5,path)).toEqual({scalp:true});
    expect(setFeature('cheap',false,6,path)).toEqual({scalp:true,cheap:false});     // the other switch is kept
    expect(JSON.parse(readFileSync(path,'utf8'))).toEqual({scalp:true,cheap:false,time:6,by:'user'});
    writeFileSync(path,JSON.stringify({scalp:'on',sellLosers:true,other:1}));expect(readFeatures(path)).toEqual({sellLosers:true});
    const bot={features:{cheap:true,sellLosers:false,scalp:false}};
    expect(featuresShown(bot,{})).toEqual({cheap:true,sellLosers:false,scalp:false});
    expect(featuresShown(bot,{scalp:true})).toEqual({cheap:true,sellLosers:false,scalp:true});   // a press shows at once
    expect(featuresShown(null,{cheap:false})).toEqual({cheap:false});               // bot not reporting: only what the file says
    const status=join(dir,'status.json');writeFileSync(status,JSON.stringify({time:100,mode:'paper',features:bot.features}));writeFileSync(path,JSON.stringify({cheap:false}));
    expect(readBotRecord(join(dir,'none.db'),status,105,join(dir,'no-switch.json'),path).features).toEqual({cheap:false,sellLosers:false,scalp:false});
  }finally{rmSync(dir,{recursive:true,force:true});}
});
