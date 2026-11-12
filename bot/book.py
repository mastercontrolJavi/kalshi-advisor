"""Kalshi order book for one market. Kalshi publishes resting BIDS on each side; buying YES means hitting NO bids, so
the YES ask ladder is the NO bids seen from the other side (YES ask = 1 - NO bid). Prices are kept in tenths of a cent."""
from __future__ import annotations

from collections import deque
from typing import Deque, Dict, Iterable, List, Optional, Tuple

EPS = 1e-9


def key(price: float) -> int:
    return int(round(price * 1000))


class Book:
    def __init__(self) -> None:
        self.yes: Dict[int, float] = {}  # YES bids: price key -> contracts
        self.no: Dict[int, float] = {}   # NO bids, keyed by NO price
        self.valid = False

    def snapshot(self, yes_levels: Iterable, no_levels: Iterable) -> None:
        """Levels are (price, contracts) with each side at its OWN price."""
        self.yes = {key(float(p)): float(q) for p, q in yes_levels if float(q) > EPS}
        self.no = {key(float(p)): float(q) for p, q in no_levels if float(q) > EPS}
        self.valid = True

    def delta(self, side: str, price: float, change: float) -> bool:
        """Apply a size change. False (and the book goes invalid) if it would leave a negative size."""
        levels = self.yes if side == 'yes' else self.no
        k = key(price)
        size = levels.get(k, 0.0) + change
        if size < -1e-6:
            self.valid = False
            return False
        if size <= EPS:
            levels.pop(k, None)
        else:
            levels[k] = size
        return True

    def best_bid(self, side: str) -> Optional[float]:
        levels = self.yes if side == 'yes' else self.no
        return max(levels) / 1000 if levels else None

    def asks(self, side: str, depth: int = 5) -> List[Tuple[float, float]]:
        """Cheapest first: what buying `side` costs and how many contracts rest there."""
        other = self.no if side == 'yes' else self.yes
        return [((1000 - k) / 1000, other[k]) for k in sorted(other, reverse=True)[:depth]]

    def ask(self, side: str) -> Optional[float]:
        a = self.asks(side, 1)
        return a[0][0] if a else None

    @property
    def crossed(self) -> bool:
        y, n = self.best_bid('yes'), self.best_bid('no')
        return y is not None and n is not None and y + n > 1 + EPS


class FeedDelay:
    """How far behind its own send times a stream is running: receive time minus send time, above the lowest value of
    the last 10 minutes. The floor absorbs the clock difference and the normal network time, so no clock sync is needed."""

    def __init__(self, window_ms: float = 600_000) -> None:
        self.window = window_ms
        self._floor: Deque[Tuple[float, float]] = deque()
        self.ms = 0.0

    def observe(self, sent_ms: float, now_ms: float) -> None:
        raw = now_ms - sent_ms
        f = self._floor
        while f and f[-1][1] >= raw:
            f.pop()
        f.append((now_ms, raw))
        while f[0][0] < now_ms - self.window:
            f.popleft()
        self.ms = max(0.0, raw - f[0][1])
