"""Part 1: post-mortem of your real KXBTC15M fills, and a search for features that predict anything after Kalshi's fees.

    uv run python research.py              # both parts
    uv run python research.py fills        # only the fill post-mortem
    uv run python research.py features     # only the feature study
    uv run python research.py flow --refresh   # order flow & perp lead (flow.py); --refresh rebuilds the journal cache

Writes output/quant/research.json and output/quant/research.md. Read-only on data/*.db (see data.py).
"""
from __future__ import annotations

import sys
from collections import defaultdict, deque

import numpy as np
import polars as pl

from common import QUANT_OUT, block_bootstrap, close_from_ticker, md_table, price_bucket, pt_hour, tau_bucket, taker_fee, write_json
from data import load

# ---------------------------------------------------------------------------------------------------------------------
# Fill post-mortem
# ---------------------------------------------------------------------------------------------------------------------


def lots(fills: pl.DataFrame | None = None, results: dict | None = None) -> pl.DataFrame:
    """Every contract you took on as a lot, closed FIFO by a later opposite fill or else held to settlement.

    On a Kalshi fill, `side` is the contract acquired at that side's price; `action` is only the order type. Selling YES
    at 46¢ is recorded as "sell no @ 54¢": you acquire NO, which nets your YES away at $1 a pair. This reading reproduces
    Kalshi's settlement records exactly (e.g. KXBTC15M-26OCT212300: −$1,049.59). So a fill on the side you hold (or when
    flat) opens a lot; a fill on the other side closes your oldest lots at 1 − its price, and any excess opens new lots.
    Fees stay with the fill that paid them: an entry's fee with its lot, an exit's fee shared by the lots it closed.
    """
    fills = (load("fills") if fills is None else fills).with_columns(
        price=pl.when(pl.col("side") == "yes").then("yes_price").otherwise("no_price"),
        close=close_from_ticker(),
    )
    if results is None:
        results = dict(load("settlements").select("ticker", "result").iter_rows())
    held: dict[str, deque] = defaultdict(deque)
    out = []
    for f in fills.sort("created").iter_rows(named=True):
        q = held[f["ticker"]]
        left, per = f["count"], f["fee"] / f["count"] if f["count"] else 0.0
        while left > 1e-9 and q and q[0]["side"] != f["side"]:
            lot = q[0]
            n = min(lot["open"], left)
            lot["open"] -= n; lot["sold"] += n; left -= n
            lot["proceeds"] += n * (1 - f["price"]); lot["exit_fee"] += n * per; lot["exit_time"] = f["time"]
            if lot["open"] <= 1e-9:
                out.append(q.popleft())
        if left > 1e-9:
            q.append({
                "ticker": f["ticker"], "side": f["side"], "entry_time": f["time"], "tau": (f["close"] - f["time"]) / 1000,
                "price": f["price"], "taker": f["is_taker"], "open": left, "count": left,
                "fee": per * left, "proceeds": 0.0, "sold": 0.0, "exit_fee": 0.0, "exit_time": None,
            })
    out.extend(lot for q in held.values() for lot in q)
    unmatched = 0.0
    rows = []
    for lot in out:
        result = results.get(lot["ticker"])
        won = None if result is None else (result == lot["side"])
        payout = lot["open"] * (1.0 if won else 0.0) if won is not None else np.nan
        cost = lot["count"] * lot["price"]
        rows.append({
            **{k: lot[k] for k in ("ticker", "side", "entry_time", "tau", "price", "taker", "count", "sold", "exit_time")},
            "held": lot["open"], "won": won, "cost": cost, "fees": lot["fee"] + lot["exit_fee"], "exit_fee": lot["exit_fee"],
            "gross": lot["proceeds"] + payout - cost,
            # What the sold part would have paid had it been held to settlement instead.
            "hold_instead": (lot["sold"] * (1.0 if won else 0.0) - lot["proceeds"] + lot["exit_fee"]) if won is not None else np.nan,
        })
    frame = pl.DataFrame(rows).with_columns(net=pl.col("gross") - pl.col("fees"))
    return frame, unmatched


def _model_at_entry(frame: pl.DataFrame) -> pl.DataFrame:
    """The engine's forecast (q, the number it showed you) and its raw model p, as of each entry second."""
    ticks = load("ticks").select("ticker", "time", "q", "p", "yes_bid", "yes_ask").drop_nulls("q").sort("time")
    joined = frame.sort("entry_time").join_asof(
        ticks, left_on="entry_time", right_on="time", by="ticker", strategy="backward", tolerance=3000,
    )
    side_q = pl.when(pl.col("side") == "yes").then(pl.col("q")).otherwise(1 - pl.col("q"))
    return joined.with_columns(
        model_edge=side_q - pl.col("price") - taker_fee(pl.col("price")),
    ).with_columns(
        agreed=pl.when(pl.col("model_edge").is_null()).then(pl.lit("no forecast"))
        .when(pl.col("model_edge") >= 0.04).then(pl.lit("engine edge >= 4c"))
        .when(pl.col("model_edge") >= 0).then(pl.lit("engine edge 0-4c"))
        .otherwise(pl.lit("engine said no (edge < 0)")),
    )


def _group(frame: pl.DataFrame, by: str) -> pl.DataFrame:
    return (
        frame.group_by(by).agg(
            lots=pl.len(), rounds=pl.col("ticker").n_unique(), contracts=pl.col("count").sum(),
            staked=pl.col("cost").sum(), gross=pl.col("gross").sum(), fees=pl.col("fees").sum(), net=pl.col("net").sum(),
        )
        .with_columns(roi_pct=pl.col("net") / pl.col("staked") * 100)
        .sort(by)
    )


def post_mortem() -> tuple[dict, str]:
    frame, unmatched = lots()
    frame = _model_at_entry(frame).with_columns(
        tau_bucket=tau_bucket("tau").cast(pl.String), price_bucket=price_bucket("price").cast(pl.String),
        exit=pl.when(pl.col("sold") <= 1e-9).then(pl.lit("held to settlement"))
        .when(pl.col("held") <= 1e-9).then(pl.lit("sold before close")).otherwise(pl.lit("part sold")),
        hour=pt_hour("entry_time"),
        week=pl.from_epoch("entry_time", time_unit="ms").dt.truncate("1w").dt.date().cast(pl.String),
        taker_label=pl.when(pl.col("taker")).then(pl.lit("taker")).otherwise(pl.lit("maker")),
    ).with_columns(window=pl.col("hour").cut([5, 8, 12, 17, 21], labels=["0-5 PT", "5-8 PT", "8-12 PT", "12-17 PT", "17-21 PT", "21-24 PT"], left_closed=True).cast(pl.String))
    settled = frame.filter(pl.col("won").is_not_null())
    by_round = settled.group_by("ticker").agg(pl.col("net").sum(), pl.col("fees").sum(), pl.col("entry_time").min()).sort("entry_time")
    sold = settled.filter(pl.col("sold") > 0)
    totals = {
        "first": int(frame["entry_time"].min()), "last": int(frame["entry_time"].max()),
        "lots": frame.height, "rounds": frame["ticker"].n_unique(), "unmatched_sells": unmatched,
        "staked": settled["cost"].sum(), "gross": settled["gross"].sum(), "fees": settled["fees"].sum(), "net": settled["net"].sum(),
        "round_win_rate": float((by_round["net"] > 0).mean()), "rounds_settled": by_round.height,
        "best_round": float(by_round["net"].max()), "worst_round": float(by_round["net"].min()),
        "sold_early_lots": sold.height, "hold_instead_dollars": float(sold["hold_instead"].sum()),
        "hold_instead_top5": float(sold["hold_instead"].sort(descending=True).head(5).sum()),
        "hold_better_share": float((sold["hold_instead"] > 0).mean()),
        "exit_fees": float(sold["exit_fee"].sum()),
        "net_without_fees_pct_of_loss": float(settled["fees"].sum() / -settled["net"].sum() * 100) if settled["net"].sum() < 0 else None,
    }
    tables = {name: _group(settled, col) for name, col in [
        ("maker_taker", "taker_label"), ("time_left", "tau_bucket"), ("entry_price", "price_bucket"),
        ("exit", "exit"), ("engine_view", "agreed"), ("window", "window"), ("week", "week"),
    ]}
    worst = by_round.sort("net").head(5).with_columns(
        when=pl.from_epoch("entry_time", time_unit="ms").dt.replace_time_zone("UTC").dt.convert_time_zone("America/Los_Angeles").dt.strftime("%b %d %H:%M PT"),
    ).select("ticker", "when", "net", "fees")
    md = [
        "## 1. Where the money went (your real fills)", "",
        f"{totals['lots']:,} bought lots across {totals['rounds']} rounds. On settled rounds you staked ${totals['staked']:,.2f}; "
        f"before fees you made **${totals['gross']:,.2f}**, fees were **${totals['fees']:,.2f}**, net **${totals['net']:,.2f}**. "
        f"You won {totals['round_win_rate']*100:.0f}% of {totals['rounds_settled']} rounds (best ${totals['best_round']:,.2f}, worst ${totals['worst_round']:,.2f}).", "",
        "Taker vs maker:", "", md_table(tables["maker_taker"]), "",
        "By time left at entry:", "", md_table(tables["time_left"]), "",
        "By entry price (of the side bought):", "", md_table(tables["entry_price"]), "",
        "Early exits vs holding to settlement:", "", md_table(tables["exit"]), "",
        f"Holding the {totals['sold_early_lots']} lots you sold early would have made **${totals['hold_instead_dollars']:,.2f}** more "
        f"(and saved ${totals['exit_fees']:,.2f} of exit fees), but that is hindsight: 5 lots account for "
        f"${totals['hold_instead_top5']:,.2f} of it and holding beat selling on only {totals['hold_better_share']*100:.0f}% of them. "
        "Without those 5, selling early was roughly neutral.", "",
        "What the engine's forecast said at the second you bought (its edge after the taker fee):", "", md_table(tables["engine_view"]), "",
        "By time of day at entry (you never traded 5–8 AM PT):", "", md_table(tables["window"]), "",
        "By week:", "", md_table(tables["week"]), "",
        "Worst rounds:", "", md_table(worst), "",
    ]
    payload = {"totals": totals, **{k: v.to_dicts() for k, v in tables.items()}, "worst_rounds": worst.to_dicts()}
    return payload, "\n".join(md)


# ---------------------------------------------------------------------------------------------------------------------
# Feature study
# ---------------------------------------------------------------------------------------------------------------------


def main(parts: list[str]):
    payload, md = {}, ["# Python research", ""]
    if "--refresh" in parts:
        # The flow bars only start on 2026-11-02, so the cached journal and panel must include the latest seconds.
        from features import build_panel
        load("ticks", refresh=True); build_panel(refresh=True)
    if "fills" in parts:
        p, m = post_mortem()
        payload["fills"] = p; md.append(m)
    if "features" in parts:
        from features import feature_study
        p, m = feature_study()
        payload["features"] = p; md.append(m)
    if "flow" in parts:
        from flow import flow_study
        p, m = flow_study()
        payload["flow"] = p; md.append(m)
    write_json("research.json", payload)
    (QUANT_OUT / "research.md").write_text("\n".join(md), encoding="utf-8")
    print("\n".join(md))


if __name__ == "__main__":
    main(sys.argv[1:] or ["fills", "features", "flow"])
