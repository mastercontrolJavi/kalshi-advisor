"""Real-money mode: the on/off switch, Kalshi's order format and reading back what was filled.

Nothing here runs unless MODE is 'live' and the switch file says armed. The switch is turned on only from the Bot page;
the bot itself can only turn it off (after any refused or unclear order). An order is sent once and never resent; a
round whose order filled nothing may get a new order at the new ask (bot/README.md)."""
from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from pathlib import Path
from typing import List, Optional, Tuple

from . import kalshi

ORDERS = '/portfolio/events/orders'  # Kalshi Create Order V2; the older /portfolio/orders answers 410 Gone


class Switch:
    """data/bot-live.json: {"armed": bool, "time": ms, "by": "user" | "bot", "note": str}. Missing or unreadable = off."""

    def __init__(self, path: Path):
        self.path = Path(path)

    def read(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding='utf-8'))
            return {'armed': data.get('armed') is True, 'time': data.get('time'), 'by': data.get('by'), 'note': data.get('note') or ''}
        except Exception:
            return {'armed': False, 'time': None, 'by': None, 'note': ''}

    @property
    def armed(self) -> bool:
        return self.read()['armed']

    def off(self, note: str) -> None:
        tmp = self.path.with_suffix('.tmp')
        tmp.write_text(json.dumps({'armed': False, 'time': time.time() * 1000, 'by': 'bot', 'note': note}), encoding='utf-8')
        os.replace(tmp, self.path)


def sell_body(ticker: str, side: str, limit: float, contracts: float, client_order_id: Optional[str] = None) -> dict:
    """Immediate-or-cancel sale of `contracts` of `side` at no less than `limit`: the mirror order (selling YES is an ask
    at the YES price; selling NO is a bid at 1 - the NO price), marked reduce_only so Kalshi caps it at what the account
    really holds. It can close a position and can never open one on the other side."""
    if side not in ('yes', 'no') or not (0 < limit < 1) or contracts <= 0:
        raise ValueError('invalid order')
    yes_price = limit if side == 'yes' else 1 - limit
    return {'ticker': ticker, 'client_order_id': client_order_id or str(uuid.uuid4()), 'side': 'ask' if side == 'yes' else 'bid',
            'count': f'{contracts:.2f}', 'price': f'{yes_price:.4f}', 'time_in_force': 'immediate_or_cancel',
            'self_trade_prevention_type': 'taker_at_cross', 'cancel_order_on_pause': True, 'reduce_only': True}


def sold(fills: List[dict], side: str) -> Tuple[float, float]:
    """(contracts, dollars after fees) of `side` sold in these fills, whoever sold them: the bot or the owner by hand.
    Kalshi reports a sale of one side as a fill on the other (outcome_side), with both prices on it."""
    other = 'no' if side == 'yes' else 'yes'
    n = cash = 0.0
    for f in fills:
        if (f.get('outcome_side') or f.get('side')) != other:
            continue
        count = float(f['count_fp'])
        n += count
        cash += count * float(f['yes_price_dollars'] if side == 'yes' else f['no_price_dollars']) - float(f.get('fee_cost') or 0)
    return round(n, 2), cash


def order_body(ticker: str, side: str, limit: float, contracts: float, client_order_id: Optional[str] = None) -> dict:
    """Immediate-or-cancel buy of `contracts` on `side` at no worse than `limit`. Kalshi quotes every order from the YES
    leg: YES is a bid at the YES price; NO is an ask at 1 - the NO price. A moved price fills less or nothing."""
    if side not in ('yes', 'no') or not (0 < limit < 1) or contracts <= 0:
        raise ValueError('invalid order')
    yes_price = limit if side == 'yes' else 1 - limit
    return {'ticker': ticker, 'client_order_id': client_order_id or str(uuid.uuid4()), 'side': 'bid' if side == 'yes' else 'ask',
            'count': f'{contracts:.2f}', 'price': f'{yes_price:.4f}', 'time_in_force': 'immediate_or_cancel',
            'self_trade_prevention_type': 'taker_at_cross', 'cancel_order_on_pause': True}


def from_fills(fills: List[dict], side: str) -> Tuple[float, float, float]:
    """(contracts, dollars paid, fees) for the fills that bought `side`, as Kalshi reports them."""
    n = paid = fees = 0.0
    for f in fills:
        if (f.get('outcome_side') or f.get('side')) != side:
            continue
        count = float(f['count_fp'])
        n += count
        paid += count * float(f['yes_price_dollars'] if side == 'yes' else f['no_price_dollars'])
        fees += float(f.get('fee_cost') or 0)
    return round(n, 2), paid, fees


def from_reply(reply: dict, side: str) -> Tuple[float, float, float]:
    """The same three numbers from the order reply alone (average_fill_price is the YES price). Used only when the
    fills cannot be read back."""
    n = float(reply.get('fill_count') or 0)
    if n <= 0:
        return 0.0, 0.0, 0.0
    yes = float(reply['average_fill_price'])
    return n, n * (yes if side == 'yes' else 1 - yes), n * float(reply.get('average_fee_paid') or 0)


async def read_fills(signer: kalshi.Signer, query: str, want: float = 0.0, tries: int = 4) -> List[dict]:
    """Signed GET of /portfolio/fills. Reading is safe to repeat: it waits briefly for the fills to appear."""
    fills: List[dict] = []
    for attempt in range(tries):
        try:
            fills = (await kalshi.signed_get(signer, '/portfolio/fills?' + query)).get('fills') or []
            if sum(float(f['count_fp']) for f in fills) >= want - 1e-9 and (fills or want <= 0):
                return fills
        except Exception:
            if attempt == tries - 1:
                raise
        await asyncio.sleep(0.4 * (attempt + 1))
    return fills
