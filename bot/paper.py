"""Paper account: cash, one position per round, fills against the visible asks, Kalshi's taker fee, settlement at $1.
State lives in SQLite (data/bot.db) so a restart resumes the same account."""
from __future__ import annotations

import math
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from edge.ev_gate import order_fee

SCHEMA = """
CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY CHECK (id = 1), cash REAL NOT NULL, start REAL NOT NULL, started REAL NOT NULL, peak REAL NOT NULL);
CREATE TABLE IF NOT EXISTS fills (
  id INTEGER PRIMARY KEY, ts REAL NOT NULL, ticker TEXT NOT NULL, side TEXT NOT NULL, contracts REAL NOT NULL, price REAL NOT NULL,
  fee REAL NOT NULL, q REAL, edge REAL, p_yes REAL, secs_left REAL, decided_ask REAL, wanted INTEGER, latency_ms REAL,
  result TEXT, payout REAL, pnl REAL, settled REAL);
CREATE INDEX IF NOT EXISTS fills_ticker ON fills (ticker);
CREATE TABLE IF NOT EXISTS misses (id INTEGER PRIMARY KEY, ts REAL NOT NULL, ticker TEXT NOT NULL, side TEXT NOT NULL, decided_ask REAL, ask_then REAL, edge REAL, secs_left REAL);
CREATE TABLE IF NOT EXISTS equity (ts REAL NOT NULL, equity REAL NOT NULL, note TEXT);
"""


@dataclass
class Position:
    ticker: str
    side: str
    contracts: float
    cost: float  # price paid plus fees


@dataclass(frozen=True)
class Fill:
    ticker: str
    side: str
    contracts: float
    price: float  # average
    fee: float


def walk(asks: Sequence[Tuple[float, float]], limit: float, want: float, cash: float) -> Tuple[float, float, float]:
    """Immediate-or-cancel buy: take contracts (in hundredths) from the cheapest asks at or under `limit` while cash
    lasts. Returns (contracts, dollars paid, fees). Kalshi charges the fee per fill, rounded up to $0.0001."""
    got, paid, fees = 0, 0.0, 0.0  # got counts hundredths
    left = int(round(want * 100))
    for price, qty in asks:
        if price > limit + 1e-9 or left <= 0:
            break
        n = min(left, int(math.floor(qty * 100 + 1e-6)))
        afford = int(math.floor((cash - paid - fees) / (price * 1.07) * 100)) + 2  # a close upper bound, trimmed below
        n = min(n, max(afford, 0))
        while n > 0 and paid + fees + n / 100 * price + order_fee(price, n / 100) > cash + 1e-9:
            n -= 1
        if n <= 0:
            break
        got, left, paid, fees = got + n, left - n, paid + n / 100 * price, fees + order_fee(price, n / 100)
    return got / 100, paid, fees


class PaperBroker:
    def __init__(self, path: str, start: float, now: Optional[float] = None):
        if path != ':memory:':
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.executescript(SCHEMA)
        row = self.db.execute('SELECT cash, start, peak FROM account WHERE id = 1').fetchone()
        if row is None:
            now = time.time() if now is None else now
            self.db.execute('INSERT INTO account (id, cash, start, started, peak) VALUES (1, ?, ?, ?, ?)', (start, start, now, start))
            self.db.execute('INSERT INTO equity (ts, equity, note) VALUES (?, ?, ?)', (now, start, 'start'))
            self.db.commit()
            row = (start, start, start)
        self.cash, self.start, self.peak = row
        self.positions: Dict[str, Position] = {}
        for ticker, side, n, cost in self.db.execute(
                'SELECT ticker, side, SUM(contracts), SUM(contracts * price + fee) FROM fills WHERE settled IS NULL GROUP BY ticker, side'):
            self.positions[ticker] = Position(ticker, side, float(n), cost)

    @property
    def equity(self) -> float:
        """Cash plus open positions at what they cost (they are marked only at settlement)."""
        return self.cash + sum(p.cost for p in self.positions.values())

    def traded(self, ticker: str) -> bool:
        return ticker in self.positions or self.db.execute('SELECT 1 FROM fills WHERE ticker = ? LIMIT 1', (ticker,)).fetchone() is not None

    def buy(self, ticker: str, side: str, limit: float, want: float, asks: Sequence[Tuple[float, float]], ts: float, **context) -> Optional[Fill]:
        if ticker in self.positions:
            return None
        n, paid, fees = walk(asks, limit, want, self.cash)
        if n <= 0:
            return None
        return self.record(ticker, side, n, paid, fees, limit, want, ts, **context)

    def record(self, ticker: str, side: str, n: float, paid: float, fees: float, limit: float, want: float, ts: float, **context) -> Fill:
        """Book a fill: `n` contracts for `paid` dollars plus `fees`. The paper fill comes from walk(); a real one from Kalshi's reply."""
        self.cash -= paid + fees
        self.positions[ticker] = Position(ticker, side, n, paid + fees)
        self.db.execute(
            'INSERT INTO fills (ts, ticker, side, contracts, price, fee, q, edge, p_yes, secs_left, decided_ask, wanted, latency_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
            (ts, ticker, side, n, paid / n, fees, context.get('q'), context.get('edge'), context.get('p_yes'), context.get('secs_left'), limit, want,
             context.get('latency_ms')))
        self.db.execute('UPDATE account SET cash = ? WHERE id = 1', (self.cash,))
        self.db.commit()
        return Fill(ticker, side, n, paid / n, fees)

    def miss(self, ticker: str, side: str, decided_ask: float, ask_then: Optional[float], edge: float, secs_left: float, ts: float) -> None:
        self.db.execute('INSERT INTO misses (ts, ticker, side, decided_ask, ask_then, edge, secs_left) VALUES (?,?,?,?,?,?,?)',
                        (ts, ticker, side, decided_ask, ask_then, edge, secs_left))
        self.db.commit()

    def settle(self, ticker: str, result: str, ts: float) -> Optional[float]:
        """Close the round's position at $1 a contract if its side won. Returns the P&L, or None with no position."""
        pos = self.positions.pop(ticker, None)
        if pos is None:
            return None
        payout = float(pos.contracts) if pos.side == result else 0.0
        pnl = payout - pos.cost
        self.cash += payout
        self.peak = max(self.peak, self.equity)
        # One buy a round, so the position is one fills row.
        self.db.execute('UPDATE fills SET result = ?, payout = ?, pnl = ?, settled = ? WHERE ticker = ? AND settled IS NULL', (result, payout, pnl, ts, ticker))
        self.db.execute('UPDATE account SET cash = ?, peak = ? WHERE id = 1', (self.cash, self.peak))
        self.db.execute('INSERT INTO equity (ts, equity, note) VALUES (?, ?, ?)', (ts, self.equity, ticker))
        self.db.commit()
        return pnl

    def open_tickers(self) -> List[str]:
        return list(self.positions)

    def summary(self) -> dict:
        rows = self.db.execute('SELECT contracts, price, fee, pnl, edge FROM fills WHERE settled IS NOT NULL ORDER BY settled').fetchall()
        n = len(rows)
        contracts = sum(r[0] for r in rows)
        pnl = sum(r[3] for r in rows)
        wins = sum(1 for r in rows if r[3] > 0)
        per = [r[3] / r[0] for r in rows]
        mean = sum(per) / n if n else 0.0
        half = 1.96 * math.sqrt(sum((x - mean) ** 2 for x in per) / (n - 1) / n) if n > 1 else float('nan')
        misses = self.db.execute('SELECT COUNT(*) FROM misses').fetchone()[0]
        started = self.db.execute('SELECT started FROM account WHERE id = 1').fetchone()[0]
        return {'start': self.start, 'equity': self.equity, 'cash': self.cash, 'peak': self.peak, 'open': len(self.positions), 'rounds': n, 'wins': wins,
                'contracts': contracts, 'pnl': pnl, 'fees': sum(r[2] for r in rows), 'per_contract': mean, 'per_contract_ci': half,
                'avg_price': sum(r[1] * r[0] for r in rows) / contracts if contracts else None,
                'avg_edge': sum(r[4] or 0 for r in rows) / n if n else None, 'misses': misses, 'started': started}

    def reset(self, start: float, now: Optional[float] = None) -> None:
        now = time.time() if now is None else now
        for table in ('fills', 'misses', 'equity', 'account'):
            self.db.execute(f'DELETE FROM {table}')
        self.db.execute('INSERT INTO account (id, cash, start, started, peak) VALUES (1, ?, ?, ?, ?)', (start, start, now, start))
        self.db.execute('INSERT INTO equity (ts, equity, note) VALUES (?, ?, ?)', (now, start, 'start'))
        self.db.commit()
        self.cash, self.start, self.peak, self.positions = start, start, start, {}
