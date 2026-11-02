"""Part 2a: LightGBM models with strict walk-forward splits and isotonic calibration.

    uv run python model.py

Three models, each trained only on rounds that closed before its test block (expanding window, 6 folds by round time,
the last 20% of each training window held out for early stopping and Platt calibration). Settlement models boost
from Kalshi's price (init score = logit mid), so they can only add corrections to it:

  history  — settles YES? on the 10,878-round archive, one row per minute left (Kalshi 1-min bid/ask, 1-min BTC).
  journal  — settles YES? on the 1,000-round 1-s journal (book, BRTI, lock math, flow), every 5th second.
  scalp    — net P&L in cents of buying YES (or NO) at the ask and selling at the bid 60 s later, two taker fees.

Out-of-sample predictions go to quant/cache/pred_<name>.parquet for backtest.py; scores to output/quant/model.json.
"""
from __future__ import annotations

import sys

import lightgbm as lgb
import numpy as np
import polars as pl
from sklearn.linear_model import LogisticRegression

from common import CACHE_PANEL, block_bootstrap, brier, close_from_ticker, log_loss, md_table, pt_hour, taker_fee, write_json
from data import load
from features import _ev, build_panel

CACHE = CACHE_PANEL.parent
FOLDS = 6
PARAMS = dict(objective="binary", learning_rate=0.03, num_leaves=15, min_child_samples=300, feature_fraction=0.8,
              bagging_fraction=0.8, bagging_freq=1, lambda_l2=10.0, verbose=-1, seed=7)


def history_panel() -> pl.DataFrame:
    """One row per round per minute left (1–14), at the minute's end, from history.db."""
    rounds = load("rounds").with_columns(pl.col("result").eq("yes").cast(pl.Int8).alias("y"))
    candles = load("candles").filter(pl.col("bid") > 0, pl.col("ask") < 1, pl.col("ask") > pl.col("bid"))
    # Coinbase-style candles are stamped at their start; the close is the price at start + 60 s.
    spot = load("spot").select((pl.col("time") + 60000).alias("time"), pl.col("close").alias("spot")).sort("time")
    spot = spot.with_columns(r1=pl.when(pl.col("time").diff() == 60000).then((pl.col("spot") / pl.col("spot").shift(1)).log())).with_columns(
        vol60=pl.col("r1").rolling_std(window_size=60, min_samples=30),
        mom5=(pl.col("spot") / pl.col("spot").shift(5)).log(), mom15=(pl.col("spot") / pl.col("spot").shift(15)).log(),
    )
    p = (
        candles.join(rounds.select("ticker", "close", "strike", "y"), on="ticker")
        .with_columns(m=((pl.col("close") - pl.col("time")) / 60000).round(0).cast(pl.Int32))
        .filter(pl.col("m").is_between(1, 14))
        .join(spot, on="time", how="inner")
        .with_columns(
            mid=(pl.col("bid") + pl.col("ask")) / 2, spread=pl.col("ask") - pl.col("bid"),
            yes_ask=pl.col("ask"), yes_bid=pl.col("bid"), hour=pt_hour("time"), tau=pl.col("m") * 60,
            dist_sd=(pl.col("spot") / pl.col("strike")).log() / (pl.col("vol60") * pl.col("m").cast(pl.Float64).sqrt()),
            mom1=pl.col("r1"), log_vol60=pl.col("vol60").log(),
        )
        .drop_nulls(["dist_sd", "mom15"]).filter(pl.col("dist_sd").is_finite())
    )
    lm = pl.col("mid").clip(.005, .995)
    return p.with_columns(
        logit_mid=(lm / (1 - lm)).log(), high_vol=pl.col("hour").is_between(5, 7).cast(pl.Int8),
        hour_sin=(pl.col("hour") * 2 * np.pi / 24).sin(), hour_cos=(pl.col("hour") * 2 * np.pi / 24).cos(),
    ).sort("time")


HISTORY_FEATURES = ["logit_mid", "spread", "dist_sd", "mom1", "mom5", "mom15", "log_vol60", "m", "hour_sin", "hour_cos", "high_vol"]
JOURNAL_FEATURES = ["logit_mid", "spread", "gap_model", "gap_brti", "dist_sd", "imb5", "imbalance", "flow_ratio", "mom30", "mom120",
                    "proxy_minus_brti", "velocity_div1", "velocity_div5", "log_sigma", "tau", "n_locked", "required_gap_sd", "hour"]


def _round_order(frame: pl.DataFrame) -> np.ndarray:
    return frame.group_by("ticker").agg(pl.col("time").min()).sort("time")["ticker"].to_numpy()


def walk_forward(frame: pl.DataFrame, features: list[str], target: str, objective: str = "binary") -> pl.DataFrame:
    """Out-of-sample predictions for every test block. Training rounds all close before the test block opens."""
    order = _round_order(frame)
    edges = np.linspace(0, len(order), FOLDS + 2).astype(int)
    preds, importance = [], np.zeros(len(features))
    for k in range(1, FOLDS + 1):
        train_rounds, test_rounds = order[: edges[k]], order[edges[k]: edges[k + 1]]
        cut = int(len(train_rounds) * 0.8)
        fit = frame.filter(pl.col("ticker").is_in(train_rounds[:cut]))
        cal = frame.filter(pl.col("ticker").is_in(train_rounds[cut:]))
        test = frame.filter(pl.col("ticker").is_in(test_rounds))
        # Embargo: the calibration block must have settled before the first test second.
        test = test.filter(pl.col("time") > cal["C"].max()) if "C" in cal.columns else test
        if fit.height < 2000 or test.height == 0:
            continue
        X = lambda d: d.select(features).to_numpy()
        params = {**PARAMS, "objective": objective}
        if objective != "binary":
            params["metric"] = "l2"
        # Settlement models boost from Kalshi's own price (init score = logit mid): the trees learn only corrections to it.
        base = (lambda d: d["logit_mid"].to_numpy()) if objective == "binary" else (lambda d: None)
        model = lgb.train(params, lgb.Dataset(X(fit), fit[target].to_numpy(), init_score=base(fit)), num_boost_round=2000,
                          valid_sets=[lgb.Dataset(X(cal), cal[target].to_numpy(), init_score=base(cal))],
                          callbacks=[lgb.early_stopping(100, verbose=False)])
        if objective == "binary":
            score = lambda d: model.predict(X(d), raw_score=True) + base(d)
            # Platt scaling on the held-out block: two parameters, safe on small samples.
            platt = LogisticRegression(C=1e4).fit(score(cal).reshape(-1, 1), cal[target].to_numpy())
            pred = platt.predict_proba(score(test).reshape(-1, 1))[:, 1].clip(.001, .999)
        else:
            pred = model.predict(X(test))
        importance += model.feature_importance("gain")
        preds.append(test.with_columns(pred=pl.Series(pred), fold=pl.lit(k), trees=pl.lit(model.best_iteration)))
    out = pl.concat(preds)
    out.importance = dict(zip(features, (importance / max(importance.sum(), 1)).round(4)))  # type: ignore[attr-defined]
    return out


def _score(pred: pl.DataFrame, label: str) -> dict:
    y, p, m = pred["y"].to_numpy(), pred["pred"].to_numpy(), pred["mid"].clip(.001, .999).to_numpy()
    ll = lambda q: -(y * np.log(np.clip(q, 1e-4, 1 - 1e-4)) + (1 - y) * np.log(np.clip(1 - q, 1e-4, 1 - 1e-4)))
    gain = ll(m) - ll(p)
    lo, hi = block_bootstrap(gain, pred["ticker"].to_numpy())
    by_fold = pred.group_by("fold").agg(rows=pl.len(), rounds=pl.col("ticker").n_unique(),
        model_brier=((pl.col("pred") - pl.col("y")) ** 2).mean(), kalshi_brier=((pl.col("mid") - pl.col("y")) ** 2).mean()).sort("fold")
    return {"dataset": label, "rows": pred.height, "rounds": pred["ticker"].n_unique(),
            "model_logloss": log_loss(y, p), "kalshi_logloss": log_loss(y, m), "model_brier": brier(y, p), "kalshi_brier": brier(y, m),
            "gain_vs_kalshi_x1000": float(gain.mean() * 1000), "low_x1000": lo * 1000, "high_x1000": hi * 1000,
            "by_fold": by_fold.to_dicts()}


def train_all():
    out, md = {}, ["## 3. Walk-forward models (out of sample)", ""]
    hist = history_panel().with_columns(C=pl.col("close"))
    print(f"[model] history panel {hist.height:,} rows, {hist['ticker'].n_unique():,} rounds", file=sys.stderr)
    ph = walk_forward(hist, HISTORY_FEATURES, "y")
    ph.write_parquet(CACHE / "pred_history.parquet")
    out["history"] = {**_score(ph, "history"), "importance": ph.importance}

    journal = _ev(build_panel()).filter(pl.col("time") % 5000 == 0)
    journal = journal.with_columns(pl.col(f) .cast(pl.Float64) for f in JOURNAL_FEATURES)
    print(f"[model] journal panel {journal.height:,} rows, {journal['ticker'].n_unique():,} rounds", file=sys.stderr)
    pj = walk_forward(journal, JOURNAL_FEATURES, "y")
    pj.write_parquet(CACHE / "pred_journal.parquet")
    out["journal"] = {**_score(pj, "journal"), "importance": pj.importance}

    scalp = journal.drop_nulls(["sc_yes", "sc_no"]).with_columns(sc_yes_c=pl.col("sc_yes") * 100, sc_no_c=pl.col("sc_no") * 100)
    sy = walk_forward(scalp, JOURNAL_FEATURES, "sc_yes_c", objective="regression").rename({"pred": "pred_sc_yes"})
    sn = walk_forward(scalp, JOURNAL_FEATURES, "sc_no_c", objective="regression").select("ticker", "time", pl.col("pred").alias("pred_sc_no"))
    ps = sy.join(sn, on=["ticker", "time"])
    ps.write_parquet(CACHE / "pred_scalp.parquet")
    corr = lambda a, b: float(np.corrcoef(ps[a].to_numpy(), ps[b].to_numpy())[0, 1])
    out["scalp"] = {"rows": ps.height, "rounds": ps["ticker"].n_unique(), "corr_yes": corr("pred_sc_yes", "sc_yes_c"), "corr_no": corr("pred_sc_no", "sc_no_c"),
                    "mean_actual_yes_c": float(ps["sc_yes_c"].mean()), "mean_actual_no_c": float(ps["sc_no_c"].mean()),
                    "share_pred_positive": float(((ps["pred_sc_yes"] > 0) | (ps["pred_sc_no"] > 0)).mean())}
    rows = [{k: v for k, v in out[n].items() if k in ("dataset", "rows", "rounds", "model_logloss", "kalshi_logloss", "model_brier", "kalshi_brier",
                                                        "gain_vs_kalshi_x1000", "low_x1000", "high_x1000")} for n in ("history", "journal")]
    imp = lambda n: ", ".join(f"{k} {v:.0%}" for k, v in sorted(out[n]["importance"].items(), key=lambda kv: -kv[1])[:6])
    md += [
        "Settlement models. Gain = Kalshi mid's log-loss minus the model's (×1000), positive = the model forecasts better; "
        "95% range resamples whole rounds.", "", md_table(pl.DataFrame(rows), floats=4), "",
        f"Top features (share of split gain): history — {imp('history')}; journal — {imp('journal')}.", "",
        f"Scalp model (60-s round trip, net of two taker fees): correlation of predicted with actual P&L is {out['scalp']['corr_yes']:.3f} (YES) / "
        f"{out['scalp']['corr_no']:.3f} (NO) on {out['scalp']['rows']:,} out-of-sample seconds; the average actual round trip is "
        f"{out['scalp']['mean_actual_yes_c']:.2f}¢ (YES) / {out['scalp']['mean_actual_no_c']:.2f}¢ (NO).", "",
    ]
    write_json("model.json", out)
    return out, "\n".join(md)


if __name__ == "__main__":
    _, md = train_all()
    print(md)
