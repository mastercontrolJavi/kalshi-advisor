"""Settlement-aware probability for KXBTC15M: YES if the simple average of the 60 one-second BRTI prints before close is
>= the Target (ties YES). Arithmetic Brownian motion with zero drift unless drift_usd is given.

  secs_left > 60:  mean = spot + drift,  sd = sigma * sqrt(secs_left - 60 + 20)   (20 = 60/3, variance of a 60-s average)
  secs_left <= 60: n fixed prints, r = secs_left
                   mean = (sum(fixed) + r*(spot + drift)) / (n + r),  sd = (r/(n + r)) * sigma * sqrt(r/3)
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from statistics import NormalDist
from typing import Dict, List, Optional, Sequence

P_MIN, P_MAX = 0.001, 0.999
_N = NormalDist()


def phi(x: float) -> float:
    return _N.cdf(x)


@dataclass(frozen=True)
class FairValue:
    p_yes: float
    mean_final: float
    sd_final: float
    regime: str  # 'pre_window' | 'final_minute'
    weight: float  # d mean_final / d drift_usd: 1 before the window, r/(n+r) inside it

    def as_dict(self) -> Dict[str, object]:
        return {'p_yes': self.p_yes, 'mean_final': self.mean_final, 'sd_final': self.sd_final, 'regime': self.regime}


def fair_value(spot: float, target: float, secs_left: float, sigma: float, fixed_prints: Sequence[float] = (), drift_usd: float = 0.0) -> FairValue:
    if not (spot > 0 and target > 0 and sigma >= 0 and math.isfinite(secs_left)):
        raise ValueError('invalid fair-value inputs')
    secs_left = max(0.0, secs_left)
    if secs_left > 60:
        mean = spot + drift_usd
        sd = sigma * math.sqrt(secs_left - 60 + 20)
        regime, weight = 'pre_window', 1.0
    else:
        n, r = len(fixed_prints), secs_left
        if n + r <= 0:
            raise ValueError('no prints and no time left')
        mean = (sum(fixed_prints) + r * (spot + drift_usd)) / (n + r)
        sd = (r / (n + r)) * sigma * math.sqrt(r / 3)
        regime, weight = 'final_minute', r / (n + r)
    if sd <= 1e-9:
        p = 1.0 if mean >= target else 0.0
    else:
        p = phi((mean - target) / sd)
    return FairValue(min(P_MAX, max(P_MIN, p)), mean, sd, regime, weight)


def engine_drift(q: float, spot: float, target: float, secs_left: float, sigma: float, fixed_prints: Sequence[float] = ()) -> float:
    """Adapter: the drift_usd that makes fair_value() return the engine's probability q under this layer's sigma.

    The directional engine outputs a probability, not a dollar move. With base mean m0 (drift 0), sd and weight w,
    p = Phi((m0 + w*d - target)/sd), so d = (target + sd*Phi^-1(q) - m0)/w. q is clamped to [0.001, 0.999]."""
    base = fair_value(spot, target, secs_left, sigma, fixed_prints, 0.0)
    if base.sd_final <= 1e-9 or base.weight <= 0:
        return 0.0
    qc = min(P_MAX, max(P_MIN, q))
    return (target + base.sd_final * _N.inv_cdf(qc) - base.mean_final) / base.weight


class FinalWindowTracker:
    """Collects the 1-s prints with close_ts - 60 <= ts < close_ts (epoch seconds), one per second."""

    def __init__(self, close_ts: int):
        self.close_ts = close_ts
        self._prints: Dict[int, float] = {}
        self.carried = 0

    def add(self, ts: int, price: float, carried: bool = False) -> bool:
        if not (self.close_ts - 60 <= ts < self.close_ts) or ts in self._prints:
            return False
        self._prints[ts] = price
        self.carried += int(carried)
        return True

    def put(self, ts: int, price: float) -> bool:
        """An official print for second ts: replaces this layer's own value for that second."""
        if not (self.close_ts - 60 <= ts < self.close_ts) or not price > 0:
            return False
        self._prints[ts] = price
        return True

    def fixed_before(self, ts: int) -> List[float]:
        """Prints already locked in at second ts (strictly earlier seconds)."""
        return [p for t, p in sorted(self._prints.items()) if t < ts]

    @property
    def n(self) -> int:
        return len(self._prints)

    def average(self) -> Optional[float]:
        return sum(self._prints.values()) / len(self._prints) if self._prints else None
