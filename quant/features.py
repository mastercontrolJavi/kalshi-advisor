"""The per-second feature panel from the engine's journal, and the feature study (Part 1b).

One row per journal second with a fresh Kalshi book. Labels: the round's result and Kalshi's mid / bid 30, 60 and 120 s
later. Every feature uses only data available at that second (BRTI only through the previous whole second).

Settlement window: Kalshi settles on the simple average of BRTI over [close − 60 s, close) — the 60 one-second values
before the close second. This matches Kalshi's published value within half a cent on 983 of 983 checked rounds; the
TypeScript engine's (close − 60 s, close] is one second late (median error $0.19, worst $7.97).
"""
from __future__ import annotations

import numpy as np
import polars as pl
from scipy.stats import norm, spearmanr
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from common import CACHE_PANEL, block_bootstrap, close_from_ticker, log_loss, logit, md_table, pt_hour, taker_fee
from data import load

HORIZONS = (30, 60, 120)
VR = 1.18  # BRTI 15-min variance ratio over √t from 1-s returns (output/BASELINE-CALIBRATION.md)


def _results() -> pl.DataFrame:
    hist = load("rounds").select("ticker", "result", pl.col("strike").alias("strike_hist"))
    live = load("outcomes").select("ticker", pl.col("result").alias("result_live"))
    return hist.join(live, on="ticker", how="full", coalesce=True).select(
        "ticker", pl.coalesce("result", "result_live").alias("result"),
    ).drop_nulls("result")


def _brti() -> pl.DataFrame:
    """BRTI each second with its trailing 1-s volatility (300 s window, scaled by the variance ratio)."""
    b = load("brti_1s").select(pl.col("time").alias("s_ms"), pl.col("price").alias("brti_s")).sort("s_ms")
    r = pl.when(pl.col("s_ms").diff() == 1000).then((pl.col("brti_s") / pl.col("brti_s").shift(1)).log())
    return b.with_columns(ret=r).with_columns(
        brti_sigma=pl.col("ret").rolling_std(window_size=300, min_samples=100) * np.sqrt(VR),
        brti_ret5=(pl.col("brti_s") / pl.col("brti_s").shift(5)).log(),
        brti_ret1=pl.col("ret"),
    ).drop("ret")


def _final_minute(results: pl.DataFrame) -> pl.DataFrame:
    """For every round, the cumulative BRTI sum through each second of its settlement window [C−60 s, C)."""
    b = load("brti_1s").select(pl.col("time").alias("s_ms"), pl.col("price"))
    w = results.with_columns(C=close_from_ticker()).with_columns(s_ms=pl.int_ranges(pl.col("C") - 60000, pl.col("C"), 1000)).explode("s_ms")
    w = w.join(b, on="s_ms", how="left").sort("ticker", "s_ms")
    return w.with_columns(
        locked_sum=pl.col("price").cum_sum().over("ticker"),
        locked_n=pl.col("price").is_not_null().cum_sum().over("ticker"),
        slot=pl.int_range(1, pl.len() + 1).over("ticker"),
        settle_avg=pl.col("price").mean().over("ticker"), window_n=pl.col("price").count().over("ticker"),
    ).select("ticker", "s_ms", "locked_sum", "locked_n", "slot", "settle_avg", "window_n")


def _top(col: str, n: int = 5) -> pl.Expr:
    ladder = pl.col(col).str.json_decode(pl.List(pl.List(pl.Float64)))
    return ladder.list.head(n).list.eval(pl.element().list.get(1)).list.sum()


def build_panel(refresh: bool = False) -> pl.DataFrame:
    if CACHE_PANEL.exists() and not refresh:
        return pl.read_parquet(CACHE_PANEL)
    results = _results()
    t = (
        load("ticks")
        .filter(pl.col("k_confirmed") == 1, pl.col("valid") == 1, pl.col("book_delay").fill_null(0) <= 2000,
                pl.col("yes_bid").is_not_null(), pl.col("yes_ask").is_not_null(), pl.col("yes_ask") > pl.col("yes_bid"),
                pl.col("tau").is_between(1, 900))
        .unique(["ticker", "time"]).sort("ticker", "time")
        .join(results, on="ticker", how="inner")
        .with_columns(
            C=close_from_ticker(), y=(pl.col("result") == "yes").cast(pl.Int8),
            mid=(pl.col("yes_bid") + pl.col("yes_ask")) / 2, spread=pl.col("yes_ask") - pl.col("yes_bid"),
            depth_yes5=_top("book_yes"), depth_no5=_top("book_no"),
        )
    )
    # Forward Kalshi prices: the same round's book h seconds later (exact second only).
    fwd = t.select("ticker", "time", "mid", "yes_bid", "no_bid")
    for h in HORIZONS:
        t = t.join(fwd.rename({"mid": f"mid_{h}", "yes_bid": f"yes_bid_{h}", "no_bid": f"no_bid_{h}"})
                   .with_columns(pl.col("time") - h * 1000), on=["ticker", "time"], how="left")
    # BRTI through the previous whole second (published), joined as of that second.
    t = t.with_columns(s_ms=(pl.col("time") // 1000 - 1) * 1000).sort("s_ms")
    t = t.join_asof(_brti(), on="s_ms", strategy="backward", tolerance=2000)
    t = t.join(_final_minute(results), on=["ticker", "s_ms"], how="left")
    proxy_ret5 = (pl.col("proxy") / pl.col("proxy").shift(5).over("ticker")).log()
    proxy_ret1 = (pl.col("proxy") / pl.col("proxy").shift(1).over("ticker")).log()
    t = t.sort("ticker", "time").with_columns(
        hour=pt_hour("time"),
        proxy_ret1=proxy_ret1, proxy_ret5=proxy_ret5,
    )
    sig = pl.col("brti_sigma")
    # Probability from BRTI alone. tau > 60: none of the window is locked; tau ≤ 60: the exact discrete lock math.
    n_rem = (60 - pl.col("locked_n").fill_null(0)).clip(0, 60)
    var_lock = (pl.col("brti_s") * sig) ** 2 * (n_rem * (n_rem + 1) * (2 * n_rem + 1) / 6) / 3600
    exp_lock = (pl.col("locked_sum").fill_null(0) + n_rem * pl.col("brti_s")) / 60
    var_free = (pl.col("brti_s") * sig) ** 2 * ((pl.col("tau") - 60).clip(0) + 20.508)
    in_window = pl.col("tau") <= 60
    t = t.with_columns(
        n_locked=pl.when(in_window).then(pl.col("locked_n").fill_null(0)).otherwise(0),
        expected_avg=pl.when(in_window).then(exp_lock).otherwise(pl.col("brti_s")),
        avg_sd=pl.when(in_window).then(var_lock.sqrt()).otherwise(var_free.sqrt()),
        required_avg=pl.when(in_window & (n_rem > 0)).then((60 * pl.col("k") - pl.col("locked_sum").fill_null(0)) / n_rem),
    ).with_columns(
        p_brti=pl.when(pl.col("avg_sd") > 0).then(
            pl.struct("expected_avg", "k", "avg_sd").map_batches(
                lambda s: pl.Series(norm.cdf((s.struct.field("expected_avg") - s.struct.field("k")) / s.struct.field("avg_sd")).clip(.001, .999)),
                return_dtype=pl.Float64)),
        required_gap_sd=(pl.col("required_avg") - pl.col("brti_s")) / (pl.col("brti_s") * sig * (n_rem.cast(pl.Float64)).sqrt()),
    )
    lm = pl.col("mid").clip(.005, .995)
    panel = t.with_columns(
        logit_mid=(lm / (1 - lm)).log(),
        gap_model=(pl.col("p").clip(.005, .995) / (1 - pl.col("p").clip(.005, .995))).log() - (lm / (1 - lm)).log(),
        gap_brti=(pl.col("p_brti").clip(.005, .995) / (1 - pl.col("p_brti").clip(.005, .995))).log() - (lm / (1 - lm)).log(),
        imb5=(pl.col("depth_yes5") - pl.col("depth_no5")) / (pl.col("depth_yes5") + pl.col("depth_no5")),
        flow_ratio=pl.col("flow30") / pl.col("volume30"),
        proxy_minus_brti=pl.col("proxy") - pl.col("brti_s"),
        velocity_div5=(proxy_ret5 - pl.col("brti_ret5")) * 1e4,
        velocity_div1=(pl.col("proxy_ret1") - pl.col("brti_ret1")) * 1e4,
        dist_sd=(pl.col("brti_s") - pl.col("k")) / pl.col("avg_sd"),
        high_vol=pl.col("hour").is_between(5, 7).cast(pl.Int8),
        log_sigma=pl.col("brti_sigma").log(),
        day=pl.from_epoch("time", time_unit="ms").dt.date(),
    ).drop("book_yes", "book_no")
    CACHE_PANEL.parent.mkdir(exist_ok=True)
    panel.write_parquet(CACHE_PANEL)
    return panel


FEATURES = {
    "gap_model": "engine model vs Kalshi (logit p − logit mid)",
    "gap_brti": "BRTI-only probability vs Kalshi (logit)",
    "imb5": "book imbalance, top 5 levels (YES bids − NO bids)",
    "imbalance": "engine's book imbalance feature",
    "flow_ratio": "Kalshi trade flow / volume, last 30 s",
    "mom30": "spot momentum, 30 s", "mom120": "spot momentum, 2 min",
    "proxy_minus_brti": "4-exchange proxy − BRTI ($)",
    "velocity_div1": "proxy 1-s return − BRTI 1-s return (bp)",
    "velocity_div5": "proxy 5-s return − BRTI 5-s return (bp)",
    "required_gap_sd": "final minute: required average − BRTI, in sd",
    "log_sigma": "log BRTI volatility",
}


def _ev(panel: pl.DataFrame) -> pl.DataFrame:
    """Per-contract EV of buying YES or NO at the ask and holding to settlement, after the taker fee."""
    no_ask = 1 - pl.col("yes_bid")
    return panel.with_columns(
        ev_yes=pl.col("y") - pl.col("yes_ask") - taker_fee(pl.col("yes_ask")),
        ev_no=(1 - pl.col("y")) - no_ask - taker_fee(no_ask),
        # Scalp: buy at the ask now, sell at the bid in 60 s, two taker fees.
        sc_yes=pl.col("yes_bid_60") - pl.col("yes_ask") - taker_fee(pl.col("yes_ask")) - taker_fee(pl.col("yes_bid_60")),
        sc_no=pl.col("no_bid_60") - no_ask - taker_fee(no_ask) - taker_fee(pl.col("no_bid_60")),
    )


def _folds(rounds: np.ndarray, k: int = 5):
    """Expanding walk-forward folds over rounds in time order: train on everything before each test block."""
    edges = np.linspace(0, len(rounds), k + 2).astype(int)
    for i in range(1, k + 1):
        yield rounds[: edges[i]], rounds[edges[i]: edges[i + 1]]


def _incremental_logloss(frame: pl.DataFrame, feature: str) -> dict:
    """Walk-forward: does adding this feature to Kalshi's own price improve settlement forecasts out of sample?"""
    f = frame.drop_nulls([feature, "logit_mid"]).filter(pl.col(feature).is_finite())
    order = f.group_by("ticker").agg(pl.col("time").min()).sort("time")["ticker"].to_numpy()
    base_l, full_l, groups, rows = [], [], [], 0
    for train, test in _folds(order):
        tr, te = f.filter(pl.col("ticker").is_in(train)), f.filter(pl.col("ticker").is_in(test))
        if tr.height < 1000 or te.height < 200:
            continue
        x = lambda d, cols: np.column_stack([d[c].to_numpy() for c in cols])
        lo, hi = np.percentile(tr[feature].to_numpy(), [1, 99])
        clip = lambda d: d.with_columns(pl.col(feature).clip(lo, hi))
        tr, te = clip(tr), clip(te)
        fit = lambda cols: make_pipeline(StandardScaler(), LogisticRegression(C=1.0)).fit(x(tr, cols), tr["y"].to_numpy())
        b, m = fit(["logit_mid"]), fit(["logit_mid", feature])
        pb, pm = b.predict_proba(x(te, ["logit_mid"]))[:, 1], m.predict_proba(x(te, ["logit_mid", feature]))[:, 1]
        y = te["y"].to_numpy()
        base_l.append(-(y * np.log(pb) + (1 - y) * np.log(1 - pb)))
        full_l.append(-(y * np.log(pm) + (1 - y) * np.log(1 - pm)))
        groups.append(te["ticker"].to_numpy()); rows += te.height
    if not base_l:
        return {"rows": 0}
    gain = np.concatenate(base_l) - np.concatenate(full_l)
    lo, hi = block_bootstrap(gain, np.concatenate(groups))
    return {"rows": rows, "rounds": len(np.unique(np.concatenate(groups))), "logloss_gain": float(gain.mean()), "low": lo, "high": hi}


def _deciles(frame: pl.DataFrame, feature: str) -> dict:
    """EV after fees in the feature's extreme deciles: hold to settlement or scalp 60 s, on the side it points to."""
    f = frame.drop_nulls([feature]).filter(pl.col(feature).is_finite())
    if f.height < 500 or f[feature].n_unique() < 10:
        return {}
    q10, q90 = f[feature].quantile(.1), f[feature].quantile(.9)
    top, bottom = f.filter(pl.col(feature) >= q90), f.filter(pl.col(feature) <= q10)
    moved = f.drop_nulls("mid_60")
    rho = spearmanr(moved[feature].to_numpy(), (moved["mid_60"] - moved["mid"]).to_numpy()).statistic if moved.height > 100 else None
    out = {"spearman_dmid60": None if rho is None else float(rho)}
    for name, part, side in (("top", top, "yes"), ("bottom", bottom, "no")):
        for kind in ("ev", "sc"):
            v = part[f"{kind}_{side}"].drop_nulls()
            if v.len() < 30:  # no 60-s-later price in the final minute
                continue
            g = part.drop_nulls(f"{kind}_{side}")["ticker"].to_numpy()
            ci = block_bootstrap(v.to_numpy(), g)
            out[f"{name}_{kind}"] = {"cents": float(v.mean() * 100), "low": ci[0] * 100, "high": ci[1] * 100, "n": v.len()}
    return out


def feature_study() -> tuple[dict, str]:
    panel = _ev(build_panel())
    sample = panel.filter(pl.col("time") % 5000 == 0)  # every 5th second: neighbouring seconds are near-duplicates
    final = panel.filter(pl.col("tau") <= 60, pl.col("window_n") == 60)
    rows, payload = [], {"panel_rows": panel.height, "rounds": panel["ticker"].n_unique(),
                         "from": int(panel["time"].min()), "to": int(panel["time"].max())}
    for feat, label in FEATURES.items():
        frame = final if feat == "required_gap_sd" else sample
        inc, dec = _incremental_logloss(frame, feat), _deciles(frame, feat)
        payload[feat] = {"incremental": inc, "deciles": dec}
        rows.append({
            "feature": label, "rounds": inc.get("rounds"),
            "logloss gain vs Kalshi (x1000)": inc.get("logloss_gain", np.nan) * 1000,
            "95% low": inc.get("low", np.nan) * 1000, "95% high": inc.get("high", np.nan) * 1000,
            "rho vs 60s move": dec.get("spearman_dmid60"),
            "top-decile YES hold (c)": dec.get("top_ev", {}).get("cents"),
            "bottom-decile NO hold (c)": dec.get("bottom_ev", {}).get("cents"),
            "best scalp (c)": max((dec[k]["cents"] for k in ("top_sc", "bottom_sc") if k in dec), default=None),
        })
    # Is Kalshi's own price biased? EV of buying each side at the ask, by price.
    by_price = (
        sample.with_columns(bucket=(pl.col("mid") * 10).floor().clip(0, 9).cast(pl.Int8) * 10)
        .group_by("bucket").agg(seconds=pl.len(), rounds=pl.col("ticker").n_unique(), yes_rate=pl.col("y").mean(),
                                mid=pl.col("mid").mean(), ev_yes_c=pl.col("ev_yes").mean() * 100, ev_no_c=pl.col("ev_no").mean() * 100)
        .sort("bucket").with_columns(pl.format("{}-{}c", "bucket", pl.col("bucket") + 10).alias("YES mid")).drop("bucket")
        .select("YES mid", "seconds", "rounds", "mid", "yes_rate", "ev_yes_c", "ev_no_c")
    )
    def ll(col):
        return pl.struct("y", col).map_batches(
            lambda st: pl.Series([log_loss(st.struct.field("y").filter(st.struct.field(col).is_not_null()), st.struct.field(col).drop_nulls())]),
            returns_scalar=True)
    by_window = (
        sample.with_columns(window=pl.col("hour").cut([4, 12, 17, 21], labels=["0-4 PT", "4-12 PT", "12-17 PT", "17-21 PT", "21-24 PT"], left_closed=True).cast(pl.String))
        .group_by("window").agg(seconds=pl.len(), rounds=pl.col("ticker").n_unique(), kalshi_logloss=ll("mid"), model_logloss=ll("p"),
                                brti_logloss=ll("p_brti"), mean_abs_dmid60_c=(pl.col("mid_60") - pl.col("mid")).abs().mean() * 100)
        .sort("window")
    )
    table = pl.DataFrame(rows)
    payload["by_price"], payload["by_window"] = by_price.to_dicts(), by_window.to_dicts()
    md = [
        "## 2. Which features predict anything after fees", "",
        f"{payload['panel_rows']:,} journal seconds with a fresh book on {payload['rounds']:,} settled rounds; every 5th second "
        "is used (neighbours are near-duplicates); final-minute lock features use the last 60 s of rounds with all 60 BRTI values. "
        "**Log-loss gain** is walk-forward out-of-sample (5 expanding folds by round time): adding the feature to a model that "
        "already knows Kalshi's mid. Positive = new information; the 95% range resamples whole rounds. **Decile EVs** are per contract after the taker fee: buy YES "
        "at the ask in the feature's top decile (NO in its bottom decile) and hold, or scalp out at the bid 60 s later.", "",
        md_table(table, floats=2), "",
        "Kalshi's own price, by level (buy at the ask, hold to settlement, after the taker fee, cents per contract):", "",
        md_table(by_price, floats=3), "",
        "By time of day (lower log-loss is better). The journal has no data from 4 to 10 AM PT, so the 5–8 AM window is studied "
        "on the 10,878-round 1-minute archive in model.py:", "",
        md_table(by_window, floats=4), "",
    ]
    return payload, "\n".join(md)
