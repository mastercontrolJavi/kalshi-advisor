export const defaults = {
  minEdge: .04, earlyEdge: .08, sweetMinSeconds: 60, sweetMaxSeconds: 900,
  maxSpread: .06, minDepth: 20, makerMargin: .03, minMakerEdge: .02, makerMinSeconds: 120,
  exitMargin: .02, exitMode: 'risk' as 'risk'|'ev', takeProfitPct: .25, stopLossPct: .5, stopWinProb: .25, trailGiveback: .5, trailFloor: .05, showMakerIdeas: false, signalBelowMinSize: true, useQuantForSignals: true, autoBasis: true,
  scalpMinEdge: .03, scalpMinSeconds: 180, scalpMaxSpread: .03, dipMove: .08, kellyFraction: .25, maxRiskPerTrade: .02, maxContracts: 25,
  dailyLossLimit: .10, consecutiveLossLimit: 3, cooldownMinutes: 30, maxTradesPerHour: 4,
  chaseMove: .15, chaseSeconds: 60, halfLifeSeconds: 300, realizedBlend: .25,
  basisCorrection: 0, allowEstimatedK: false, staleMs: 2000, bookStaleMs: 5000, accountStaleMs: 60000, minVolSamples: 120,
  feePrecision: .0001, audio: false, notifications: false
};
export type Config = typeof defaults;
export function validateConfig(input: unknown): Config {
  if (!input || typeof input !== 'object') throw new Error('Settings must be an object');
  const result = {...defaults};
  for (const [key,value] of Object.entries(input)) {
    if (!(key in defaults)) throw new Error(`Unknown setting ${key}`);
    const original = defaults[key as keyof Config];
    if (typeof value !== typeof original || (typeof value === 'number' && !Number.isFinite(value))) throw new Error(`Invalid ${key}`);
    (result as unknown as Record<string,number|boolean|string>)[key] = value as number|boolean|string;
  }
  for (const [key,value] of Object.entries(result)) {
    if (typeof value === 'number' && key !== 'basisCorrection' && value < 0) throw new Error(`${key} must be nonnegative`);
  }
  for (const key of ['minEdge','earlyEdge','maxSpread','makerMargin','minMakerEdge','exitMargin','takeProfitPct','stopLossPct','stopWinProb','trailGiveback','trailFloor','scalpMinEdge','scalpMaxSpread','dipMove','kellyFraction','maxRiskPerTrade','dailyLossLimit','realizedBlend'] as const) if(result[key]>1) throw new Error(`${key} must be <= 1`);
  if(result.halfLifeSeconds<1 || result.staleMs<100 || result.sweetMinSeconds<60 || result.sweetMaxSeconds<result.sweetMinSeconds || result.makerMinSeconds<60 || result.scalpMinSeconds<60 || result.minVolSamples<2 || ![.0001,.01].includes(result.feePrecision)) throw new Error('Invalid time, sample, or precision setting');
  if(!['risk','ev'].includes(result.exitMode)) throw new Error('exitMode must be risk or ev');
  for(const key of ['maxContracts','consecutiveLossLimit','maxTradesPerHour','minVolSamples'] as const) if(!Number.isInteger(result[key]) || result[key]<1) throw new Error(`${key} must be a positive integer`);
  return result;
}
