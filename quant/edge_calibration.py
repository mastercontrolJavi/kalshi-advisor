"""Calibrate the edge layer's fair value (edge/fair_value.py + edge/vol.py) on the BRTI 1-s archive.

    cd quant; uv run python edge_calibration.py            # report -> output/quant/edge-calibration.md

What it measures, and why each part exists:

1. The variance ratio VR(h) of BRTI (how much more an h-second move varies than h one-second moves). The sidecar's
   VAR_RATIO knots are this table; re-run to see whether they still hold.
2. x = (settlement average - model mean) / model sd for every minute of the archive. The strike does not enter x, so
   every minute is a usable "virtual round" (15x Kalshi's own rounds). If the model is right, x has variance 1 at every
   time left. This is the high-power check of the sd formula; outcomes of real rounds are too few to tell 5% apart.
3. Binary calibration on virtual rounds (strike = the average of the 60 prints that ended 15 minutes before the close,
   exactly Kalshi's construction) and on Kalshi's real rounds: the scale fitted on the first half of the calendar is
   scored on the second half, against the old shortcut formula with its 1.15 / 0.90 multipliers.
4. The EV gate on the journal's real Kalshi asks, filled 1, 2, 3 and 5 seconds AFTER the decision. A same-second fill is
   shown for reference only: it is not achievable (in 35% of journal seconds the BRTI print the replay decides on had
   not reached the engine yet), and it is what made an earlier version of this report show a +2.3c edge at MIN_EDGE 3c.
"""
from __future__ import annotations

import json
import math
import sys
from dataclasses import replace
from pathlib import Path

import numpy as np
import polars as pl
from scipy.optimize import minimize, minimize_scalar
from scipy.stats import norm

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from edge.config import EdgeConfig, load_config  # noqa: E402
from edge.fair_value import VAR_RATIO, VARIOGRAM, WINDOW  # noqa: E402
from edge.vol import EwmaVol  # noqa: E402

CACHE = Path(__file__).resolve().parent / 'cache'
OUT = ROOT / 'output' / 'quant'
PRE_GRID = list(range(840, 60, -15))            # seconds left, before the final minute
FINAL_GRID = [60, 45, 30, 20, 15, 10, 5, 3, 2]  # inside it (1 s left is deterministic: sd = 0)
BUCKETS = [('7-14 min', 420, 901), ('3-7 min', 180, 420), ('1-3 min', 60, 180), ('30-60 s', 30, 60), ('10-30 s', 10, 30), ('2-10 s', 1, 10)]
VR_HORIZONS = (1, 2, 3, 5, 10, 15, 30, 60, 120, 300, 600, 900)


def bucket_of(left: np.ndarray) -> np.ndarray:
    out = np.empty(len(left), dtype=object)
    for name, lo, hi in BUCKETS:
        out[(left > lo) & (left <= hi) if lo >= 60 else (left > lo) & (left <= hi)] = name
    return out


class Archive:
    """The 1-s BRTI series on a dense second grid, with the sidecar's own EWMA variance at every second."""

    def __init__(self, cfg: EdgeConfig):
        b = pl.read_parquet(CACHE / 'brti_1s.parquet').sort('time').unique('time', keep='first').sort('time')
        ts = (b['time'].to_numpy() // 1000).astype(np.int64)
        px = b['price'].to_numpy().astype(float)
        self.t0, self.t1 = int(ts[0]), int(ts[-1])
        n = self.t1 - self.t0 + 1
        self.price = np.full(n, np.nan)
        self.var = np.full(n, np.nan)   # per-second variance of log returns, floored, tail 1.0
        self.ready = np.zeros(n, bool)
        vol = EwmaVol(cfg.VOL_HALFLIFE_S, cfg.VOL_FLOOR_ANN, 1.0, cfg.VOL_MIN_SAMPLES)
        for t, p in zip(ts.tolist(), px.tolist()):
            vol.update(t, p, 'brti')  # archive and live are the same index, so never a source switch
            i = t - self.t0
            self.price[i], self.var[i], self.ready[i] = p, vol.var, vol.ready
        ok = ~np.isnan(self.price)
        self.ok = ok
        self._cs = np.concatenate([[0.0], np.cumsum(np.where(ok, self.price, 0.0))])
        self._cc = np.concatenate([[0], np.cumsum(ok.astype(np.int64))])
        self.n = n

    def window(self, a: np.ndarray, b: np.ndarray):
        """Sum and count of prints in seconds [a, b) (dense offsets)."""
        return self._cs[b] - self._cs[a], self._cc[b] - self._cc[a]

    def variance_ratio(self, lo: int, hi: int) -> dict:
        lp, var, ready = np.log(self.price[lo:hi]), self.var[lo:hi], self.ready[lo:hi]
        out = {}
        for h in VR_HORIZONS:
            d = lp[h:] - lp[:-h]
            m = ~np.isnan(d) & ready[:-h] & ~np.isnan(var[:-h])
            out[h] = float(np.mean(d[m] ** 2) / np.mean(h * var[:-h][m]))
        return out


def samples(ar: Archive) -> pl.DataFrame:
    """One row per (minute-boundary close, seconds left): the settlement average A, the model mean m, spot, the EWMA
    variance, the sd in dollars under the shipped formula (tail 1.0) and under the old shortcut, and the virtual strike."""
    first = ((ar.t0 + 3600) // 60 + 1) * 60
    closes = np.arange(first, ar.t1 - 60, 60)
    c = closes - ar.t0
    a_sum, a_n = ar.window(c - WINDOW, c)
    k_sum, k_n = ar.window(c - 960, c - 900)
    parts = []
    for left in PRE_GRID + FINAL_GRID:
        t = c - left
        good = (a_n >= WINDOW - 1) & ar.ok[t] & ar.ready[t]
        spot, var = ar.price[t], ar.var[t]
        if left > WINDOW:
            mean = spot.copy()
            u_new = VARIOGRAM.pre_window(left - WINDOW)
            u_old = left - WINDOW + 20.0
        else:
            lk_sum, lk_n = ar.window(c - WINDOW, t)
            good &= lk_n == WINDOW - left
            mean = (lk_sum + left * spot) / WINDOW
            u_new = VARIOGRAM.final_sum(left) / WINDOW ** 2
            u_old = (left / WINDOW) ** 2 * left / 3.0
        g = np.flatnonzero(good)
        sig = spot[g] * np.sqrt(var[g])  # dollars per sqrt(second), tail 1.0
        parts.append(pl.DataFrame({
            'close': closes[g], 'left': np.full(len(g), left), 'A': a_sum[g] / a_n[g], 'm': mean[g],
            'sd': sig * math.sqrt(u_new), 'sd_old': sig * math.sqrt(u_old),
            'vstrike': np.where(k_n[g] >= WINDOW - 1, k_sum[g] / np.maximum(k_n[g], 1), np.nan),
        }))
    return pl.concat(parts)


def logloss_vec(p: np.ndarray, y: np.ndarray) -> np.ndarray:
    p = np.clip(p, 1e-4, 1 - 1e-4)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def block_ci(values: np.ndarray, close: np.ndarray, block_s: int = 3600, n: int = 1000, seed: int = 7):
    """95% range of the mean, resampling whole hours (rounds overlap and neighbours are dependent)."""
    key = close // block_s
    uniq, inv = np.unique(key, return_inverse=True)
    sums, counts = np.bincount(inv, weights=values), np.bincount(inv)
    draws = np.random.default_rng(seed).integers(0, len(uniq), size=(n, len(uniq)))
    est = sums[draws].sum(1) / counts[draws].sum(1)
    return float(np.percentile(est, 2.5)), float(np.percentile(est, 97.5))


def fit_scale(z: np.ndarray, y: np.ndarray) -> float:
    return float(minimize_scalar(lambda s: logloss_vec(norm.cdf(z / s), y).mean(), bounds=(0.4, 2.5), method='bounded').x)


def fit_mixture(x: np.ndarray) -> tuple:
    """Two-scale normal mixture for x by maximum likelihood: weight w on scale s1 (calm), 1 - w on s2 (jumpy)."""
    def nll(par):
        w = 1 / (1 + math.exp(-par[0])); s1, s2 = math.exp(par[1]), math.exp(par[2])
        return -np.mean(np.log(w * norm.pdf(x / s1) / s1 + (1 - w) * norm.pdf(x / s2) / s2 + 1e-300))
    r = minimize(nll, [1.5, math.log(0.7), math.log(2.0)], method='Nelder-Mead', options={'xatol': 1e-4, 'fatol': 1e-8, 'maxiter': 2000})
    w, s1, s2 = 1 / (1 + math.exp(-r.x[0])), math.exp(r.x[1]), math.exp(r.x[2])
    return (w, s1, s2) if s1 <= s2 else (1 - w, s2, s1)


def mix_cdf(z: np.ndarray, par: tuple) -> np.ndarray:
    w, s1, s2 = par
    return w * norm.cdf(z / s1) + (1 - w) * norm.cdf(z / s2)


def table(head: list, rows: list) -> list:
    return ['| ' + ' | '.join(head) + ' |', '|' + '|'.join(['---'] + ['---:'] * (len(head) - 1)) + '|'] + ['| ' + ' | '.join(r) + ' |' for r in rows]


def gate_replay(real: pl.DataFrame, cfg: EdgeConfig) -> list:
    """The sidecar's gate on p_base against the journal's real asks `delay` seconds after the decision; first TRADE per
    round (one position per window), held to settlement, per contract after the taker fee."""
    from edge.ev_gate import evaluate, market_prob, taker_fee
    ticks = (pl.read_parquet(CACHE / 'ticks.parquet', columns=['ticker', 'tau', 'yes_bid', 'yes_ask', 'no_ask'])
             .with_columns(pl.col('tau').round(0).cast(pl.Int64).alias('tau_i')).unique(['ticker', 'tau_i']))
    md = ['', '## The EV gate on real Kalshi asks, by fill delay', '',
          'Decide on the BRTI print at second t; buy at the Kalshi ask journaled `delay` seconds later. First TRADE per round, '
          'held to settlement, per contract after the taker fee; 95% range over rounds. "Gross" is before the fee. '
          'The sidecar paper-fills at the next tick (delay 1 s); a person reading a signal and clicking is slower than 2 s. '
          'Delay 0 is NOT achievable and is listed only to show how fast the apparent edge decays.', '']
    rows = []
    for min_edge in (0.01, 0.02, 0.03, 0.05):
        g = replace(cfg, MIN_EDGE=min_edge)
        for delay in (0, 1, 2, 3, 5):
            j = (real.join(ticks.select('ticker', (pl.col('tau_i') + delay).alias('left'), 'yes_bid', 'yes_ask', 'no_ask'), on=['ticker', 'left'], how='inner')
                 .sort('close', 'left', descending=[False, True]))
            done, pnl = set(), []
            for tk, close, left, p, yes, yb, ya, na in j.select('ticker', 'close', 'left', 'p', 'yes', 'yes_bid', 'yes_ask', 'no_ask').iter_rows():
                if tk in done or left - delay < 1:
                    continue
                mid = (yb + ya) / 2 if yb is not None and ya is not None else None
                d = evaluate(p, ya, na, 1000.0, g, market_prob(mid, ya, na))
                if d.action != 'TRADE':
                    continue
                done.add(tk)
                win = (d.side == 'yes') == bool(yes)
                pnl.append((close, float(win), d.ask, (1.0 if win else 0.0) - d.ask - taker_fee(d.ask), (1.0 if win else 0.0) - d.ask))
            if len(pnl) < 2:
                continue
            pnl.sort()
            x = np.array([r[3] for r in pnl]); half = len(x) // 2
            h = 1.96 * x.std(ddof=1) / math.sqrt(len(x))
            rows.append([f'{min_edge * 100:.0f}c', f'{delay} s' + (' (not achievable)' if delay == 0 else ''), f'{len(x):,}', f'{np.mean([r[1] for r in pnl]) * 100:.1f}',
                         f'{np.mean([r[2] for r in pnl]) * 100:.1f}c', f'{np.mean([r[4] for r in pnl]) * 100:+.2f}c', f'**{x.mean() * 100:+.2f}c**',
                         f'{(x.mean() - h) * 100:+.2f}c', f'{(x.mean() + h) * 100:+.2f}c', f'{x[:half].mean() * 100:+.2f}c / {x[half:].mean() * 100:+.2f}c'])
    return md + table(['MIN_EDGE', 'fill delay', 'trades', 'win %', 'avg ask', 'gross', 'net per contract', '95% low', '95% high', 'halves'], rows)


def main() -> None:
    cfg = load_config()  # shipped defaults plus any EDGE_* override, so a what-if run is one environment variable away
    ar = Archive(cfg)
    D = samples(ar)
    close, left = D['close'].to_numpy(), D['left'].to_numpy()
    A, m, sd, sd_old, vstrike = (D[c].to_numpy() for c in ('A', 'm', 'sd', 'sd_old', 'vstrike'))
    bk = bucket_of(left)
    pre = left > WINDOW
    mid_t = ar.t0 + ar.n // 2
    train, test = close < mid_t, close >= mid_t
    x = (A - m) / sd
    x_old = (A - m) / (sd_old * np.where(pre, 1.15, 0.90))
    out: dict = {}
    md = ['# Edge layer fair-value calibration', '',
          f'BRTI 1-s archive: {int(ar.ok.sum()):,} seconds ({ar.ok.sum() / 86400:.1f} days), {len(np.unique(close)):,} minute-boundary closes, {len(x):,} samples. '
          f'Shipped settings: TAIL_MULT {cfg.TAIL_MULT:g}, TAIL_MULT_FINAL {cfg.TAIL_MULT_FINAL:g}.', '']

    # 1. variance ratio
    vr_all, vr_a, vr_b = ar.variance_ratio(0, ar.n), ar.variance_ratio(0, ar.n // 2), ar.variance_ratio(ar.n // 2, ar.n)
    out['variance_ratio'] = vr_all
    md += ['## 1. Variance ratio of BRTI', '', 'E[r_h^2] / (h x EWMA 1-s variance). 1.00 would mean independent seconds. "In code" is the sidecar\'s VAR_RATIO curve.', '']
    md += table(['horizon', 'all', 'first half', 'second half', 'in code'],
                [[f'{h} s', f'{vr_all[h]:.3f}', f'{vr_a[h]:.3f}', f'{vr_b[h]:.3f}', f'{VARIOGRAM.ratio(h):.3f}'] for h in VR_HORIZONS])

    # 2. is x standard?
    md += ['', '## 2. Is the sd right? Variance of x = (settlement average - mean) / sd', '',
           '1.00 is correct; above 1 the model is too confident, below 1 too cautious. "Old" is the previous shortcut with its 1.15 / 0.90 multipliers; '
           '"new" is the exact sum at tail 1.0. Tails: share of |x| > 3 (a normal distribution gives 0.27%).', '']
    rows = []
    for name, _, _ in BUCKETS:
        s = bk == name
        rows.append([name, f'{s.sum():,}', f'{np.mean(x_old[s] ** 2):.3f}', f'{np.mean(x[s] ** 2):.3f}', f'{np.mean(x[s & train] ** 2):.3f}', f'{np.mean(x[s & test] ** 2):.3f}',
                     f'{np.median(np.abs(x[s])):.3f}', f'{np.mean(np.abs(x[s]) > 3) * 100:.2f}%'])
        out.setdefault('var_x', {})[name] = {'old': float(np.mean(x_old[s] ** 2)), 'new': float(np.mean(x[s] ** 2))}
    md += table(['time left', 'samples', 'old var(x)', 'new var(x)', 'new, first half', 'new, second half', 'median abs(x) (normal 0.674)', 'abs(x) > 3'], rows)

    # 3. binary calibration on virtual rounds, then on real rounds
    has_k = ~np.isnan(vstrike)
    yv = (A >= vstrike).astype(float)
    z, z_old = (m - vstrike) / sd, (m - vstrike) / (sd_old * np.where(pre, 1.15, 0.90))
    fits = {}
    for reg, sel in (('pre_window', pre), ('final_minute', ~pre)):
        s = sel & has_k & train
        fits[reg] = {'scale': fit_scale(z[s], yv[s]), 'mix': fit_mixture(x[sel & train])}
    out['fits_first_half'] = {k: {'scale': v['scale'], 'mixture_w_s1_s2': list(v['mix'])} for k, v in fits.items()}
    scale_v = np.where(pre, fits['pre_window']['scale'], fits['final_minute']['scale'])
    p_mix = np.where(pre, mix_cdf(z, fits['pre_window']['mix']), mix_cdf(z, fits['final_minute']['mix']))
    variants = {'old shortcut, 1.15 / 0.90': norm.cdf(z_old), 'new, tail 1.0': norm.cdf(z), 'new, scale fitted on first half': norm.cdf(z / scale_v),
                'new, two-scale mixture fitted on first half': p_mix}
    base = 'old shortcut, 1.15 / 0.90'
    md += ['', '## 3. Outcome calibration, second half of the calendar (never used for fitting)', '',
           f"Fitted on the first half: scale {fits['pre_window']['scale']:.3f} before the final minute and {fits['final_minute']['scale']:.3f} inside it; "
           f"mixture (weight, calm scale, jumpy scale) {tuple(round(v, 3) for v in fits['pre_window']['mix'])} and {tuple(round(v, 3) for v in fits['final_minute']['mix'])}. "
           'Gain is log loss of the old shortcut minus the variant, x1000; positive = the variant forecasts better. 95% ranges resample whole hours.', '',
           '**Virtual rounds** (every minute of the archive, strike built the way Kalshi builds it):', '']
    def score_block(sel_all, y, label_count):
        rows = []
        for nm, p in variants.items():
            row = [nm]
            for reg, sel in (('all', np.ones(len(left), bool)), ('before final minute', pre), ('final minute', ~pre)):
                s = sel_all & sel
                ll = logloss_vec(np.clip(p[s], .001, .999), y[s])
                cell = f'{ll.mean():.4f}'
                if nm != base:
                    d = logloss_vec(np.clip(variants[base][s], .001, .999), y[s]) - ll
                    lo, hi = block_ci(d, close[s])
                    cell += f' (gain {d.mean() * 1000:+.2f}, {lo * 1000:+.2f} to {hi * 1000:+.2f})'
                    out.setdefault(label_count, {}).setdefault(nm, {})[reg] = {'gain_x1000': float(d.mean() * 1000), 'low': lo * 1000, 'high': hi * 1000}
                row.append(cell)
            rows.append(row)
        return table(['variant', 'all', 'before final minute', 'final minute'], rows)
    sv = has_k & test
    md += score_block(sv, yv, 'virtual') + ['', f'{len(np.unique(close[sv])):,} virtual closes, {int(sv.sum()):,} samples.']

    rounds = pl.read_parquet(CACHE / 'rounds.parquet').filter(pl.col('result').is_in(['yes', 'no']) & pl.col('strike').is_not_null())
    real_map = {int(c // 1000): (tk, k, r == 'yes') for tk, c, k, r in rounds.select('ticker', 'close', 'strike', 'result').iter_rows()}
    is_real = np.array([int(c) in real_map for c in close])
    k_real = np.array([real_map[int(c)][1] if r else np.nan for c, r in zip(close, is_real)])
    y_real = np.array([float(real_map[int(c)][2]) if r else np.nan for c, r in zip(close, is_real)])
    agree = np.mean((yv == y_real)[is_real & has_k])
    zr, zr_old = (m - k_real) / sd, (m - k_real) / (sd_old * np.where(pre, 1.15, 0.90))
    variants = {'old shortcut, 1.15 / 0.90': norm.cdf(zr_old), 'new, tail 1.0': norm.cdf(zr), 'new, scale fitted on first half': norm.cdf(zr / scale_v),
                'new, two-scale mixture fitted on first half': np.where(pre, mix_cdf(zr, fits['pre_window']['mix']), mix_cdf(zr, fits['final_minute']['mix']))}
    sr = is_real & test
    md += ['', f"**Kalshi's real rounds** (Kalshi's own strike and result; the virtual construction reproduces Kalshi's result on {agree * 100:.1f}% of samples):", '']
    md += score_block(sr, y_real, 'real') + ['', f'{len(np.unique(close[sr])):,} real rounds, {int(sr.sum()):,} samples.']

    p_ship = np.clip(norm.cdf(zr / np.where(pre, cfg.TAIL_MULT, cfg.TAIL_MULT_FINAL)), .001, .999)
    md += ['', '**Calibration of the shipped setting on all real rounds** (predicted vs realised YES rate):', '']
    rows = []
    for lo in np.arange(0, 1, 0.1):
        cells = [f'{int(round(lo * 100))}-{int(round(lo * 100)) + 10}%']
        for sel in (pre, ~pre):
            s = is_real & sel & (p_ship >= lo) & (p_ship < lo + 0.1)
            cells += [f'{int(s.sum()):,}', f'{p_ship[s].mean() * 100:.1f}% -> {y_real[s].mean() * 100:.1f}%' if s.any() else '—']
        rows.append(cells)
    md += table(['bin', 'n (before final minute)', 'predicted -> realised', 'n (final minute)', 'predicted -> realised'], rows)

    # 4. gate replay with fill delay
    real = pl.DataFrame({'ticker': [real_map[int(c)][0] for c in close[is_real]], 'close': close[is_real], 'left': left[is_real].astype(np.int64),
                         'p': p_ship[is_real], 'yes': y_real[is_real] > 0.5})
    md += gate_replay(real, cfg)

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'edge-calibration.md').write_text('\n'.join(md) + '\n', encoding='utf-8')
    (OUT / 'edge-calibration.json').write_text(json.dumps(out, indent=1), encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    print('\n'.join(md))


if __name__ == '__main__':
    main()
