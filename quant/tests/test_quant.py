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


def test_flow_seconds_use_only_bars_that_finished_before_the_second(tmp_path, monkeypatch):
    import sqlite3
    import data
    import flow
    db = sqlite3.connect(tmp_path / "flow.db")
    cols = ["t"] + [f"{v}_{f}" for v in ("cb", "bn", "by") for f in ("last", "buy", "sell", "n", "lag")] + ["bn_bid", "bn_ask", "bn_mark", "bn_index", "bn_funding"]
    db.execute(f"CREATE TABLE flow_bars({', '.join(cols)})")
    t0 = 1_793_600_000_000
    for i in range(4 * 400):  # 400 s of bars: 1 BTC taker buy on Coinbase per bar, perp 1 BTC sell; perp jumps at the end
        t = t0 + i * 250
        row = {"t": t, "cb_last": 77000.0, "cb_buy": 1.0, "cb_sell": 0.0, "cb_n": 1, "bn_last": 77100.0 + (30 if i >= 4 * 399 else 0), "bn_buy": 0.0, "bn_sell": 1.0, "bn_n": 1}
        db.execute(f"INSERT INTO flow_bars({', '.join(row)}) VALUES({', '.join('?' * len(row))})", list(row.values()))
    db.commit(); db.close()
    monkeypatch.setattr(data, "DATA", tmp_path); monkeypatch.setattr(data, "CACHE", tmp_path / "cache"); monkeypatch.delenv("FLOW_DB", raising=False)
    s = flow.seconds()
    at = lambda sec: s.filter(pl.col("time") == t0 + sec * 1000).row(0, named=True)
    assert at(59)["cvd_spot60"] is None and at(60)["cvd_spot60"] == pytest.approx(240)  # second 60 holds bars [0 s, 60 s)
    assert at(60)["ratio_spot60"] == 1 and at(60)["cvd_perp60"] == pytest.approx(-240)
    assert at(399)["lead1"] == pytest.approx(0) and at(400)["lead1"] == pytest.approx(30)  # the jump lands in the bars of [399 s, 400 s)
    assert at(400)["votes"] == 1 + -1 + 1  # spot buys, perp sells, perp impulse up


def test_flow_db_follows_flow_db_like_the_engine(tmp_path, monkeypatch):
    import data
    monkeypatch.setattr(data, "DATA", tmp_path / "data"); monkeypatch.setattr(data, "ROOT", tmp_path)
    monkeypatch.delenv("FLOW_DB", raising=False)
    assert data.flow_db() == tmp_path / "data" / "flow.db"
    (tmp_path / ".env.local").write_text("KALSHI_KEY_ID=x\nFLOW_DB=./data/other-flow.db\n", encoding="utf-8")
    assert data.flow_db() == (tmp_path / "data" / "other-flow.db").resolve()  # .env.local, relative to the repo root
    monkeypatch.setenv("FLOW_DB", str(tmp_path / "elsewhere.db"))
    assert data.flow_db() == tmp_path / "elsewhere.db"  # the environment wins, as with dotenv
