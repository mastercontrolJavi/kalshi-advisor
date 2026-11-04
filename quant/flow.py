"""Part 1c: do order flow and the perp futures lead add anything to Kalshi's price, after fees? (DECISIONS 71)

The engine's flow worker records 250 ms bars to data/flow.db (or FLOW_DB) from 2026-11-02: Coinbase spot, Binance and Bybit BTCUSDT
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

from common import block_bootstrap, md_table, taker_fee
from data import flow_db, load
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
    if not flow_db().exists():
        return None
    bars = load("flow", refresh=True)
    if bars.height == 0:
        return None
    vol = lambda c: pl.col(c).fill_null(0)
    for c in ("bn_bid", "bn_mark"):
        if c not in bars.columns:
            bars = bars.with_columns(pl.lit(None, dtype=pl.Float64).alias(c))
    s = (
        bars.with_columns(s=(pl.col("t") // 1000 + 1) * 1000)
        .group_by("s").agg(
            bars=pl.len(),
            spot_buy=vol("cb_buy").sum(), spot_sell=vol("cb_sell").sum(),
            perp_buy=(vol("bn_buy") + vol("by_buy")).sum(), perp_sell=(vol("bn_sell") + vol("by_sell")).sum(),
            bn_buy=vol("bn_buy").sum(), bn_sell=vol("bn_sell").sum(), by_buy=vol("by_buy").sum(), by_sell=vol("by_sell").sum(),
            # A venue frame in this second: a trade (any venue), or Binance's depth or mark stream (they keep it alive too).
            cb_frame=(vol("cb_n") > 0).any(), by_frame=(vol("by_n") > 0).any(),
            bn_frame=((vol("bn_n") > 0) | pl.col("bn_bid").is_not_null() | pl.col("bn_mark").is_not_null()).any(),
            spot=pl.col("cb_last").drop_nulls().last(), perp=pl.coalesce("bn_last", "by_last").drop_nulls().last(),
            mark=pl.col("bn_mark").drop_nulls().last(), index=pl.col("bn_index").drop_nulls().last(),
        )
    )
    grid = pl.DataFrame({"s": np.arange(s["s"].min(), s["s"].max() + 1000, 1000, dtype=np.int64)})
    s = grid.join(s, on="s", how="left").sort("s").with_columns(
        pl.col("bars", "spot_buy", "spot_sell", "perp_buy", "perp_sell", "bn_buy", "bn_sell", "by_buy", "by_sell").fill_null(0),
        pl.col("cb_frame", "bn_frame", "by_frame").fill_null(False),
        pl.col("spot", "perp", "mark", "index").forward_fill(limit=5),
    )
    # The card's health gates, rebuilt from the bars (code review on PR #6). A venue is healthy while it sent a frame within
    # FLOW_SILENT_MS = 3 s (flow.ts healthy(); its feed-delay test is not replayed). The pulse is current only when the worker
    # wrote bars this second (it writes every 250 ms, and the card drops a pulse older than 1.5 s); it is usable only with
    # Coinbase and at least one perp healthy (flow.ts: healthy = spotOk && perpVenue).
    alive = lambda c: pl.col(c).cast(pl.Int8).rolling_max(window_size=3, min_samples=1) == 1
    s = s.with_columns(cb_alive=alive("cb_frame"), bn_alive=alive("bn_frame"), by_alive=alive("by_frame")).with_columns(
        pulse_ok=(pl.col("bars") > 0) & pl.col("cb_alive") & (pl.col("bn_alive") | pl.col("by_alive")),
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
    # Only healthy venues vote (flow.ts side()): a perp that went silent drops out of the 60 s perp volumes; with no healthy
    # venue on a side its vote is null (FLOW UNKNOWN), and with no usable pulse every vote and the impulse are null.
    vote = lambda buy, sell, lo: pl.when((buy + sell) < lo).then(0).when(buy / (buy + sell) >= .55).then(1).when(buy / (buy + sell) <= .45).then(-1).otherwise(0)
    healthy_sum = lambda col: (pl.when(pl.col("bn_alive")).then(roll(f"bn_{col}", 60)).otherwise(0)
                               + pl.when(pl.col("by_alive")).then(roll(f"by_{col}", 60)).otherwise(0))
    usable = pl.col("pulse_ok") & cover(60)
    s = s.with_columns(
        spot_vote=pl.when(usable).then(vote(roll("spot_buy", 60), roll("spot_sell", 60), .25)),
        perp_vote=pl.when(usable).then(vote(healthy_sum("buy"), healthy_sum("sell"), 2)),
        impulse=pl.when(pl.col("pulse_ok") & pl.col("lead_z").is_not_null()).then(
            pl.when((pl.col("lead_z") >= 2) & (pl.col("lead1") >= 5)).then(1).when((pl.col("lead_z") <= -2) & (pl.col("lead1") <= -5)).then(-1).otherwise(0)),
    )
    # The card's impulse memory (master-signal.ts nextImpulse): the last impulse in either direction and when it fired,
    # recorded only from a current, healthy pulse and kept (not refreshed) while the pulse is stale.
    fired = pl.col("impulse").fill_null(0) != 0
    return s.with_columns(
        votes=pl.col("spot_vote") + pl.col("perp_vote") + pl.col("impulse"),
        last_impulse=pl.when(fired).then(pl.col("impulse")).forward_fill(),
        last_impulse_at=pl.when(fired).then(pl.col("s")).forward_fill(),
    ).rename({"s": "time"})


# ---------------------------------------------------------------------------------------------------------------------
# Master Signal replay (src/engine/master-signal.ts, DECISIONS 73)
# ---------------------------------------------------------------------------------------------------------------------

FLIP_BAND = .02         # live.ts: the live call flips only past 50% ± 2 points
IMPULSE_HOLD_MS = 5000  # master-signal.ts: a perp impulse counts for 5 s
MIN_ENTRY_TAU = 60      # config.finalMinuteSignals is off: entries close with 60 s left
STAGES = {
    "live": "Follow the live call",
    "agree": "+ opening call agrees (or none yet)",
    "flow": "+ FLOW CONFIRMED",
    "strong": "+ perp impulse ≤ 5 s = STRONG BUY",
}


def live_direction(frame: pl.DataFrame) -> pl.Series:
    """The engine's live call (index.ts + live.ts nextDirection): q with a ±2-point flip band, reset each round; null with no q."""
    out, state, ticker = [], None, None
    for t, q in zip(frame["ticker"], frame["q"]):
        if t != ticker:
            state, ticker = None, t
        if q is None:
            out.append(None); continue
        if state is None:
            state = 1 if q >= .5 else -1
        elif state == 1 and q <= .5 - FLIP_BAND:
            state = -1
        elif state == -1 and q >= .5 + FLIP_BAND:
            state = 1
        out.append(state)
    return pl.Series("live_dir", out, dtype=pl.Int8)


def _cents_up(x: pl.Expr) -> pl.Expr:
    return (x * 100 - 1e-9).ceil() / 100


def maker_price(bid: pl.Expr, ask: pl.Expr) -> pl.Expr:
    """makerEntryPrice on 1¢ ticks: a tick above the bid when that is still below the ask, else the bid; no bid → a tick
    under the ask; null when nothing legal is below the ask. (The 0.1¢ tail ticks are ignored: those prices are rare here.)"""
    below = _cents_up(ask) - .01
    up = (bid * 100 + 1e-9).floor() / 100 + .01
    price = pl.when(bid.is_null() | (bid <= 0) | (bid >= ask)).then(below).when(up < ask - 1e-9).then(up).otherwise(bid)
    return pl.when(below > 0).then(price)


def live_calls(ticks: pl.DataFrame) -> pl.DataFrame:
    """The live call at every journal second, from the complete tick stream: the engine updates its remembered direction
    on every tick (index.ts), including the seconds build_panel() drops (stale or invalid books), so the band's state has
    to be carried through those seconds too (code review on PR #6)."""
    t = ticks.select("ticker", "time", "q").unique(["ticker", "time"], keep="first").sort("ticker", "time")
    return t.select("ticker", "time").with_columns(live_direction(t))


def master_stages(panel: pl.DataFrame, opening: pl.DataFrame, ticks: pl.DataFrame | None = None) -> pl.DataFrame:
    """Per journal second: the side the card would take and how far down its STRONG BUY checklist it gets.

    `panel` needs ticker, time, tau, q, yes_bid, yes_ask, y, pulse_ok, spot_vote, perp_vote, impulse, last_impulse and
    last_impulse_at. `ticks` is the unfiltered journal (ticker, time, q) the live call's state is carried through; without
    it the panel's own q is used. Not replayed: the stale-book breaker (the panel keeps only fresh, valid books).
    """
    p = panel.sort("ticker", "time")
    calls = live_calls(p if ticks is None else ticks)
    p = p.join(calls, on=["ticker", "time"], how="left").join(
        opening.select("ticker", pl.col("time").alias("open_at"),
                       pl.when(pl.col("direction") == "UP").then(1).otherwise(-1).cast(pl.Int8).alias("open_dir")),
        on="ticker", how="left",
    )
    d = pl.col("live_dir")
    no_ask = 1 - pl.col("yes_bid")
    ask = pl.when(d == 1).then(pl.col("yes_ask")).otherwise(no_ask)
    bid = pl.when(d == 1).then(pl.col("yes_bid")).otherwise(1 - pl.col("yes_ask"))
    opening_now = pl.when(pl.col("time") >= pl.col("open_at")).then(pl.col("open_dir"))
    p = p.with_columns(
        side_ask=ask, side_bid=bid,
        live=d.is_not_null() & (pl.col("tau") >= MIN_ENTRY_TAU) & ask.is_between(0, 1, closed="none"),
        agree=opening_now.is_null() | (opening_now == d),
        # flowAlignment on a current, healthy pulse (master-signal.ts pulseCurrent, flow.ts): otherwise FLOW UNKNOWN.
        # A missing impulse counts as not against, as in flow.ts (votes.impulse ?? 0).
        flow=pl.col("pulse_ok") & (pl.col("spot_vote") == d) & (pl.col("perp_vote") == d) & (pl.col("impulse").fill_null(0) != -d),
        recent=(pl.col("last_impulse") == d) & (pl.col("time") - pl.col("last_impulse_at") <= IMPULSE_HOLD_MS),
        won=pl.when(d == 1).then(pl.col("y")).otherwise(1 - pl.col("y")),
    ).with_columns(
        agree=pl.col("live") & pl.col("agree"),
    ).with_columns(
        flow=pl.col("agree") & pl.col("flow").fill_null(False),
    ).with_columns(
        strong=pl.col("flow") & pl.col("recent").fill_null(False),
        maker=maker_price(pl.col("side_bid"), pl.col("side_ask")),
    )
    # A resting maker buy fills only if the side's ask later trades through it (strictly below) before the close.
    yes_later = pl.col("yes_ask").reverse().cum_min().reverse().shift(-1).over("ticker")
    no_later = (1 - pl.col("yes_bid")).reverse().cum_min().reverse().shift(-1).over("ticker")
    return p.with_columns(
        maker_filled=pl.col("maker").is_not_null() & (pl.when(d == 1).then(yes_later).otherwise(no_later) < pl.col("maker") - 1e-9),
        taker_ev=pl.col("won") - pl.col("side_ask") - taker_fee(pl.col("side_ask")),
    )


def master_summary(stages: pl.DataFrame) -> pl.DataFrame:
    """Each checklist stage scored at the first second of every run of it (one entry per signal, not one per second)."""
    rows = []
    base = None
    for key, label in STAGES.items():
        on = stages.with_columns(
            start=pl.col(key) & ~(pl.col(key).shift(1).fill_null(False) & (pl.col("live_dir").shift(1) == pl.col("live_dir"))).over("ticker")
        ).filter(pl.col("start"))
        n = on.height
        row = {"stage": label, "signals": n, "rounds": on["ticker"].n_unique() if n else 0,
               "seconds on": int(stages[key].sum())}
        if n:
            g = on["ticker"].to_numpy()
            ev = on["taker_ev"].to_numpy()
            lo, hi = block_bootstrap(ev, g)
            filled = on.filter(pl.col("maker_filled"))
            maker_ev = np.where(on["maker_filled"].to_numpy(), (on["won"] - on["maker"].fill_null(0)).to_numpy(), 0.0)
            mlo, mhi = block_bootstrap(maker_ev, g)
            row |= {
                "win %": float(on["won"].mean() * 100),
                "taker EV (c)": float(ev.mean() * 100), "taker 95% low": lo * 100, "taker 95% high": hi * 100,
                "maker fill %": float(on["maker_filled"].mean() * 100),
                "maker EV if filled (c)": float((filled["won"] - filled["maker"]).mean() * 100) if filled.height else None,
                "maker EV per signal (c)": float(maker_ev.mean() * 100), "maker 95% low": mlo * 100, "maker 95% high": mhi * 100,
            }
            if base is None:
                base = row["taker EV (c)"]
            row["taker vs live call (c)"] = row["taker EV (c)"] - base
        rows.append(row)
    return pl.DataFrame(rows, infer_schema_length=None)


def master_study(panel: pl.DataFrame) -> tuple[dict, str]:
    stages = master_stages(panel, load("opening_calls"), load("ticks").select("ticker", "time", "q"))
    table = master_summary(stages)
    strong = table.filter(pl.col("stage") == STAGES["strong"]).row(0, named=True)
    md = [
        "### 3b. The Master Signal card, replayed", "",
        "Every journal second with flow data, run through the card's STRONG BUY checklist in order. Each stage is scored at the "
        "first second of every run (one entry per signal) on the side the live call names. **Taker**: buy at the ask, hold to "
        "settlement, after the taker fee. **Maker**: rest the card's maker price (a cent above the bid); it fills only if the "
        "ask later trades below it before the close, then holds ($0 maker fee on this series), so unfilled signals count 0. "
        "\"vs live call\" is the stage's taker EV minus simply following the live call: what that layer of the card adds. "
        "95% ranges resample whole rounds.", "",
        md_table(table, floats=1), "",
        f"STRONG BUY fired {strong['signals']} times on {strong['rounds']} rounds. Signals inside one round move together, so "
        "the sample size is the rounds. "
        + ("That is far too few to call: a few cents of EV needs ~300+ rounds before it stands out from luck. The win rate is "
           "not the test either: the card buys favourites at high prices, so it should win often; only EV after the price counts."
           if strong["rounds"] < 300 else "Judge it by the 95% range: an edge needs the low end above 0."), "",
        "Replay approximations: the perp impulse is evaluated once a second here (the engine checks it 4× a second), the "
        "stale-book breaker is replaced by the panel's fresh-book filter, and sub-cent tail ticks are ignored.", "",
    ]
    return {"stages": table.to_dicts()}, "\n".join(md)


def flow_study() -> tuple[dict, str]:
    head = f"## 3. Order flow & the perp futures lead ({flow_db().name})"
    flow = seconds()
    if flow is None:
        return {"rows": 0}, f"{head}\n\nNo flow data yet: the engine's flow worker writes {flow_db()} (FLOW_DB) while it runs.\n"
    card_cols = ["pulse_ok", "spot_vote", "perp_vote", "impulse", "last_impulse", "last_impulse_at"]
    panel = _ev(build_panel()).join(flow.select("time", *FLOW_FEATURES, *card_cols), on="time", how="inner")
    if panel.height == 0:
        # Say why instead of printing an empty table that reads like "not enough data yet".
        built_to = int(build_panel()["time"].max())
        return {"rows": 0, "seconds": flow.height}, (
            f"{head}\n\n**No overlap:** the flow data starts {int(flow['time'].min())} but the settled journal panel ends "
            f"{built_to}. Rebuild the caches with `uv run python research.py flow --refresh`.\n")
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
            "top-decile YES hold vs avg (c)": dec.get("top_ev", {}).get("excess"),
            "bottom-decile NO hold vs avg (c)": dec.get("bottom_ev", {}).get("excess"),
            "best scalp (c)": max((dec[k]["cents"] for k in ("top_sc", "bottom_sc") if k in dec), default=None),
        })
    days = (payload["to"] - payload["from"]) / 86_400_000
    master_payload, master_md = master_study(panel)
    payload["master_signal"] = master_payload
    md = [
        head, "",
        f"{flow.height:,} seconds of flow ({days:.1f} days) overlap {payload['panel_rows']:,} journal seconds on "
        f"{payload['rounds']:,} settled rounds; every 5th second is used. Same tests as section 2: walk-forward log-loss gain "
        "over Kalshi's mid (positive = information Kalshi's price does not have; the 95% range resamples whole rounds), and "
        "decile EVs per contract after the taker fee, **minus the same side's average EV over every second** (so a day when "
        "BTC drifted down does not make every NO decile look like an edge). rho vs 30 s / 60 s move: does the feature lead "
        "Kalshi's own mid?", "",
        md_table(pl.DataFrame(rows), floats=2), "",
        "Fewer than ~300 rounds is too few to call either way; the plan is to re-run after a few days and at 2–3 weeks.", "",
        master_md,
    ]
    return payload, "\n".join(md)
