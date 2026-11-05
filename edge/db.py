"""data/edge.db, owned by the sidecar. `signals` holds one snapshot per window per minute plus every gated TRADE;
`windows` holds the settlement proxy check (this layer's own 60-s average vs Kalshi's settlement)."""
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

from .ev_gate import order_fee
from .timeutil import day_key, week_key

SIGNAL_COLUMNS = ('ts', 'ticker', 'kind', 'secs_left', 'spot', 'target', 'sigma', 'regime', 'p_base', 'p_engine', 'p_math', 'q', 'q_raw',
                  'engine_call', 'engine_confidence', 'market_mid', 'yes_ask', 'no_ask', 'action', 'side', 'ask', 'edge', 'contracts', 'reason',
                  'fill_price', 'fill_ts', 'contracts_filled', 'fee', 'mode', 'degraded', 'source', 'carried', 'outcome', 'pnl',
                  'sd_final', 'z', 'sigma_ann', 'tail_mult')
# Columns added after the first release; created on an existing edge.db at startup.
ADDED_COLUMNS = {'sd_final': 'REAL', 'z': 'REAL', 'sigma_ann': 'REAL', 'tail_mult': 'REAL'}

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS signals(
  id INTEGER PRIMARY KEY, ts REAL NOT NULL, ticker TEXT NOT NULL, kind TEXT NOT NULL, secs_left REAL, spot REAL, target REAL, sigma REAL,
  regime TEXT, p_base REAL, p_engine REAL, p_math REAL, q REAL, q_raw REAL, engine_call TEXT, engine_confidence TEXT, market_mid REAL,
  yes_ask REAL, no_ask REAL, action TEXT NOT NULL, side TEXT, ask REAL, edge REAL, contracts INTEGER, reason TEXT,
  fill_price REAL, fill_ts REAL, contracts_filled INTEGER, fee REAL, mode TEXT NOT NULL, degraded INTEGER NOT NULL DEFAULT 0, source TEXT,
  carried INTEGER NOT NULL DEFAULT 0, outcome INTEGER, pnl REAL);
CREATE INDEX IF NOT EXISTS signals_ticker ON signals(ticker);
CREATE INDEX IF NOT EXISTS signals_ts ON signals(ts);
CREATE TABLE IF NOT EXISTS windows(
  ticker TEXT PRIMARY KEY, close_ts REAL NOT NULL, target REAL, my_avg REAL, my_n INTEGER, my_carried INTEGER, my_source TEXT,
  proxy_avg REAL, kalshi_value REAL, result TEXT, discrepancy REAL, sign_agree INTEGER, settled_ts REAL);
"""


class EdgeDB:
    def __init__(self, path: str):
        if path != ':memory:':
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.executescript(SCHEMA)
        have = {r[1] for r in self.db.execute('PRAGMA table_info(signals)')}
        for col, kind in ADDED_COLUMNS.items():
            if col not in have:
                self.db.execute(f'ALTER TABLE signals ADD COLUMN {col} {kind}')
        # Bumped by every write that changes the paper book or the settlement check, so readers can cache in between.
        self.version = 0

    # signals
    def insert_signal(self, row: dict) -> int:
        cols = [c for c in SIGNAL_COLUMNS if c in row]
        if row.get('kind') == 'trade':
            self.version += 1
        cur = self.db.execute(f"INSERT INTO signals({','.join(cols)}) VALUES({','.join('?' * len(cols))})", [row[c] for c in cols])
        return int(cur.lastrowid)

    def pending_fill(self, ticker: str) -> Optional[sqlite3.Row]:
        return self.db.execute("SELECT * FROM signals WHERE ticker=? AND kind='trade' AND mode='shadow' AND fill_price IS NULL AND reason NOT LIKE 'unfilled%' ORDER BY id LIMIT 1", (ticker,)).fetchone()

    def fill(self, signal_id: int, price: float, ts: float, contracts: int) -> float:
        fee = order_fee(price, contracts)
        self.version += 1
        self.db.execute('UPDATE signals SET fill_price=?, fill_ts=?, contracts_filled=?, fee=? WHERE id=?', (price, ts, contracts, fee, signal_id))
        return fee

    def expire_unfilled(self, ticker: str) -> None:
        self.version += 1
        self.db.execute("UPDATE signals SET reason='unfilled: no ask before close' WHERE ticker=? AND kind='trade' AND fill_price IS NULL", (ticker,))

    def shadow_trades(self) -> List[sqlite3.Row]:
        return self.db.execute("SELECT * FROM signals WHERE kind='trade' AND mode='shadow' AND fill_price IS NOT NULL ORDER BY fill_ts").fetchall()

    def shadow_book(self, now: float, ticker: str) -> Tuple[float, float, float, float, int, bool]:
        """(day pnl, week pnl, pnl before today, pnl before this week, windows traded today, in this window) for the paper book."""
        day, week = day_key(now), week_key(now)
        day_pnl = week_pnl = before_day = before_week = 0.0
        windows, in_window = set(), False
        for r in self.db.execute("SELECT ticker, ts, pnl, fill_price FROM signals WHERE kind='trade' AND mode='shadow' AND reason NOT LIKE 'unfilled%'"):
            if r['ticker'] == ticker:
                in_window = True
            if day_key(r['ts']) == day:
                windows.add(r['ticker'])
            pnl = r['pnl']
            if pnl is None:
                continue
            if day_key(r['ts']) == day:
                day_pnl += pnl
            else:
                before_day += pnl
            if week_key(r['ts']) == week:
                week_pnl += pnl
            else:
                before_week += pnl
        return day_pnl, week_pnl, before_day, before_week, len(windows), in_window

    # windows / settlement
    def upsert_window(self, ticker: str, close_ts: float, target: Optional[float], avg: Optional[float], n: int, carried: int, source: str) -> None:
        self.db.execute("""INSERT INTO windows(ticker, close_ts, target, my_avg, my_n, my_carried, my_source) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(ticker) DO UPDATE SET close_ts=excluded.close_ts, target=COALESCE(excluded.target, windows.target),
          my_avg=COALESCE(excluded.my_avg, windows.my_avg), my_n=MAX(COALESCE(excluded.my_n,0), COALESCE(windows.my_n,0)),
          my_carried=excluded.my_carried, my_source=excluded.my_source""", (ticker, close_ts, target, avg, n, carried, source))

    def settle(self, ticker: str, result: str, kalshi_value: Optional[float], proxy_avg: Optional[float], now: float) -> dict:
        if result not in ('yes', 'no'):
            raise ValueError('result must be yes or no')
        outcome = 1 if result == 'yes' else 0
        self.version += 1
        self.db.execute('INSERT OR IGNORE INTO windows(ticker, close_ts) VALUES(?, ?)', (ticker, now))
        w = self.db.execute('SELECT * FROM windows WHERE ticker=?', (ticker,)).fetchone()
        my_avg, target = w['my_avg'], w['target']
        discrepancy = my_avg - kalshi_value if my_avg is not None and kalshi_value is not None else None
        agree = int((my_avg >= target) == (outcome == 1)) if my_avg is not None and target is not None and (w['my_n'] or 0) >= 55 else None
        self.db.execute('UPDATE windows SET proxy_avg=?, kalshi_value=?, result=?, discrepancy=?, sign_agree=?, settled_ts=? WHERE ticker=?',
                        (proxy_avg, kalshi_value, result, discrepancy, agree, now, ticker))
        self.db.execute('UPDATE signals SET outcome=? WHERE ticker=?', (outcome, ticker))
        for r in self.db.execute("SELECT id, side, fill_price, contracts_filled, fee FROM signals WHERE ticker=? AND kind='trade' AND fill_price IS NOT NULL", (ticker,)).fetchall():
            win = (r['side'] == 'yes') == (outcome == 1)
            pnl = r['contracts_filled'] * ((1 - r['fill_price']) if win else -r['fill_price']) - r['fee']
            self.db.execute('UPDATE signals SET pnl=? WHERE id=?', (pnl, r['id']))
        return {'ticker': ticker, 'outcome': outcome, 'discrepancy': discrepancy, 'sign_agree': agree}

    def unsettled(self, before: float, limit: int = 5) -> List[str]:
        return [r[0] for r in self.db.execute(
            'SELECT ticker FROM windows WHERE result IS NULL AND close_ts < ? ORDER BY close_ts DESC LIMIT ?', (before, limit))]

    def proxy_check(self, last: int = 50) -> Tuple[int, Optional[float], Optional[float]]:
        rows = self.db.execute('SELECT sign_agree, discrepancy FROM windows WHERE sign_agree IS NOT NULL ORDER BY close_ts DESC LIMIT ?', (last,)).fetchall()
        if not rows:
            return 0, None, None
        disc = [abs(r['discrepancy']) for r in rows if r['discrepancy'] is not None]
        return len(rows), sum(r['sign_agree'] for r in rows) / len(rows), (sum(disc) / len(disc) if disc else None)

    def rows(self, sql: str, params: Iterable = ()) -> List[sqlite3.Row]:
        return self.db.execute(sql, tuple(params)).fetchall()
