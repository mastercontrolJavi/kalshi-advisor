import {describe,it,expect} from 'vitest';
import Database from 'better-sqlite3';
import {baseFees,fee} from '../src/engine/model/fees';
import {replayOrder,replayScenarios,type ExecutionDecision,type ExecutionSnapshot,type ExecutionScenario,type ExecutionOutcome} from '../src/engine/quant/execution-replay';
import {executionStudy} from '../scripts/execution-study';

const scenario:ExecutionScenario={name:'base',latencyMs:250,maxSnapshotWaitMs:500,maxSnapshotAgeMs:500,maxFeedDelayMs:2000};
const decision=(patch:Partial<ExecutionDecision>={}):ExecutionDecision=>({id:'A-60',ticker:'A',time:1000,probabilityTime:1000,closeTime:10000,side:'yes',probability:.8,limitPrice:.6,contracts:5,maxCost:5,minEdge:.04,fees:baseFees,...patch});
const book=(patch:Partial<ExecutionSnapshot>={}):ExecutionSnapshot=>({ticker:'A',time:1250,bookUpdated:1250,valid:true,delayMs:0,yes:[[.49,20]],no:[[.5,20]],...patch});
const outcome:ExecutionOutcome={ticker:'A',result:'yes',availableTime:11000};

describe('causal execution replay',()=>{
  it('uses the first post-latency observation and cannot reuse a better decision-time quote',()=>{
    const result=replayOrder(decision(),[book({time:1000,bookUpdated:1000,no:[[.7,20]],yes:[[.29,20]]}),book(),book({time:1300,bookUpdated:1300,no:[[.6,20]],yes:[[.39,20]]})],outcome,scenario,12000);
    expect(result.status).toBe('filled');expect(result.snapshotTime).toBe(1250);expect(result.premium).toBe(2.5);expect(result.pnl).toBeCloseTo(5-2.5-5*fee(.5));
  });
  it('does not cherry-pick a valid or cheaper snapshot after the first post-arrival observation',()=>{
    const books=[book({valid:false}),book({time:1300,bookUpdated:1300})];
    expect(replayOrder(decision(),books,outcome,scenario,12000).reason).toBe('invalid-book');
    books[0]=book({no:[[.3,20]]});
    const result=replayOrder(decision(),books,outcome,scenario,12000);expect(result.status).toBe('unfilled');expect(result.reason).toBe('limit-price');
  });
  it('does not see future features, snapshots or outcomes',()=>{
    expect(replayOrder(decision({probabilityTime:1001}),[book()],outcome,scenario,12000).reason).toBe('future-probability');
    expect(replayOrder(decision(),[book()],outcome,scenario,1100).reason).toBe('awaiting-arrival');
    expect(replayOrder(decision(),[book({time:1350,bookUpdated:1350})],outcome,scenario,1300).reason).toBe('missing-snapshot');
    const pending=replayOrder(decision(),[book()],outcome,scenario,10500);expect(pending.status).toBe('filled');expect(pending.settlement).toBe('pending');expect(pending.pnl).toBeNull();
    expect(replayOrder(decision(),[book()],outcome,scenario,11000).settlement).toBe('settled');
  });
  it('cannot trade after close or use a delayed capture outside the arrival interval',()=>{
    expect(replayOrder(decision({closeTime:1250}),[book()],outcome,scenario,12000).reason).toBe('closed-before-arrival');
    expect(replayOrder(decision({closeTime:1400}),[book({time:1400,bookUpdated:1400})],outcome,scenario,12000).reason).toBe('snapshot-too-late');
    expect(replayOrder(decision(),[book({time:1800,bookUpdated:1800})],outcome,scenario,12000).reason).toBe('snapshot-too-late');
  });
  it.each([
    [{valid:false},'invalid-book'],[{bookUpdated:500},'stale-book'],[{bookUpdated:1300},'stale-book'],
    [{delayMs:null},'unknown-delay'],[{delayMs:2001},'delayed-book'],[{no:[]},'no-recorded-depth'],
    [{no:[[.7,5]]},'crossed-book'],[{no:[[.5,-5]]},'invalid-depth'],[{no:[[.5,5],[.5,1]]},'invalid-depth'],
  ] as [Partial<ExecutionSnapshot>,string][])('excludes unusable recorded depth %j', (patch,reason)=>{
    const result=replayOrder(decision(),[book(patch)],outcome,scenario,12000);expect(result.status).toBe('excluded');expect(result.reason).toBe(reason);expect(result.contracts).toBe(0);
  });
  it('does not invent missing snapshots or substitute a different market',()=>{
    expect(replayOrder(decision(),[book({ticker:'B'})],outcome,scenario,12000).reason).toBe('missing-snapshot');
    expect(replayOrder(decision(),[book({time:1200,bookUpdated:1200})],outcome,scenario,12000).reason).toBe('missing-snapshot');
  });
});

describe('fills and accounting',()=>{
  it('walks only recorded depth and allows partial IOC fills',()=>{
    const result=replayOrder(decision(),[book({no:[[.45,1],[.5,2]]})],outcome,scenario,12000);
    expect(result.status).toBe('partial');expect(result.reason).toBe('partial-depth');expect(result.contracts).toBe(3);expect(result.fills.map(f=>f.price)).toEqual([.5,.5,.55]);expect(result.premium).toBeCloseTo(1.55);
  });
  it('enforces the limit price and after-fee edge separately at each level',()=>{
    const books=[book({no:[[.5,2],[.35,10]]})];
    const limit=replayOrder(decision(),books,outcome,scenario,12000);expect(limit.contracts).toBe(2);expect(limit.reason).toBe('limit-price');
    const edge=replayOrder(decision({limitPrice:.9,probability:.7,minEdge:.04}),books,outcome,scenario,12000);expect(edge.contracts).toBe(2);expect(edge.reason).toBe('insufficient-edge');
  });
  it('includes full per-fill fee rounding and respects the all-in cost cap',()=>{
    const fees={...baseFees,precision:.01},result=replayOrder(decision({fees,maxCost:1.04}),[book()],outcome,scenario,12000);
    expect(result.contracts).toBe(2);expect(result.fees).toBe(.04);expect(result.cost).toBe(1.04);expect(result.reason).toBe('cost-cap');
    const grouped=replayOrder(decision({fees,contracts:3}),[book()],outcome,{...scenario,maxContractsPerFill:3},12000);
    expect(grouped.fees).toBe(.06);expect(grouped.fees).toBe(fee(.5,3,'taker',fees));
  });
  it('uses the opposite bid ladder for NO and settles the correct side',()=>{
    const result=replayOrder(decision({side:'no',probability:.2}),[book({yes:[[.55,5]],no:[[.44,5]]})],{...outcome,result:'no'},scenario,12000);
    expect(result.fills[0].price).toBe(.45);expect(result.payout).toBe(5);expect(result.pnl).toBeCloseTo(5-result.cost);
    const loss=replayOrder(decision({side:'no',probability:.2}),[book({yes:[[.55,5]],no:[[.44,5]]})],outcome,scenario,12000);expect(loss.pnl).toBe(-loss.cost);
  });
  it('supports an explicit fractional quantum without making up fractional depth',()=>{
    const result=replayOrder(decision({contracts:.5}),[book({no:[[.5,.37]]})],outcome,{...scenario,quantityStep:.01},12000);
    expect(result.contracts).toBe(.37);expect(result.status).toBe('partial');expect(result.fees).toBe(fee(.5,.37));
  });
  it('uses no result when it is missing, belongs to another market, or predates the close',()=>{
    for(const o of [null,{...outcome,ticker:'B'},{...outcome,availableTime:9000}])expect(replayOrder(decision(),[book()],o,scenario,12000).settlement).toBe('pending');
    expect(replayOrder(decision({fees:{...baseFees,verified:false}}),[book()],outcome,scenario,12000).reason).toBe('unverified-fees');
  });
});

describe('paired scenario studies',()=>{
  it('locks the same first attempt per market, even when it misses, and reports fee/depth stress',()=>{
    const decisions=[decision({id:'A-later',time:1300,probabilityTime:1300}),decision()],snapshots=[book({no:[[.5,8]]}),book({time:1550,bookUpdated:1550})];
    const report=replayScenarios(decisions,snapshots,[outcome],[scenario,{...scenario,name:'stress',depthFraction:.5,extraCostPerContract:.01}],12000);
    expect(report.results[0].attempts.map(r=>r.id)).toEqual(['A-60','A-later']);expect(report.results[0].summary.reasons['duplicate-market']).toBe(1);
    expect(report.results[1].attempts[0].contracts).toBe(4);expect(report.results[1].attempts[0].extraCost).toBe(.04);expect(report.comparisons[0].paired).toBe(1);expect(report.comparisons[0].difference).toBeLessThan(0);
    expect(decisions[0].id).toBe('A-later');// Caller-owned arrays remain unchanged.
  });
  it('pairs no-fill attempts as zero, but reports missing data and pending exposure as unpaired',()=>{
    const books=[book(),book({time:1500,bookUpdated:1500,no:[[.3,10]]})];
    const stressed={...scenario,name:'slower',latencyMs:500};
    const result=replayScenarios([decision()],books,[outcome],[scenario,stressed],12000);
    expect(result.comparisons[0].paired).toBe(1);expect(result.comparisons[0].scenarioPnl).toBe(0);
    const missing=replayScenarios([decision()],[book()],[outcome],[scenario,stressed],12000);expect(missing.comparisons[0].unpaired).toBe(1);expect(missing.comparisons[0].paired).toBe(0);
    const pending=replayScenarios([decision()],books,[outcome],[scenario,stressed],9000);expect(pending.results[0].summary.pending).toBe(1);expect(pending.results[0].summary.settled).toBe(0);expect(pending.comparisons[0].unpaired).toBe(1);
  });
  it('is deterministic and handles an empty collection without reporting a return',()=>{
    const first=replayScenarios([decision()],[book()],[outcome],[scenario],12000);expect(replayScenarios([decision()],[book()],[outcome],[scenario],12000)).toEqual(first);
    const empty=replayScenarios([],[],[],[scenario],12000);expect(empty.results[0].summary.returnOnSettledCost).toBeNull();expect(empty.results[0].summary.settled).toBe(0);
  });
});

describe('read-only execution study',()=>{
  function database(){const db=new Database(':memory:');db.exec(`CREATE TABLE research_forecasts(ticker TEXT,horizon INTEGER,version TEXT,time INTEGER,context TEXT);
    CREATE TABLE research_books(id INTEGER PRIMARY KEY,ticker TEXT,time INTEGER,context TEXT);
    CREATE INDEX research_books_time ON research_books(ticker,time);
    CREATE TABLE outcomes(ticker TEXT,time INTEGER,result TEXT);`);return db;}
  function checkpoint(db:Database.Database,time=1000,patch:Record<string,unknown>={}){
    const context={brtiP:.8,marketP:.495,quantP:.8,candidateP:null,clockOffset:100,closeTime:61000,fees:baseFees,book:book({time,bookUpdated:time}),...patch};
    db.prepare('INSERT INTO research_forecasts VALUES(?,?,?,?,?)').run('A',60,'btc-research-v1',time,JSON.stringify(context));
  }
  it('reports collecting without migrating a legacy database or inventing execution history',()=>{
    const db=new Database(':memory:');try{const report=executionStudy(db,12000);expect(report.status).toBe('collecting');expect(report.snapshotRowsRead).toBe(0);expect(report.methods.every(m=>m.selected===0)).toBe(true);expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);}finally{db.close();}
  });
  it('freezes first qualifying checkpoints, bounds depth reads, and converts outcome clock offsets',()=>{
    const db=database();try{
      checkpoint(db);checkpoint(db,2000,{brtiP:.99});
      for(const time of [0,1250,2000,4000,100000])db.prepare('INSERT INTO research_books(ticker,time,context) VALUES(?,?,?)').run('A',time,JSON.stringify(book({time,bookUpdated:time})));
      db.prepare('INSERT INTO outcomes VALUES(?,?,?)').run('A',62100,'yes');
      db.pragma('query_only = ON');const report=executionStudy(db,62000),brti=report.methods.find(m=>m.method==='brtiP')!;
      expect(report.status).toBe('shadow-replay');expect(report.snapshotRowsRead).toBe(3);expect(brti.selected).toBe(1);expect(brti.decisions[0].time).toBe(1000);expect(brti.results.every(r=>r.summary.settled===1)).toBe(true);
      expect(report.methods.find(m=>m.method==='candidateP')!.selected).toBe(0);expect(report.methods.find(m=>m.method==='marketP')!.selected).toBe(0);
      expect(executionStudy(db,61999).methods.find(m=>m.method==='brtiP')!.results[0].summary.pending).toBe(1);
    }finally{db.close();}
  });
  it('retains malformed first depth rows as exclusions and requires recorded clock metadata',()=>{
    const db=database();try{
      checkpoint(db);db.prepare('INSERT INTO research_books(ticker,time,context) VALUES(?,?,?)').run('A',1250,'broken JSON');db.prepare('INSERT INTO research_books(ticker,time,context) VALUES(?,?,?)').run('A',1300,JSON.stringify(book({time:1300,bookUpdated:1300})));
      const result=executionStudy(db,12000).methods[0].results[0];expect(result.summary.reasons['invalid-book']).toBe(1);expect(result.summary.filled).toBe(0);
      db.prepare('DELETE FROM research_forecasts').run();checkpoint(db,1000,{clockOffset:null});expect(executionStudy(db,12000).methods[0].checkpointExclusions['missing-clock-offset']).toBe(1);
    }finally{db.close();}
  });
});
