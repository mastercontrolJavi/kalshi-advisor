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
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Tuple

from . import kalshi

ORDERS = '/portfolio/events/orders'  # Kalshi Create Order V2; the older /portfolio/orders answers 410 Gone


class Switch:
    """data/bot-live.json: {"armed": bool, "time": ms, "by": "user" | "bot", "note": str, "expires_at": ms,
    "boot_id": str}. Missing or unreadable = off.

    Being armed in the file is not enough to trade (2026-11-18). The arming must also name the run of the bot it was
    made for (`boot_id`, a new one at every start, so a restart after a crash is never armed) and an end time
    (`expires_at`, UTC ms, at most ARM_MAX_HOURS ahead). `why_off` is the one place that decides."""

    def __init__(self, path: Path):
        self.path = Path(path)

    def read(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding='utf-8'))
            return {'armed': data.get('armed') is True, 'time': data.get('time'), 'by': data.get('by'), 'note': data.get('note') or '',
                    'expires_at': data.get('expires_at'), 'boot_id': data.get('boot_id')}
        except Exception:
            return {'armed': False, 'time': None, 'by': None, 'note': '', 'expires_at': None, 'boot_id': None}

    @property
    def armed(self) -> bool:
        """What the file says. Whether that arming is good for this run of the bot is why_off()."""
        return self.read()['armed']

    def why_off(self, boot_id: Optional[str], now_ms: float, max_hours: float, state: Optional[dict] = None) -> Optional[str]:
        """None when real orders are allowed right now, else the reason they are not."""
        s = self.read() if state is None else state
        if not s['armed']:
            return 'switched off'
        if not boot_id or s['boot_id'] != boot_id:
            return 'switched on for an earlier run of the bot'
        exp = s['expires_at']
        if isinstance(exp, bool) or not isinstance(exp, (int, float)):
            return 'switched on without an end time'
        if now_ms >= exp:
            return 'the time it was switched on for has run out'
        if exp - now_ms > max_hours * 3600_000 + 60_000:  # a minute of slack for the page's clock
            return f'switched on for longer than the {max_hours:g} hours allowed'
        return None

    def off(self, note: str) -> None:
        tmp = self.path.with_suffix('.tmp')
        tmp.write_text(json.dumps({'armed': False, 'time': time.time() * 1000, 'by': 'bot', 'note': note, 'expires_at': None, 'boot_id': None}), encoding='utf-8')
        os.replace(tmp, self.path)


def drift(row: dict, fills: List[dict]) -> Optional[dict]:
    """Compare one round of the bot's record with what Kalshi's fills for that market add up to. `row`: ticker, side,
    contracts, paid, fee, exit_n, exit_cash, and ts (the recorded time of the buy) when known. Returns the differences
    (Kalshi minus the record) when any is larger than half a hundredth of a contract or one cent, else None. A buy or a
    sale by hand on the same round shows up here."""
    side = row['side']
    n, paid, fees = from_fills(fills, side)
    sold_n, sold_cash = sold(fills, side, row.get('ts'))
    d = {'contracts': n - row['contracts'], 'paid': paid - row['paid'], 'fee': fees - row['fee'],
         'sold': min(sold_n, n) - row['exit_n'], 'sold_cash': sold_cash - row['exit_cash']}
    if abs(d['contracts']) <= 0.005 and abs(d['sold']) <= 0.005 and all(abs(d[k]) <= 0.01 for k in ('paid', 'fee', 'sold_cash')):
        return None
    return {'ticker': row['ticker'], **{k: round(v, 4) for k, v in d.items()}}


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


def fill_time(f: dict) -> Optional[float]:
    """Kalshi's own time of a fill, epoch seconds: `created_time` (ISO, UTC) or `ts`. None when neither can be read."""
    raw = f.get('created_time')
    if isinstance(raw, str) and raw:
        try:
            return datetime.fromisoformat(raw.replace('Z', '+00:00')).timestamp()
        except ValueError:
            pass
    try:
        return float(f['ts']) if f.get('ts') is not None else None
    except (TypeError, ValueError):
        return None


BUY_MATCH_S = 30.0   # the bot's own buy is looked for in Kalshi's fills this close to the time the record gives it
BUY_SLACK_S = 3.0    # with no such fill, a fill up to this long before the recorded time still counts (clock difference)


def sold(fills: List[dict], side: str, bought_at: Optional[float] = None) -> Tuple[float, float]:
    """(contracts, dollars after fees) of `side` sold in these fills, whoever sold them: the bot or the owner by hand.
    Kalshi reports a sale of one side as a fill on the other (outcome_side), with both prices on it, and reports a
    purchase of the other side the same way: the two cannot be told apart on a fill.

    `bought_at` is the time the record gives the bot's own buy (epoch seconds). With it, only fills AFTER that buy
    count. Without it, a purchase of the other side made by hand before the bot bought was booked as a sale of the
    bot's position (2026-11-19, KXBTC15M-26NOV192315-15: the owner bought YES 26.26 at 18c, the bot bought NO 2.06 five
    minutes later, and the record showed that NO as sold at 82c). The buy is located in Kalshi's own fills (the fill of
    `side` nearest `bought_at`), so both times are on Kalshi's clock; this PC's clock runs about 2 s behind it. A fill
    with no readable time is counted, as before. A purchase of the other side made by hand AFTER the bot's buy still
    counts: on the account that is a sale of the position."""
    other = 'no' if side == 'yes' else 'yes'
    start: Optional[float] = None
    if bought_at is not None:
        own = [t for f in fills if (f.get('outcome_side') or f.get('side')) == side and (t := fill_time(f)) is not None and abs(t - bought_at) <= BUY_MATCH_S]
        start = min(own, key=lambda t: abs(t - bought_at)) if own else bought_at - BUY_SLACK_S
    n = cash = 0.0
    for f in fills:
        if (f.get('outcome_side') or f.get('side')) != other:
            continue
        if start is not None and (t := fill_time(f)) is not None and t <= start:
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
