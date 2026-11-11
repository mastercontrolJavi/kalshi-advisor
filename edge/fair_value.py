"""Settlement-aware probability for KXBTC15M: YES if the simple average of the 60 one-second BRTI prints before close is
>= the Target (ties YES). The average is a sum of 60 discrete prints, so its variance is the exact double sum of the
covariances of those prints, not a continuous-time shortcut:

  Var[average] = sigma^2 / N^2 * sum_i sum_j C(i, j),   C(i, j) = (V(i) + V(j) - V(|i - j|)) / 2

where i, j are the seconds from the latest print to each print still to come and V(h) = h * VR(h) is the variance of an
h-second BRTI move in units of the 1-second variance. VR(h) is the measured variance ratio (see VAR_RATIO): BRTI's 1-s
returns are slightly positively autocorrelated, so a 5-minute move is ~23% more variable than 300 one-second moves.

  secs_left > 60:  mean = spot + drift; the 60 prints are (secs_left - 60) .. (secs_left - 1) seconds away
  secs_left <= 60: n fixed prints, m = ceil(secs_left) slots left. The print for the current second IS the spot, so it
                   is known; only the m - 1 later prints carry variance.
                   mean = (sum(fixed) + m*(spot + drift)) / (n + m)

History (quant/edge_calibration.py, 2026-11-10): the old shortcut sd = (r/60)*sigma*sqrt(r/3) counted the current print
as unknown, overstating the final-minute variance by 2.5% at 60 s left, 10% at 15 s, 28% at 5 s and 100% at 1 s, and it
used VR = 1 everywhere, understating the variance 5+ minutes out by ~20%. Two hand-fitted sigma multipliers (1.15 before
the final minute, 0.90 inside it) papered over both.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from statistics import NormalDist
from typing import Dict, List, Optional, Sequence, Tuple

P_MIN, P_MAX = 0.001, 0.999
_N = NormalDist()
WINDOW = 60  # settlement prints

# Variance ratio of BRTI: E[r_h^2] / (h * EWMA 1-s variance), measured on 1.25 M seconds of the 1-s archive
# (2026-10-07 .. 2026-11-07; the two halves agree within 0.01 up to 60 s and within 0.07 at 5 min). Re-measured and
# printed by quant/edge_calibration.py. Log-linear between knots, flat beyond the last.
VAR_RATIO: Tuple[Tuple[float, float], ...] = ((1, 1.00), (5, 1.03), (15, 1.08), (30, 1.115), (60, 1.145), (120, 1.18), (300, 1.23), (900, 1.25))


def phi(x: float) -> float:
    return _N.cdf(x)


class Variogram:
    """V(h) and the two sums fair_value needs, precomputed so a tick costs a table lookup."""

    def __init__(self, knots: Sequence[Tuple[float, float]] = VAR_RATIO, max_lead: int = 900):
        hs = [float(h) for h, _ in knots]
        if not hs or any(h <= 0 or r <= 0 for h, r in knots) or any(b <= a for a, b in zip(hs, hs[1:])):
            raise ValueError('variance-ratio knots need ascending positive horizons and positive ratios')
        self._lh = [math.log(h) for h in hs]
        self._r = [float(r) for _, r in knots]
        # The part of the double sum over the 60 window prints that does not depend on how far away the window is.
        self._d = sum((WINDOW - d) * self.v(d) for d in range(1, WINDOW))
        self._pre = [self._pre_units(a) for a in range(max_lead + 2)]
        self._final = [self._final_units(m) for m in range(WINDOW + 1)]

    def ratio(self, h: float) -> float:
        lh, r = self._lh, self._r
        if h <= 0:
            return r[0]
        x = math.log(h)
        if x <= lh[0]:
            return r[0]
        for k in range(1, len(lh)):
            if x <= lh[k]:
                return r[k - 1] + (x - lh[k - 1]) / (lh[k] - lh[k - 1]) * (r[k] - r[k - 1])
        return r[-1]

    def v(self, h: float) -> float:
        """Variance of an h-second move, in units of the 1-second variance."""
        return h * self.ratio(h) if h > 0 else 0.0

    def _pre_units(self, lead: float) -> float:
        return (WINDOW * sum(self.v(lead + k) for k in range(WINDOW)) - self._d) / WINDOW ** 2

    def _final_units(self, m: int) -> float:
        if m <= 1:
            return 0.0
        k = m - 1
        return k * sum(self.v(i) for i in range(1, k + 1)) - sum((k - d) * self.v(d) for d in range(1, k))

    def pre_window(self, lead: float) -> float:
        """Variance of the 60-print average when its first print is `lead` seconds away, in 1-second units."""
        lead = max(0.0, lead)
        i = int(lead)
        if i + 1 >= len(self._pre):
            return self._pre_units(lead)
        return self._pre[i] + (lead - i) * (self._pre[i + 1] - self._pre[i])

    def final_sum(self, m: int) -> float:
        """Variance of the SUM of the m - 1 prints after the current one (1 .. m-1 seconds away), in 1-second units."""
        return self._final[m] if 0 <= m <= WINDOW else self._final_units(m)


VARIOGRAM = Variogram()


@dataclass(frozen=True)
class FairValue:
    p_yes: float
    mean_final: float
    sd_final: float
    regime: str  # 'pre_window' | 'final_minute'
    weight: float  # d mean_final / d drift_usd: 1 before the window, m/(n+m) inside it

    def as_dict(self) -> Dict[str, object]:
        return {'p_yes': self.p_yes, 'mean_final': self.mean_final, 'sd_final': self.sd_final, 'regime': self.regime}


def fair_value(spot: float, target: float, secs_left: float, sigma: float, fixed_prints: Sequence[float] = (), drift_usd: float = 0.0,
               variogram: Variogram = VARIOGRAM) -> FairValue:
    """sigma is dollars per sqrt(second) at the 1-second scale. Inside the final minute `spot` must be the print for the
    current second and `fixed_prints` the prints of the window's earlier seconds."""
    if not (spot > 0 and target > 0 and sigma >= 0 and math.isfinite(secs_left)):
        raise ValueError('invalid fair-value inputs')
    secs_left = max(0.0, secs_left)
    if secs_left > WINDOW:
        mean = spot + drift_usd
        sd = sigma * math.sqrt(variogram.pre_window(secs_left - WINDOW))
        regime, weight = 'pre_window', 1.0
    else:
        n, m = len(fixed_prints), int(math.ceil(secs_left - 1e-9))
        if n + m <= 0:
            raise ValueError('no prints and no time left')
        mean = (sum(fixed_prints) + m * (spot + drift_usd)) / (n + m)
        sd = sigma * math.sqrt(variogram.final_sum(m)) / (n + m)
        regime, weight = 'final_minute', m / (n + m)
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
