"""1 Hz spot series. The engine picks the source (BRTI from Kalshi's CF Benchmarks feed; otherwise the median of the
Coinbase, Kraken and Bitstamp mids, flagged degraded) and posts one value per new second. This keeps exactly one price
per second: a skipped second is filled with the last value and flagged `carried`; a longer outage restarts the series."""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

MAX_CARRY_S = 10


@dataclass(frozen=True)
class Print:
    ts: int  # epoch seconds, start of the second
    price: float
    source: str  # 'brti' | 'proxy'
    degraded: bool
    carried: bool


class SpotSeries:
    def __init__(self, max_carry_s: int = MAX_CARRY_S):
        self.max_carry_s = max_carry_s
        self.last: Optional[Print] = None

    def add(self, ts: int, price: Optional[float], source: str, degraded: bool) -> List[Print]:
        """Prints emitted for this tick, oldest first: carried fills for skipped seconds, then this second."""
        if self.last is not None and ts <= self.last.ts:
            return []  # duplicate or out of order: the series already has this second
        out: List[Print] = []
        if self.last is not None and ts - self.last.ts <= self.max_carry_s:
            for t in range(self.last.ts + 1, ts):
                out.append(Print(t, self.last.price, self.last.source, True, True))
        if price is not None and price > 0:
            out.append(Print(ts, float(price), source, bool(degraded), False))
        elif self.last is not None and ts - self.last.ts <= self.max_carry_s:
            out.append(Print(ts, self.last.price, self.last.source, True, True))
        if out:
            self.last = out[-1]
        return out
