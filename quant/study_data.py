"""Data for vol_study.py and knife_replay.py: the quant cache (built by data.py) extended to the latest journal row.

    cd quant; uv run python study_data.py      # appends newer rows to cache/study_*.parquet (read-only on data/*.db)

The cache made by data.py is left as it is. Newer journal seconds, BRTI prints and outcomes are read from
data/advisor.db (mode=ro) into separate study_* files, incrementally, so a re-run only reads what was added.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import numpy as np
import polars as pl

from data import CACHE, TICK_FIELDS, connect, query

TICK_COLS = ['id', 'time', 'ticker', 'tau', 'k', 'mid', 'close', 'yes_bid', 'yes_ask', 'no_bid', 'no_ask', 'yes_depth', 'no_depth', 'valid', 'book_delay', 'brti_time']
SCHEMA = {'id': pl.Int64, 'time': pl.Int64, 'ticker': pl.Utf8, 'tau': pl.Float64, 'k': pl.Float64, 'mid': pl.Float64, 'close': pl.Int64, 'yes_bid': pl.Float64,
          'yes_ask': pl.Float64, 'no_bid': pl.Float64, 'no_ask': pl.Float64, 'yes_depth': pl.Float64, 'no_depth': pl.Float64, 'valid': pl.Int64,
          'book_delay': pl.Float64, 'brti_time': pl.Int64}


def _cast(frame: pl.DataFrame) -> pl.DataFrame:
    return frame.select([pl.col(c).cast(SCHEMA[c], strict=False) for c in TICK_COLS])


def refresh() -> None:
    base = pl.scan_parquet(CACHE / 'ticks.parquet').select(pl.col('id').max()).collect().item()
    path = CACHE / 'study_ticks_new.parquet'
    old = pl.read_parquet(path) if path.exists() else None
    start = max(base, old['id'].max() if old is not None and old.height else 0)
    hi = connect('advisor.db').execute('SELECT max(id) FROM ticks').fetchone()[0]
    fields = {k: v for k, v in TICK_FIELDS.items() if k in TICK_COLS}
    extract = ', '.join(f"json_extract(context,'{p}') AS {n}" for n, p in fields.items())
    parts, step, began = ([] if old is None else [old]), 50_000, time.time()
    for a in range(start + 1, hi + 1, step):
        parts.append(_cast(query('advisor.db', f'SELECT id, time, ticker, tau, k, mid, {extract} FROM ticks WHERE id>=? AND id<?', (a, a + step))))
        print(f'[study_data] ticks {min(a + step, hi) - start:,}/{hi - start:,} ({time.time() - began:.0f} s)', file=sys.stderr)
    if parts:
        pl.concat(parts).unique('id').sort('id').write_parquet(path)
    last = pl.scan_parquet(CACHE / 'brti_1s.parquet').select(pl.col('time').max()).collect().item()
    query('advisor.db', "SELECT source_time AS time, received_time, price FROM benchmark_ticks WHERE channel='cfbenchmarks_value' AND source_time % 1000 = 0 AND source_time > ?",
          (last,)).write_parquet(CACHE / 'study_brti_new.parquet')
    query('advisor.db', "SELECT ticker, time, result, actual_average, json_extract(context,'$.market.floor_strike') AS strike FROM outcomes ORDER BY time").write_parquet(CACHE / 'study_outcomes.parquet')


def ticks() -> pl.DataFrame:
    """Every journal second with a strike, a close time and the BRTI print the engine had, joined to the round's result."""
    t = _cast(pl.read_parquet(CACHE / 'ticks.parquet', columns=TICK_COLS))
    new = CACHE / 'study_ticks_new.parquet'
    if new.exists():
        t = pl.concat([t, pl.read_parquet(new)]).unique('id')
    out = pl.read_parquet(CACHE / 'study_outcomes.parquet').select('ticker', 'result').unique('ticker')
    return (t.filter(pl.col('brti_time').is_not_null() & pl.col('close').is_not_null() & (pl.col('k') > 0))
            .join(out, on='ticker', how='inner').sort('time'))


def brti() -> pl.DataFrame:
    b = pl.read_parquet(CACHE / 'brti_1s.parquet').select('time', 'price')
    new = CACHE / 'study_brti_new.parquet'
    if new.exists():
        b = pl.concat([b, pl.read_parquet(new).select('time', 'price')])
    return b.unique('time', keep='first').sort('time')


class Series:
    """BRTI on a dense one-second grid (NaN where a print is missing), with EWMA variances of 1-s log returns at several
    half-lives, each exactly as edge/vol.py computes its one (a gap restarts the return, the value carries)."""

    def __init__(self, halflives=(300, 900, 3600, 14400)):
        b = brti()
        ts = (b['time'].to_numpy() // 1000).astype(np.int64)
        px = b['price'].to_numpy().astype(float)
        self.t0, self.t1 = int(ts[0]), int(ts[-1])
        n = self.t1 - self.t0 + 1
        self.price = np.full(n, np.nan)
        self.price[ts - self.t0] = px
        lp = np.log(self.price)
        r2 = np.full(n, np.nan)
        r2[1:] = (lp[1:] - lp[:-1]) ** 2            # NaN unless both seconds have a print
        self.r2 = r2
        self.count = np.cumsum(~np.isnan(r2))        # 1-s returns seen so far (edge/vol.py's `count`)
        self.var = {}
        for hl in halflives:
            alpha = 1.0 - 0.5 ** (1.0 / hl)
            v, cur = np.full(n, np.nan), np.nan
            for i in range(n):
                x = r2[i]
                if x == x:
                    cur = x if cur != cur else (1 - alpha) * cur + alpha * x
                v[i] = cur
            self.var[hl] = v
        ok = ~np.isnan(self.price)
        self.ok = ok
        self._cs = np.concatenate([[0.0], np.cumsum(np.where(ok, self.price, 0.0))])
        self._cc = np.concatenate([[0], np.cumsum(ok.astype(np.int64))])
        self._r2s = np.concatenate([[0.0], np.cumsum(np.where(np.isnan(r2), 0.0, r2))])
        self._r2c = np.concatenate([[0], np.cumsum((~np.isnan(r2)).astype(np.int64))])
        self.n = n

    def window(self, a, b):
        """Sum and count of prints in seconds [a, b) (dense offsets)."""
        return self._cs[b] - self._cs[a], self._cc[b] - self._cc[a]

    def realised(self, a, b):
        """Mean squared 1-s log return over offsets (a, b], and how many returns that is."""
        n = self._r2c[b + 1] - self._r2c[a + 1]
        return (self._r2s[b + 1] - self._r2s[a + 1]) / np.maximum(n, 1), n


if __name__ == '__main__':
    refresh()
    t = ticks()
    print(f"ticks {t.height:,} rows, {t['ticker'].n_unique():,} settled rounds, {t['time'].min()} .. {t['time'].max()}; brti {brti().height:,} prints")
