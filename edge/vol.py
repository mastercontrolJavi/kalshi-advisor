"""EWMA volatility of 1-second log returns (half-life VOL_HALFLIFE_S), floored at VOL_FLOOR_ANN annualised, with a
TAIL_MULT inflation for fat tails. Carried (filled) seconds, gaps and source switches are not returns and are skipped."""
from __future__ import annotations

import math
from typing import Optional

SECONDS_PER_YEAR = 365.0 * 24 * 3600


class EwmaVol:
    def __init__(self, halflife_s: float = 300.0, floor_ann: float = 0.10, tail_mult: float = 1.15, min_samples: int = 120):
        self.alpha = 1.0 - 0.5 ** (1.0 / halflife_s)
        self.floor_var = floor_ann ** 2 / SECONDS_PER_YEAR
        self.tail_mult = tail_mult
        self.min_samples = min_samples
        self.ewma: Optional[float] = None
        self.count = 0
        self._last: Optional[tuple] = None  # (ts, price, source)

    def update(self, ts: int, price: float, source: str = 'brti', carried: bool = False) -> None:
        if carried:
            self._last = None  # the next real second is not one second after a real print
            return
        last = self._last
        self._last = (ts, price, source)
        if last is None or ts - last[0] != 1 or last[2] != source or last[1] <= 0 or price <= 0:
            return
        r2 = math.log(price / last[1]) ** 2
        self.ewma = r2 if self.ewma is None else (1 - self.alpha) * self.ewma + self.alpha * r2
        self.count += 1

    @property
    def var(self) -> float:
        """Per-second variance of log returns, never below the floor."""
        return max(self.ewma if self.ewma is not None else 0.0, self.floor_var)

    @property
    def ready(self) -> bool:
        return self.count >= self.min_samples

    def sigma_usd(self, price: float) -> float:
        """Dollars per sqrt(second)."""
        return price * math.sqrt(self.var) * self.tail_mult

    @property
    def sigma_ann(self) -> float:
        return math.sqrt(self.var * SECONDS_PER_YEAR)
