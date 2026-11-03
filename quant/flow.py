"""Part 1c: do order flow and the perp futures lead add anything to Kalshi's price, after fees? (DECISIONS 71)

The engine's flow worker records 250 ms bars to data/flow.db from 2026-11-02: Coinbase spot, Binance and Bybit BTCUSDT
perp taker volume and last trades, Binance's top-of-book and mark/index. Bars are keyed in Kalshi's clock, like the
journal's ticks. Each journal second gets features from bars that finished before it (no look-ahead), then the same
walk-forward test as the feature study: does adding the feature to a model that already knows Kalshi's mid lower the
settlement log-loss out of sample, and do its extreme deciles pay after the taker fee?

    uv run python research.py flow --refresh   # refresh the journal cache first (the flow data is all recent)
"""
from __future__ import annotations

import numpy as np
import polars as pl
from scipy.stats import spearmanr

from common import md_table
from data import DATA, load
from features import _deciles, _ev, _incremental_logloss, build_panel

FLOW_FEATURES = {
    "cvd_spot60": "Coinbase taker buys − sells, 60 s (BTC)",
    "ratio_spot60": "Coinbase taker-buy share, 60 s",
    "cvd_perp60": "Binance + Bybit taker buys − sells, 60 s (BTC)",
    "cvd_perp15": "Binance + Bybit taker buys − sells, 15 s (BTC)",
    "ratio_perp60": "perp taker-buy share, 60 s",
    "lead1": "perp 1-s move − spot 1-s move ($)",
    "lead5": "perp 5-s move − spot 5-s move ($)",
    "basis_chg": "perp − spot basis vs its 5-min mean ($)",
    "premium_bps": "Binance mark − index (bp)",
    "votes": "flow badge votes for UP (−3 … +3)",
}


def seconds() -> pl.DataFrame | None:
    """One row per Kalshi-clock second s, from the bars in [s − 1 s, s); windows need ≥ 90% of their bars present."""
    if not (DATA / "flow.db").exists():
        return None
    bars = load("flow", refresh=True)
    if bars.height == 0:
        return None
    vol = lambda c: pl.col(c).fill_null(0)
    s = (
        bars.with_columns(s=(pl.col("t") // 1000 + 1) * 1000)
        .group_by("s").agg(
            bars=pl.len(),
            spot_buy=vol("cb_buy").sum(), spot_sell=vol("cb_sell").sum(),
            perp_buy=(vol("bn_buy") + vol("by_buy")).sum(), perp_sell=(vol("bn_sell") + vol("by_sell")).sum(),
            spot=pl.col("cb_last").drop_nulls().last(), perp=pl.coalesce("bn_last", "by_last").drop_nulls().last(),
            mark=pl.col("bn_mark").drop_nulls().last(), index=pl.col("bn_index").drop_nulls().last(),
        )
    )
    grid = pl.DataFrame({"s": np.arange(s["s"].min(), s["s"].max() + 1000, 1000, dtype=np.int64)})
    s = grid.join(s, on="s", how="left").sort("s").with_columns(
        pl.col("bars", "spot_buy", "spot_sell", "perp_buy", "perp_sell").fill_null(0),
        pl.col("spot", "perp", "mark", "index").forward_fill(limit=5),
    )
    roll = lambda c, n: pl.col(c).rolling_sum(window_size=n)
    cover = lambda n: roll("bars", n) >= .9 * 4 * n
    s = s.with_columns(
        cvd_spot60=pl.when(cover(60)).then(roll("spot_buy", 60) - roll("spot_sell", 60)),
        ratio_spot60=pl.when(cover(60)).then(roll("spot_buy", 60) / (roll("spot_buy", 60) + roll("spot_sell", 60))),
        cvd_perp60=pl.when(cover(60)).then(roll("perp_buy", 60) - roll("perp_sell", 60)),
        cvd_perp15=pl.when(cover(15)).then(roll("perp_buy", 15) - roll("perp_sell", 15)),
        ratio_perp60=pl.when(cover(60)).then(roll("perp_buy", 60) / (roll("perp_buy", 60) + roll("perp_sell", 60))),
        lead1=(pl.col("perp") - pl.col("perp").shift(1)) - (pl.col("spot") - pl.col("spot").shift(1)),
        lead5=(pl.col("perp") - pl.col("perp").shift(5)) - (pl.col("spot") - pl.col("spot").shift(5)),
        basis=pl.col("perp") - pl.col("spot"),
        premium_bps=(pl.col("mark") - pl.col("index")) / pl.col("index") * 1e4,
    ).with_columns(
        basis_chg=pl.when(cover(300)).then(pl.col("basis") - pl.col("basis").rolling_mean(window_size=300)),
        lead_z=pl.col("lead1") / pl.col("lead1").pow(2).rolling_mean(window_size=300, min_samples=240).sqrt(),
    )
    # The dashboard badge's votes (flow.ts): 60 s taker share ≥ 55% / ≤ 45% on enough volume, and a 1-s lead ≥ 2 sd and ≥ $5.
    v = lambda ratio, volume, lo: pl.when(volume < lo).then(0).when(pl.col(ratio) >= .55).then(1).when(pl.col(ratio) <= .45).then(-1).otherwise(0)
    return s.with_columns(votes=(
        v("ratio_spot60", roll("spot_buy", 60) + roll("spot_sell", 60), .25) + v("ratio_perp60", roll("perp_buy", 60) + roll("perp_sell", 60), 2)
        + pl.when((pl.col("lead_z") >= 2) & (pl.col("lead1") >= 5)).then(1).when((pl.col("lead_z") <= -2) & (pl.col("lead1") <= -5)).then(-1).otherwise(0)
    )).rename({"s": "time"})


def flow_study() -> tuple[dict, str]:
    head = "## 3. Order flow & the perp futures lead (data/flow.db)"
    flow = seconds()
    if flow is None:
        return {"rows": 0}, f"{head}\n\nNo flow data yet: the engine's flow worker writes data/flow.db while it runs.\n"
    panel = _ev(build_panel()).join(flow.select("time", *FLOW_FEATURES), on="time", how="inner")
    sample = panel.filter(pl.col("time") % 5000 == 0)
    payload = {"seconds": flow.height, "panel_rows": panel.height, "rounds": panel["ticker"].n_unique(),
               "from": int(flow["time"].min()), "to": int(flow["time"].max())}
    rows = []
    for feat, label in FLOW_FEATURES.items():
        inc, dec = _incremental_logloss(sample, feat), _deciles(sample, feat)
        moved = sample.drop_nulls([feat, "mid_30"])
        rho30 = float(spearmanr(moved[feat].to_numpy(), (moved["mid_30"] - moved["mid"]).to_numpy()).statistic) if moved.height > 100 else None
        payload[feat] = {"incremental": inc, "deciles": dec, "spearman_dmid30": rho30}
        rows.append({
            "feature": label, "rounds": inc.get("rounds"),
            "logloss gain vs Kalshi (x1000)": inc.get("logloss_gain", np.nan) * 1000,
            "95% low": inc.get("low", np.nan) * 1000, "95% high": inc.get("high", np.nan) * 1000,
            "rho vs 30s move": rho30, "rho vs 60s move": dec.get("spearman_dmid60"),
            "top-decile YES hold (c)": dec.get("top_ev", {}).get("cents"),
            "bottom-decile NO hold (c)": dec.get("bottom_ev", {}).get("cents"),
            "best scalp (c)": max((dec[k]["cents"] for k in ("top_sc", "bottom_sc") if k in dec), default=None),
        })
    days = (payload["to"] - payload["from"]) / 86_400_000
    md = [
        head, "",
        f"{flow.height:,} seconds of flow ({days:.1f} days) overlap {payload['panel_rows']:,} journal seconds on "
        f"{payload['rounds']:,} settled rounds; every 5th second is used. Same tests as section 2: walk-forward log-loss gain "
        "over Kalshi's mid (positive = information Kalshi's price does not have; the 95% range resamples whole rounds), and "
        "decile EVs per contract after the taker fee. rho vs 30 s / 60 s move: does the feature lead Kalshi's own mid?", "",
        md_table(pl.DataFrame(rows), floats=2), "",
        "Fewer than ~300 rounds is too few to call either way; the plan is to re-run after a few days and at 2–3 weeks.", "",
    ]
    return payload, "\n".join(md)
