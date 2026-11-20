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
    # 2026-11-19, owner: "let the bot buy cheap tickets under 10 cents". It was 0.10 (no longshots: the fee is about 7%
    # of the stake there). The rest of the rule is unchanged, so a 5c ask is bought only when the model says 8.3% or
    # more. Replay with 0.01 on the journal (907 fills, 1 s after the decision, flat 1 contract, held): 48 tickets were
    # bought under 10c, none under 3c; 9 won (18.8% at an average 7.2c): +11.1c a contract (95% +0.6..+23.1), and the
    # whole rule went from +0.37c to +0.90c a contract (-1.7..+3.4). Nine winners is not proof: the neighbouring 10-19c
    # band is -0.5c on 182 fills. Across every recorded round a 3-5c offer wins 4.1% and a 6-10c offer 10.0%: Kalshi's
    # cheap prices are fair on their own. Selling one of these tickets when it jumped (2x .. 10x the price paid, or a
    # bid of 30c / 50c) was worse than holding in every version (-4c .. -12c a contract), so there is no such sale.
    MIN_ASK: float = 0.01          # Kalshi's lowest price
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
    # 2026-11-20, user choice: size every trade as if its edge were at most SIZE_EDGE_CAP (0 = no cap). Which trades are
    # taken is unchanged. On the 319 settled paper rounds the model's 5c+ edges won 27% against the 38% it said (n 44,
    # -$16.20) while 0-5c edges made +$15.74, so plain Kelly put the biggest bets on the worst trades. Replay at a fixed
    # $15: plain Kelly +$2.77, cap 3c +$6.92, 4c +$8.47, 5c +$8.82; a blend toward Kalshi's price was worse (-$3 to -$4)
    # because the fee wipes out the small edges first. The cap was picked on those same rounds: live is the test.
    SIZE_EDGE_CAP: float = 0.04
    # --- Real money (bot/live.py), 2026-11-17, user: "same type of experiment, but with real money that I can afford to lose" ---
    # MODE 'live' sends real Kalshi orders, and only while the switch on the Bot page is on (data/bot-live.json). The bot
    # spends from its own ledger (LIVE_DB_PATH), which starts at LIVE_BUDGET and grows only by its own wins: whatever
    # else is in the Kalshi account is never counted. In live mode the paper account is left as it is.
    MODE: str = 'paper'            # 'paper' | 'live'
    LIVE_BUDGET: float = 15.0
    LIVE_DB_PATH: str = str(ROOT / 'data' / 'bot-live.db')
    # --- Arming and plumbing-test sizing (2026-11-18 audit). Switching real trading on is good for one run of the bot
    # and for ARM_MAX_HOURS at most: every start, a restart after a crash included, begins switched off, and an arming
    # that has run out switches itself off (bot/live.py Switch.why_off).
    ARM_MAX_HOURS: float = 10.0    # 2026-11-20, user: 4 -> 10 so one arming covers a night
    # Real orders are a flat MAX_CONTRACTS_PER_ROUND contracts (still cut to what the cash can pay) instead of the
    # Kelly size: the paper record shows no edge, so real money is only testing the plumbing. 0 = size by the rule.
    # 2026-11-20, user: back to the rule's own Kelly size (KELLY_FRAC, capped at MAX_RISK_FRAC of the bankroll).
    MAX_CONTRACTS_PER_ROUND: float = 0.0
    AUDIT_ROUNDS: int = 50         # at start, this many of the latest recorded rounds are compared with Kalshi's fills
    # --- Selling a losing position early (live mode only), 2026-11-17, user: "sell whatever we have left, something is
    # better than nothing". When the best bid for the side held has stayed at or under EXIT_BELOW x the entry price for
    # EXIT_HOLD_S seconds, with at least EXIT_MIN_SECS_LEFT left, the bot sells what it holds at that bid. Replay on
    # the bot's 302 entries and on 5,312 recorded cheap-side entries (minute candles): the same average result as
    # holding (-3.5c vs -3.9c; +0.8c vs +0.8c) with smaller swings. Selling winners at a fixed gain (2x the entry,
    # +15c, ...) cost about 2c a contract in the same replay, so there is no take-profit rule.
    # Reversal (the owner sold three rounds by hand that had gone up and were turning): once the bid has been EXIT_UP
    # above the entry, a fall back to EXIT_BACK x its highest bid sells too, down to EXIT_REVERSAL_MIN_SECS_LEFT.
    # Both rules together in the same replay: -3.8c vs -3.9c held, swing 27c vs 37c. They cut swings, not the fee.
    # 2026-11-19, owner's choice after the review of the first 73 real trades: BOTH RULES OFF (0). The bot's own 34 sales
    # booked -$14.64 where the same positions held to settlement were -$0.39 (the side sold went on to win 10 of 34
    # times at an average sale price of 13.5c), and a second-by-second replay on 883 recorded entries (the journal's
    # one-second books, not minute candles) put selling at -1.35c a contract against holding (95% -3.10..+0.30; 54% of
    # positions sold, swing 40c -> 32c): every sale pays a second fee and crosses the spread. To have them back, set
    # BOT_EXIT_BELOW=0.5 and BOT_EXIT_BACK=0.6 in .env.local. Sales by hand are still booked either way.
    EXIT_BELOW: float = 0.0        # 0 = the losing-position exit is off (it was 0.5: sell at half the entry)
    EXIT_MIN_SECS_LEFT: float = 120.0
    EXIT_UP: float = 0.10
    EXIT_BACK: float = 0.0         # 0 = the reversal exit is off (it was 0.6: sell at 60% of the high)
    EXIT_REVERSAL_MIN_SECS_LEFT: float = 60.0
    EXIT_HOLD_S: float = 15.0      # the bid must stay there this long: one flicker of the book is not a reversal
    # Scalp (2026-11-19, owner: "a scalping button"): a ticket bought under SCALP_BELOW is sold, at once, when its bid
    # reaches SCALP_AT x the price paid, down to SCALP_MIN_SECS_LEFT. OFF (0) unless switched on from the Bot page
    # (bot/features.py): on the replay's 48 tickets under 10c, selling at 5x made +1.9c a contract where holding made
    # +11.1c (9.2c worse, 95% 2.5..16.8c worse); 2x, 3x, 10x, a bid of 30c and a bid of 50c were all worse than holding.
    SCALP_AT: float = 0.0          # 0 = off; 5 = sell at five times the price paid
    SCALP_BELOW: float = 0.10
    SCALP_MIN_SECS_LEFT: float = 5.0
    # --- Fill model ---
    LATENCY_MS: int = 300          # decision -> the order reaching Kalshi; the paper fill uses the book as it is then
    # --- Data guards ---
    # 500 ms each since 2026-11-18 (were 1500), the engine's stale-book breaker (DECISIONS 70): the bet is on about one
    # second of information, so a book or an index value older than half of that is not a price to decide on. The 5 Hz
    # value arrives every 200 ms; without it the bot can decide only in the half second after each 1 Hz print.
    MAX_BOOK_DELAY_MS: int = 500   # Kalshi's stream behind its own send times by more than this: no trade
    MAX_PRINT_AGE_MS: int = 500    # newest BRTI value older than this (local receive time): no trade
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
    # Everything the bot prints also goes here, with the traceback of any crash (runner.open_log). Rotated by size.
    LOG_PATH: str = str(ROOT / 'logs' / 'bot.log')
    LOG_MAX_MB: float = 5.0
    LOG_BACKUPS: int = 5

    def __post_init__(self) -> None:
        if not (0 < self.MIN_EDGE < 1 and 0 <= self.MIN_ASK < self.MAX_ASK <= 1):
            raise ValueError('MIN_EDGE, MIN_ASK and MAX_ASK must be prices in (0, 1)')
        if not (0 < self.KELLY_FRAC <= 1 and 0 < self.MAX_RISK_FRAC <= 1):
            raise ValueError('KELLY_FRAC and MAX_RISK_FRAC must be in (0, 1]')
        if not (0 <= self.SIZE_EDGE_CAP < 1):
            raise ValueError('SIZE_EDGE_CAP must be 0 (off) or a price in (0, 1)')
        if not (0 <= self.MIN_SECS_LEFT < self.MAX_SECS_LEFT <= 900):
            raise ValueError('need 0 <= MIN_SECS_LEFT < MAX_SECS_LEFT <= 900')
        if self.START_BANKROLL <= 0 or self.LATENCY_MS < 0 or self.PRIORITY not in ('low', 'normal'):
            raise ValueError('invalid bankroll, latency or priority')
        if not (0 <= self.EXIT_BELOW < 1 and 0 <= self.EXIT_BACK < 1 and self.EXIT_UP > 0 and min(self.EXIT_HOLD_S, self.EXIT_MIN_SECS_LEFT, self.EXIT_REVERSAL_MIN_SECS_LEFT) >= 0):
            raise ValueError('EXIT_BELOW and EXIT_BACK must be in [0, 1), EXIT_UP positive and the exit times non-negative')
        if not ((self.SCALP_AT == 0 or self.SCALP_AT > 1) and 0 < self.SCALP_BELOW <= 1 and self.SCALP_MIN_SECS_LEFT >= 0):
            raise ValueError('SCALP_AT must be 0 (off) or a multiple above 1, SCALP_BELOW a price and SCALP_MIN_SECS_LEFT not negative')
        if self.MODE not in ('paper', 'live') or not (0 < self.LIVE_BUDGET <= 1000):
            raise ValueError("MODE must be 'paper' or 'live', and LIVE_BUDGET between 0 and 1000 dollars")
        if not (0 < self.ARM_MAX_HOURS <= 24 and self.MAX_CONTRACTS_PER_ROUND >= 0 and self.AUDIT_ROUNDS >= 0):
            raise ValueError('ARM_MAX_HOURS must be in (0, 24], MAX_CONTRACTS_PER_ROUND and AUDIT_ROUNDS not negative')
        if min(self.MAX_BOOK_DELAY_MS, self.MAX_PRINT_AGE_MS) <= 0 or self.LOG_MAX_MB <= 0 or self.LOG_BACKUPS < 0:
            raise ValueError('the data guards and the log size must be positive')


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
