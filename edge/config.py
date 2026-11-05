"""Edge layer configuration: one typed file. Defaults below; override any knob with EDGE_<NAME> in the environment or
in .env.local (ENGINE_VALIDATED may also be set without the prefix). Values are parsed to the field's type."""
from __future__ import annotations

import os
from dataclasses import dataclass, fields, replace
from pathlib import Path
from typing import Mapping, Optional

ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class EdgeConfig:
    # EV gate (ev_gate.py)
    MIN_EDGE: float = 0.01
    BLOCK_MID_BAND: bool = True
    MID_BAND_LOW: float = 0.30
    MID_BAND_HIGH: float = 0.70
    KELLY_FRAC: float = 0.25
    MAX_RISK_FRAC: float = 0.01
    # Risk governor (risk.py)
    DAILY_STOP: float = -0.03
    WEEKLY_STOP: float = -0.06
    MAX_WINDOWS: int = 10
    EQUITY_OPEN_BLACKOUT: bool = True
    BLACKOUTS_PATH: str = str(ROOT / 'edge' / 'blackouts.json')
    # Volatility (vol.py)
    VOL_HALFLIFE_S: float = 300.0
    VOL_FLOOR_ANN: float = 0.10
    VOL_MIN_SAMPLES: int = 120
    TAIL_MULT: float = 1.15
    # Decisions use p_engine only when this is set by hand after `python -m edge.score` says ENGINE: ADDS SIGNAL.
    ENGINE_VALIDATED: bool = False
    MODE: str = 'shadow'  # 'shadow' records paper fills; 'live' records decisions only (real fills come from Kalshi)
    BANKROLL: Optional[float] = None  # None: the Kalshi account value sent by the engine
    # Proxy-quality banner: fail when fewer than this share of the last 50 settled windows agree with Kalshi.
    PROXY_MIN_AGREE: float = 0.95
    PROXY_MIN_WINDOWS: int = 10
    # Service
    HOST: str = '127.0.0.1'
    PORT: int = 3003
    DB_PATH: str = str(ROOT / 'data' / 'edge.db')

    def __post_init__(self) -> None:
        if self.MODE not in ('shadow', 'live'):
            raise ValueError("MODE must be 'shadow' or 'live'")
        if not (0 < self.MIN_EDGE < 1 and 0 < self.KELLY_FRAC <= 1 and 0 < self.MAX_RISK_FRAC <= 1):
            raise ValueError('MIN_EDGE, KELLY_FRAC and MAX_RISK_FRAC must be in (0, 1]')
        if not (self.DAILY_STOP < 0 and self.WEEKLY_STOP < 0):
            raise ValueError('DAILY_STOP and WEEKLY_STOP must be negative fractions')
        if self.MAX_WINDOWS < 1 or self.VOL_HALFLIFE_S <= 0 or self.TAIL_MULT <= 0 or self.VOL_MIN_SAMPLES < 2:
            raise ValueError('Invalid window cap or volatility setting')


def _dotenv(path: Path) -> dict:
    out: dict = {}
    try:
        for line in path.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            out[key.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        pass
    return out


def _parse(kind: str, raw: str):
    if kind == 'bool':
        if raw.lower() in ('1', 'true', 'yes', 'on'):
            return True
        if raw.lower() in ('0', 'false', 'no', 'off'):
            return False
        raise ValueError(f'not a boolean: {raw}')
    if kind == 'int':
        return int(raw)
    if kind in ('float', 'Optional[float]'):
        return None if raw.lower() in ('', 'none', 'auto') else float(raw)
    return raw


def load_config(env: Optional[Mapping[str, str]] = None, dotenv: Optional[Path] = ROOT / '.env.local') -> EdgeConfig:
    merged = {**(_dotenv(dotenv) if dotenv else {}), **(os.environ if env is None else env)}
    changes = {}
    for f in fields(EdgeConfig):
        raw = merged.get('EDGE_' + f.name)
        if raw is None and f.name == 'ENGINE_VALIDATED':
            raw = merged.get('ENGINE_VALIDATED')
        if raw is not None:
            changes[f.name] = _parse(str(f.type), raw)
    return replace(EdgeConfig(), **changes)
