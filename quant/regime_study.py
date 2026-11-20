"""Regime study: does buying UP during a multi-hour / multi-day BTC downtrend lose more than Kalshi's price implies?

Read-only on data/history.db, data/bot.db and data/bot-live.db. Plain Python (no numpy) so it runs anywhere:

    python quant/regime_study.py            # -> output/quant/regime-study.md

Part A, every KXBTC15M round: Kalshi's ask at a fixed time left, bucketed by the BTC trend at that moment (6 h, 24 h,
7 d return, and distance below the 7-day high). For each bucket: how often UP actually won against what the UP ask
charged, and the same for DOWN. A positive "UP edge" in a down bucket means Kalshi overpriced the trend (UP was
cheap); negative means buying UP in a dump lost more than its price said.

Part B, the bot's own fills (paper + live): win rate against the price paid, split by side and trend bucket.

Trend for the last hours not yet in history.db's spot table is filled from Coinbase's public hourly candles.
"""
from __future__ import annotations

import bisect
import json
import math
import sqlite3
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "output" / "quant" / "regime-study.md"
SECS_LEFT = (600, 300, 120)
FEE_K = 0.07  # Kalshi taker fee per contract 0.07 * p * (1 - p); the bot buys fractional contracts, so unrounded


def ro(name: str) -> sqlite3.Connection:
    c = sqlite3.connect(f"file:{ROOT / 'data' / name}?mode=ro", uri=True)
    c.execute("pragma query_only=1")
    return c


def fee(p: float) -> float:
    return FEE_K * p * (1 - p)


def load_spot() -> tuple[list[int], list[float]]:
    h = ro("history.db")
    rows = h.execute("select ts, close from spot order by ts").fetchall()
    ts = [r[0] for r in rows]
    px = [r[1] for r in rows]
    # Fill the tail from Coinbase hourly candles (public, unsigned).
    last = ts[-1]
    try:
        import time
        end = int(time.time())
        start = last
        extra = []
        while start < end:
            stop = min(end, start + 300 * 3600)
            url = (f"https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600"
                   f"&start={start}&end={stop}")
            req = urllib.request.Request(url, headers={"User-Agent": "research-script"})
            data = json.loads(urllib.request.urlopen(req, timeout=20).read())
            extra += [(int(r[0]), float(r[4])) for r in data if int(r[0]) > last]
            start = stop
        for t, c in sorted(set(extra)):
            ts.append(t)
            px.append(c)
    except Exception as e:  # offline is fine, the tail is just missing
        print("coinbase fill skipped:", e)
    return ts, px


class Spot:
    def __init__(self) -> None:
        self.ts, self.px = load_spot()
        # running 7-day max via a coarse hourly series
        self.hts = []
        self.hpx = []
        for t, p in zip(self.ts, self.px):
            if not self.hts or t - self.hts[-1] >= 3600:
                self.hts.append(t)
                self.hpx.append(p)

    def at(self, t: float) -> float | None:
        i = bisect.bisect_right(self.ts, t) - 1
        if i < 0 or t - self.ts[i] > 3 * 3600:
            return None
        return self.px[i]

    def ret(self, t: float, back: float) -> float | None:
        a, b = self.at(t - back), self.at(t)
        if a is None or b is None:
            return None
        return b / a - 1

    def below_high(self, t: float, days: float = 7) -> float | None:
        now = self.at(t)
        if now is None:
            return None
        lo = bisect.bisect_left(self.hts, t - days * 86400)
        hi = bisect.bisect_right(self.hts, t)
        if hi - lo < 24 * days * 0.8:
            return None
        return now / max(self.hpx[lo:hi]) - 1


def bucket(r: float | None, cuts: tuple[float, float, float, float]) -> str | None:
    if r is None:
        return None
    a, b, c, d = cuts
    if r < a:
        return "1 strong down"
    if r < b:
        return "2 down"
    if r <= c:
        return "3 flat"
    if r <= d:
        return "4 up"
    return "5 strong up"


FEATURES = {
    "6 h return": (6 * 3600, (-0.02, -0.005, 0.005, 0.02)),
    "24 h return": (86400, (-0.04, -0.01, 0.01, 0.04)),
    "7 d return": (7 * 86400, (-0.08, -0.02, 0.02, 0.08)),
}


def dd_bucket(x: float | None) -> str | None:
    if x is None:
        return None
    if x > -0.02:
        return "1 near 7-d high (<2% off)"
    if x > -0.06:
        return "2 2-6% off"
    if x > -0.12:
        return "3 6-12% off"
    return "4 >12% off (crash)"


def stats(rows: list[tuple[float, int]]) -> tuple[int, float, float, float, float]:
    """rows: (price paid, won 0/1). Returns n, avg price, win rate, edge per contract after fee, std error."""
    n = len(rows)
    if n == 0:
        return 0, 0, 0, 0, 0
    pnl = [w - p - fee(p) for p, w in rows]
    m = sum(pnl) / n
    sd = math.sqrt(sum((x - m) ** 2 for x in pnl) / max(1, n - 1))
    return n, sum(p for p, _ in rows) / n, sum(w for _, w in rows) / n, m, sd / math.sqrt(n)


def fmt_row(label: str, up: list, dn: list) -> str:
    a = stats(up)
    b = stats(dn)
    def cell(s):
        n, p, w, e, se = s
        if n == 0:
            return "| – | – | – |"
        flag = " **" if abs(e) > 2 * se and n >= 100 else ""
        return f"| {p*100:.1f}¢ / {w*100:.1f}% | {e*100:+.2f}¢ ± {se*100:.2f}{flag} | {n} |"
    return f"| {label} " + cell(a)[0:] + cell(b)[1:]


def part_a(spot: Spot) -> list[str]:
    h = ro("history.db")
    mk = h.execute("select ticker, close_ts, result from markets where series='KXBTC15M' and result in ('yes','no')").fetchall()
    out = ["## Part A — every KXBTC15M round, buying at Kalshi's ask", "",
           f"{len(mk):,} settled rounds. Each cell: average ask / how often that side won, then the average result per "
           "contract after the taker fee (± one standard error), then rounds. ** = more than 2 standard errors from zero "
           "with 100+ rounds. A fairly priced side reads about −2¢ (the 1.75¢ fee at 50¢ plus half the spread); compare each "
           "row with the `all` row, not with zero.", ""]
    candles: dict[str, dict[int, tuple[float, float]]] = {}
    for t, ts, bid, ask in h.execute("select ticker, ts, bid, ask from candles where ticker like 'KXBTC15M%'"):
        candles.setdefault(t, {})[ts] = (bid, ask)
    for S in SECS_LEFT:
        groups: dict[str, dict[str, tuple[list, list]]] = {}
        for tic, close, res in mk:
            c = candles.get(tic, {}).get(close - S)
            if not c or c[0] is None or c[1] is None:
                continue
            bid, ask = c
            if not (0.03 <= ask <= 0.97) or not (0.03 <= bid <= 0.97):
                continue
            t = close - S
            won_up = 1 if res == "yes" else 0
            keys = {name: bucket(spot.ret(t, back), cuts) for name, (back, cuts) in FEATURES.items()}
            keys["below 7-d high"] = dd_bucket(spot.below_high(t))
            keys["all rounds"] = "all"
            for fname, b in keys.items():
                if b is None:
                    continue
                up, dn = groups.setdefault(fname, {}).setdefault(b, ([], []))
                up.append((ask, won_up))
                dn.append((1 - bid, 1 - won_up))
        out += [f"### {S // 60} min left", "",
                "| BTC trend | UP: ask / won | UP result | n | DOWN: ask / won | DOWN result | n |",
                "|---|---|---|---|---|---|---|"]
        for fname in ["all rounds", *FEATURES, "below 7-d high"]:
            for b in sorted(groups.get(fname, {})):
                up, dn = groups[fname][b]
                label = "all" if fname == "all rounds" else f"{fname}: {b[2:]}"
                out.append(fmt_row(label, up, dn))
        out.append("")
    return out


def part_b(spot: Spot) -> list[str]:
    out = ["## Part B — the bot's own fills", "",
           "Settled fills only (sold early are excluded, held-to-settle win rate against the price paid). Same columns as above.", ""]
    for db, label in (("bot.db", "paper"), ("bot-live.db", "live")):
        c = ro(db)
        rows = c.execute("select ts, side, price, result from fills where result in ('yes','no')").fetchall()
        g: dict[str, tuple[list, list]] = {}
        for ts, side, price, res in rows:
            won = 1 if res == side else 0
            for name in ("all", "24 h return", "below 7-d high"):
                if name == "all":
                    b = "all"
                elif name == "24 h return":
                    back, cuts = FEATURES[name]
                    b = bucket(spot.ret(ts, back), cuts)
                    b = b and f"24 h: {b[2:]}"
                else:
                    b = dd_bucket(spot.below_high(ts))
                    b = b and f"7-d high: {b[2:]}"
                if b is None:
                    continue
                up, dn = g.setdefault(b, ([], []))
                (up if side == "yes" else dn).append((price, won))
        out += [f"### {label} ({len(rows)} settled fills)", "",
                "| BTC trend | UP: paid / won | UP result | n | DOWN: paid / won | DOWN result | n |",
                "|---|---|---|---|---|---|---|"]
        for b in sorted(g, key=lambda k: (k != "all", k)):
            out.append(fmt_row(b, *g[b]))
        out.append("")
    return out


def main() -> None:
    spot = Spot()
    lines = ["# Regime study — UP bets in a BTC downtrend", ""]
    lines += part_a(spot)
    lines += part_b(spot)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
