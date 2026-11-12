"""The bot's whole trading logic, with no I/O, so the live loop and the replay run the same code.

Pricer turns BRTI values into a settlement-aware probability (edge/fair_value.py: Kalshi settles on the average of the
last 60 one-second BRTI prints). decide() compares it with the ask after the taker fee and sizes the buy.

What the bot is betting on: the model's disagreement with Kalshi's price is worth something for about a second after a
BRTI value arrives and nothing after that (quant/edge_calibration.py, DECISIONS 77). A person cannot act in that time;
a program can. Whether it is enough to beat the fee is what the paper record measures.
"""
from __future__ import annotations

import math
from collections import OrderedDict
from dataclasses import dataclass
from typing import Optional, Tuple

from edge.ev_gate import order_fee, taker_fee
from edge.fair_value import WINDOW, FairValue, fair_value
from edge.vol import EwmaVol

from .config import BotConfig


class Pricer:
    """BRTI state that carries across rounds: volatility, the recent 1 Hz prints, the freshest 5 Hz value."""

    def __init__(self, cfg: BotConfig):
        self.cfg = cfg
        self.vol = EwmaVol(cfg.VOL_HALFLIFE_S, cfg.VOL_FLOOR_ANN, 1.0, cfg.VOL_MIN_SAMPLES)
        self.prints: 'OrderedDict[int, float]' = OrderedDict()  # epoch second -> 1 Hz print
        self.last: Optional[Tuple[int, float]] = None           # newest 1 Hz print
        self.fast: Optional[Tuple[float, float]] = None         # newest 5 Hz value (epoch seconds, price)

    def on_print(self, ts: int, price: float) -> bool:
        """A 1 Hz settlement print for epoch second ts. Out-of-order and repeated seconds are ignored."""
        if not price > 0 or (self.last is not None and ts <= self.last[0]):
            return False
        if self.last is not None and ts - self.last[0] > 1:
            self.vol.update(ts, price, carried=True)  # a gap: the next return is not a 1-second return
        self.vol.update(ts, price)
        self.last = (ts, price)
        self.prints[ts] = price
        while len(self.prints) > 2 * WINDOW:
            self.prints.popitem(last=False)
        return True

    def on_fast(self, ts: float, price: float) -> None:
        if price > 0 and (self.fast is None or ts > self.fast[0]):
            self.fast = (ts, price)

    @property
    def ready(self) -> bool:
        return self.last is not None and self.vol.ready

    def fair(self, strike: float, close_ts: int) -> Optional[Tuple[FairValue, float]]:
        """(fair value, seconds left measured from the value priced on), or None when it cannot be priced."""
        if not self.ready or not strike > 0:
            return None
        ts, spot = self.last
        left = close_ts - ts
        if left < 1 or left > 900:
            return None
        sigma = self.vol.sigma_usd(spot)
        if left > WINDOW:
            # Before the settlement window any newer value of the same index is simply a fresher spot.
            if self.cfg.USE_FAST_SPOT and self.fast is not None and ts < self.fast[0] < ts + 1.5 and close_ts - self.fast[0] > WINDOW:
                left, spot = close_ts - self.fast[0], self.fast[1]
            return fair_value(spot, strike, left, sigma), left
        fixed = [p for t, p in self.prints.items() if close_ts - WINDOW <= t < ts]
        if len(fixed) + left < WINDOW - 2:  # prints missing from the window: the average cannot be trusted
            return None
        return fair_value(spot, strike, left, sigma, fixed), left


@dataclass(frozen=True)
class Intent:
    side: str          # 'yes' | 'no'
    limit: float       # the ask decided on; the order is immediate-or-cancel at this price
    contracts: float   # hundredths of a contract, as Kalshi fills them
    q: float           # model probability that this side wins
    edge: float        # q - (limit + fee), per contract
    p_yes: float
    secs_left: float


LOT = 100  # Kalshi fills in hundredths of a contract (the owner's real fills: 0.36, 15.38)


def size(cfg: BotConfig, q: float, ask: float, bankroll: float) -> float:
    """Contracts, in hundredths: KELLY_FRAC of the Kelly stake, at most MAX_RISK_FRAC of the bankroll. Fractional, so a
    small account stakes what the rule says instead of rounding up to a whole contract."""
    cost = ask + taker_fee(ask)
    if bankroll <= 0 or cost >= 1 or q <= cost:
        return 0.0
    kelly = (q - cost) / (1 - cost)
    cap = cfg.MAX_RISK_FRAC * bankroll
    lots = math.floor(min(cfg.KELLY_FRAC * kelly * bankroll, cap) / cost * LOT + 1e-9)
    while lots > 0 and lots / LOT * ask + order_fee(ask, lots / LOT) > cap + 1e-9:
        lots -= 1
    return lots / LOT


def decide(cfg: BotConfig, fv: FairValue, secs_left: float, yes_ask: Optional[float], no_ask: Optional[float],
           bankroll: float) -> Tuple[Optional[Intent], str]:
    """The better side if it passes every rule, else (None, why not)."""
    if not (cfg.MIN_SECS_LEFT < secs_left <= cfg.MAX_SECS_LEFT):
        return None, 'outside the trading window'
    if bankroll < cfg.BUST:
        return None, 'bankroll below the bust level'
    best: Optional[Intent] = None
    why = 'no ask'
    for side, q, ask in (('yes', fv.p_yes, yes_ask), ('no', 1 - fv.p_yes, no_ask)):
        if ask is None or not (0 < ask < 1):
            continue
        edge = q - ask - taker_fee(ask)
        if edge < cfg.MIN_EDGE:
            why = 'no edge after the fee' if why == 'no ask' else why
            continue
        if not (cfg.MIN_ASK <= ask <= cfg.MAX_ASK):
            why = 'ask outside the allowed prices'
            continue
        if cfg.BLOCK_MID_BAND and cfg.MID_BAND_LOW <= ask <= cfg.MID_BAND_HIGH:
            why = 'mid band'
            continue
        n = size(cfg, q, ask, bankroll)
        if n <= 0:
            why = 'stake too small to buy'
            continue
        if best is None or edge > best.edge:
            best = Intent(side, ask, n, q, edge, fv.p_yes, secs_left)
    return (best, 'trade') if best else (None, why)
