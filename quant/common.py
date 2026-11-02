"""Shared fee, time and metric helpers for the quant research scripts."""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import polars as pl

OUT = Path(__file__).resolve().parent.parent / "output"
QUANT_OUT = OUT / "quant"
CACHE_PANEL = Path(__file__).resolve().parent / "cache" / "panel.parquet"
TAKER_RATE = 0.07    # Kalshi quadratic taker fee: ceil-ish(0.07 * C * P * (1 - P)); verified on all 1,351 of your taker fills.
MAKER_RATE = 0.0     # Your 2 maker fills paid $0, matching the engine's fee schedule for this series (makerMultiplier 0).
MAKER_RATE_STRESS = 0.0175  # Kalshi's standard maker rate, used as a stress scenario in case the series changes.


def taker_fee(price, count: float = 1.0):
    """Fee in dollars for `count` contracts at `price` (dollars), before Kalshi's sub-cent rounding."""
    return TAKER_RATE * count * price * (1 - price)


def maker_fee(price, count: float = 1.0, rate: float = MAKER_RATE):
    return rate * count * price * (1 - price)


def close_from_ticker(col: str = "ticker") -> pl.Expr:
    """KXBTC15M-26NOV020130-30 closes 2026-11-02 01:30 America/New_York. Returns epoch ms."""
    return (
        pl.col(col).str.extract(r"-(\d{2}[A-Z]{3}\d{6})-", 1)
        .str.to_titlecase()
        .str.strptime(pl.Datetime("ms"), "%y%b%d%H%M")
        .dt.replace_time_zone("America/New_York", ambiguous="earliest")
        .dt.epoch("ms")
    )


def pt_hour(col: str = "time") -> pl.Expr:
    return pl.from_epoch(pl.col(col), time_unit="ms").dt.replace_time_zone("UTC").dt.convert_time_zone("America/Los_Angeles").dt.hour()


TAU_EDGES = [0, 60, 120, 300, 600, 900]


def tau_bucket(col: str = "tau") -> pl.Expr:
    return pl.col(col).cut(TAU_EDGES[1:-1], labels=["0-60s", "60-120s", "120-300s", "300-600s", "600-900s"], left_closed=True)


def price_bucket(col: str = "price") -> pl.Expr:
    return pl.col(col).cut([0.2, 0.4, 0.6, 0.8], labels=["<20c", "20-40c", "40-60c", "60-80c", ">=80c"], left_closed=True)


def logit(p):
    p = np.clip(np.asarray(p, dtype=float), 1e-4, 1 - 1e-4)
    return np.log(p / (1 - p))


def brier(y, p):
    return float(np.mean((np.asarray(p) - np.asarray(y)) ** 2))


def log_loss(y, p):
    p = np.clip(np.asarray(p, dtype=float), 1e-4, 1 - 1e-4)
    y = np.asarray(y, dtype=float)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def block_bootstrap(values: np.ndarray, groups: np.ndarray, stat=np.mean, n: int = 2000, seed: int = 7):
    """95% interval of `stat` resampling whole groups (rounds), since seconds inside a round are not independent."""
    rng = np.random.default_rng(seed)
    uniq, inverse = np.unique(groups, return_inverse=True)
    if len(uniq) < 2:
        return (math.nan, math.nan)
    sums = np.bincount(inverse, weights=values, minlength=len(uniq))
    counts = np.bincount(inverse, minlength=len(uniq))
    draws = rng.integers(0, len(uniq), size=(n, len(uniq)))
    if stat is np.sum:
        est = sums[draws].sum(axis=1)
    else:
        est = sums[draws].sum(axis=1) / np.maximum(counts[draws].sum(axis=1), 1)
    return (float(np.percentile(est, 2.5)), float(np.percentile(est, 97.5)))


def write_json(name: str, payload) -> Path:
    QUANT_OUT.mkdir(parents=True, exist_ok=True)
    path = QUANT_OUT / name
    path.write_text(json.dumps(payload, indent=2, default=_jsonable) + "\n", encoding="utf-8")
    return path


def _jsonable(x):
    if isinstance(x, (np.floating, np.integer)):
        return x.item()
    if isinstance(x, np.ndarray):
        return x.tolist()
    return str(x)


def md_table(frame: pl.DataFrame, floats: int = 2) -> str:
    """A polars frame as a GitHub table."""
    def cell(v):
        if v is None:
            return "—"
        if isinstance(v, float):
            return "—" if math.isnan(v) else f"{v:,.{floats}f}"
        if isinstance(v, int):
            return f"{v:,}"
        return str(v)
    head = "| " + " | ".join(frame.columns) + " |"
    rule = "|" + "|".join("---" if frame[c].dtype in (pl.String, pl.Categorical, pl.Boolean) else "---:" for c in frame.columns) + "|"
    rows = ["| " + " | ".join(cell(v) for v in row) + " |" for row in frame.iter_rows()]
    return "\n".join([head, rule, *rows])
