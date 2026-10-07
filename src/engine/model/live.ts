/**
 * Live call: the opening-call formula re-run on current data every evaluation.
 * Direction has hysteresis (must clear 50% by FLIP_BAND to flip) so the call does not flicker around a coin flip.
 * Snapshots at fixed horizons are journaled and scored, one per window per horizon.
 */
export const FLIP_BAND = .02;
export const LIVE_HORIZONS = [600, 300, 120, 60] as const;
export type Direction = 'UP'|'DOWN';
export function nextDirection(previous: Direction|null, p: number, band = FLIP_BAND): Direction {
  if (previous === null) return p >= .5 ? 'UP' : 'DOWN';
  if (previous === 'UP' && p <= .5 - band) return 'DOWN';
  if (previous === 'DOWN' && p >= .5 + band) return 'UP';
  return previous;
}
export function confidence(p: number) {
  const d = Math.abs(p - .5);
  return d < .05 ? 'Toss-up' : d < .15 ? 'Lean' : d < .3 ? 'Likely' : 'Strong';
}
/** Horizon due now: the first checkpoint the window has crossed within the last 30 s that has no snapshot yet. */
export function dueHorizon(tau: number, saved: Set<number>) {
  return LIVE_HORIZONS.find(h => tau <= h && tau > h - 30 && !saved.has(h)) ?? null;
}
export interface Quality {level: 'solid'|'degraded'|'unreliable'; issues: string[]}
/** Data quality for the forecast: unreliable blocks the call, degraded is shown with its issues. */
export function dataQuality(q: {healthyFeeds: number; totalFeeds: number; kalshiLive: boolean; bookLive: boolean; kConfirmed: boolean; modelReady: boolean; clockSynced: boolean}): Quality {
  const issues: string[] = [];
  if (!q.modelReady) issues.push('model warming');
  if (q.healthyFeeds < Math.min(2, q.totalFeeds)) issues.push(`only ${q.healthyFeeds}/${q.totalFeeds} price feeds live`);
  const blocking = issues.length > 0;
  // An estimated K is computed from the same 60 s of prices Kalshi uses; it only degrades confidence.
  if (!q.kConfirmed) issues.push('opening K estimated from proxy');
  if (q.healthyFeeds < q.totalFeeds && q.healthyFeeds >= 2) issues.push(`${q.healthyFeeds}/${q.totalFeeds} price feeds live`);
  if (!q.kalshiLive) issues.push('Kalshi stream down (REST fallback)');
  if (!q.bookLive) issues.push('Kalshi book stale');
  if (!q.clockSynced) issues.push('clock not synced');
  return {level: blocking ? 'unreliable' : issues.length ? 'degraded' : 'solid', issues};
}
