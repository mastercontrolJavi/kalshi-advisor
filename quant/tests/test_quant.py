"""Checks for the accounting and math the report depends on. Run: uv run pytest"""
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import polars as pl
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import block_bootstrap, close_from_ticker, taker_fee  # noqa: E402
from research import lots  # noqa: E402

T = "KXBTC15M-26NOV020130-30"


def fill(action, side, count, yes_price, fee=0.0, t=0):
    return {"fill_id": f"{t}", "ticker": T, "order_id": "o", "time": 1793600000000 + t, "created": datetime(2026, 11, 2, 6, 0, t, tzinfo=timezone.utc),
            "action": action, "side": side, "is_taker": True, "count": float(count), "yes_price": yes_price, "no_price": round(1 - yes_price, 4), "fee": fee}


def test_ticker_close_is_eastern_time():
    got = pl.DataFrame({"ticker": [T]}).select(close_from_ticker())["ticker"][0]
    assert got == int(datetime(2026, 11, 2, 6, 30, tzinfo=timezone.utc).timestamp() * 1000)  # 01:30 EST


def test_taker_fee_is_quadratic():
    assert taker_fee(0.5, 100) == pytest.approx(1.75)
    assert taker_fee(0.1) == pytest.approx(0.0063)


def test_a_sell_no_fill_closes_a_yes_position():
    # Kalshi records selling YES at 46¢ as "sell no @ 54¢": the YES lot is closed at 46¢, nothing is left to settle.
    frame, _ = lots(pl.DataFrame([fill("buy", "yes", 10, 0.66, 0.10, 0), fill("sell", "no", 10, 0.46, 0.20, 1)]), {T: "yes"})
    assert frame.height == 1
    row = frame.row(0, named=True)
    assert row["held"] == pytest.approx(0) and row["sold"] == pytest.approx(10)
    assert row["gross"] == pytest.approx(10 * (0.46 - 0.66))
    assert row["fees"] == pytest.approx(0.30)
    assert row["hold_instead"] == pytest.approx(10 * 1.0 - 10 * 0.46 + 0.20)  # holding would have paid $1 each


def test_fills_on_the_held_side_add_to_the_position_and_settle():
    frame, _ = lots(pl.DataFrame([fill("buy", "no", 5, 0.20, 0, 0), fill("buy", "no", 5, 0.30, 0, 1)]), {T: "no"})
    assert frame["held"].sum() == pytest.approx(10)
    assert frame["gross"].sum() == pytest.approx(5 * 0.20 + 5 * 0.30)  # paid 80¢ and 70¢ for $1 payouts


def test_lock_variance_identity():
    # Var of the sum of n future 1-s Brownian values at offsets 1..n is σ²·Σ_ij min(i, j) = σ²·n(n+1)(2n+1)/6.
    for n in (1, 7, 60):
        t = np.arange(1, n + 1)
        assert np.minimum.outer(t, t).sum() == n * (n + 1) * (2 * n + 1) // 6


def test_block_bootstrap_brackets_the_mean():
    rng = np.random.default_rng(1)
    values, groups = rng.normal(1, 1, 3000), np.repeat(np.arange(300), 10)
    lo, hi = block_bootstrap(values, groups)
    assert lo < values.mean() < hi
