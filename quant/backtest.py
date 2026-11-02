"""Part 2b: fee-aware backtests on out-of-sample predictions only, and the tear sheet.

    uv run python research.py && uv run python model.py && uv run python backtest.py

Every strategy trades 1 contract per signal and is scored only on rounds its model never trained on (model.py's
walk-forward predictions). Thresholds are fixed before looking at results (taker 4¢, maker 2¢, lock 2¢ — the engine's
own defaults); the grids are shown for transparency, not to pick a winner. Execution:

  taker  — decide at second t, pay the ask at t+1 s (one second of latency) plus the quadratic taker fee; hold to
           settlement, or for the scalp sell at the bid 60 s after entry (second taker fee).
  maker  — post a buy at the best bid of the chosen side for up to 60 s; filled only when that side's ask later trades
           strictly *through* the limit (a seller had to cross our price, so queue position cannot matter). "touch" (ask ≤
           limit) is shown as the optimistic bound. One live order at a time, one fill per side per round. Maker fee 0
           (your fills), with Kalshi's standard 0.0175 as a stress case.
  lock   — final 60 s only: BRTI-only probability with the seconds of the settlement window already locked in.

Writes output/PYTHON-QUANT-REPORT.md (with Part 1 and the model scores) and output/quant/backtest.json.
"""
from __future__ import annotations

import json
import math

import numpy as np
import polars as pl

from common import CACHE_PANEL, MAKER_RATE, MAKER_RATE_STRESS, OUT, QUANT_OUT, block_bootstrap, maker_fee, md_table, taker_fee, write_json
from features import build_panel

CACHE = CACHE_PANEL.parent
TAKER_EDGE, MAKER_EDGE, LOCK_EDGE = 0.04, 0.02, 0.02


def _with_next_second(decisions: pl.DataFrame, panel: pl.DataFrame) -> pl.DataFrame:
    nxt = panel.select("ticker", (pl.col("time") - 1000).alias("time"), pl.col("yes_ask").alias("ask_next"), pl.col("yes_bid").alias("bid_next"))
    return decisions.join(nxt, on=["ticker", "time"], how="inner")


def metrics(trades: pl.DataFrame, days: list) -> dict:
    """trades: one row per trade with pnl and fee in dollars per contract. Sharpe from daily P&L over every test day."""
    if trades.height == 0:
        return {"trades": 0}
    t = trades.sort("time")
    daily = t.group_by("day").agg(pl.col("pnl").sum())
    series = pl.DataFrame({"day": days}).join(daily, on="day", how="left").fill_null(0)["pnl"].to_numpy()
    sd = series.std(ddof=1)
    cum = np.cumsum(t["pnl"].to_numpy())
    dd = float(np.max(np.maximum.accumulate(np.concatenate([[0], cum]))[1:] - cum)) if len(cum) else 0.0
    lo, hi = block_bootstrap(t["pnl"].to_numpy(), t["ticker"].to_numpy())
    return {
        "trades": t.height, "rounds": t["ticker"].n_unique(), "win_rate": float((t["pnl"] > 0).mean()),
        "avg_cents": float(t["pnl"].mean() * 100), "low_cents": lo * 100, "high_cents": hi * 100,
        "net_dollars": float(t["pnl"].sum()), "fees_dollars": float(t["fee"].sum()), "staked_dollars": float(t["cost"].sum()),
        "sharpe": float(series.mean() / sd * math.sqrt(365)) if sd > 0 else None, "max_drawdown_dollars": dd, "days": len(days),
    }


# ---------------------------------------------------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------------------------------------------------


def taker_hold(decisions: pl.DataFrame, prob: str, edge: float, tau=(60, 840), latency=True) -> pl.DataFrame:
    """First second per round where the model's edge over the ask (after fee) clears `edge`; hold to settlement."""
    d = decisions.filter(pl.col("tau").is_between(*tau)).drop_nulls(prob)
    ask_yes = pl.col("ask_next") if latency else pl.col("yes_ask")
    bid_yes = pl.col("bid_next") if latency else pl.col("yes_bid")
    d = d.with_columns(
        e_yes=pl.col(prob) - ask_yes - taker_fee(ask_yes),
        e_no=(1 - pl.col(prob)) - (1 - bid_yes) - taker_fee(1 - bid_yes),
    ).filter(pl.max_horizontal("e_yes", "e_no") >= edge, ask_yes < 0.995, bid_yes > 0.005)
    first = d.sort("time").group_by("ticker").first()
    side_yes = pl.col("e_yes") >= pl.col("e_no")
    price = pl.when(side_yes).then(ask_yes).otherwise(1 - bid_yes)
    won = pl.when(side_yes).then(pl.col("y")).otherwise(1 - pl.col("y"))
    return first.with_columns(price=price, won=won, side=pl.when(side_yes).then(pl.lit("yes")).otherwise(pl.lit("no"))).with_columns(
        fee=taker_fee(pl.col("price")), cost=pl.col("price"),
    ).with_columns(pnl=pl.col("won") - pl.col("price") - pl.col("fee"))


def taker_scalp(pred: pl.DataFrame, panel: pl.DataFrame, edge_cents: float) -> pl.DataFrame:
    """Buy at the ask 1 s after the scalp model predicts ≥ edge_cents net; sell at the bid 60 s after entry. Non-overlapping."""
    later = panel.select("ticker", (pl.col("time") - 61000).alias("time"), pl.col("yes_bid").alias("exit_yes_bid"), (1 - pl.col("yes_ask")).alias("exit_no_bid"))
    d = _with_next_second(pred, panel).join(later, on=["ticker", "time"], how="inner").filter(
        pl.max_horizontal("pred_sc_yes", "pred_sc_no") >= edge_cents, pl.col("tau") > 75)
    rows = []
    for _, g in d.sort("time").group_by("ticker"):
        busy = -1
        for r in g.iter_rows(named=True):
            if r["time"] < busy:
                continue
            yes = r["pred_sc_yes"] >= r["pred_sc_no"]
            entry = r["ask_next"] if yes else 1 - r["bid_next"]
            exit_ = r["exit_yes_bid"] if yes else r["exit_no_bid"]
            if not (0.005 < entry < 0.995):
                continue
            fee = taker_fee(entry) + taker_fee(exit_)
            rows.append({"ticker": r["ticker"], "time": r["time"], "day": r["day"], "pnl": exit_ - entry - fee, "fee": fee, "cost": entry})
            busy = r["time"] + 61000
    return pl.DataFrame(rows, schema={"ticker": pl.String, "time": pl.Int64, "day": pl.Date, "pnl": pl.Float64, "fee": pl.Float64, "cost": pl.Float64})


def maker(decisions: pl.DataFrame, panel: pl.DataFrame, prob: str | None, edge: float, through: bool = True,
          rate: float = MAKER_RATE, life_ms: int = 60000) -> pl.DataFrame:
    """Post at the best bid when the model's edge over the bid clears `edge` (prob=None: post both sides, no model)."""
    d = decisions.filter(pl.col("tau").is_between(90, 840))
    if prob is not None:
        d = d.drop_nulls(prob).with_columns(
            yes_ok=pl.col(prob) - pl.col("yes_bid") - maker_fee(pl.col("yes_bid"), rate=rate) >= edge,
            no_ok=(1 - pl.col(prob)) - (1 - pl.col("yes_ask")) - maker_fee(1 - pl.col("yes_ask"), rate=rate) >= edge,
        )
    else:
        d = d.with_columns(yes_ok=pl.lit(True), no_ok=pl.lit(True))
    asks = panel.select("ticker", pl.col("time").alias("t2"), "yes_ask", "yes_bid")
    rows = []
    for side in ("yes", "no"):
        o = d.filter(pl.col(f"{side}_ok")).select("ticker", "time", "day", "y", limit=pl.col("yes_bid") if side == "yes" else 1 - pl.col("yes_ask"))
        o = o.filter(pl.col("limit").is_between(0.01, 0.99))
        j = o.join(asks, on="ticker").filter(pl.col("t2") > pl.col("time"), pl.col("t2") <= pl.col("time") + life_ms)
        side_ask = pl.col("yes_ask") if side == "yes" else 1 - pl.col("yes_bid")
        hit = side_ask < pl.col("limit") - 1e-9 if through else side_ask <= pl.col("limit") + 1e-9
        fills = j.filter(hit).group_by("ticker", "time").agg(pl.col("t2").min().alias("filled"))
        o = o.join(fills, on=["ticker", "time"], how="left").sort("ticker", "time")
        for _, g in o.group_by("ticker"):
            free = -1
            for r in g.iter_rows(named=True):  # one live order at a time; stop at the first fill
                if r["time"] < free:
                    continue
                if r["filled"] is not None:
                    won = r["y"] if side == "yes" else 1 - r["y"]
                    fee = maker_fee(r["limit"], rate=rate)
                    rows.append({"ticker": r["ticker"], "time": r["filled"], "day": r["day"], "side": side,
                                 "pnl": won - r["limit"] - fee, "fee": fee, "cost": r["limit"]})
                    break
                free = r["time"] + life_ms
    return pl.DataFrame(rows, schema={"ticker": pl.String, "time": pl.Int64, "day": pl.Date, "side": pl.String, "pnl": pl.Float64, "fee": pl.Float64, "cost": pl.Float64})


def lock(panel: pl.DataFrame, edge: float, close_only: bool = False, max_tau: int = 60) -> pl.DataFrame:
    """Final minute: trade the BRTI lock probability against the ask 1 s later. Requires every elapsed window second."""
    d = panel.filter(pl.col("tau").is_between(2, max_tau), pl.col("n_locked") == 60 - pl.col("tau").round(0)).drop_nulls("p_brti")
    if close_only:
        d = d.filter((pl.col("expected_avg") - pl.col("k")).abs() <= 10)
    return taker_hold(_with_next_second(d, panel), "p_brti", edge, tau=(2, max_tau))


# ---------------------------------------------------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------------------------------------------------


def run():
    panel = build_panel()
    pj = pl.read_parquet(CACHE / "pred_journal.parquet")
    ph = pl.read_parquet(CACHE / "pred_history.parquet").with_columns(day=pl.from_epoch("time", time_unit="ms").dt.date())
    ps = pl.read_parquet(CACHE / "pred_scalp.parquet")
    test_rounds = pj["ticker"].unique()
    oos_panel = panel.filter(pl.col("ticker").is_in(test_rounds.implode()))
    days = sorted(oos_panel["day"].unique().to_list())
    hdays = sorted(ph["day"].unique().to_list())
    dj = _with_next_second(pj, panel)
    results, rows = {}, []

    def add(name: str, group: str, trades: pl.DataFrame, d=days, note: str = ""):
        m = metrics(trades, d)
        results[name] = {**m, "group": group, "note": note}
        rows.append({"strategy": name, "data": group, "trades": m.get("trades", 0), "win %": (m.get("win_rate") or 0) * 100,
                     "avg ¢/contract": m.get("avg_cents"), "95% low": m.get("low_cents"), "95% high": m.get("high_cents"),
                     "net $ (1 lot)": m.get("net_dollars"), "fees $": m.get("fees_dollars"), "Sharpe": m.get("sharpe"),
                     "max DD $": m.get("max_drawdown_dollars")})

    # High-conviction taker, hold to settlement.
    add("Taker · LightGBM ≥4¢", "journal", taker_hold(dj, "pred", TAKER_EDGE))
    add("Taker · engine model ≥4¢ (today's TS)", "journal", taker_hold(dj, "p", TAKER_EDGE))
    add("Taker · LightGBM ≥4¢", "history", taker_hold(ph, "pred", TAKER_EDGE, latency=False), hdays)
    add("Taker · LightGBM ≥4¢, 5–8 AM PT", "history", taker_hold(ph.filter(pl.col("high_vol") == 1), "pred", TAKER_EDGE, latency=False), hdays)
    add("Taker scalp 60 s · predicted ≥ +1¢", "journal", taker_scalp(ps, panel, 1.0))
    # Maker.
    add("Maker · LightGBM ≥2¢ (through)", "journal", maker(pj, panel, "pred", MAKER_EDGE))
    add("Maker · LightGBM ≥2¢ (touch, optimistic)", "journal", maker(pj, panel, "pred", MAKER_EDGE, through=False))
    add("Maker · LightGBM ≥2¢, maker fee 1.75%", "journal", maker(pj, panel, "pred", MAKER_EDGE, rate=MAKER_RATE_STRESS))
    add("Maker · no model, both sides (through)", "journal", maker(pj, panel, None, 0.0))
    # Final-minute lock.
    lock_panel = oos_panel
    add("Lock · BRTI lock math ≥2¢", "journal", lock(lock_panel, LOCK_EDGE))
    add("Lock · ≥2¢, within $10 of target", "journal", lock(lock_panel, LOCK_EDGE, close_only=True))
    add("Lock · ≥8¢", "journal", lock(lock_panel, 0.08))
    # Exploratory, added after seeing that the lock math beats Kalshi's mid only with ≤ 30 s left (report section 2b).
    add("Lock · ≥2¢, ≤30 s left (exploratory)", "journal", lock(lock_panel, LOCK_EDGE, max_tau=30))
    add("Lock · ≥2¢, ≤15 s left (exploratory)", "journal", lock(lock_panel, LOCK_EDGE, max_tau=15))

    grid = []
    for e in (0.02, 0.04, 0.06, 0.08, 0.10):
        for label, frame, kw in (("taker journal", dj, {}), ("taker history", ph, {"latency": False})):
            m = metrics(taker_hold(frame, "pred", e, **kw), days if "journal" in label else hdays)
            grid.append({"rule": label, "edge ≥ ¢": e * 100, "trades": m.get("trades", 0), "avg ¢": m.get("avg_cents"), "net $": m.get("net_dollars")})
        m = metrics(lock(lock_panel, e), days)
        grid.append({"rule": "lock", "edge ≥ ¢": e * 100, "trades": m.get("trades", 0), "avg ¢": m.get("avg_cents"), "net $": m.get("net_dollars")})
    write_json("backtest.json", {"strategies": results, "grid": grid})

    span = f"{days[0]} → {days[-1]}" if days else "—"
    research = (QUANT_OUT / "research.md").read_text(encoding="utf-8").replace("# Python research\n", "")
    model = json.loads((QUANT_OUT / "model.json").read_text(encoding="utf-8"))
    model_md = _model_section(model)
    table = pl.DataFrame(rows)
    winners = [r for r in rows if (r["95% low"] or -1) > 0]
    verdict = ("**No strategy clears zero with confidence.** Every 95% range below includes or sits below 0¢ per contract after fees."
               if not winners else "Strategies whose 95% range is above zero: " + ", ".join(f"{r['strategy']} ({r['data']})" for r in winners) + ".")
    md = [
        "# Python quant report — KXBTC15M", "",
        f"Generated by `quant/` (Python {'.'.join(map(str, __import__('sys').version_info[:3]))}, polars, LightGBM). Read-only on data/*.db. "
        f"Out-of-sample journal span {span} ({len(test_rounds):,} rounds); archive {hdays[0]} → {hdays[-1]} ({ph['ticker'].n_unique():,} rounds).", "",
        "## Verdict", "", verdict, "",
        research,
        "## 2b. Final-minute lock math vs Kalshi's mid", "",
        "The lock probability forecasts settlement better than Kalshi's mid once 30+ of the 60 seconds are locked (≤ 30 s left), but in those seconds the "
        "book is usually pinned at 99¢+ / 1¢-, so the better forecast rarely meets an ask it beats by more than the fee.", "",
        md_table(lock_quality(panel), floats=4), "",
        model_md,
        "## 4. Backtests (out of sample, 1 contract per signal, after fees)", "",
        "Per-contract P&L with a 95% range that resamples whole rounds. Sharpe uses daily P&L over every test day (×√365). "
        "Thresholds are the engine's defaults, fixed in advance.", "",
        md_table(table, floats=2), "",
        "Threshold grid (transparency only — choosing the best row would be fitting to the test set):", "",
        md_table(pl.DataFrame(grid), floats=2), "",
        "## Method and limits", "",
        "- Walk-forward: 6 expanding folds by round time; each model sees only rounds that closed before its test block, "
        "with the last 20% of its window held out for early stopping and Platt calibration.",
        "- The journal covers about 1,000 rounds (Oct 7 → now) and has no data from 4 to 10 AM PT; the 1-minute archive covers "
        "10,878 rounds but only minute-end quotes, so it cannot test maker fills or the final minute.",
        "- Taker entries pay the ask one second after the decision. Maker fills require the market to trade through the limit; "
        "a real queue could fill sooner (the 'touch' row) but then adverse selection is larger, not smaller.",
        "- 1 contract per signal keeps depth out of it. At the sizes you traded (often 1,000+ contracts) you would also walk the book.",
        "- Settlement uses Kalshi's [close − 60 s, close) BRTI average, which reproduces Kalshi's value on 983/983 checked rounds.", "",
    ]
    path = OUT / "PYTHON-QUANT-REPORT.md"
    path.write_text("\n".join(md), encoding="utf-8")
    print("\n".join(md[:14 + 0]))
    print(md_table(table, floats=2))
    print(md_table(pl.DataFrame(grid), floats=2))
    print(f"\nwrote {path}")


def lock_quality(panel: pl.DataFrame) -> pl.DataFrame:
    """Final minute: Brier of the BRTI lock probability vs Kalshi's mid, by seconds left (every round with full BRTI)."""
    f = panel.filter(pl.col("tau").is_between(2, 60), pl.col("n_locked") == 60 - pl.col("tau").round(0)).drop_nulls("p_brti")
    return (
        f.with_columns(left=pl.col("tau").cut([10, 20, 30, 45], labels=["2-10 s", "10-20 s", "20-30 s", "30-45 s", "45-60 s"], left_closed=True).cast(pl.String))
        .group_by("left").agg(seconds=pl.len(), rounds=pl.col("ticker").n_unique(),
                              lock_brier=((pl.col("p_brti") - pl.col("y")) ** 2).mean(), kalshi_mid_brier=((pl.col("mid") - pl.col("y")) ** 2).mean(),
                              book_pinned_pct=((pl.col("yes_ask") >= .99) | (pl.col("yes_bid") <= .01)).mean() * 100,
                              order=pl.col("tau").min())
        .sort("order").drop("order")
    )


def _model_section(model: dict) -> str:
    rows = [{k: model[n][k] for k in ("dataset", "rounds", "model_logloss", "kalshi_logloss", "model_brier", "kalshi_brier", "gain_vs_kalshi_x1000", "low_x1000", "high_x1000")}
            for n in ("history", "journal")]
    s = model["scalp"]
    imp = lambda n: ", ".join(f"{k} {v:.0%}" for k, v in sorted(model[n]["importance"].items(), key=lambda kv: -kv[1])[:5])
    return "\n".join([
        "## 3. Can a model beat Kalshi's price? (out of sample)", "",
        "LightGBM boosted from Kalshi's own price (it can only add corrections), Platt-calibrated. Gain = Kalshi's log-loss − "
        "the model's, ×1000; positive means the model forecasts settlement better.", "",
        md_table(pl.DataFrame(rows), floats=4), "",
        f"Largest split-gain features — archive: {imp('history')}; journal: {imp('journal')}.", "",
        f"Scalp model (net 60-s round trip): predicted vs actual correlation {s['corr_yes']:.3f} (YES) / {s['corr_no']:.3f} (NO); "
        f"the average round trip loses {-s['mean_actual_yes_c']:.2f}¢ (YES) / {-s['mean_actual_no_c']:.2f}¢ (NO).", "",
    ])


if __name__ == "__main__":
    run()
