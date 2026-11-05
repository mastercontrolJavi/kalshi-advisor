"""Fee-aware gate and sizing. Both sides are priced against the taker fee; a side trades only if its edge after fees
clears MIN_EDGE, its ask is outside the 30-70c band (where the fee peaks and the market is a coin flip), and the
quarter-Kelly size, capped at 1% of bankroll, buys at least one contract."""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from typing import Optional

from .config import EdgeConfig


def taker_fee(p: float) -> float:
    """Kalshi taker fee per contract in dollars, p in dollars: 0.07 * p * (1 - p). No maker fee on KXBTC15M."""
    return 0.07 * p * (1 - p)


def order_fee(p: float, contracts: int) -> float:
    """What Kalshi charges for the whole order: 0.07*C*P*(1-P) rounded up to the account's $0.0001 precision."""
    return math.ceil(round(0.07 * contracts * p * (1 - p), 9) * 10000) / 10000


@dataclass(frozen=True)
class Decision:
    action: str  # 'TRADE' | 'NO_EDGE' | 'BLOCKED'
    side: Optional[str]  # 'yes' | 'no'
    ask: Optional[float]
    q: Optional[float]
    edge: Optional[float]
    contracts: int
    reason: str

    def as_dict(self) -> dict:
        return asdict(self)


def _side(name: str, q: float, ask: Optional[float], bankroll: float, cfg: EdgeConfig) -> Decision:
    if ask is None or not (0 < ask < 1):
        return Decision('NO_EDGE', name, ask, q, None, 0, f'no {name.upper()} ask')
    cost = ask + taker_fee(ask)
    edge = q - cost
    if edge < cfg.MIN_EDGE:
        return Decision('NO_EDGE', name, ask, q, edge, 0, f'{name.upper()} edge {edge * 100:+.1f}c < {cfg.MIN_EDGE * 100:.1f}c after fee')
    if cfg.BLOCK_MID_BAND and cfg.MID_BAND_LOW <= ask <= cfg.MID_BAND_HIGH:
        return Decision('BLOCKED', name, ask, q, edge, 0, f'mid band: {name.upper()} ask {ask * 100:.0f}c is within {cfg.MID_BAND_LOW * 100:.0f}-{cfg.MID_BAND_HIGH * 100:.0f}c')
    kelly = (q - cost) / (1 - cost)
    risk = min(kelly * cfg.KELLY_FRAC, cfg.MAX_RISK_FRAC) * bankroll
    contracts = math.floor(risk / cost + 1e-9) if bankroll > 0 else 0
    if contracts < 1:
        return Decision('NO_EDGE', name, ask, q, edge, 0, f'size < 1 contract (risk ${risk:.2f} at ${cost:.4f})')
    return Decision('TRADE', name, ask, q, edge, contracts, f'{name.upper()} edge {edge * 100:+.1f}c after fee')


def evaluate(p_yes: float, yes_ask: Optional[float], no_ask: Optional[float], bankroll: float, cfg: EdgeConfig) -> Decision:
    sides = [_side('yes', p_yes, yes_ask, bankroll, cfg), _side('no', 1 - p_yes, no_ask, bankroll, cfg)]
    key = lambda d: d.edge if d.edge is not None else -math.inf
    for action in ('TRADE', 'BLOCKED'):
        hits = [d for d in sides if d.action == action]
        if hits:
            return max(hits, key=key)
    return max(sides, key=key)
