import {describe,it,expect} from 'vitest';
import Database from 'better-sqlite3';
import {baseFees} from '../src/engine/model/fees';
import {probability} from '../src/engine/model/math';
import {bookSides,censoredProbability,pinnedRuns,tapeCheck,PROBABILITY_CLIP,type CapturedBook} from '../src/engine/quant/one-sided';
import type {ExecutionSnapshot} from '../src/engine/quant/execution-replay';
import {executionStudy} from '../scripts/execution-study';
import {parseTrade,tapeMarkdown} from '../scripts/one-sided-tape-check';

describe('book sides',()=>{
  it('separates pinned books from one-sided books below the ceiling and from empty books',()=>{
    expect(bookSides({yes:[[.4,1]],no:[[.5,1]]}).kind).toBe('two-sided');
    expect(bookSides({yes:[[.998,5],[.999,100]],no:[]})).toEqual({kind:'pinned',present:'yes',executable:'no',bestBid:.999});
    expect(bookSides({yes:[],no:[[.999,100]]})).toEqual({kind:'pinned',present:'no',executable:'yes',bestBid:.999});
    expect(bookSides({yes:[[.97,10]],no:[]})).toMatchObject({kind:'one-sided',executable:'no'});
    // A 1¢-tick ceiling is not assumed: it stays one-sided, the conservative label.
    expect(bookSides({yes:[[.99,10]],no:[]}).kind).toBe('one-sided');
    expect(bookSides({yes:[],no:[]}).kind).toBe('empty');
  });
  it('treats the diffusion model bounds as censored',()=>{
    expect(probability(100000,90000,.0001,120).p).toBe(PROBABILITY_CLIP.high);
    expect(probability(90000,100000,.0001,120).p).toBe(PROBABILITY_CLIP.low);
    expect([.99,.01].map(censoredProbability)).toEqual([true,true]);
    expect([.985,.0101,.5].map(censoredProbability)).toEqual([false,false,false]);
  });
});

describe('one-sided shadow arm',()=>{
  const book=(time:number,patch:Partial<ExecutionSnapshot>={}):ExecutionSnapshot=>({ticker:'A',time,bookUpdated:time,valid:true,delayMs:0,yes:[[.49,20]],no:[[.5,20]],...patch});
  function database(){const db=new Database(':memory:');db.exec(`CREATE TABLE research_forecasts(ticker TEXT,horizon INTEGER,version TEXT,time INTEGER,context TEXT);
    CREATE TABLE research_books(id INTEGER PRIMARY KEY,ticker TEXT,time INTEGER,context TEXT);
    CREATE TABLE outcomes(ticker TEXT,time INTEGER,result TEXT);`);return db;}
  function checkpoint(db:Database.Database,time:number,horizon:number,patch:Record<string,unknown>={},books:Partial<ExecutionSnapshot>={}){
    const context={brtiP:.8,marketP:.495,quantP:.8,candidateP:null,clockOffset:100,closeTime:61000,fees:baseFees,book:book(time,books),...patch};
    db.prepare('INSERT INTO research_forecasts VALUES(?,?,?,?,?)').run('A',horizon,'btc-research-v1',time,JSON.stringify(context));
    for(const t of [time+250,time+1000,time+3000])db.prepare('INSERT INTO research_books(ticker,time,context) VALUES(?,?,?)').run('A',t,JSON.stringify(book(t,books)));
  }
  const pinned={yes:[[.999,500000]],no:[]} as Partial<ExecutionSnapshot>,unpinned={yes:[[.9,20]],no:[]} as Partial<ExecutionSnapshot>;

  it('keeps v1 decisions identical and labels pinned books instead of calling them missing depth',()=>{
    const plain=database(),mixed=database();try{
      for(const db of [plain,mixed]){checkpoint(db,2000,30);db.prepare('INSERT INTO outcomes VALUES(?,?,?)').run('A',62100,'yes');}
      checkpoint(mixed,1000,60,{brtiP:.99,quantP:.99,marketP:null},pinned);
      const a=executionStudy(plain,63000),b=executionStudy(mixed,63000,{oneSided:true}),brti=b.methods.find(m=>m.method==='brtiP')!;
      for(const method of ['brtiP','marketP','quantP','candidateP'])expect(b.methods.find(m=>m.method===method)!.decisions).toEqual(a.methods.find(m=>m.method===method)!.decisions);
      expect(brti.checkpointExclusions['pinned-book']).toBe(1);expect(brti.checkpointExclusions['missing-decision-depth']).toBeUndefined();
      const arm=b.oneSided!.methods.find(m=>m.method==='brtiP')!,market=b.oneSided!.methods.find(m=>m.method==='marketP')!;
      expect(arm.exclusions).toEqual({'censored-probability':1});expect(market.exclusions).toEqual({'market-point-undefined':1});
      expect(arm.oneSidedSelected).toBe(0);expect(arm.moved).toEqual([]);expect(arm.selected).toBe(1);
      expect(b.oneSided!.coverage.byKind).toEqual({'two-sided':1,pinned:1});expect(b.oneSided!.coverage.markets).toEqual({total:1,anyOneSided:1,allOneSided:0});
    }finally{plain.close();mixed.close();}
  });
  it('is skipped unless asked, so the engine worker does no extra work and v1 output is the same either way',()=>{
    const db=database();try{
      checkpoint(db,1000,60,{brtiP:.7,marketP:null},unpinned);checkpoint(db,2000,30);db.prepare('INSERT INTO outcomes VALUES(?,?,?)').run('A',62100,'yes');
      const lean=executionStudy(db,63000),full=executionStudy(db,63000,{oneSided:true});
      expect(lean.oneSided).toBeNull();expect(full.oneSided).not.toBeNull();expect(lean.snapshotRowsRead).toBeLessThan(full.snapshotRowsRead);
      expect(lean.methods).toEqual(full.methods);
    }finally{db.close();}
  });
  it('buys only the side whose ask comes from the recorded ladder, and replays it causally',()=>{
    const db=database();try{
      checkpoint(db,1000,60,{brtiP:.7,quantP:.97,marketP:null},unpinned);db.prepare('INSERT INTO outcomes VALUES(?,?,?)').run('A',62100,'no');
      const report=executionStudy(db,63000,{oneSided:true}),v1=report.methods.find(m=>m.method==='brtiP')!,arm=report.oneSided!.methods.find(m=>m.method==='brtiP')!;
      expect(v1.selected).toBe(0);expect(v1.checkpointExclusions['one-sided-book']).toBe(1);
      expect(arm.decisions).toHaveLength(1);expect(arm.decisions[0]).toMatchObject({side:'no',id:'A:60:brtiP:one-sided'});expect(arm.added).toEqual(['A']);
      const at=(name:string)=>arm.results.find(r=>r.scenario.name===name)!.oneSided;
      expect(at('250ms').settled).toBe(1);expect(at('250ms').contracts).toBe(5);expect(at('250ms').pnl).toBeGreaterThan(0);
      expect(arm.results[0].attempts[0].fills.every(f=>Math.abs(f.price-.1)<1e-9)).toBe(true);
      // Same fills recharged at 1¢ fee rounding cost more; they are not removed.
      expect(at('1000ms-cent-fees').contracts).toBe(at('1000ms').contracts);expect(at('1000ms-cent-fees').fees).toBeGreaterThan(at('1000ms').fees);
      // The favoured YES side has no ask at all: a 97% quant cannot buy it, and the 3% NO is not worth 10¢.
      const quant=report.oneSided!.methods.find(m=>m.method==='quantP')!;expect(quant.selected).toBe(0);expect(quant.exclusions).toEqual({'no-qualifying-edge':1});
    }finally{db.close();}
  });
  it('is a causal policy: an earlier one-sided decision moves the market, it does not wait for a later v1 entry',()=>{
    const db=database();try{
      checkpoint(db,1000,60,{brtiP:.7,marketP:null},unpinned);checkpoint(db,2000,30);db.prepare('INSERT INTO outcomes VALUES(?,?,?)').run('A',62100,'yes');
      const report=executionStudy(db,63000,{oneSided:true}),arm=report.oneSided!.methods.find(m=>m.method==='brtiP')!;
      expect(report.methods.find(m=>m.method==='brtiP')!.decisions[0].time).toBe(2000);
      expect(arm.moved).toEqual(['A']);expect(arm.decisions[0].time).toBe(1000);
    }finally{db.close();}
  });
});

describe('tape check',()=>{
  const captured=(time:number,patch:Partial<CapturedBook>={}):CapturedBook=>({time,valid:true,delayMs:50,clockOffset:100,yes:[[.999,1000]],no:[],...patch});
  it('builds pinned runs in exchange time and ends them on any other state or a capture gap',()=>{
    const books=[0,250,500,750,1000,1250,1500,1750,2000,2250,2500,2750,3000].map(t=>captured(t));
    expect(pinnedRuns([...books,captured(3250,{no:[[.001,5]]})])).toEqual([{present:'yes',from:550,to:2550,snapshots:13}]);
    expect(pinnedRuns([...books,captured(6000),captured(6250),captured(9000)],0)).toEqual([{present:'yes',from:50,to:3050,snapshots:13},{present:'yes',from:6050,to:6300,snapshots:2}]);
    expect(pinnedRuns([captured(0),captured(250,{delayMs:2500}),captured(500)],0)).toEqual([]);
    expect(pinnedRuns([captured(0),captured(1000,{yes:[],no:[[.999,10]]}),captured(2000,{yes:[],no:[[.999,10]]})],0)).toEqual([{present:'no',from:1050,to:2050,snapshots:2}]);
  });
  it('accepts longshot takers, counts sweeps, and flags favourite takers',()=>{
    const runs=[{present:'yes' as const,from:500,to:2500,snapshots:9},{present:'no' as const,from:4000,to:5000,snapshots:5}];
    const check=tapeCheck(runs,[{time:1000,yesPrice:.999,takerSide:'no',count:10},{time:1200,yesPrice:.997,takerSide:'no',count:5},{time:1500,yesPrice:.999,takerSide:'yes',count:42},
      {time:3000,yesPrice:.5,takerSide:'yes',count:1},{time:4500,yesPrice:.001,takerSide:'yes',count:3}]);
    expect(check).toEqual({runs:2,pinnedSeconds:3,trades:4,longshotTaker:3,belowCeiling:1,favouriteTaker:1,favouriteContracts:42});
  });
  it('parses Kalshi public trades and refuses malformed ones',()=>{
    expect(parseTrade({created_time:'2026-10-24T01:59:59.160948Z',yes_price_dollars:'0.9990',taker_outcome_side:'no',taker_side:'no',count_fp:'30.00'})).toEqual({time:Date.parse('2026-10-24T01:59:59.160948Z'),yesPrice:.999,takerSide:'no',count:30});
    expect(parseTrade({created_time:'bad',yes_price_dollars:'0.5',taker_side:'yes'})).toBeNull();expect(parseTrade({created_time:'2026-10-24T01:59:59Z',yes_price_dollars:'0.5',taker_side:'maybe'})).toBeNull();
    const totals={runs:1,pinnedSeconds:2,trades:3,longshotTaker:2,belowCeiling:0,favouriteTaker:1,favouriteContracts:4};
    expect(tapeMarkdown({asOf:'2026-10-28T00:00:00.000Z',marginMs:500,totals,markets:[{ticker:'A',check:totals,error:null,truncated:false}]})).toContain('| A | 1 | 4 | 3 |');
  });
});
