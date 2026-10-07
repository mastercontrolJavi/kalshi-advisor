/**
 * Opening call: one frozen UP/DOWN forecast per window, made in its first minute.
 * Base = the diffusion model at the open (≈50% because spot ≈ K). Lean = an UNCALIBRATED hypothesis that
 * short-term momentum, Kalshi book imbalance and Kalshi trade flow continue. The lean shifts the base by at
 * most ±MAX_LEAN and is scored on the calibration page before it may influence any trade signal.
 */
export const OPENING_WINDOW_SECONDS = 60;
export const MAX_LEAN = .10;
const WEIGHTS = {momentum120s: .45, momentum30s: .25, imbalance: .15, tradeFlow30s: .15};
export interface OpeningInputs {
  modelP: number;
  sigma: number;
  momentum30s: number | null;
  momentum120s: number | null;
  imbalance: number | null;
  tradeFlow30s: number | null;
  /** Gross contracts traded in the same 30 s; flow is scored as net/gross so huge volume does not saturate it. */
  tradeVolume30s?: number | null;
}
export interface OpeningCall {direction: 'UP'|'DOWN'; p: number; baseP: number; lean: number; reasons: string[]; inputs: OpeningInputs}
const signed = (x: number, digits = 2) => (x >= 0 ? '+' : '') + x.toFixed(digits);
export function openingCall(inputs: OpeningInputs): OpeningCall {
  const {modelP, sigma, momentum30s, momentum120s, imbalance, tradeFlow30s, tradeVolume30s} = inputs;
  if (![modelP, sigma].every(Number.isFinite) || modelP < 0 || modelP > 1 || sigma <= 0) throw new Error('Invalid opening inputs');
  // Standardize log-return momentum by the per-second volatility over its own horizon.
  const z = (r: number | null, seconds: number) => r === null ? null : r / (sigma * Math.sqrt(seconds));
  const parts = [
    {key: 'momentum120s', value: z(momentum120s, 120), squash: Math.tanh, label: (v: number) => `BTC 2-min move ${signed(v)}σ`},
    {key: 'momentum30s', value: z(momentum30s, 30), squash: Math.tanh, label: (v: number) => `BTC 30-s move ${signed(v)}σ`},
    {key: 'imbalance', value: imbalance, squash: (v: number) => Math.max(-1, Math.min(1, v)), label: (v: number) => `Kalshi book leans ${v >= 0 ? 'YES' : 'NO'} (${signed(v)})`},
    {key: 'tradeFlow30s', value: tradeFlow30s === null ? null : tradeVolume30s ? tradeFlow30s / tradeVolume30s : Math.tanh(tradeFlow30s / 100), squash: (v: number) => Math.max(-1, Math.min(1, v)), label: (v: number) => `Kalshi 30-s flow ${signed(v * 100, 0)}% net toward ${v >= 0 ? 'YES' : 'NO'}`}
  ] as const;
  let lean = 0;const reasons: string[] = [];
  for (const part of parts) {
    if (part.value === null || !Number.isFinite(part.value)) {reasons.push(`${part.key} unavailable (counted as neutral)`);continue;}
    const contribution = WEIGHTS[part.key] * part.squash(part.value);
    lean += contribution;
    reasons.push(`${part.label(part.value)} → ${contribution >= 0 ? 'UP' : 'DOWN'} ${Math.abs(contribution * MAX_LEAN * 100).toFixed(1)}pp`);
  }
  // Same 1–99% clip as the diffusion model, so a live call late in the window is not capped below the model itself.
  const p = Math.min(.99, Math.max(.01, modelP + MAX_LEAN * lean));
  reasons.unshift(`Model at open ${(modelP * 100).toFixed(1)}%`);
  return {direction: p >= .5 ? 'UP' : 'DOWN', p, baseP: modelP, lean, reasons, inputs};
}
/** Wilson 95% interval for a hit rate. */
export function wilson(hits: number, n: number) {
  if (!n) return {low: null, high: null};
  const z = 1.96, phat = hits / n, d = 1 + z * z / n, c = phat + z * z / (2 * n), m = z * Math.sqrt(phat * (1 - phat) / n + z * z / (4 * n * n));
  return {low: (c - m) / d, high: (c + m) / d};
}
