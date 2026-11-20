"""Trade journal: every bot fill and miss with its market context, what went wrong, and a forward test of each
registered idea in quant/hypotheses.json.

Offline and read-only on the bot's ledgers (data/bot.db paper, data/bot-live.db live) and data/history.db. It never
touches the engine, the bot, its settings or its orders. Refresh the price history first so recent rounds have context:

    npm run backtest -- --days 10 --fetch-only     # Kalshi rounds + candles, Coinbase 1-min BTC into data/history.db
    python quant/journal.py [--days 14]            # -> output/journal/journal-YYYY-MM-DD.md (+ journal-latest.md)
                                                   #    data/journal.db (rebuilt each run; derived, safe to delete)

Tags are descriptions, not verdicts. A tag earns a rule only through hypotheses.json: an idea is written down with its
pass and kill rules first, then judged on rounds after its registration date, never on the rounds that suggested it.
"""
from __future__ import annotations

import json
import math
import sqlite3
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
from regime_study import ROOT, Spot, fee, ro  # noqa: E402

OUT_DIR = ROOT / "output" / "journal"
DB = ROOT / "data" / "journal.db"
HYP = Path(__file__).resolve().parent / "hypotheses.json"


@dataclass
class Trade:
    book: str  # paper | live | miss-paper | miss-live
    ts: float
    ticker: str
    side: str  # yes = UP, no = DOWN
    price: float
    contracts: float
    edge: Optional[float]
    q: Optional[float]
    secs_left: Optional[float]
    latency_ms: Optional[float]
    result: Optional[str]  # market result yes/no, or "sold"
    pnl: Optional[float]
    close_ts: Optional[int] = None
    ret_1h: Optional[float] = None
    ret_6h: Optional[float] = None
    ret_24h: Optional[float] = None
    ret_7d: Optional[float] = None
    below_high: Optional[float] = None
    vol_1h: Optional[float] = None  # stdev of 1-min BTC returns over the last hour, %
    bid_2m: Optional[float] = None  # our side's bid with 2 min left
    best_bid: Optional[float] = None  # our side's highest bid after entry
    sold: bool = False  # sold before settlement (live); result then holds the market's result
    tags: list = field(default_factory=list)

    @property
    def won(self) -> Optional[int]:
        if self.result in ("yes", "no"):
            return 1 if self.result == self.side else 0
        return None

    @property
    def cents(self) -> Optional[float]:
        """Net per contract, held to settlement, after the taker fee."""
        w = self.won
        return None if w is None else w - self.price - fee(self.price)


# Tags known when the bot decided: each could become a rule, so the report shows what skipping them would have done.
# Tags only known afterwards (HINDSIGHT): what happened, never a rule by themselves.
HINDSIGHT = {"lost_after_leading", "lost_after_20c_up", "won_from_behind", "sold_early"}


def tag(t: Trade, vol_hi: Optional[float]) -> list:
    """What to look at on this trade. Pure; unit-tested."""
    out = []
    up = t.side == "yes"
    if t.ret_6h is not None:
        if up and t.ret_6h < -0.015:
            out.append("up_after_6h_drop")
        if not up and t.ret_6h > 0.015:
            out.append("down_after_6h_rally")
        if (up and t.ret_6h < -0.005) or (not up and t.ret_6h > 0.005):
            out.append("against_6h_trend")
        elif (up and t.ret_6h > 0.005) or (not up and t.ret_6h < -0.005):
            out.append("with_6h_trend")
    if t.below_high is not None and t.below_high < -0.12:
        out.append("crash_regime")
    if vol_hi is not None and t.vol_1h is not None and t.vol_1h >= vol_hi:
        out.append("high_vol")
    if t.price < 0.15:
        out.append("longshot_under_15c")
    if t.price > 0.85:
        out.append("favourite_over_85c")
    if t.edge is not None and t.edge >= 0.06:
        out.append("claimed_edge_6c_plus")
    if t.latency_ms is not None and t.latency_ms > 500:
        out.append("slow_fill_500ms")
    if t.won == 0 and t.bid_2m is not None and t.bid_2m >= 0.70:
        out.append("lost_after_leading")  # winning at 2 min left, lost at settlement
    if t.won == 0 and t.best_bid is not None and t.best_bid >= t.price + 0.20:
        out.append("lost_after_20c_up")  # was worth 20c+ more than paid at some point
    if t.won == 1 and t.bid_2m is not None and t.bid_2m <= 0.30:
        out.append("won_from_behind")
    if t.sold:
        out.append("sold_early")
    return out


def load_trades(since: float) -> list:
    trades = []
    for db, book in (("bot.db", "paper"), ("bot-live.db", "live")):
        if not (ROOT / "data" / db).exists():
            continue
        c = ro(db)
        for r in c.execute("select ts, ticker, side, price, contracts, edge, q, secs_left, latency_ms, result, pnl "
                           "from fills where ts >= ?", (since,)):
            trades.append(Trade(book, *r))
        for ts, tic, side, ask, edge, left in c.execute(
                "select ts, ticker, side, decided_ask, edge, secs_left from misses where ts >= ?", (since,)):
            trades.append(Trade("miss-" + book, ts, tic, side, ask, 0.0, edge, None, left, None, None, None))
    return trades


def enrich(trades: list, spot: Spot) -> None:
    h = ro("history.db")
    for t in trades:
        m = h.execute("select close_ts, result from markets where ticker = ?", (t.ticker,)).fetchone()
        if m:
            t.close_ts = m[0]
            if t.result == "sold":
                t.sold = True
                t.result = m[1] if m[1] in ("yes", "no") else None  # judged as if held, like every other fill
            elif t.result is None and m[1] in ("yes", "no"):
                t.result = m[1]  # misses, and fills the bot has not settled yet
        t.ret_1h = spot.ret(t.ts, 3600)
        t.ret_6h = spot.ret(t.ts, 6 * 3600)
        t.ret_24h = spot.ret(t.ts, 86400)
        t.ret_7d = spot.ret(t.ts, 7 * 86400)
        t.below_high = spot.below_high(t.ts)
        t.vol_1h = vol(spot, t.ts)
        if t.close_ts:
            rows = h.execute("select ts, bid, ask, bid_hi, ask_lo from candles where ticker = ? order by ts",
                             (t.ticker,)).fetchall()
            up = t.side == "yes"
            for ts, bid, ask, bid_hi, ask_lo in rows:
                mine = bid if up else (None if ask is None else 1 - ask)
                hi = bid_hi if up else (None if ask_lo is None else 1 - ask_lo)
                if ts == t.close_ts - 120:
                    t.bid_2m = mine
                if ts > t.ts and ts < t.close_ts and hi is not None:
                    t.best_bid = hi if t.best_bid is None else max(t.best_bid, hi)


def vol(spot: Spot, t: float) -> Optional[float]:
    import bisect
    i = bisect.bisect_right(spot.ts, t)
    j = bisect.bisect_left(spot.ts, t - 3600)
    px = spot.px[j:i]
    if len(px) < 40:
        return None
    r = [px[k] / px[k - 1] - 1 for k in range(1, len(px))]
    m = sum(r) / len(r)
    return math.sqrt(sum((x - m) ** 2 for x in r) / (len(r) - 1)) * 100


def summarize(rows: list) -> Optional[dict]:
    xs = [t for t in rows if t.cents is not None]
    if not xs:
        return None
    c = [t.cents for t in xs]
    n = len(c)
    m = sum(c) / n
    se = math.sqrt(sum((x - m) ** 2 for x in c) / max(1, n - 1) / n) if n > 1 else float("nan")
    dollars = sum(t.cents * t.contracts for t in xs)
    return {"n": n, "paid": sum(t.price for t in xs) / n, "won": sum(t.won for t in xs) / n, "cents": m, "se": se,
            "dollars": dollars}


def line(label: str, s: Optional[dict], extra: str = "") -> str:
    if not s:
        return f"| {label} | 0 | | | | | {extra} |"
    return (f"| {label} | {s['n']} | {s['paid']*100:.0f}¢ | {s['won']*100:.0f}% | {s['cents']*100:+.1f}¢ ± "
            f"{s['se']*100:.1f} | {s['dollars']:+.2f} | {extra} |")


def market_up_after_6h_drop(spot: Spot, since: float) -> dict:
    """Market-wide forward check for H1: UP at the ask with 5 min left, tagged rounds against the rest."""
    h = ro("history.db")
    tagged, rest = [], []
    days = set()
    for tic, close, res in h.execute("select ticker, close_ts, result from markets where series='KXBTC15M' "
                                     "and result in ('yes','no') and close_ts >= ?", (since,)):
        c = h.execute("select bid, ask from candles where ticker = ? and ts = ?", (tic, close - 300)).fetchone()
        if not c or c[0] is None or c[1] is None or not (0.03 <= c[1] <= 0.97):
            continue
        r = spot.ret(close - 300, 6 * 3600)
        if r is None:
            continue
        x = (1 if res == "yes" else 0) - c[1] - fee(c[1])
        if r < -0.015:
            tagged.append(x)
            days.add(datetime.fromtimestamp(close, timezone.utc).date())
        else:
            rest.append(x)

    def ms(v):
        if len(v) < 2:
            return (len(v), float("nan"), float("nan"))
        m = sum(v) / len(v)
        return (len(v), m, math.sqrt(sum((a - m) ** 2 for a in v) / (len(v) - 1) / len(v)))
    return {"tagged": ms(tagged), "rest": ms(rest), "days": len(days)}


MARKET_CHECKS = {"up_after_6h_drop": market_up_after_6h_drop}


def judge(h: dict, trades: list, spot: Spot) -> list:
    since = datetime.fromisoformat(h["registered"]).replace(tzinfo=timezone.utc).timestamp() + 86400  # day after
    out = [f"### {h['id']} — {h['idea']}", "", f"Status **{h['status']}**, registered {h['registered']}; "
           f"judged on rounds from {datetime.fromtimestamp(since, timezone.utc).date()} on.", ""]
    fwd = [t for t in trades if t.book in ("paper", "live") and t.ts >= since]
    other = h.get("compare_tag")
    s_tag = summarize([t for t in fwd if h["tag"] in t.tags])
    s_rest = summarize([t for t in fwd if (other in t.tags if other else h["tag"] not in t.tags)])
    out += ["| bot fills since registration | n | avg paid | won | per contract | $ | |", "|---|---|---|---|---|---|---|",
            line(f"tagged `{h['tag']}`", s_tag), line(f"tagged `{other}`" if other else "the rest", s_rest)]
    if s_tag and s_rest and s_tag["n"] > 1 and s_rest["n"] > 1:
        d = s_tag["cents"] - s_rest["cents"]
        se = math.sqrt(s_tag["se"] ** 2 + s_rest["se"] ** 2)
        out += ["", f"Difference {d*100:+.1f}¢ ± {se*100:.1f} a contract."]
    out.append("")
    fn = MARKET_CHECKS.get(h.get("market_check", ""))
    if fn:
        r = fn(spot, since)
        (n1, m1, se1), (n2, m2, se2) = r["tagged"], r["rest"]
        if n1 >= 2 and n2 >= 2:
            diff = m1 - m2
            se = math.sqrt(se1 ** 2 + se2 ** 2)
            out.append(f"Market-wide since registration: tagged {n1} rounds over {r['days']} days "
                       f"{m1*100:+.1f}¢, the rest {n2} rounds {m2*100:+.1f}¢; difference {diff*100:+.1f}¢ ± {se*100:.1f}.")
        else:
            out.append(f"Market-wide since registration: {n1} tagged rounds so far — too early.")
        out.append("")
    out += [f"Pass: {h['pass_rule']}", "", f"Kill: {h['kill_rule']}", ""]
    return out


def write_db(trades: list) -> None:
    DB.unlink(missing_ok=True)
    c = sqlite3.connect(DB)
    c.execute("create table journal(book text, ts real, ticker text, side text, price real, contracts real, edge real, "
              "q real, secs_left real, latency_ms real, result text, pnl real, cents real, ret_1h real, ret_6h real, "
              "ret_24h real, ret_7d real, below_high real, vol_1h real, bid_2m real, best_bid real, tags text)")
    c.executemany("insert into journal values (" + ",".join("?" * 22) + ")", [
        (t.book, t.ts, t.ticker, t.side, t.price, t.contracts, t.edge, t.q, t.secs_left, t.latency_ms, t.result, t.pnl,
         t.cents, t.ret_1h, t.ret_6h, t.ret_24h, t.ret_7d, t.below_high, t.vol_1h, t.bid_2m, t.best_bid,
         ",".join(t.tags)) for t in trades])
    c.commit()
    c.close()


def report(trades: list, days: float, spot: Spot) -> list:
    now = datetime.now(timezone.utc)
    recent_cut = now.timestamp() - days * 86400
    fills = [t for t in trades if t.book in ("paper", "live")]
    recent = [t for t in fills if t.ts >= recent_cut]
    lines = [f"# Trade journal — {now:%Y-%m-%d %H:%M} UTC", "",
             "Held-to-settlement result per contract after the taker fee, ± one standard error. `$` is that times the "
             "contracts bought (fills sold early count at settlement value here, so `$` is what holding would have "
             "made). Nothing here is a rule; ideas are tested in the Hypotheses section.", ""]
    last = max((t.ts for t in fills), default=None)
    ctx = [t for t in recent if t.ret_6h is not None]
    lines += [f"Fills in the last {days:g} days: {len(recent)} ({sum(t.book == 'live' for t in recent)} live). "
              f"Last fill {datetime.fromtimestamp(last, timezone.utc):%Y-%m-%d %H:%M} UTC. "
              f"Market context found for {len(ctx)} of them" + (" — refresh history.db." if len(ctx) < len(recent) else "."), ""]
    n_now = spot.at(now.timestamp() - 600)
    if n_now:
        t0 = now.timestamp() - 600
        r6, r24, r7 = (spot.ret(t0, s) for s in (6 * 3600, 86400, 7 * 86400))
        bh = spot.below_high(t0)
        f = lambda x: "–" if x is None else f"{x*100:+.1f}%"
        lines += [f"## Market now", "", f"BTC {n_now:,.0f}: 6 h {f(r6)}, 24 h {f(r24)}, 7 d {f(r7)}, "
                  f"{f(bh)} from the 7-day high.", ""]

    for book in ("live", "paper"):
        rows = [t for t in recent if t.book == book]
        if not rows:
            continue
        lines += [f"## {book.capitalize()} fills, last {days:g} days", "",
                  "| group | n | avg paid | won | per contract | $ | note |", "|---|---|---|---|---|---|---|",
                  line("all", summarize(rows)),
                  line("UP (yes)", summarize([t for t in rows if t.side == "yes"])),
                  line("DOWN (no)", summarize([t for t in rows if t.side == "no"]))]
        names = sorted({g for t in rows for g in t.tags})
        for g in [g for g in names if g not in HINDSIGHT]:
            s = summarize([t for t in rows if g in t.tags])
            note = f"skipping these: {-s['dollars']:+.2f}" if s and s["n"] >= 5 else ""
            lines.append(line(f"`{g}`", s, note))
        hind = [g for g in names if g in HINDSIGHT]
        if hind:
            lines += ["", "Known only afterwards (what happened, not a rule):", "",
                      "| group | n | avg paid | won | per contract | $ | note |", "|---|---|---|---|---|---|---|"]
            for g in hind:
                sel = [t for t in rows if g in t.tags]
                note = ""
                if g == "sold_early":
                    real = sum(t.pnl or 0 for t in sel)
                    hold = sum(t.cents * t.contracts for t in sel if t.cents is not None)
                    note = f"actual {real:+.2f} vs held {hold:+.2f}"
                lines.append(line(f"`{g}`", summarize(sel), note))
        lines.append("")

    lines += ["## Model calibration (all fills, all time)", "",
              "Does the bot's probability for its own side match how often that side won? A claimed edge that does not "
              "show up here is the model being too sure.", "",
              "| model's probability | n | avg model | won | avg paid |", "|---|---|---|---|---|"]
    for lo, hi in ((0, .2), (.2, .4), (.4, .6), (.6, .8), (.8, 1.01)):
        sel = [t for t in fills if t.q is not None and t.won is not None and lo <= t.q < hi]
        if sel:
            lines.append(f"| {lo:.0%}–{min(hi,1):.0%} | {len(sel)} | {sum(t.q for t in sel)/len(sel):.0%} | "
                         f"{sum(t.won for t in sel)/len(sel):.0%} | {sum(t.price for t in sel)/len(sel)*100:.0f}¢ |")
    claimed = [t.edge for t in fills if t.edge is not None and t.cents is not None]
    real = summarize(fills)
    if claimed and real:
        lines += ["", f"Claimed edge {sum(claimed)/len(claimed)*100:+.1f}¢ a contract on average; realized "
                  f"{real['cents']*100:+.1f}¢ ± {real['se']*100:.1f} over {real['n']} fills.", ""]

    miss = [t for t in trades if t.book.startswith("miss") and t.ts >= recent_cut]
    if miss:
        s = summarize(miss)
        lines += ["## Missed fills", "", "Orders the ask moved away from before they filled. If these would have won, "
                  "speed is costing money; if they would have lost, the misses were lucky.", "",
                  "| | n | ask | won | per contract | | |", "|---|---|---|---|---|---|---|", line("misses", s), ""]

    worst = sorted([t for t in recent if t.cents is not None and t.won == 0], key=lambda t: t.cents * t.contracts)[:10]
    if worst:
        lines += ["## Biggest losses, last period", "", "| when (UTC) | book | side | paid | contracts | 6 h BTC | 2-min bid | best bid | tags |",
                  "|---|---|---|---|---|---|---|---|---|"]
        for t in worst:
            f = lambda x, p=True: "–" if x is None else (f"{x*100:+.1f}%" if p else f"{x*100:.0f}¢")
            lines.append(f"| {datetime.fromtimestamp(t.ts, timezone.utc):%m-%d %H:%M} | {t.book} | "
                         f"{'UP' if t.side == 'yes' else 'DOWN'} | {t.price*100:.0f}¢ | {t.contracts:g} | {f(t.ret_6h)} | "
                         f"{f(t.bid_2m, False)} | {f(t.best_bid, False)} | {', '.join(t.tags)} |")
        lines.append("")

    hyps = json.loads(HYP.read_text(encoding="utf-8")) if HYP.exists() else []
    lines += ["## Hypotheses (forward test only)", ""]
    for h in hyps:
        if h.get("status") in ("testing", "proposed"):
            lines += judge(h, trades, spot)
    done = [h for h in hyps if h.get("status") not in ("testing", "proposed")]
    if done:
        lines += ["Closed: " + ", ".join(f"{h['id']} ({h['status']})" for h in done), ""]
    return lines


def main() -> None:
    days = 14.0
    if "--days" in sys.argv:
        days = float(sys.argv[sys.argv.index("--days") + 1])
    spot = Spot()
    trades = load_trades(0)
    enrich(trades, spot)
    vols = sorted(t.vol_1h for t in trades if t.vol_1h is not None)
    vol_hi = vols[int(len(vols) * 0.75)] if len(vols) >= 20 else None
    for t in trades:
        t.tags = tag(t, vol_hi)
    write_db(trades)
    lines = report(trades, days, spot)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    text = "\n".join(lines)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    (OUT_DIR / f"journal-{stamp}.md").write_text(text, encoding="utf-8")
    (OUT_DIR / "journal-latest.md").write_text(text, encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
