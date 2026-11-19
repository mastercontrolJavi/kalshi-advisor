"""Bot settings: one typed file. Override any knob with BOT_<NAME> in the environment or in .env.local."""
from __future__ import annotations

import os
from dataclasses import dataclass, fields, replace
from pathlib import Path
from typing import Mapping, Optional

from edge.config import _dotenv, _parse

ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class BotConfig:
    # --- Paper account ---
    START_BANKROLL: float = 15.0
    TARGET: float = 100.0          # first goal; the bot keeps trading past it and logs the milestone
    BUST: float = 1.0              # below this it stops opening positions

    # --- Entry rule (strategy.py). Replay of 524 recorded rounds, 2026-10-23..11-06 (bot/backtest.py): one buy a round,
    # held to settlement, +2.0c a contract after the fee if filled in the same second (95% -1.8..+5.7), -0.4c if filled
    # one second later. Nothing here is proven; the live paper record at LATENCY_MS is the test.
    MIN_EDGE: float = 0.03         # model probability minus (ask + taker fee)
    MIN_ASK: float = 0.10          # no longshots: the fee is the largest share of the upside there
    MAX_ASK: float = 0.97
    BLOCK_MID_BAND: bool = True    # 30-70c asks lost in every time bucket of the replay (-1..-4c)
    MID_BAND_LOW: float = 0.30
    MID_BAND_HIGH: float = 0.70
    MIN_SECS_LEFT: float = 120.0   # the last 2 minutes lost (-3..-4c); the model is not better than Kalshi there
    MAX_SECS_LEFT: float = 600.0   # the first 5 minutes were a coin flip around zero

    # --- Sizing: fractional Kelly on the model's probability, in hundredths of a contract ---
    # 2026-11-13, user choice: 1.5x the first sizing (was 0.5 Kelly, 10% cap). A replay of 134 paper trades put the useful ceiling at 1.5-2x.
    KELLY_FRAC: float = 0.75
    MAX_RISK_FRAC: float = 0.15    # most of the bankroll one round may cost
    # --- Real money (bot/live.py), 2026-11-17, user: "same type of experiment, but with real money that I can afford to lose" ---
    # MODE 'live' sends real Kalshi orders, and only while the switch on the Bot page is on (data/bot-live.json). The bot
    # spends from its own ledger (LIVE_DB_PATH), which starts at LIVE_BUDGET and grows only by its own wins: whatever
    # else is in the Kalshi account is never counted. In live mode the paper account is left as it is.
    MODE: str = 'paper'            # 'paper' | 'live'
    LIVE_BUDGET: float = 15.0
    LIVE_DB_PATH: str = str(ROOT / 'data' / 'bot-live.db')
    # --- Selling a losing position early (live mode only), 2026-11-17, user: "sell whatever we have left, something is
    # better than nothing". When the best bid for the side held has stayed at or under EXIT_BELOW x the entry price for
    # EXIT_HOLD_S seconds, with at least EXIT_MIN_SECS_LEFT left, the bot sells what it holds at that bid. Replay on
    # the bot's 302 entries and on 5,312 recorded cheap-side entries (minute candles): the same average result as
    # holding (-3.5c vs -3.9c; +0.8c vs +0.8c) with smaller swings. Selling winners at a fixed gain (2x the entry,
    # +15c, ...) cost about 2c a contract in the same replay, so there is no take-profit rule.
    # Reversal (the owner sold three rounds by hand that had gone up and were turning): once the bid has been EXIT_UP
    # above the entry, a fall back to EXIT_BACK x its highest bid sells too, down to EXIT_REVERSAL_MIN_SECS_LEFT.
    # Both rules together in the same replay: -3.8c vs -3.9c held, swing 27c vs 37c. They cut swings, not the fee.
    EXIT_BELOW: float = 0.5        # 0 switches the losing-position exit off
    EXIT_MIN_SECS_LEFT: float = 120.0
    EXIT_UP: float = 0.10
    EXIT_BACK: float = 0.6         # 0 switches the reversal exit off
    EXIT_REVERSAL_MIN_SECS_LEFT: float = 60.0
    EXIT_HOLD_S: float = 15.0      # the bid must stay there this long: one flicker of the book is not a reversal
    # --- Fill model ---
    LATENCY_MS: int = 300          # decision -> the order reaching Kalshi; the paper fill uses the book as it is then
    # --- Data guards ---
    MAX_BOOK_DELAY_MS: int = 1500  # Kalshi's stream behind its own send times by more than this: no trade
    MAX_PRINT_AGE_MS: int = 1500   # newest BRTI value older than this (local receive time): no trade
    USE_FAST_SPOT: bool = True     # price off the 5 Hz BRTI value when it is newer than the 1 Hz print (pre-window only)
    VOL_HALFLIFE_S: float = 300.0
    VOL_FLOOR_ANN: float = 0.10
    # 10 minutes of prints before the first trade. With the sidecar's 120 the first live trade (2 minutes after a start)
    # priced a 74c ask at 92%: a two-minute volatility sample is too short and makes the model overconfident.
    VOL_MIN_SAMPLES: int = 600
    # --- Process ---
    PRIORITY: str = 'low'          # below-normal CPU priority so the bot yields to the advisor's engine
    DB_PATH: str = str(ROOT / 'data' / 'bot.db')
    SERIES: str = 'KXBTC15M'

    def __post_init__(self) -> None:
        if not (0 < self.MIN_EDGE < 1 and 0 <= self.MIN_ASK < self.MAX_ASK <= 1):
            raise ValueError('MIN_EDGE, MIN_ASK and MAX_ASK must be prices in (0, 1)')
        if not (0 < self.KELLY_FRAC <= 1 and 0 < self.MAX_RISK_FRAC <= 1):
            raise ValueError('KELLY_FRAC and MAX_RISK_FRAC must be in (0, 1]')
        if not (0 <= self.MIN_SECS_LEFT < self.MAX_SECS_LEFT <= 900):
            raise ValueError('need 0 <= MIN_SECS_LEFT < MAX_SECS_LEFT <= 900')
        if self.START_BANKROLL <= 0 or self.LATENCY_MS < 0 or self.PRIORITY not in ('low', 'normal'):
            raise ValueError('invalid bankroll, latency or priority')
        if not (0 <= self.EXIT_BELOW < 1 and 0 <= self.EXIT_BACK < 1 and self.EXIT_UP > 0 and min(self.EXIT_HOLD_S, self.EXIT_MIN_SECS_LEFT, self.EXIT_REVERSAL_MIN_SECS_LEFT) >= 0):
            raise ValueError('EXIT_BELOW and EXIT_BACK must be in [0, 1), EXIT_UP positive and the exit times non-negative')
        if self.MODE not in ('paper', 'live') or not (0 < self.LIVE_BUDGET <= 1000):
            raise ValueError("MODE must be 'paper' or 'live', and LIVE_BUDGET between 0 and 1000 dollars")


def load_config(env: Optional[Mapping[str, str]] = None, dotenv: Optional[Path] = ROOT / '.env.local') -> BotConfig:
    merged = {**(_dotenv(dotenv) if dotenv else {}), **(os.environ if env is None else env)}
    changes = {}
    for f in fields(BotConfig):
        raw = merged.get('BOT_' + f.name)
        if raw is not None:
            changes[f.name] = _parse(str(f.type), raw)
    return replace(BotConfig(), **changes)


def credentials(dotenv: Path = ROOT / '.env.local') -> tuple[str, Path]:
    """Kalshi API key id and private-key path, the same two settings the engine reads. Never logged."""
    merged = {**_dotenv(dotenv), **os.environ}
    key_id, path = merged.get('KALSHI_API_KEY_ID', ''), merged.get('KALSHI_PRIVATE_KEY_PATH', '')
    if not key_id or not path:
        raise RuntimeError('KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_PATH are needed in .env.local (Kalshi streams require a signed connection)')
    p = Path(path)
    return key_id, p if p.is_absolute() else ROOT / p
