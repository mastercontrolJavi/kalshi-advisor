"""Feature switches the owner flips on the Bot page (2026-11-19): data/bot-features.json.

The page writes the file (src/bot/record.ts setFeature); the bot only reads it, every 10 s, and never writes it. Each
switch stands for one or two settings in config.py; a switch that is not in the file leaves config.py (and any
BOT_<NAME> in .env.local) as it is, and a file that cannot be read keeps whatever is running. No restart is needed.

    cheap       buy tickets under 10c           MIN_ASK 0.01 (on) / 0.10 (off)
    sellLosers  sell a losing or reversing      EXIT_BELOW 0.5 and EXIT_BACK 0.6 (on) / both 0 (off)
                position early (real money)
    scalp       sell a ticket bought under 10c  SCALP_AT 5 (on) / 0 (off)
                when its bid has jumped

None of these switches real trading on or off: that is the separate switch in bot/live.py.
"""
from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Dict, Optional

from .config import BotConfig

NAMES = ('cheap', 'sellLosers', 'scalp')
CHEAP_ON, CHEAP_OFF = 0.01, 0.10      # MIN_ASK
LOSERS_ON = (0.5, 0.6)                # EXIT_BELOW, EXIT_BACK: the two rules of 2026-11-17
SCALP_ON = 5.0                        # SCALP_AT


def read(path: Path) -> Optional[Dict[str, bool]]:
    """The switches the file sets, {name: bool}; a value that is not true/false is left out. No file: {} (nothing is
    switched). A file that is there but cannot be read or is not what the page writes: None, which means "keep what
    is running". On Windows a read can fail for a moment while the page replaces the file; treating that as "no
    switches" would put a switch back for 10 s (e.g. buy a 5c ticket with cheap tickets switched off)."""
    try:
        text = Path(path).read_text(encoding='utf-8')
    except FileNotFoundError:
        return {}
    except OSError:
        return None
    try:
        data = json.loads(text)
    except Exception:  # not JSON, or nested past what the parser takes
        return None
    if not isinstance(data, dict):
        return None
    return {k: data[k] for k in NAMES if isinstance(data.get(k), bool)}


def apply(cfg: BotConfig, switches: Dict[str, bool]) -> BotConfig:
    """`cfg` with the switches laid over it. Always from the settings the bot started with, so switching back restores them."""
    changes: dict = {}
    if 'cheap' in switches:
        changes['MIN_ASK'] = CHEAP_ON if switches['cheap'] else max(CHEAP_OFF, cfg.MIN_ASK)
    if 'sellLosers' in switches:
        changes['EXIT_BELOW'], changes['EXIT_BACK'] = LOSERS_ON if switches['sellLosers'] else (0.0, 0.0)
    if 'scalp' in switches:
        changes['SCALP_AT'] = SCALP_ON if switches['scalp'] else 0.0
    return replace(cfg, **changes) if changes else cfg


def state(cfg: BotConfig) -> Dict[str, bool]:
    """What is in effect, for the Bot page."""
    return {'cheap': cfg.MIN_ASK < CHEAP_OFF, 'sellLosers': cfg.EXIT_BELOW > 0 or cfg.EXIT_BACK > 0, 'scalp': cfg.SCALP_AT > 0}
