"""US Eastern time without third-party packages. Windows Python ships no tz database (zoneinfo needs the `tzdata`
wheel there), so when zoneinfo cannot load America/New_York the US rule is applied directly: EDT from the second
Sunday of March 02:00 local to the first Sunday of November 02:00 local (in force since 2007)."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

try:  # pragma: no cover - depends on the platform's tz data
    from zoneinfo import ZoneInfo
    _ET = ZoneInfo('America/New_York')
except Exception:  # ZoneInfoNotFoundError on Windows without tzdata
    _ET = None


def _nth_sunday(year: int, month: int, n: int) -> date:
    d = date(year, month, 1)
    d += timedelta(days=(6 - d.weekday()) % 7)
    return d + timedelta(weeks=n - 1)


def _offset_hours(utc: datetime) -> int:
    y = utc.year
    start = datetime.combine(_nth_sunday(y, 3, 2), datetime.min.time(), timezone.utc) + timedelta(hours=7)  # 02:00 EST
    end = datetime.combine(_nth_sunday(y, 11, 1), datetime.min.time(), timezone.utc) + timedelta(hours=6)  # 02:00 EDT
    return -4 if start <= utc < end else -5


def to_et(ts: float, use_zoneinfo: bool = True) -> datetime:
    """Naive datetime in US Eastern local time for an epoch-seconds timestamp."""
    utc = datetime.fromtimestamp(ts, timezone.utc)
    if use_zoneinfo and _ET is not None:
        return utc.astimezone(_ET).replace(tzinfo=None)
    return (utc + timedelta(hours=_offset_hours(utc))).replace(tzinfo=None)


def et_to_ts(local: datetime) -> float:
    """Epoch seconds for a naive US Eastern local datetime (first occurrence on the November fall-back hour)."""
    if _ET is not None:
        return local.replace(tzinfo=_ET).timestamp()
    for offset in (-4, -5):
        guess = (local - timedelta(hours=offset)).replace(tzinfo=timezone.utc)
        if _offset_hours(guess) == offset:
            return guess.timestamp()
    return (local + timedelta(hours=5)).replace(tzinfo=timezone.utc).timestamp()


def day_key(ts: float) -> str:
    return to_et(ts).date().isoformat()


def week_key(ts: float) -> str:
    """Monday (ET) of the week containing ts."""
    d = to_et(ts).date()
    return (d - timedelta(days=d.weekday())).isoformat()
