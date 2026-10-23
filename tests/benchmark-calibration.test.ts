import {describe,expect,it} from 'vitest';
import {BENCHMARK_MODEL_VERSION} from '../src/engine/quant/benchmark';
import {
  BENCHMARK_CALIBRATION_VERSION,CALIBRATION_EMBARGO_MS,benchmarkCalibrationFeatures,benchmarkCalibrationSamples,
  fitBenchmarkCalibration,predictBenchmarkCalibration,scoreBenchmarkCalibrationProspective,
  type BenchmarkCalibrationInput,type BenchmarkCalibrationSample,type BenchmarkCalibrationRecord,type BenchmarkCalibrationProspectiveSample
} from '../src/engine/quant/benchmark-calibration';

const base=1_790_000_000_000;
const input:BenchmarkCalibrationInput={brtiP:.65,marketP:.55,quantP:.6,tau:30,sigma:.0001};
function samples(count:number):BenchmarkCalibrationSample[]{
  return Array.from({length:count},(_,i)=>{
    const y=i%2===0?1:0,time=base+i*3600000;
    return {...input,brtiP:y?.65:.35,marketP:y?.55:.45,quantP:y?.6:.4,
      ticker:`round-${i}`,horizon:30,time,sourceTime:time,settledTime:time+45000,y,version:BENCHMARK_MODEL_VERSION};
  });
}
const after=(rows:BenchmarkCalibrationSample[])=>Math.max(...rows.map(r=>r.settledTime))+CALIBRATION_EMBARGO_MS+1;

describe('immutable calibration sample mapping',()=>{
  it('reads frozen BRTI probabilities, exact tau when recorded, and horizon for legacy rows',()=>{
    const record:BenchmarkCalibrationRecord={ticker:'round',horizon:30,version:BENCHMARK_MODEL_VERSION,time:base,source_time:base,
      p:.7,quant_p:.6,mid:.55,context:JSON.stringify({model:{sigma:.0001},tau:29}),result:'yes',settled_time:base+45000};
    const result=benchmarkCalibrationSamples([record,{...record,ticker:'legacy',context:JSON.stringify({model:{sigma:.0002}})},
      {...record,ticker:'unsettled',result:null,settled_time:null},{...record,ticker:'bad-context',context:'{'},
      {...record,ticker:'void',result:'void'}]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({brtiP:.7,marketP:.55,quantP:.6,tau:29,sigma:.0001,sourceTime:base,settledTime:base+45000,y:1});
    expect(result[1]).toMatchObject({tau:30,sigma:.0002});
    expect(record.context).toContain('"tau":29');
  });
  it('rejects wrong model versions, invalid checkpoints, future sources and inconsistent outcomes',()=>{
    const good=samples(3),bad=[{...good[0],ticker:'bad-version',version:'recreated-history'},
      {...good[0],ticker:'bad-tau',tau:20},{...good[0],ticker:'future-source',sourceTime:base+1},
      {...good[0],ticker:'stale-source',sourceTime:base-3000},{...good[0],ticker:'bad-price',brtiP:NaN},
      {...good[0],ticker:'missing-volatility',sigma:undefined as any},
      {...good[0],ticker:'missing-market',marketP:null},{...good[0],ticker:'late-label',settledTime:base-1}];
    const conflict={...good[1],horizon:10,tau:10,time:good[1].time+20000,sourceTime:good[1].time+20000,y:1 as const};
    const fit=fitBenchmarkCalibration([...good,...bad,conflict],after(good));
    expect(fit.markets).toBe(2);expect(fit.rows).toBe(2);
    expect(fit.excluded.invalid).toBe(bad.length);expect(fit.excluded.conflictingMarkets).toBe(1);
  });
});

describe('causal, regularized benchmark calibration',()=>{
  it('starts from a transparent market fallback and abstains when the quote or scope is unavailable',()=>{
    const fit=fitBenchmarkCalibration([],base),prediction=predictBenchmarkCalibration(fit,input,base);
    expect(fit.state).toBe('insufficient-data');expect(fit.parameters).toBeNull();
    expect(prediction).toMatchObject({active:false,source:'market-fallback',p:.55,fallbackP:.55,rawP:null,version:BENCHMARK_CALIBRATION_VERSION});
    expect(predictBenchmarkCalibration(fit,{...input,marketP:null},base)).toMatchObject({source:'abstain',p:null,rawP:null});
    expect(predictBenchmarkCalibration(fit,{...input,tau:61},base)).toMatchObject({source:'abstain',p:null});
  });
  it('has no directional intercept and uses bounded time/volatility interactions',()=>{
    const x=benchmarkCalibrationFeatures(input,.0001),reverse=benchmarkCalibrationFeatures({...input,brtiP:1-input.brtiP,marketP:1-input.marketP!,quantP:1-input.quantP!},.0001);
    x.forEach((v,i)=>expect(v).toBeCloseTo(-reverse[i],12));
    expect(x[2]).toBe(0);expect(x[3]).toBe(0);
    const early=benchmarkCalibrationFeatures({...input,tau:60,sigma:.001},.0001);
    expect(early[2]).toBeCloseTo(-early[0]);expect(Math.abs(early[3])).toBeLessThan(Math.abs(early[0]));
    expect(()=>benchmarkCalibrationFeatures(input,NaN)).toThrow();
  });
  it('does not use an outcome at the embargo boundary, including submillisecond clock corrections',()=>{
    const rows=samples(31),boundary=rows.at(-1)!.settledTime+CALIBRATION_EMBARGO_MS;
    const before=fitBenchmarkCalibration(rows,boundary),afterBoundary=fitBenchmarkCalibration(rows,boundary+.5);
    expect(before.markets).toBe(30);expect(before.excluded.notYetKnown).toBe(1);
    expect(afterBoundary.markets).toBe(31);expect(afterBoundary.trainThrough).toBe(rows.at(-1)!.settledTime);
  });
  it('cannot change an earlier fit by appending later outcomes or extreme future volatility',()=>{
    const rows=samples(100),asOf=after(rows.slice(0,50)),past=fitBenchmarkCalibration(rows.slice(0,50),asOf);
    const future=rows.slice(50).map(r=>({...r,sigma:10,brtiP:1-r.brtiP,y:(1-r.y) as 0|1}));
    const augmented=fitBenchmarkCalibration([...rows.slice(0,50),...future],asOf);
    expect(augmented.parameters).toEqual(past.parameters);expect(augmented.validation).toEqual(past.validation);
    expect(augmented.markets).toBe(past.markets);
  });
  it('is invariant to duplicate snapshots and gives a market one training unit regardless of checkpoint count',()=>{
    const rows=samples(80).map(r=>({...r,brtiP:r.marketP!})),time=after(rows);
    const original=fitBenchmarkCalibration(rows,time);
    const duplicate=fitBenchmarkCalibration([...rows,...rows,...rows],time);
    expect(duplicate.parameters).toEqual(original.parameters);expect(duplicate.rows).toBe(rows.length);
    expect(duplicate.excluded.duplicates).toBe(rows.length*2);
    const r=rows[0],additional=[{...r,horizon:60,tau:60,time:r.time-30000,sourceTime:r.time-30000},
      {...r,horizon:10,tau:10,time:r.time+20000,sourceTime:r.time+20000}];
    const checkpoints=fitBenchmarkCalibration([...rows,...additional],time);
    expect(checkpoints.markets).toBe(original.markets);expect(checkpoints.rows).toBe(original.rows+2);
    checkpoints.parameters!.weights.forEach((w,i)=>expect(w).toBeCloseTo(original.parameters!.weights[i],12));
  });
  it('discards conflicting copies of an immutable checkpoint instead of cherry-picking one',()=>{
    const rows=samples(31),conflict={...rows[0],brtiP:.99},fit=fitBenchmarkCalibration([...rows,conflict],after(rows));
    expect(fit.markets).toBe(30);expect(fit.excluded.conflictingMarkets).toBe(1);
    const reverse=fitBenchmarkCalibration([conflict,...rows],after(rows));expect(reverse.parameters).toEqual(fit.parameters);
  });
  it('exposes a raw fitted candidate while keeping the fallback explicit when evidence is thin',()=>{
    const rows=samples(45),asOf=after(rows),fit=fitBenchmarkCalibration(rows,asOf),prediction=predictBenchmarkCalibration(fit,input,asOf);
    expect(fit.state).toBe('unproven');expect(fit.parameters).not.toBeNull();
    expect(prediction.source).toBe('market-fallback');expect(prediction.p).toBe(.55);
    expect(prediction.rawP).toBeGreaterThan(.55);expect(prediction.active).toBe(false);
    expect(fit.validation.gains.market.low).toBeNull();
  });
  it('refuses a future fit or insufficiently embargoed training labels at prediction time',()=>{
    const rows=samples(40),asOf=after(rows),fit=fitBenchmarkCalibration(rows,asOf);
    expect(predictBenchmarkCalibration(fit,input,asOf-1)).toMatchObject({rawP:null,p:.55,source:'market-fallback'});
    expect(predictBenchmarkCalibration({...fit,fittedAt:asOf-1000,trainThrough:asOf-60000},input,asOf)).toMatchObject({rawP:null,p:.55});
    expect(predictBenchmarkCalibration({...fit,parameters:{weights:[NaN,0,0,0],referenceSigma:.0001}},input,asOf)).toMatchObject({rawP:null,p:.55});
  });
  it('purges delayed settlements from every forward-training fold and excludes unpaired comparison rows',()=>{
    const rows=samples(160).map((r,i)=>({...r,settledTime:i<10?base+140*3600000:r.settledTime,quantP:i%5===0?null:r.quantP}));
    const fit=fitBenchmarkCalibration(rows,after(rows));
    expect(fit.validation.folds).toHaveLength(4);
    for(const fold of fit.validation.folds){expect(fold.trainThrough).toBeLessThan(fold.testFrom-CALIBRATION_EMBARGO_MS);expect(fold.pairedMarkets).toBeLessThan(fold.testMarkets);}
    expect(fit.validation.markets).toBe(fit.validation.folds.reduce((n,f)=>n+f.pairedMarkets,0));
    const first=fit.validation.folds[0],past=rows.filter(r=>r.time<first.testFrom&&r.settledTime<first.testFrom-CALIBRATION_EMBARGO_MS);
    const causal=fitBenchmarkCalibration(past,first.testFrom),test=rows.filter(r=>r.time>=first.testFrom&&r.time<=first.testThrough&&r.quantP!==null);
    const expected=test.reduce((sum,r)=>sum+(predictBenchmarkCalibration(causal,r,first.testFrom).rawP!-r.y)**2,0)/test.length;
    expect(first.scores.candidate.brier).toBeCloseTo(expected,12);
  });
  it('allows supported shadow evidence only after stable chronological gains against all three baselines',()=>{
    const rows=samples(1200),asOf=after(rows),fit=fitBenchmarkCalibration(rows,asOf),prediction=predictBenchmarkCalibration(fit,input,asOf);
    expect(fit.state).toBe('supported');expect(fit.active).toBe(false);expect(prediction.active).toBe(false);
    expect(prediction.source).toBe('candidate');expect(prediction.p).toBe(prediction.rawP);expect(prediction.p).toBeGreaterThan(input.brtiP);
    for(const key of ['brti','market','quant'] as const){
      expect(fit.validation.gains[key].low).toBeGreaterThan(0);
      expect(fit.validation.scores.candidate.brier!).toBeLessThan(fit.validation.scores[key].brier!);
      expect(fit.validation.scores.candidate.logLoss!).toBeLessThan(fit.validation.scores[key].logLoss!);
    }
  });
  it('does not claim evidence from many snapshots compressed into too few dependent time blocks',()=>{
    const rows=samples(150).map((r,i)=>({...r,time:base+i*120000,sourceTime:base+i*120000,settledTime:base+i*120000+45000}));
    const fit=fitBenchmarkCalibration(rows,after(rows));
    expect(fit.validation.markets).toBeGreaterThanOrEqual(60);expect(fit.validation.blocks).toBeLessThan(20);
    expect(fit.state).toBe('unproven');expect(fit.validation.gains.market.low).toBeNull();
  });
});

describe('immutable prospective calibration scoring',()=>{
  const record=(ticker:string,horizon:number,rawP:number):BenchmarkCalibrationProspectiveSample=>({ticker,horizon,rawP,
    time:base+(60-horizon)*1000,settledTime:base+90000,y:1,version:BENCHMARK_CALIBRATION_VERSION,brtiP:.8,marketP:.7,quantP:.6});
  it('scores recorded raw candidates on the same paired markets, with one unit per settlement',()=>{
    const records=[record('A',60,.9),record('A',30,.9),record('A',10,.9),record('B',30,.6)],asOf=base+100000;
    const scored=scoreBenchmarkCalibrationProspective(records,asOf);
    expect(scored.method).toBe('immutable-prospective');expect(scored.markets).toBe(2);expect(scored.rows).toBe(4);
    expect(scored.scores.candidate.brier).toBeCloseTo((.01+.16)/2,12);
    expect(scored.scores.brti.brier).toBeCloseTo(.04,12);expect(scored.scores.market.brier).toBeCloseTo(.09,12);
    expect(scoreBenchmarkCalibrationProspective([...records,...records],asOf)).toEqual(scored);
    expect(scored.byHorizon.find(h=>h.horizon===30)?.markets).toBe(2);
  });
  it('never replaces missing raw predictions with a fallback, uses future labels, or mixes conflicting versions',()=>{
    const good=record('good',30,.8),records=[good,{...good,ticker:'warming',rawP:null},
      {...good,ticker:'future',settledTime:base+200000},{...good,ticker:'unpaired',quantP:null},
      {...good,ticker:'old',version:'old-model'},{...good,ticker:'lookahead',time:base+100000},
      {...good,ticker:'conflict'},{...good,ticker:'conflict',rawP:.99}];
    const scores=scoreBenchmarkCalibrationProspective(records,base+100000);
    expect(scores.markets).toBe(1);expect(scores.rows).toBe(1);expect(scores.scores.candidate.brier).toBeCloseTo(.04,12);
    expect(()=>scoreBenchmarkCalibrationProspective(records,NaN)).toThrow();
  });
});
