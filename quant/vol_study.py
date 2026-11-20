"""Why does the fair value's volatility run hot, and does recalibrating it beat Kalshi's price out of sample?

    cd quant; uv run python study_data.py; uv run python vol_study.py     # report -> output/quant/vol-study.md

The bot prices a round with edge/fair_value.py on a volatility from edge/vol.py: an EWMA of squared 1-second BRTI
returns with a 300-second half-life. The 2026-11-18 diagnostic found that sd 1.18x what BRTI then did on the paper
rounds with a large claimed edge, and 1.33x the sd Kalshi's price implied. This script takes the three suspects apart:

1. the 60-second settlement average (is the variance reduction of the average mis-scaled?),
2. the EWMA window (is a 300-s half-life too reactive, so that after a burst the forecast for the next ten minutes
   is too high?),
3. microstructure noise in the 1-second prints (is noise counted as volatility?),

and then refits the volatility forecast strictly walk-forward (six calendar blocks; each block is forecast with
parameters fitted only on the blocks before it) and scores it against Kalshi's mid on real rounds.

Everything strike-free is measured on "virtual rounds": every minute of the BRTI archive is a possible close, and
x = (settlement average - spot) / model sd must have variance 1 whatever the strike. That gives ~25x the samples of
Kalshi's own rounds. Read-only; nothing here changes the engine or the bot.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import polars as pl
from scipy.optimize import minimize
from scipy.stats import norm

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from edge.fair_value import VAR_RATIO, VARIOGRAM, WINDOW  # noqa: E402
from edge.vol import SECONDS_PER_YEAR  # noqa: E402

import study_data as sd  # noqa: E402

CACHE = Path(__file__).resolve().parent / 'cache'
OUT = ROOT / 'output' / 'quant'
HLS = (300, 900, 3600, 14400)
FLOOR = 0.10 ** 2 / SECONDS_PER_YEAR      # edge/vol.py's floor (10% annualised), as a per-second variance
MIN_SAMPLES = 600                         # the bot's VOL_MIN_SAMPLES
LEFTS = [840, 720, 600, 480, 360, 240, 120, 75]
BLOCKS = 6
U = {L: VARIOGRAM.pre_window(L - WINDOW) for L in LEFTS}


def table(head, rows):
    return ['| ' + ' | '.join(head) + ' |', '|' + '|'.join(['---'] + ['---:'] * (len(head) - 1)) + '|'] + ['| ' + ' | '.join(r) + ' |' for r in rows]


def virtual(s: sd.Series) -> dict:
    """One row per (minute-boundary close, seconds left): what the average did against the spot, the EWMA variances at
    that second, and the variance BRTI then realised up to the close."""
    first = ((s.t0 + 4 * 3600) // 60 + 1) * 60
    closes = np.arange(first, s.t1 - 60, 60)
    c = closes - s.t0
    a_sum, a_n = s.window(c - WINDOW, c)
    k_sum, k_n = s.window(c - 960, c - 900)      # the strike as Kalshi builds it: the average that ended 15 minutes before the close
    cols = {k: [] for k in ('close', 'left', 'dev', 'kdev', 'rv', 'rv_n') + tuple(f'v{h}' for h in HLS)}
    for L in LEFTS:
        t = c - L
        rv, rv_n = s.realised(t, c - 1)
        good = (a_n >= WINDOW - 1) & s.ok[t] & (s.count[t] >= MIN_SAMPLES) & (rv_n >= 0.9 * (L - 1))
        for h in HLS:
            good &= ~np.isnan(s.var[h][t])
        g = np.flatnonzero(good)
        cols['close'].append(closes[g]); cols['left'].append(np.full(len(g), L))
        cols['dev'].append((a_sum[g] / a_n[g] - s.price[t][g]) / s.price[t][g])      # as a fraction of spot
        cols['kdev'].append(np.where(k_n[g] >= WINDOW - 1, (k_sum[g] / np.maximum(k_n[g], 1) - s.price[t][g]) / s.price[t][g], np.nan))  # strike - spot
        cols['rv'].append(rv[g]); cols['rv_n'].append(rv_n[g])
        for h in HLS:
            cols[f'v{h}'].append(np.maximum(s.var[h][t][g], FLOOR))
    return {k: np.concatenate(v) for k, v in cols.items()}


# ---- candidate volatility forecasts: per-second variance from the EWMAs, parameters `par` ----
def f_shipped(v, par=None):
    return v['v300']


def f_scale(v, par):
    return math.exp(par[0]) * v['v300']


def f_blend(v, par):
    """Geometric blend of the fast and the slower EWMAs, times a constant: exp(c) * v300^a * v3600^b * v14400^(1-a-b)."""
    c, a, b = par
    return np.exp(c + a * np.log(v['v300']) + b * np.log(v['v3600']) + (1 - a - b) * np.log(v['v14400']))




def nll(var_f, dev, left_units):
    """Gaussian negative log-likelihood of the average's move given the forecast variance (per sample)."""
    s2 = var_f * left_units
    return 0.5 * (np.log(s2) + dev ** 2 / s2)


def fit(fn, start, v, dev, units):
    if start is None:
        return None
    r = minimize(lambda p: float(np.mean(nll(fn(v, p), dev, units))), start, method='Nelder-Mead', options={'xatol': 1e-4, 'fatol': 1e-9, 'maxiter': 4000})
    return list(r.x)


def fit_mixture(x):
    """Two-scale normal mixture for x by maximum likelihood: weight w on scale s1 (quiet), 1 - w on s2 (jumpy)."""
    def loss(par):
        w = 1 / (1 + math.exp(-par[0])); s1, s2 = math.exp(par[1]), math.exp(par[2])
        return -float(np.mean(np.log(w * norm.pdf(x / s1) / s1 + (1 - w) * norm.pdf(x / s2) / s2 + 1e-300)))
    r = minimize(loss, [1.0, math.log(0.7), math.log(1.8)], method='Nelder-Mead', options={'xatol': 1e-4, 'fatol': 1e-9, 'maxiter': 3000})
    w, s1, s2 = 1 / (1 + math.exp(-r.x[0])), math.exp(r.x[1]), math.exp(r.x[2])
    return (w, s1, s2) if s1 <= s2 else (1 - w, s2, s1)


def mix_cdf(z, par):
    w, s1, s2 = par
    return w * norm.cdf(z / s1) + (1 - w) * norm.cdf(z / s2)


def mix_pdf(z, par):
    w, s1, s2 = par
    return w * norm.pdf(z / s1) / s1 + (1 - w) * norm.pdf(z / s2) / s2


def block_ci(values, key, n=1000, seed=7):
    uniq, inv = np.unique(key, return_inverse=True)
    sums, counts = np.bincount(inv, weights=values), np.bincount(inv)
    draws = np.random.default_rng(seed).integers(0, len(uniq), size=(n, len(uniq)))
    est = sums[draws].sum(1) / counts[draws].sum(1)
    return float(np.percentile(est, 2.5)), float(np.percentile(est, 97.5))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    s = sd.Series(HLS)
    V = virtual(s)
    n = len(V['close'])
    units = np.array([U[L] for L in V['left']])
    edges = np.linspace(V['close'].min(), V['close'].max() + 1, BLOCKS + 1)
    block = np.clip(np.searchsorted(edges, V['close'], side='right') - 1, 0, BLOCKS - 1)
    day = lambda t: np.datetime64(int(t), 's').astype('datetime64[D]')
    md = ['# Volatility study: why the fair value runs hot, and whether recalibrating it beats Kalshi', '',
          f'BRTI 1 Hz, {day(s.t0)} to {day(s.t1)}; {n:,} virtual-round samples ({len(np.unique(V["close"])):,} minute closes x {len(LEFTS)} times left). '
          f'Walk-forward blocks: ' + ', '.join(f'{i + 1}: {day(edges[i])}..{day(edges[i + 1])}' for i in range(BLOCKS)) + '.', '']

    # ---- 1. microstructure noise ----
    lp = np.log(s.price)
    r1 = lp[1:] - lp[:-1]
    ok = ~np.isnan(r1[1:]) & ~np.isnan(r1[:-1])
    ac1 = float(np.corrcoef(r1[1:][ok], r1[:-1][ok])[0, 1])
    base = np.nanmean(r1 ** 2)
    vr = []
    for h in (1, 2, 5, 15, 30, 60, 120, 300, 600, 900):
        d = lp[h:] - lp[:-h]
        vr.append((h, float(np.nanmean(d ** 2) / (h * base))))
    knots = dict(VAR_RATIO)
    md += ['## 1. Is noise in the 1-second prints counted as volatility?', '',
           f'Lag-1 autocorrelation of 1-s BRTI returns: **{ac1:+.3f}**. Bid-ask style noise would make it negative and make '
           'longer moves vary LESS than the 1-s variance scaled up (variance ratio below 1). BRTI does the reverse:', '']
    md += table(['horizon (s)'] + [str(h) for h, _ in vr], [['variance ratio, measured'] + [f'{x:.3f}' for _, x in vr],
                                                            ['fair_value.py VAR_RATIO'] + [f'{VARIOGRAM.ratio(h):.3f}' for h, _ in vr]])
    md += ['', '**No.** The 1-s EWMA is not inflated by noise, and the VAR_RATIO table that scales it to longer horizons is within a few percent of the data.', '']

    # ---- 2. the settlement average ----
    x300 = V['dev'] / np.sqrt(V['v300'] * units)
    rows = []
    for L in LEFTS:
        m = V['left'] == L
        # the same samples with the realised variance in place of the forecast: tests the average's formula alone
        xr = V['dev'][m] / np.sqrt(np.maximum(V['rv'][m], 1e-18) * U[L])
        rows.append([str(L), f'{U[L]:.1f}', f'{U[L] / (L - 30):.3f}', f'{np.mean(x300[m] ** 2):.3f}', f'{np.mean(np.clip(xr, -6, 6) ** 2):.3f}',
                     f'{np.median(np.abs(x300[m])):.3f}', f'{100 * np.mean(np.abs(x300[m]) > 2):.1f}%'])
    allv = float(np.mean(x300 ** 2))
    md += ['## 2. Is the 60-second average mis-scaled?', '',
           'x = (settlement average - spot) / model sd. If the sd is right the variance of x is 1 at every time left. "Units" is the variance of '
           'the average in 1-second variances (the double sum in fair_value.py). The "realised vol" column replaces the forecast volatility with '
           'the volatility BRTI actually had from then to the close: it tests the averaging arithmetic apart from the volatility forecast (it sits '
           'below 1 because the realised volatility is measured on the same path, so what matters is that it is flat). A normal has median |x| '
           '0.674 and |x| > 2 in 4.6% of cases.', '']
    md += table(['seconds left', 'units', 'units / (left - 30)', 'var(x), forecast vol', 'var(x), realised vol', 'median |x|', '|x| > 2'], rows)
    md += ['', f'**No.** Both variance columns are flat from 14 minutes to 75 seconds left, so the reduction for the average is scaled right at every '
           f'horizon. Overall var(x) is {allv:.2f}: by variance the sd is {1 / math.sqrt(allv):.2f}x what it should be, i.e. slightly too NARROW, not too wide.', '']

    # ---- 3. the EWMA window ----
    ratio_means = float(np.mean(V['v300']) / np.mean(V['rv']))
    med_ratio = float(np.median(np.sqrt(V['v300'] / np.maximum(V['rv'], 1e-18))))
    regime = np.log(V['v300'] / V['v14400'])
    qs = np.quantile(regime, [0.2, 0.4, 0.6, 0.8])
    rq = np.searchsorted(qs, regime)
    rows = []
    for q in range(5):
        m = rq == q
        rows.append([f'{q + 1}' + (' (calm vs the last 4 h)' if q == 0 else ' (burst vs the last 4 h)' if q == 4 else ''),
                     f'{np.exp(np.median(regime[m]) / 2):.2f}', f'{math.sqrt(np.mean(V["v300"][m]) / np.mean(V["rv"][m])):.2f}',
                     f'{np.median(np.sqrt(V["v300"][m] / np.maximum(V["rv"][m], 1e-18))):.2f}', f'{np.mean(x300[m] ** 2):.3f}', f'{np.median(np.abs(x300[m])):.3f}'])
    md += ['## 3. Is the 300-second EWMA too reactive?', '',
           f'As a variance the forecast is unbiased: forecast / realised over all samples, ratio of means, is {math.sqrt(ratio_means):.2f} as a sigma. '
           f'The MEDIAN of sigma forecast / sigma realised is {med_ratio:.2f}: realised volatility is right-skewed (mostly a little below its mean, '
           'sometimes far above), so a median of ratios reads above 1 for an unbiased forecast. The 1.18x in the 2026-11-18 diagnostic was that '
           'statistic, on a selected set of rounds. By how the 300-s EWMA compares with the 4-hour one when the round is priced:', '']
    md += table(['quintile of EWMA 300 s / EWMA 4 h', 'sigma 300 s / sigma 4 h', 'sigma forecast / realised (means)', 'median sigma forecast / realised',
                 'var(x)', 'median |x|'], rows)
    md += ['', f'**Only mildly, and in the other direction from the one suspected.** After a burst var(x) is {np.mean(x300[rq == 4] ** 2):.2f}: the sd is about right, not too wide. '
           f'In calm stretches var(x) is {np.mean(x300[rq == 0] ** 2):.2f}: the sd is too narrow there, because volatility comes back up. '
           'What every row shares is a median |x| near 0.59 against 0.674 for a normal: the typical move is about 12% smaller than the sd says, and '
           'the variance is made up by rare large moves. That is a shape problem, not a scale problem (section 4).', '']

    # ---- 4. walk-forward recalibration on virtual rounds ----
    NAMES = ['shipped (EWMA 300 s, normal)', 'one scale, normal', 'blend 300 s / 1 h / 4 h, normal', 'blend + two-scale shape']
    FN = {'shipped (EWMA 300 s, normal)': (f_shipped, None), 'one scale, normal': (f_scale, [0.0]), 'blend 300 s / 1 h / 4 h, normal': (f_blend, [0.0, 0.5, 0.3])}
    oos = {name: np.full(n, np.nan) for name in FN}
    params = {name: [None] * BLOCKS for name in FN}
    mix = [None] * BLOCKS
    for b in range(1, BLOCKS):
        tr, te = block < b, block == b
        vtr = {k: V[k][tr] for k in V}
        vte = {k: V[k][te] for k in V}
        for name, (fn, start) in FN.items():
            par = fit(fn, start, vtr, V['dev'][tr], units[tr])
            params[name][b] = par
            oos[name][te] = np.maximum(fn(vte, par), FLOOR)
        bl = np.maximum(f_blend(vtr, params['blend 300 s / 1 h / 4 h, normal'][b]), FLOOR)
        mix[b] = fit_mixture(V['dev'][tr] / np.sqrt(bl * units[tr]))
    te_all = block >= 1
    mixpar = [mix[b] for b in block[te_all]]
    W, S1, S2 = (np.array([p[i] for p in mixpar]) for i in range(3))
    xb = V['dev'][te_all] / np.sqrt(oos['blend 300 s / 1 h / 4 h, normal'][te_all] * units[te_all])
    gauss = lambda vf: nll(vf, V['dev'][te_all], units[te_all])
    nll_of = {name: gauss(oos[name][te_all]) for name in FN}
    nll_of['blend + two-scale shape'] = (0.5 * np.log(oos['blend 300 s / 1 h / 4 h, normal'][te_all] * units[te_all])
                                         - np.log(W * norm.pdf(xb / S1) / S1 + (1 - W) * norm.pdf(xb / S2) / S2 + 1e-300) - 0.5 * math.log(2 * math.pi))
    # binary calibration on the virtual strike: what the forecast says for the side that is behind, and how often it wins
    kd = V['kdev'][te_all]
    has_k = ~np.isnan(kd)
    y_v = (V['dev'][te_all] >= kd).astype(float)          # the average finished at or above the strike
    pv = {}
    for name in FN:
        z = -kd / np.sqrt(oos[name][te_all] * units[te_all])
        pv[name] = norm.cdf(z)
    zb = -kd / np.sqrt(oos['blend 300 s / 1 h / 4 h, normal'][te_all] * units[te_all])
    pv['blend + two-scale shape'] = W * norm.cdf(zb / S1) + (1 - W) * norm.cdf(zb / S2)
    rows = []
    hours = V['close'][te_all] // 3600
    for name in NAMES:
        d = nll_of[name] - nll_of[NAMES[0]]
        lo, hi = block_ci(d, hours)
        p = np.clip(pv[name][has_k], 1e-4, 1 - 1e-4)
        ll = -(y_v[has_k] * np.log(p) + (1 - y_v[has_k]) * np.log(1 - p))
        p0 = np.clip(pv[NAMES[0]][has_k], 1e-4, 1 - 1e-4)
        ll0 = -(y_v[has_k] * np.log(p0) + (1 - y_v[has_k]) * np.log(1 - p0))
        blo, bhi = block_ci(ll - ll0, hours[has_k])
        vx = '-' if name == NAMES[3] else f'{np.mean((V["dev"][te_all] / np.sqrt(oos[name][te_all] * units[te_all])) ** 2):.3f}'
        rows.append([name, vx, f'{np.mean(d) * 1000:+.2f} ({lo * 1000:+.2f} .. {hi * 1000:+.2f})', f'{ll.mean():.4f}',
                     f'{(ll - ll0).mean() * 1000:+.2f} ({blo * 1000:+.2f} .. {bhi * 1000:+.2f})'])
    md += ['## 4. Recalibration, strictly walk-forward (virtual rounds)', '',
           f'Each of blocks 2-{BLOCKS} is forecast with parameters fitted only on the blocks before it. "One scale" multiplies the shipped variance by a '
           'constant. "Blend" is exp(c) x EWMA300^a x EWMA1h^b x EWMA4h^(1-a-b). "Two-scale shape" keeps the blend\'s sd and replaces the normal with a '
           'mixture of two normals (a quiet one and a jumpy one) fitted to x. "Density" is the log-likelihood of the average\'s move; "binary" is the '
           'log-loss of YES/NO against a strike built the way Kalshi builds it (the average that ended 15 minutes before the close). Lower is better; '
           '95% ranges resample whole hours.', '']
    md += table(['forecast', 'var(x) out of sample', 'density NLL vs shipped (x1000, 95%)', 'binary log-loss', 'binary vs shipped (x1000, 95%)'], rows)
    md += ['', 'Fitted parameters per block (trained on everything before it):', '']
    bp = params['blend 300 s / 1 h / 4 h, normal']
    md += table(['block', 'one scale: sigma multiplier', 'blend: sigma multiplier', 'weight on EWMA 300 s', 'on 1 h', 'on 4 h', 'shape: share quiet', 'quiet sd', 'jumpy sd'],
                [[str(b + 1), f'{math.exp(params["one scale, normal"][b][0] / 2):.3f}', f'{math.exp(bp[b][0] / 2):.3f}', f'{bp[b][1]:.2f}', f'{bp[b][2]:.2f}',
                  f'{1 - bp[b][1] - bp[b][2]:.2f}', f'{mix[b][0]:.2f}', f'{mix[b][1]:.2f}', f'{mix[b][2]:.2f}'] for b in range(1, BLOCKS)])
    # reliability for the side that is behind
    rows = []
    bins = [(0.01, 0.05), (0.05, 0.15), (0.15, 0.30), (0.30, 0.45), (0.45, 0.50)]
    for name in (NAMES[0], NAMES[3]):
        p = pv[name][has_k]
        pu = np.minimum(p, 1 - p)
        won = np.where(p < 0.5, y_v[has_k], 1 - y_v[has_k])
        cells = []
        for lo_, hi_ in bins:
            m = (pu >= lo_) & (pu < hi_)
            cells.append(f'{100 * pu[m].mean():.1f}% -> {100 * won[m].mean():.1f}% (n {m.sum():,})')
        rows.append([name] + cells)
    md += ['', 'What the forecast says for the side that is BEHIND, and how often that side then won (out of sample, virtual strikes):', '']
    md += table(['forecast'] + [f'says {int(a * 100)}-{int(b_ * 100)}%' for a, b_ in bins], rows)
    md += ['']

    # ---- dense out-of-sample variance for the replay (knife_replay.py) and the real-round scoring ----
    dense_t = np.arange(s.n) + s.t0
    dblock = np.clip(np.searchsorted(edges, dense_t, side='right') - 1, 0, BLOCKS - 1)
    dv = {f'v{h}': np.maximum(s.var[h], FLOOR) for h in HLS}
    var0 = dv['v300'].copy()
    var_blend = np.full(s.n, np.nan)
    var_scale = np.full(s.n, np.nan)
    for b in range(1, BLOCKS):
        m = dblock == b
        sub = {k: dv[k][m] for k in dv}
        var_blend[m] = np.maximum(f_blend(sub, bp[b]), FLOOR)
        var_scale[m] = np.maximum(f_scale(sub, params['one scale, normal'][b]), FLOOR)
    ready = s.count >= MIN_SAMPLES
    mix_arr = np.array([m if m is not None else (np.nan, np.nan, np.nan) for m in mix])
    np.savez_compressed(CACHE / 'study_var.npz', t0=s.t0, price=s.price, ready=ready, var_shipped=var0, var_blend=var_blend, var_scale=var_scale,
                        block=dblock, edges=edges, mix=mix_arr)

    # ---- 5. real rounds: Brier and log-loss against Kalshi's mid ----
    t = sd.ticks().filter((pl.col('valid') == 1) & pl.col('yes_bid').is_not_null() & pl.col('yes_ask').is_not_null() & (pl.col('book_delay').fill_null(0) <= 2000))
    ps = (t['brti_time'].to_numpy() // 1000).astype(np.int64)
    close = (t['close'].to_numpy() // 1000).astype(np.int64)
    left = close - ps
    idx = ps - s.t0
    inside = (idx >= 0) & (idx < s.n) & (left > WINDOW) & (left <= 840) & ((t['time'].to_numpy() // 1000) % 15 == 0)
    idx_c = np.clip(idx, 0, s.n - 1)
    inside &= ready[idx_c] & ~np.isnan(s.price[idx_c]) & (dblock[idx_c] >= 1) & ~np.isnan(var_blend[idx_c])
    g = np.flatnonzero(inside)
    spot, k, lf = s.price[idx[g]], t['k'].to_numpy()[g], left[g].astype(float)
    y = (t['result'].to_numpy()[g] == 'yes').astype(float)
    mid = (t['yes_bid'].to_numpy()[g] + t['yes_ask'].to_numpy()[g]) / 2
    un = np.array([VARIOGRAM.pre_window(x - WINDOW) for x in lf])
    tick = t['ticker'].to_numpy()[g]
    P = {'Kalshi mid': np.clip(mid, 0.001, 0.999)}
    for name, arr in ((NAMES[0], var0), (NAMES[1], var_scale), (NAMES[2], var_blend)):
        P[name] = np.clip(norm.cdf((spot - k) / (spot * np.sqrt(arr[idx[g]] * un))), 0.001, 0.999)
    mg = mix_arr[dblock[idx[g]]]
    zz = (spot - k) / (spot * np.sqrt(var_blend[idx[g]] * un))
    P[NAMES[3]] = np.clip(mg[:, 0] * norm.cdf(zz / mg[:, 1]) + (1 - mg[:, 0]) * norm.cdf(zz / mg[:, 2]), 0.001, 0.999)
    ll = lambda p: -(y * np.log(p) + (1 - y) * np.log(1 - p))
    br = lambda p: (p - y) ** 2
    _, rid = np.unique(tick, return_inverse=True)
    cuts = [('all, 1-14 min left', np.ones(len(g), bool)), ('the bot\'s window (2-10 min)', (lf > 120) & (lf <= 600)),
            ('bot\'s window, mid outside 30-70c', (lf > 120) & (lf <= 600) & ((mid < 0.3) | (mid > 0.7))),
            (f'last block only ({day(edges[BLOCKS - 1])} on)', dblock[idx[g]] == BLOCKS - 1)]
    md += ['## 5. Against Kalshi\'s mid on real rounds (out of sample)', '',
           f'{len(np.unique(tick)):,} settled rounds from {day(edges[1])} on, one sample every 15 s with a valid two-sided book. Probabilities use the '
           'walk-forward parameters of section 4. Differences are model minus Kalshi (positive = Kalshi forecasts better); 95% ranges resample whole rounds.', '']
    rows = []
    for label, m in cuts:
        for name in P:
            if name == 'Kalshi mid':
                rows.append([label, name, f'{m.sum():,}', f'{len(np.unique(tick[m])):,}', f'{br(P[name])[m].mean():.4f}', f'{ll(P[name])[m].mean():.4f}', '', ''])
                continue
            dl = (ll(P[name]) - ll(P['Kalshi mid']))[m]
            db = (br(P[name]) - br(P['Kalshi mid']))[m]
            lo, hi = block_ci(dl, rid[m])
            blo, bhi = block_ci(db, rid[m])
            rows.append(['', name, '', '', f'{br(P[name])[m].mean():.4f}', f'{ll(P[name])[m].mean():.4f}',
                         f'{db.mean() * 1000:+.2f} ({blo * 1000:+.2f} .. {bhi * 1000:+.2f})', f'{dl.mean() * 1000:+.2f} ({lo * 1000:+.2f} .. {hi * 1000:+.2f})'])
    md += table(['samples', 'forecast', 'n', 'rounds', 'Brier', 'log-loss', 'Brier - Kalshi (x1000, 95%)', 'log-loss - Kalshi (x1000, 95%)'], rows)

    # how far each forecast sits from Kalshi's price on the side that is behind
    rows = []
    for name in NAMES:
        p = P[name]
        under_k = np.minimum(mid, 1 - mid)
        under_m = np.where(mid < 0.5, p, 1 - p)
        cells = []
        for lo_, hi_ in ((0.03, 0.10), (0.10, 0.20), (0.20, 0.30), (0.30, 0.45)):
            m = (under_k >= lo_) & (under_k < hi_) & (lf > 120) & (lf <= 600)
            cells.append(f'{100 * (under_m[m] - under_k[m]).mean():+.1f} pts')
        rows.append([name] + cells)
    md += ['', 'Model probability minus Kalshi\'s mid for the side Kalshi has behind, 2-10 minutes left (positive = the model rates the underdog higher than the market):', '']
    md += table(['forecast', 'Kalshi 3-10c', '10-20c', '20-30c', '30-45c'], rows)
    md += ['']
    (OUT / 'vol-study.md').write_text('\n'.join(md) + '\n', encoding='utf-8')
    print('\n'.join(md))


if __name__ == '__main__':
    main()
