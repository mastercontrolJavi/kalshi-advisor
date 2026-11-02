"""Read-only loaders for the advisor's SQLite databases, cached as parquet under quant/cache/.

Every database is opened with ``mode=ro`` and ``query_only`` so this is safe while the engine is running. The first
load of the tick journal runs json_extract over every row (a few minutes); later loads read the parquet cache.
Run ``uv run python data.py --refresh`` to rebuild the cache from the current databases.
"""
from __future__ import annotations

import json
import sqlite3
import sys
import time
from pathlib import Path

import polars as pl

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = Path(__file__).resolve().parent / "cache"
SERIES = "KXBTC15M"


def connect(name: str) -> sqlite3.Connection:
    db = sqlite3.connect(f"file:{(DATA / name).as_posix()}?mode=ro", uri=True, timeout=30)
    db.execute("PRAGMA query_only = ON")
    db.execute("PRAGMA busy_timeout = 30000")
    return db


def query(name: str, sql: str, params: tuple = ()) -> pl.DataFrame:
    db = connect(name)
    try:
        cur = db.execute(sql, params)
        cols = [c[0] for c in cur.description]
        return pl.DataFrame(cur.fetchall(), schema=cols, orient="row", infer_schema_length=None)
    finally:
        db.close()


def _records(kind: str) -> pl.DataFrame:
    """Kalshi's raw portfolio records (fills or settlements), as Kalshi returned them."""
    rows = query("advisor.db", "SELECT context FROM account_raw WHERE type=? ORDER BY time", (kind,))
    return pl.DataFrame([json.loads(c) for c in rows["context"]], infer_schema_length=None)


def _fills() -> pl.DataFrame:
    return (
        _records("fill")
        .filter(pl.col("ticker").str.starts_with(SERIES))
        .select(
            pl.col("fill_id"), pl.col("ticker"), pl.col("order_id"),
            (pl.col("ts").cast(pl.Int64) * 1000).alias("time"),
            pl.col("created_time").str.to_datetime(time_zone="UTC").alias("created"),
            pl.col("action"), pl.col("side"), pl.col("is_taker").cast(pl.Boolean),
            pl.col("count_fp").cast(pl.Float64).alias("count"),
            pl.col("yes_price_dollars").cast(pl.Float64).alias("yes_price"),
            pl.col("no_price_dollars").cast(pl.Float64).alias("no_price"),
            pl.col("fee_cost").cast(pl.Float64).alias("fee"),
        )
        .unique("fill_id")
        .sort("created")
    )


def _settlements() -> pl.DataFrame:
    return (
        _records("settlement")
        .filter(pl.col("ticker").str.starts_with(SERIES))
        .select(
            "ticker", pl.col("market_result").alias("result"),
            pl.col("settled_time").str.to_datetime(time_zone="UTC").alias("settled"),
            pl.col("fee_cost").cast(pl.Float64).alias("settle_fee"),
            pl.col("revenue").cast(pl.Float64).alias("revenue"),
        )
        .unique("ticker")
    )


def _rounds() -> pl.DataFrame:
    return query(
        "history.db",
        "SELECT ticker, open_ts*1000 AS open, close_ts*1000 AS close, strike, settle, result, volume FROM markets "
        "WHERE series=? AND strike>0 AND settle>0 ORDER BY close_ts",
        (SERIES,),
    )


def _candles() -> pl.DataFrame:
    return query(
        "history.db",
        "SELECT c.ticker, c.ts*1000 AS time, c.bid, c.ask, c.price, c.volume FROM candles c JOIN markets m ON m.ticker=c.ticker "
        "WHERE m.series=? ORDER BY c.ts",
        (SERIES,),
    )


def _spot() -> pl.DataFrame:
    return query("history.db", "SELECT ts*1000 AS time, open, high, low, close, volume FROM spot ORDER BY ts")


def _outcomes() -> pl.DataFrame:
    return query(
        "advisor.db",
        "SELECT ticker, time, result, actual_average, proxy_average, basis_error, "
        "json_extract(context,'$.market.floor_strike') AS strike FROM outcomes ORDER BY time",
    )


def _brti_1s() -> pl.DataFrame:
    """Official BRTI at 1 Hz: the historical archive (to Oct 23) plus Kalshi's live 1 Hz channel (from Oct 23)."""
    hist = query("benchmark-history.db", "SELECT time, price FROM values_1s WHERE amended=0")
    live = query(
        "advisor.db",
        "SELECT source_time AS time, price FROM benchmark_ticks WHERE channel='cfbenchmarks_value' AND source_time % 1000 = 0",
    )
    return pl.concat([hist.with_columns(pl.lit("archive").alias("src")), live.with_columns(pl.lit("live").alias("src"))]) \
        .unique("time", keep="first").sort("time")


def _brti_5hz() -> pl.DataFrame:
    return query(
        "advisor.db",
        "SELECT source_time, received_time, price FROM benchmark_ticks WHERE channel='cfbenchmarks_value_5hz' ORDER BY source_time",
    )


TICK_FIELDS = {
    "q": "$.q", "k_confirmed": "$.kConfirmed", "close": "$.close",
    "yes_bid": "$.book.yesBid", "yes_ask": "$.book.yesAsk", "no_bid": "$.book.noBid", "no_ask": "$.book.noAsk",
    "yes_depth": "$.book.yesDepth", "no_depth": "$.book.noDepth", "valid": "$.book.valid",
    "book_yes": "$.book.yes", "book_no": "$.book.no", "book_delay": "$.bookDelay",
    "brti": "$.benchmark.price", "brti_age": "$.benchmark.ageMs", "brti_time": "$.benchmark.sourceTime",
    "imbalance": "$.features.imbalance", "flow30": "$.features.tradeFlow30s", "volume30": "$.features.tradeVolume30s",
    "mom30": "$.features.momentum30s", "mom120": "$.features.momentum120s",
}


def _ticks() -> pl.DataFrame:
    """The engine's 1-s journal. Book ladders stay JSON text; features.py parses the top levels it needs."""
    extract = ", ".join(f"json_extract(context,'{path}') AS {name}" for name, path in TICK_FIELDS.items())
    lo, hi = connect("advisor.db").execute("SELECT min(id), max(id) FROM ticks").fetchone()
    parts, step, started = [], 50_000, time.time()
    for start in range(lo, hi + 1, step):
        parts.append(query(
            "advisor.db",
            f"SELECT id, time, ticker, tau, proxy, k, sigma, p, mid, regime, {extract} FROM ticks WHERE id>=? AND id<?",
            (start, start + step),
        ))
        print(f"[data] ticks {min(start + step, hi) - lo:,}/{hi - lo:,} ({time.time() - started:.0f} s)", file=sys.stderr)
    return pl.concat(parts, how="diagonal_relaxed").sort("time")


BUILDERS = {
    "fills": _fills, "settlements": _settlements, "rounds": _rounds, "candles": _candles, "spot": _spot,
    "outcomes": _outcomes, "brti_1s": _brti_1s, "brti_5hz": _brti_5hz, "ticks": _ticks,
}


def load(name: str, refresh: bool = False) -> pl.DataFrame:
    path = CACHE / f"{name}.parquet"
    if refresh or not path.exists():
        CACHE.mkdir(exist_ok=True)
        started = time.time()
        frame = BUILDERS[name]()
        frame.write_parquet(path)
        print(f"[data] {name}: {frame.height:,} rows in {time.time() - started:.0f} s", file=sys.stderr)
        return frame
    return pl.read_parquet(path)


if __name__ == "__main__":
    refresh = "--refresh" in sys.argv
    for name in BUILDERS:
        frame = load(name, refresh=refresh)
        print(f"{name:12} {frame.height:>10,} rows  {frame.columns[:8]}")
