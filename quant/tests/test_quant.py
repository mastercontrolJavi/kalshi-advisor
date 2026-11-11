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
    assert (at(400)["spot_vote"], at(400)["perp_vote"], at(400)["impulse"]) == (1, -1, 1)
    assert at(400)["last_impulse"] == 1 and at(400)["last_impulse_at"] == t0 + 400_000 and at(399)["last_impulse"] is None


def test_live_call_flips_only_past_the_band_and_resets_each_round():
    import flow
    f = pl.DataFrame({"ticker": ["A"] * 5 + ["B"] * 2, "q": [.55, .49, .47, .51, .53, None, .45]})
    assert flow.live_direction(f).to_list() == [1, 1, -1, -1, 1, None, -1]


def test_maker_price_matches_the_card():
    import flow
    f = pl.DataFrame({"bid": [.40, .44, None, None], "ask": [.45, .45, .45, .01]}, schema={"bid": pl.Float64, "ask": pl.Float64})
    got = f.select(flow.maker_price(pl.col("bid"), pl.col("ask")).alias("m"))["m"].to_list()
    assert got[:3] == pytest.approx([.41, .44, .44]) and got[3] is None  # a tick up; join the bid; under the ask; nothing below 1¢


def _card_round(n=10, **over):
    t0 = 1_793_600_000_000
    base = {"ticker": ["R"] * n, "time": [t0 + i * 1000 for i in range(n)], "tau": [600 - i for i in range(n)],
            "q": [.6] * n, "yes_bid": [.55] * n, "yes_ask": [.57] * n, "y": [1] * n,
            "pulse_ok": [True] * n, "spot_vote": [1] * n, "perp_vote": [1] * n, "impulse": [0] * n,
            "last_impulse": [1] * n, "last_impulse_at": [t0] * n}
    return pl.DataFrame(base | over), t0


def test_strong_buy_needs_every_check_and_an_impulse_within_5_s():
    import flow
    frame, t0 = _card_round()
    s = flow.master_stages(frame, pl.DataFrame({"ticker": ["R"], "time": [t0], "direction": ["UP"]}))
    assert s["strong"].to_list() == [True] * 6 + [False] * 4  # the impulse at t0 counts through t0 + 5 s
    assert s["taker_ev"][0] == pytest.approx(1 - .57 - taker_fee(.57))
    against = flow.master_stages(frame, pl.DataFrame({"ticker": ["R"], "time": [t0], "direction": ["DOWN"]}))
    assert not against["agree"].any() and not against["strong"].any()  # opening call disagrees
    fighting, _ = _card_round(perp_vote=[-1] * 10)
    assert not flow.master_stages(fighting, pl.DataFrame({"ticker": [], "time": [], "direction": []}, schema={"ticker": pl.String, "time": pl.Int64, "direction": pl.String}))["flow"].any()


def test_entries_close_in_the_final_minute_and_makers_fill_only_on_a_trade_through():
    import flow
    no_open = pl.DataFrame({"ticker": [], "time": [], "direction": []}, schema={"ticker": pl.String, "time": pl.Int64, "direction": pl.String})
    late, _ = _card_round(tau=[61, 60, 59, 58, 57, 56, 55, 54, 53, 52])
    assert flow.master_stages(late, no_open)["live"].to_list() == [True, True] + [False] * 8
    # Maker rests at 56¢ (a cent above the 55¢ bid); the ask touches 56¢ (no fill), then trades at 55¢ (fill).
    asks = [.57, .57, .56, .57, .55, .57, .57, .57, .57, .57]
    filled = flow.master_stages(_card_round(yes_ask=asks, yes_bid=[.55, .55, .54, .55, .54, .55, .55, .55, .55, .55])[0], no_open)
    assert filled["maker"][0] == pytest.approx(.56) and filled["maker_filled"][0] and not filled["maker_filled"][4]


def test_live_call_state_is_carried_through_seconds_the_panel_drops():
    # The engine flips DOWN at a tick the panel drops (stale book); back inside the band the call must stay DOWN.
    import flow
    no_open = pl.DataFrame({"ticker": [], "time": [], "direction": []}, schema={"ticker": pl.String, "time": pl.Int64, "direction": pl.String})
    frame, t0 = _card_round(4, q=[.6, .45, .49, .51])
    panel = frame.filter(pl.col("time") != t0 + 1000)
    assert flow.master_stages(panel, no_open)["live_dir"].to_list() == [1, 1, 1]  # the filtered view alone misses the flip
    assert flow.master_stages(panel, no_open, frame.select("ticker", "time", "q"))["live_dir"].to_list() == [1, -1, -1]


def test_no_flow_confirmed_without_a_current_healthy_pulse():
    import flow
    frame, t0 = _card_round(pulse_ok=[True] * 3 + [False] * 7)
    s = flow.master_stages(frame, pl.DataFrame({"ticker": ["R"], "time": [t0], "direction": ["UP"]}))
    assert s["flow"].to_list() == [True] * 3 + [False] * 7 and s["strong"].to_list() == [True] * 3 + [False] * 7


def test_master_summary_counts_signals_not_seconds():
    import flow
    frame, t0 = _card_round()
    table = flow.master_summary(flow.master_stages(frame, pl.DataFrame({"ticker": ["R"], "time": [t0], "direction": ["UP"]})))
    strong = table.filter(pl.col("stage") == flow.STAGES["strong"]).row(0, named=True)
    assert strong["signals"] == 1 and strong["seconds on"] == 6 and strong["win %"] == 100


def _flow_seconds(tmp_path, monkeypatch, rows):
    import sqlite3
    import data
    import flow
    db = sqlite3.connect(tmp_path / "flow.db")
    cols = ["t"] + [f"{v}_{f}" for v in ("cb", "bn", "by") for f in ("last", "buy", "sell", "n", "lag")] + ["bn_bid", "bn_ask", "bn_mark", "bn_index", "bn_funding"]
    db.execute(f"CREATE TABLE flow_bars({', '.join(cols)})")
    for row in rows:
        db.execute(f"INSERT INTO flow_bars({', '.join(row)}) VALUES({', '.join('?' * len(row))})", list(row.values()))
    db.commit(); db.close()
    monkeypatch.setattr(data, "DATA", tmp_path); monkeypatch.setattr(data, "CACHE", tmp_path / "cache"); monkeypatch.delenv("FLOW_DB", raising=False)
    return flow.seconds()


T0 = 1_793_600_000_000
CB = {"cb_last": 77000.0, "cb_buy": 1.0, "cb_sell": 0.0, "cb_n": 1}


def test_a_worker_stall_or_a_silent_perp_gives_no_usable_pulse(tmp_path, monkeypatch):
    # Bars for [0 s, 400 s), nothing at all for [400 s, 403 s) (the worker stalled), then Coinbase alone (the perps went quiet).
    rows = [{"t": T0 + i * 250, **CB, "bn_last": 77100.0, "bn_buy": 1.0, "bn_sell": 0.0, "bn_n": 1} for i in range(4 * 400)]
    rows += [{"t": T0 + i * 250, **CB} for i in range(4 * 403, 4 * 420)]
    s = _flow_seconds(tmp_path, monkeypatch, rows)
    at = lambda sec: s.filter(pl.col("time") == T0 + sec * 1000).row(0, named=True)
    assert at(400)["pulse_ok"] and (at(400)["spot_vote"], at(400)["perp_vote"]) == (1, 1)
    for sec in (401, 402, 403):  # 95% of the last 60 s of bars is still there, so the old replay kept voting here
        assert not at(sec)["pulse_ok"] and at(sec)["spot_vote"] is None and at(sec)["perp_vote"] is None
    assert at(404)["bars"] > 0 and not at(404)["bn_alive"] and not at(404)["pulse_ok"]  # Binance silent > 3 s
    assert at(410)["impulse"] is None


def test_only_healthy_perp_venues_vote(tmp_path, monkeypatch):
    # Binance buys until 397 s then goes silent; Bybit sells from 300 s. At 400 s only Bybit is healthy, so the perp vote is
    # a sell, though Binance's buys are still inside the 60 s window (counting them would make it a 49% share: no vote).
    rows = []
    for i in range(4 * 400):
        r = {"t": T0 + i * 250, **CB}
        if i < 4 * 397:
            r |= {"bn_last": 77100.0, "bn_buy": 1.0, "bn_sell": 0.0, "bn_n": 1}
        if i >= 4 * 300:
            r |= {"by_last": 77100.0, "by_buy": 0.0, "by_sell": 1.0, "by_n": 1}
        rows.append(r)
    at400 = _flow_seconds(tmp_path, monkeypatch, rows).filter(pl.col("time") == T0 + 400_000).row(0, named=True)
    assert not at400["bn_alive"] and at400["by_alive"] and at400["pulse_ok"]
    assert at400["perp_vote"] == -1


def test_flow_db_follows_flow_db_like_the_engine(tmp_path, monkeypatch):
    import data
    monkeypatch.setattr(data, "DATA", tmp_path / "data"); monkeypatch.setattr(data, "ROOT", tmp_path)
    monkeypatch.delenv("FLOW_DB", raising=False)
    assert data.flow_db() == tmp_path / "data" / "flow.db"
    (tmp_path / ".env.local").write_text("KALSHI_KEY_ID=x\nFLOW_DB=./data/other-flow.db\n", encoding="utf-8")
    assert data.flow_db() == (tmp_path / "data" / "other-flow.db").resolve()  # .env.local, relative to the repo root
    monkeypatch.setenv("FLOW_DB", str(tmp_path / "elsewhere.db"))
    assert data.flow_db() == tmp_path / "elsewhere.db"  # the environment wins, as with dotenv


# ---- maker_study.py: resting-order fills against the trade tape
CLOSE = 1_800_000_000_000


def _book(overrides=None):
    """A flat book, YES 50c bid / 51c ask with 100 contracts resting at each best price, for every second of a round."""
    import json
    rows = []
    for tau in range(0, 901):
        r = {"tau": float(tau), "yes_bid": 0.50, "yes_ask": 0.51, "valid": 1, "book_delay": 0,
             "book_yes": json.dumps([[0.50, 100.0], [0.49, 500.0]]), "book_no": json.dumps([[0.49, 100.0], [0.48, 500.0]])}
        r.update((overrides or {}).get(tau, {}))
        rows.append(r)
    return pl.DataFrame(rows)


def _tape(*trades):
    """(ms after the 840-s-left snapshot, yes_price, taker_side, count)"""
    t0 = CLOSE - 840_000
    return pl.DataFrame([(t0 + ms, px, side, float(n)) for ms, px, side, n in trades],
                        schema={"time": pl.Int64, "yes_price": pl.Float64, "taker_side": pl.String, "count": pl.Float64}, orient="row").sort("time")


def _order(rows, side, tau=840):
    return next(r for r in rows if r["tau"] == tau and r["side"] == side)


def test_a_print_through_the_bid_fills_it_and_only_on_that_side():
    from maker_study import simulate_round
    rows = simulate_round("T", CLOSE, True, _book(), _tape((5000, 0.49, "no", 5)), {})
    yes, no = _order(rows, "yes"), _order(rows, "no")
    assert yes["limit"] == 0.50 and yes["posted"]
    assert yes["t_through"] == yes["t_queue"] == yes["t_queue+"] == CLOSE - 840_000 + 5000
    assert yes["m60_through"] - yes["limit"] == pytest.approx(0.005)  # the mid is 50.5c a minute later
    assert np.isnan(no["t_queue+"])  # nobody bought YES, so the NO bid (a YES offer at 51c) never traded


def test_the_queue_ahead_must_trade_first_and_early_prints_do_not_count():
    from maker_study import simulate_round
    tape = _tape((500, 0.50, "no", 500),   # before the order is live (1 s after the snapshot): ignored
                 (2000, 0.50, "no", 60), (4000, 0.50, "no", 60))  # 120 at our price: more than the 100 ahead of us
    yes = _order(simulate_round("T", CLOSE, True, _book(), tape, {}), "yes")
    assert np.isnan(yes["t_through"])
    assert yes["t_queue"] == CLOSE - 840_000 + 4000


def test_queue_plus_moves_up_when_the_size_ahead_is_cancelled():
    from maker_study import simulate_round
    import json
    thin = {tau: {"book_yes": json.dumps([[0.50, 10.0], [0.49, 500.0]])} for tau in range(700, 839)}  # from 2 s after placement
    yes = _order(simulate_round("T", CLOSE, True, _book(thin), _tape((3500, 0.50, "no", 20)), {}), "yes")
    assert np.isnan(yes["t_queue"])                      # 20 traded, 100 were ahead and "nobody cancels"
    assert yes["t_queue+"] == CLOSE - 840_000 + 3500     # but only 10 were still ahead by then


def test_a_no_bid_is_a_yes_offer_filled_by_yes_buyers():
    from maker_study import simulate_round
    rows = simulate_round("T", CLOSE, False, _book(), _tape((5000, 0.52, "yes", 5)), {})
    no = _order(rows, "no")
    assert no["limit"] == pytest.approx(0.49) and no["win"] == 1.0
    assert no["t_through"] == CLOSE - 840_000 + 5000
    assert np.isnan(_order(rows, "yes")["t_queue+"])


def test_a_bid_the_ask_has_already_reached_is_a_take_not_a_resting_fill():
    from maker_study import simulate_round
    import json
    moved = {839: {"yes_bid": 0.48, "yes_ask": 0.50, "book_yes": json.dumps([[0.48, 100.0]]), "book_no": json.dumps([[0.50, 100.0]])}}
    yes = _order(simulate_round("T", CLOSE, True, _book(moved), _tape((5000, 0.49, "no", 5)), {}), "yes")
    assert not yes["posted"] and np.isnan(yes["t_through"])
    assert yes["taker_cost"] == pytest.approx(0.50 + 0.07 * 0.25)  # what it really costs: the ask plus the taker fee
