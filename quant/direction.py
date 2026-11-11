"""How accurate is the UP/DOWN call, and can anything make it more accurate?

    cd quant; uv run python direction.py            # report -> output/quant/direction.md

1. Hit rate by time left on Kalshi's real rounds: the model's call (which side of the target the projected settlement
   average is on) against Kalshi's favourite at the same second, who is right when they point opposite ways, and the
   "ceiling": the hit rate a perfectly calibrated forecaster would expect from its own probabilities. A call that sits
   at its ceiling has no slack left; only new information can raise it.
2. The dashboard's own recorded calls (live_calls, opening_calls in data/advisor.db) against Kalshi's favourite.
3. Does recent momentum add direction information beyond distance-to-target? Every minute of the BRTI archive is a
   virtual round; fitted on the first half of the calendar, scored on the second.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import polars as pl
from scipy.stats import norm
from sklearn.linear_model import LogisticRegression

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from edge.config import load_config  # noqa: E402
import data  # noqa: E402
import edge_calibration as ec  # noqa: E402

OUT = ROOT / 'output' / 'quant'
HORIZONS = (840, 720, 600, 480, 360, 300, 240, 180, 120, 90, 75, 60, 45, 30, 15, 10)


def pct(x: float) -> str:
    return '—' if x is None or math.isnan(x) else f'{x * 100:.1f}%'


def main() -> None:
    cfg = load_config()
    ar = ec.Archive(cfg)
    D = ec.samples(ar)
    close, left = D['close'].to_numpy(), D['left'].to_numpy()
    A, m, sd, vk = (D[c].to_numpy() for c in ('A', 'm', 'sd', 'vstrike'))
    mid_t = ar.t0 + ar.n // 2
    train, test = close < mid_t, close >= mid_t
    md = ['# How accurate is the UP/DOWN call?', '']

    # 1. real rounds: model vs Kalshi's favourite
    rounds = pl.read_parquet(ec.CACHE / 'rounds.parquet').filter(pl.col('result').is_in(['yes', 'no']) & pl.col('strike').is_not_null())
    real = {int(c // 1000): (tk, k, r == 'yes') for tk, c, k, r in rounds.select('ticker', 'close', 'strike', 'result').iter_rows()}
    is_real = np.array([int(c) in real for c in close]) & (sd > 0)
    strike = np.array([real[int(c)][1] for c in close[is_real]])
    R = pl.DataFrame({'ticker': [real[int(c)][0] for c in close[is_real]], 'left': left[is_real].astype(np.int64),
                      'z': (m[is_real] - strike) / sd[is_real], 'y': np.array([float(real[int(c)][2]) for c in close[is_real]])})
    ticks = (pl.read_parquet(ec.CACHE / 'ticks.parquet', columns=['ticker', 'tau', 'yes_bid', 'yes_ask', 'book_delay'])
             .with_columns(pl.col('tau').round(0).cast(pl.Int64).alias('left')).unique(['ticker', 'left'])
             .filter(pl.col('yes_bid').is_not_null() & pl.col('yes_ask').is_not_null() & (pl.col('yes_ask') - pl.col('yes_bid') <= 0.10) & (pl.col('book_delay').fill_null(0) <= 2000))
             .with_columns(((pl.col('yes_bid') + pl.col('yes_ask')) / 2).alias('mid')).select('ticker', 'left', 'mid'))
    J = R.join(ticks, on=['ticker', 'left'], how='inner')
    md += ['## 1. By time left, on Kalshi\'s real rounds', '',
           'Rounds where the journal has a live two-sided Kalshi book at that second. "Ceiling" is the hit rate the model\'s own probabilities imply; a call at its ceiling has no slack.', '']
    rows = []
    for L in HORIZONS:
        g = J.filter(pl.col('left') == L)
        if g.height < 50:
            continue
        z, y, mid = g['z'].to_numpy(), g['y'].to_numpy(), g['mid'].to_numpy()
        mc, kc = (z >= 0).astype(float), (mid >= 0.5).astype(float)
        dis = (mc != kc) & (mid != 0.5)
        p = norm.cdf(z)
        rows.append([f'{L // 60} min' if L >= 120 and L % 60 == 0 else f'{L} s', f'{g.height:,}', pct(np.mean(mc == y)), pct(np.mean(kc == y)), pct(float(np.mean(np.maximum(p, 1 - p)))),
                     f'{int(dis.sum())}', pct(float(np.mean(mc[dis] == y[dis]))) if dis.any() else '—', pct(float(np.mean(kc[dis] == y[dis]))) if dis.any() else '—'])
    md += ec.table(['time left', 'rounds', 'model right', 'Kalshi favourite right', 'ceiling', 'they disagree', 'model right then', 'Kalshi right then'], rows)
    pre = J.filter(pl.col('left') > 60)
    z, y, mid = pre['z'].to_numpy(), pre['y'].to_numpy(), pre['mid'].to_numpy()
    dis = ((z >= 0) != (mid >= 0.5)) & (mid != 0.5)
    md += ['', f'Before the final minute the two point opposite ways in {dis.mean() * 100:.1f}% of sampled seconds (Kalshi within {np.mean(np.abs(mid[dis] - 0.5)) * 100:.1f} points of 50 on average). '
           f'There the model is right {np.mean((z[dis] >= 0) == y[dis]) * 100:.1f}% of the time and Kalshi {np.mean((mid[dis] >= 0.5) == y[dis]) * 100:.1f}%.']

    # 2. the dashboard's own recorded calls
    try:
        lc = data.query('advisor.db', "SELECT l.horizon, l.direction, l.mid, o.result FROM live_calls l JOIN outcomes o ON o.ticker = l.ticker WHERE o.result IN ('yes','no')")
        oc = data.query('advisor.db', "SELECT c.direction, c.mid, o.result FROM opening_calls c JOIN outcomes o ON o.ticker = c.ticker WHERE o.result IN ('yes','no')")
        md += ['', '## 2. The dashboard\'s own recorded calls', '']
        rows = []
        for h in sorted(lc['horizon'].unique().to_list(), reverse=True):
            g = lc.filter(pl.col('horizon') == h)
            call = (g['direction'] == 'UP') == (g['result'] == 'yes')
            p2 = g.filter(pl.col('mid').is_not_null() & (pl.col('mid') != 0.5))
            rows.append([f'{h} s left', f'{g.height:,}', pct(call.mean()), f'{p2.height:,}', pct(((p2['direction'] == 'UP') == (p2['result'] == 'yes')).mean()),
                         pct(((p2['mid'] >= 0.5) == (p2['result'] == 'yes')).mean())])
        n, k = oc.height, int(((oc['direction'] == 'UP') == (oc['result'] == 'yes')).sum())
        p2 = oc.filter(pl.col('mid').is_not_null() & (pl.col('mid') != 0.5))
        rows.append(['opening call', f'{n:,}', f'{k / n * 100:.1f}% (± {1.96 * math.sqrt(0.25 / n) * 100:.1f})', f'{p2.height:,}',
                     pct(((p2['direction'] == 'UP') == (p2['result'] == 'yes')).mean()), pct(((p2['mid'] >= 0.5) == (p2['result'] == 'yes')).mean())])
        md += ec.table(['call', 'rounds', 'right', 'rounds with a Kalshi mid', 'call right on those', 'Kalshi favourite right on those'], rows)
    except Exception as e:  # the journal may be locked or absent; the rest of the report does not need it
        md += ['', f'(Dashboard calls not scored: {type(e).__name__}.)']

    # 3. momentum on virtual rounds
    lp = np.log(ar.price)
    t = (close - left - ar.t0).astype(np.int64)
    ok = ~np.isnan(vk) & (sd > 0)
    zc = np.clip(np.where(ok, (m - vk) / np.where(sd > 0, sd, 1), np.nan), -6, 6)
    y = (A >= vk).astype(float)
    feats = []
    for k in (15, 60, 300):
        f = (lp[t] - lp[np.maximum(t - k, 0)]) / np.sqrt(k * ar.var[t])
        f[t - k < 0] = np.nan
        feats.append(np.clip(f, -4, 4))
    good = ok & ~np.isnan(zc) & np.all([~np.isnan(f) for f in feats], axis=0)
    md += ['', '## 3. Does momentum add direction information?', '',
           'Virtual rounds (every minute of the BRTI archive). A logistic model on distance-to-target alone, against the same model plus the last 15 s, 60 s and 5 min of price movement; '
           'fitted on the first half of the calendar, scored on the second. Ranges are 95%, resampling whole hours.', '']
    rows = []
    for name, g in (('7-14 min', left > 420), ('3-7 min', (left > 180) & (left <= 420)), ('1-3 min', (left > 60) & (left <= 180)), ('final minute', left <= 60), ('all', left > 0)):
        tr, te = g & good & train, g & good & test
        xb = lambda s: np.column_stack([zc[s], zc[s] ** 3])
        xa = lambda s: np.column_stack([zc[s], zc[s] ** 3] + [f[s] for f in feats])
        base, aug = LogisticRegression(C=1e6, max_iter=500).fit(xb(tr), y[tr]), LogisticRegression(C=1e6, max_iter=500).fit(xa(tr), y[tr])
        pb, pa, yy = base.predict_proba(xb(te))[:, 1], aug.predict_proba(xa(te))[:, 1], y[te]
        hb, ha = ((pb >= .5) == yy).astype(float), ((pa >= .5) == yy).astype(float)
        lo, hi = ec.block_ci(ha - hb, close[te])
        d = ec.logloss_vec(pb, yy) - ec.logloss_vec(pa, yy)
        dlo, dhi = ec.block_ci(d, close[te])
        rows.append([name, f'{int(te.sum()):,}', f'{hb.mean() * 100:.2f}%', f'{ha.mean() * 100:.2f}%', f'{(ha - hb).mean() * 100:+.2f} ({lo * 100:+.2f} to {hi * 100:+.2f})',
                     f'{d.mean() * 1000:+.2f} ({dlo * 1000:+.2f} to {dhi * 1000:+.2f})'])
    md += ec.table(['time left', 'test samples', 'distance only', 'plus momentum', 'change in hit rate, points', 'log-loss gain x1000'], rows)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'direction.md').write_text('\n'.join(md) + '\n', encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    print('\n'.join(md))


if __name__ == '__main__':
    main()
