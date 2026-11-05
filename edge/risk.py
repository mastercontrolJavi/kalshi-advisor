"""Risk governor with veto power. Checks, in order: blackouts (US equity open 09:30-10:00 ET on weekdays, plus the
macro events in blackouts.json), the daily stop (-3% of start-of-day bankroll), the weekly stop (-6% of start-of-week
bankroll), one position per window (no averaging down, no re-entry) and at most MAX_WINDOWS traded windows a day.
Days and weeks are US Eastern (weeks start Monday)."""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Tuple

from .config import EdgeConfig
from .timeutil import et_to_ts, to_et


@dataclass(frozen=True)
class Blackout:
    name: str
    start: float  # epoch seconds
    end: float


def _ts(value: str) -> float:
    """ISO time: with an offset (2026-12-09T14:00:00-05:00) it is exact; without one it is read as ET local time."""
    d = datetime.fromisoformat(value)
    return d.timestamp() if d.tzinfo is not None else et_to_ts(d)


def load_blackouts(path: str) -> List[Blackout]:
    """blackouts.json: [{"event": "FOMC decision", "start": "2026-12-09T14:00:00-05:00", "end": "2026-12-09T15:00:00-05:00"}].
    "name" is accepted for "event"; a time without an offset is ET local time."""
    try:
        rows = json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return []
    out = []
    for r in rows if isinstance(rows, list) else []:
        try:
            out.append(Blackout(str(r.get('event') or r['name']), _ts(r['start']), _ts(r['end'])))
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
    return out


def blackout_horizon_warning(blackouts: List[Blackout], now: float, days: int = 14) -> Optional[str]:
    """A reminder to extend blackouts.json when its last entry is less than `days` away (or already past)."""
    if not blackouts:
        return 'edge/blackouts.json has no entries: only the US equity-open blackout applies'
    last = max(blackouts, key=lambda b: b.end)
    left = (last.end - now) / 86400
    if left < days:
        return f'edge/blackouts.json runs out in {max(0.0, left):.1f} days (last: {last.name}); add the next dates (2027 FOMC/CPI/NFP)'
    return None


@dataclass(frozen=True)
class Book:
    """A P&L book the governor judges: the shadow paper book, or your real Kalshi fills (sent by the engine)."""
    day_pnl: float
    week_pnl: float
    start_day_bankroll: float
    start_week_bankroll: float
    windows_today: int  # distinct KXBTC15M windows traded today
    in_window: bool  # already holds or held a position in this window


class RiskGovernor:
    def __init__(self, cfg: EdgeConfig, blackouts: Optional[List[Blackout]] = None):
        self.cfg = cfg
        self.blackouts = blackouts if blackouts is not None else load_blackouts(cfg.BLACKOUTS_PATH)

    def blackout(self, ts: float) -> Optional[str]:
        et = to_et(ts)
        if self.cfg.EQUITY_OPEN_BLACKOUT and et.weekday() < 5 and (9 * 60 + 30) <= et.hour * 60 + et.minute < 10 * 60:
            return 'US equity open 09:30-10:00 ET'
        for b in self.blackouts:
            if b.start <= ts < b.end:
                return b.name
        return None

    def stops(self, book: Book) -> Optional[str]:
        if book.start_day_bankroll > 0 and book.day_pnl <= self.cfg.DAILY_STOP * book.start_day_bankroll:
            return f'daily stop: {book.day_pnl:+.2f} <= {self.cfg.DAILY_STOP * book.start_day_bankroll:.2f}'
        if book.start_week_bankroll > 0 and book.week_pnl <= self.cfg.WEEKLY_STOP * book.start_week_bankroll:
            return f'weekly stop: {book.week_pnl:+.2f} <= {self.cfg.WEEKLY_STOP * book.start_week_bankroll:.2f}'
        return None

    def check(self, ts: float, book: Book) -> Tuple[bool, str]:
        b = self.blackout(ts)
        if b:
            return False, f'blackout: {b}'
        s = self.stops(book)
        if s:
            return False, s
        if book.in_window:
            return False, 'one position per window (no re-entry)'
        if book.windows_today >= self.cfg.MAX_WINDOWS:
            return False, f'window cap: {book.windows_today}/{self.cfg.MAX_WINDOWS} traded today'
        return True, 'ok'
