"""Replay the bot on the engine's recorded 1-second journal, through the same Pricer, decide() and PaperBroker the live
bot uses.

    uv run --project bot --extra research python -m bot backtest          # report -> output/bot-backtest.md

At each journal second the bot sees what the engine saw: the BRTI print it had received (not one that arrived later)
and the Kalshi book of that second. The buy fills at the ask `delay` seconds later (0 = the same second, the best a
program could do; 1 = one second late). One buy a round, held to settlement, taker fee paid, bankroll compounding.

Data: quant/cache (build it with `cd quant; uv run python data.py`), plus journal rows recorded since, read from
data/advisor.db read-only into bot/cache/.
"""
from __future__ import annotations

import math
import random
import sys
from dataclasses import replace
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import polars as pl

from edge.ev_gate import taker_fee

from .config import BotConfig, load_config
from .paper import PaperBroker
from .strategy import Pricer, decide, size

ROOT = Path(__file__).resolve().parent.parent
QCACHE = ROOT / 'quant' / 'cache'
CACHE = Path(__file__).resolve().parent / 'cache'
TICK_COLS = ['id', 'time', 'ticker', 'k', 'close', 'yes_ask', 'no_ask', 'yes_depth', 'no_depth', 'valid', 'book_delay', 'brti_time']


def _extend() -> Tuple[pl.DataFrame, pl.DataFrame, pl.DataFrame]:
    """Journal rows, BRTI prints and outcomes newer than the quant cache, straight from the databases (read-only)."""
    sys.path.insert(0, str(ROOT / 'quant'))
    from data import TICK_FIELDS, query  # quant/data.py
    CACHE.mkdir(exist_ok=True)
    base_id = pl.scan_parquet(QCACHE / 'ticks.parquet').select(pl.col('id').max()).collect().item()
    old = pl.read_parquet(CACHE / 'ticks_new.parquet') if (CACHE / 'ticks_new.parquet').exists() else None
    start = max(base_id, old['id'].max() if old is not None and old.height else 0)
    extract = ', '.join(f"json_extract(context,'{path}') AS {name}" for name, path in TICK_FIELDS.items())
    new = query('advisor.db', f'SELECT id, time, ticker, tau, proxy, k, sigma, p, mid, regime, {extract} FROM ticks WHERE id > ?', (start,))
    if new.height:
        new = new.select([pl.col(c) for c in TICK_COLS])
        old = new if old is None else pl.concat([old, new], how='diagonal_relaxed')
        old.write_parquet(CACHE / 'ticks_new.parquet')
    brti = query('advisor.db', "SELECT source_time AS time, price FROM benchmark_ticks WHERE channel='cfbenchmarks_value' AND source_time % 1000 = 0 AND source_time > ?",
                 (pl.scan_parquet(QCACHE / 'brti_1s.parquet').select(pl.col('time').max()).collect().item(),))
    outcomes = query('advisor.db', 'SELECT ticker, result FROM outcomes')
    return (old if old is not None else pl.DataFrame(schema={c: pl.Int64 for c in TICK_COLS})), brti, outcomes


def load(extend: bool = True):
    ticks = pl.read_parquet(QCACHE / 'ticks.parquet', columns=TICK_COLS)
    brti = pl.read_parquet(QCACHE / 'brti_1s.parquet').select('time', 'price')
    outcomes = pl.read_parquet(QCACHE / 'outcomes.parquet').select('ticker', 'result')
    if extend:
        try:
            t2, b2, outcomes = _extend()
            if t2.height:
                ticks = pl.concat([ticks, t2.select(TICK_COLS)], how='diagonal_relaxed')
            brti = pl.concat([brti, b2.select('time', 'price')], how='diagonal_relaxed')
        except Exception as e:  # the cache alone is still a valid replay
            print(f'[backtest] could not read newer rows from data/advisor.db ({e!r}); using the quant cache only', file=sys.stderr)
    ticks = (ticks.filter(pl.col('brti_time').is_not_null() & pl.col('close').is_not_null() & (pl.col('k') > 0))
             .join(outcomes.unique('ticker'), on='ticker', how='inner').unique('id').sort('time'))
    brti = brti.unique('time', keep='first').sort('time')
    return ticks, brti


def replay(cfg: BotConfig, ticks: pl.DataFrame, brti: pl.DataFrame, delay: int) -> List[dict]:
    """One pass over the journal. Returns one dict per filled round."""
    pricer, broker = Pricer(cfg), PaperBroker(':memory:', cfg.START_BANKROLL, now=0.0)
    b_ts = (brti['time'].to_numpy() // 1000).astype(np.int64).tolist()
    b_px = brti['price'].to_numpy().astype(float).tolist()
    bi, nb = 0, len(b_ts)
    later: Dict[Tuple[str, int], tuple] = {}
    if delay:
        for tk, tm, ya, na, yd, nd, valid, bd in ticks.select('ticker', 'time', 'yes_ask', 'no_ask', 'yes_depth', 'no_depth', 'valid', 'book_delay').iter_rows():
            later[(tk, tm // 1000)] = (ya, na, yd, nd, valid, bd)
    trades: List[dict] = []
    done: set = set()
    result_of: Dict[str, str] = {}
    open_ticker: Optional[str] = None
    for tk, tm, k, close, ya, na, yd, nd, valid, bd, bt, result in ticks.select(
            'ticker', 'time', 'k', 'close', 'yes_ask', 'no_ask', 'yes_depth', 'no_depth', 'valid', 'book_delay', 'brti_time', 'result').iter_rows():
        if open_ticker is not None and tk != open_ticker:
            _settle(broker, trades, open_ticker, result_of[open_ticker], tm / 1000)
            open_ticker = None
        result_of[tk] = result
        upto = bt // 1000
        while bi < nb and b_ts[bi] <= upto:
            pricer.on_print(b_ts[bi], b_px[bi])
            bi += 1
        if tk in done or not valid or (bd or 0) > cfg.MAX_BOOK_DELAY_MS:
            continue
        if pricer.last is None or pricer.last[0] != upto:  # the engine's print is not in the archive: nothing to price on
            continue
        priced = pricer.fair(k, close // 1000)
        if priced is None:
            continue
        fv, left = priced
        intent, _ = decide(cfg, fv, left, ya, na, broker.equity)
        if intent is None:
            continue
        if delay:
            row = later.get((tk, tm // 1000 + delay))
            if row is None or not row[4] or (row[5] or 0) > cfg.MAX_BOOK_DELAY_MS or tm // 1000 + delay >= close // 1000:
                continue
            ask, depth = (row[0], row[2]) if intent.side == 'yes' else (row[1], row[3])
        else:
            ask, depth = (ya, yd) if intent.side == 'yes' else (na, nd)
        if ask is None:
            continue
        fill = broker.buy(tk, intent.side, intent.limit, intent.contracts, [(ask, depth or 0.0)], tm / 1000, q=intent.q, edge=intent.edge,
                          p_yes=intent.p_yes, secs_left=intent.secs_left)
        if fill is None:
            continue  # the ask moved above the limit: missed, try again on a later second
        done.add(tk)
        open_ticker = tk
        trades.append({'ticker': tk, 'time': tm / 1000, 'side': fill.side, 'contracts': fill.contracts, 'price': fill.price, 'fee': fill.fee,
                       'q': intent.q, 'edge': intent.edge, 'secs_left': intent.secs_left, 'win': fill.side == result, 'equity_before': broker.equity})
    if open_ticker is not None:
        _settle(broker, trades, open_ticker, result_of[open_ticker], ticks['time'][-1] / 1000)
    return trades


def _settle(broker: PaperBroker, trades: List[dict], ticker: str, result: str, ts: float) -> None:
    pnl = broker.settle(ticker, result, ts)
    trades[-1]['pnl'] = pnl
    trades[-1]['equity'] = broker.equity


def per_contract(trades: List[dict]) -> np.ndarray:
    return np.array([(1.0 if t['win'] else 0.0) - t['price'] - t['fee'] / t['contracts'] for t in trades])


def project(cfg: BotConfig, trades: List[dict], rounds_per_day: float, days: int, sims: int = 4000, seed: int = 7) -> dict:
    """Resample the replay's trades (ask, model probability, won or lost) with the bot's own sizing and compounding:
    how often the bankroll reaches the target before going bust within `days` of trading at the replay's pace."""
    rng = random.Random(seed)
    pool = [(t['price'], t['q'], t['win']) for t in trades]
    n = int(round(rounds_per_day * days))
    hit = bust = 0
    finals = []
    for _ in range(sims):
        eq, reached = cfg.START_BANKROLL, False
        for _ in range(n):
            ask, q, win = pool[rng.randrange(len(pool))]
            c = size(cfg, q, ask, eq)
            if c <= 0 or eq < cfg.BUST:
                continue
            eq += c * ((1.0 if win else 0.0) - ask - taker_fee(ask))
            if eq >= cfg.TARGET:
                reached = True
                break
        hit += reached
        bust += (not reached) and eq < cfg.BUST + 1.0
        finals.append(eq)
    finals.sort()
    return {'days': days, 'trades': n, 'p_target': hit / sims, 'p_bust': bust / sims, 'median': finals[len(finals) // 2], 'p10': finals[len(finals) // 10],
            'p90': finals[9 * len(finals) // 10]}


def main(argv: Optional[List[str]] = None) -> None:
    argv = argv or []
    cfg = load_config()
    ticks, brti = load(extend='--no-extend' not in argv)
    n_rounds = ticks['ticker'].n_unique()
    span_days = (ticks['time'].max() - ticks['time'].min()) / 86_400_000
    recorded_days = ticks.height / 86_400
    md = ['# Bot replay on the recorded journal', '',
          f"{n_rounds:,} settled rounds with a BRTI print in the journal, {ticks.height:,} seconds ({recorded_days:.1f} days recorded over {span_days:.0f} calendar days). "
          f"Start ${cfg.START_BANKROLL:.0f}, goal ${cfg.TARGET:.0f}. Rule: edge after fee >= {cfg.MIN_EDGE * 100:.0f}c, ask {cfg.MIN_ASK * 100:.0f}-{cfg.MAX_ASK * 100:.0f}c"
          + (f" outside {cfg.MID_BAND_LOW * 100:.0f}-{cfg.MID_BAND_HIGH * 100:.0f}c" if cfg.BLOCK_MID_BAND else '')
          + f", {cfg.MIN_SECS_LEFT:.0f}-{cfg.MAX_SECS_LEFT:.0f} s left; size {cfg.KELLY_FRAC:g} Kelly, at most {cfg.MAX_RISK_FRAC * 100:.0f}% of the bankroll a round.", '',
          'The time window and the price bands were chosen on the first 524 of these rounds, so their results there flatter the rule. '
          'Fill delay 0 s is the best case for a program; the live paper bot (fills 0.3 s after the decision) is the real test.', '',
          '| fill delay | rounds traded | won | avg price | net per contract | 95% range | first half / second half | final bankroll | lowest | highest |',
          '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
    results = {}
    for delay in (0, 1, 2):
        trades = replay(cfg, ticks, brti, delay)
        results[delay] = trades
        if len(trades) < 2:
            md.append(f'| {delay} s | {len(trades)} | | | | | | | | |')
            continue
        x = per_contract(trades)
        h = 1.96 * x.std(ddof=1) / math.sqrt(len(x))
        half = len(x) // 2
        eq = [t['equity'] for t in trades]
        md.append(f"| {delay} s | {len(trades):,} | {np.mean([t['win'] for t in trades]) * 100:.1f}% | {np.mean([t['price'] for t in trades]) * 100:.1f}c | "
                  f"**{x.mean() * 100:+.2f}c** | {(x.mean() - h) * 100:+.2f}..{(x.mean() + h) * 100:+.2f}c | {x[:half].mean() * 100:+.2f}c / {x[half:].mean() * 100:+.2f}c | "
                  f"${eq[-1]:.2f} | ${min(eq):.2f} | ${max(eq):.2f} |")
    md += ['', '## Chance of turning the start into the goal', '',
           'The replay\'s trades resampled 4,000 times with the bot\'s sizing and compounding, at the replay\'s pace of trades per recorded day. '
           'This assumes the future looks like the replay at that fill delay, which is the optimistic reading for 0 s.', '',
           '| fill delay | horizon | trades | reaches goal | ends near bust | median bankroll | 10th-90th percentile |', '|---|---:|---:|---:|---:|---:|---:|']
    for delay, trades in results.items():
        if len(trades) < 20:
            continue
        pace = len(trades) / recorded_days
        for days in (7, 30, 90):
            p = project(cfg, trades, pace, days)
            md.append(f"| {delay} s | {days} days | {p['trades']:,} | {p['p_target'] * 100:.1f}% | {p['p_bust'] * 100:.1f}% | ${p['median']:.2f} | ${p['p10']:.2f}..${p['p90']:.2f} |")
    out = ROOT / 'output' / 'bot-backtest.md'
    out.parent.mkdir(exist_ok=True)
    out.write_text('\n'.join(md) + '\n', encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    print('\n'.join(md))
    print(f'\nwritten to {out}')


if __name__ == '__main__':
    main(sys.argv[1:])
