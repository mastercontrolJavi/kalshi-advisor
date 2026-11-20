"""The live loop: one signed Kalshi websocket carrying the order book of the current round and the BRTI index (1 Hz
settlement prints and the 5 Hz value). Every BRTI value and every book change re-prices the round; a decision becomes a
paper fill LATENCY_MS later, against the book as it stands at that moment. In live mode (config MODE, bot/live.py) the
decision becomes one real immediate-or-cancel order instead, and only while the switch on the Bot page is on."""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import sys
import time
import traceback
import uuid
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import websockets

from edge.ev_gate import taker_fee

from . import kalshi, live
from .book import Book, FeedDelay
from .config import BotConfig, credentials
from .paper import PaperBroker, walk
from .strategy import Intent, Pricer, decide


BALANCE_MAX_AGE_S = 60.0    # live mode: no order on a Kalshi balance older than this
PENDING_GIVE_UP_S = 300.0   # live mode: an unclear order Kalshi still does not show after this is reported for a manual check


def settled_result(market: dict) -> Optional[str]:
    """'yes' or 'no' once Kalshi has decided the round, 'void' for a voided one, None while it is not settled.

    Checked against Kalshi 2026-11-17: all 6,480 settled KXBTC15M markets read status 'finalized' with result 'yes' or
    'no'. The market's result enum is yes / no / scalar / '' (docs.kalshi.com Get Market); 'void' ("voided/cancelled and
    all positions returned at original cost") is named in the account's settlement records. So a finalized market with
    neither yes nor no is read by its settlement_value_dollars (the YES payout): 1 or 0 is a plain yes or no, none is a
    void. A fractional value (a scalar settlement, not something a binary BTC round should get) is left open and logged,
    for the owner to check, rather than guessed."""
    result = market.get('result')
    if result in ('yes', 'no'):
        return result
    if result == 'void':
        return 'void'
    if market.get('status') != 'finalized':
        return None
    raw = market.get('settlement_value_dollars')
    if raw in (None, ''):
        return 'void'
    value = float(raw)
    if value >= 1 - 1e-9:
        return 'yes'
    if value <= 1e-9:
        return 'no'
    log('settlement-unhandled', ticker=market.get('ticker'), result=result, settlement_value=raw)
    return None


_file_log: Optional[logging.Logger] = None


def open_log(path: str, max_mb: float = 5.0, backups: int = 5) -> None:
    """Also write every log line to a file that rotates by size (logs/bot.log, .1 ... .N). The launcher's console
    window is the only other place the bot's output goes, and it is gone after a crash or a relaunch."""
    global _file_log
    close_log()
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(path, maxBytes=int(max_mb * 1_000_000), backupCount=backups, encoding='utf-8')
    handler.setFormatter(logging.Formatter('%(message)s'))
    logger = logging.getLogger('bot.file')
    logger.setLevel(logging.INFO)
    logger.propagate = False
    logger.addHandler(handler)
    _file_log = logger


def close_log() -> None:
    global _file_log
    if _file_log is not None:
        for h in list(_file_log.handlers):
            _file_log.removeHandler(h)
            h.close()
        _file_log = None


def log(event: str, **data) -> None:
    line = json.dumps({'time': datetime.now(timezone.utc).isoformat(timespec='milliseconds'), 'event': event, **data}, default=str)
    try:
        print(line, flush=True)
    except Exception:  # a closed console must not stop the bot, or the file log
        pass
    if _file_log is not None:
        try:
            _file_log.info(line)
        except Exception:
            pass


def log_crash(where: str, exc: BaseException) -> None:
    """An error nothing handled, with its traceback, so a crash is in logs/bot.log and not only in a closed window."""
    log('crash', where=where, error=repr(exc), traceback=''.join(traceback.format_exception(type(exc), exc, exc.__traceback__)))


def spawn(coro, where: str) -> 'asyncio.Task':
    """create_task, with any error the task ends on written to the log (a bare task would lose it)."""
    task = asyncio.get_running_loop().create_task(coro)

    def done(t: 'asyncio.Task') -> None:
        if not t.cancelled() and t.exception() is not None:
            log_crash(where, t.exception())
    task.add_done_callback(done)
    return task


def lower_priority() -> str:
    try:
        if sys.platform == 'win32':
            import ctypes
            from ctypes import wintypes as w
            k = ctypes.WinDLL('kernel32', use_last_error=True)
            k.GetCurrentProcess.restype = w.HANDLE
            k.SetPriorityClass.argtypes, k.SetPriorityClass.restype = [w.HANDLE, w.DWORD], w.BOOL
            return 'below-normal' if k.SetPriorityClass(k.GetCurrentProcess(), 0x00004000) else 'unchanged'
        import os
        os.nice(5)
        return 'nice +5'
    except Exception as e:  # never fail startup over priority
        return f'unchanged ({e!r})'


def parse_ts(iso: str) -> float:
    return datetime.fromisoformat(iso.replace('Z', '+00:00')).timestamp()


def best_side(p_yes: float, yes_ask: Optional[float], no_ask: Optional[float], intent: Optional[Intent]) -> dict:
    """The side and edge to show: the one decide() picked, else the side with the larger edge after the fee (the one
    decide() would pick if it passed the rules). Never inferred from which side the model favours."""
    if intent is not None:
        return {'side': intent.side, 'edge': intent.edge}
    edges = [(q - ask - taker_fee(ask), side) for side, q, ask in (('yes', p_yes, yes_ask), ('no', 1 - p_yes, no_ask)) if ask is not None and 0 < ask < 1]
    if not edges:
        return {'side': None, 'edge': None}
    edge, side = max(edges)
    return {'side': side, 'edge': edge}


class Market:
    def __init__(self, m: dict):
        self.ticker: str = m['ticker']
        self.open = parse_ts(m['open_time'])
        self.close = parse_ts(m['close_time'])
        self.strike: Optional[float] = None
        self.update(m)
        self.book = Book()
        self.book_ts_ms: Optional[float] = None  # Kalshi's send time of the last book message for this round

    def update(self, m: dict) -> None:
        k = m.get('floor_strike')
        if k is not None and float(k) > 0:
            self.strike = float(k)


class Bot:
    # Defaults for a Bot built without __init__ (the tests do that).
    boot_id: Optional[str] = None      # this run of the bot; an arming made for another run does not count
    drift: List[dict] = []             # what the start-up comparison with Kalshi found (live mode)
    decision_marks: Optional[dict] = None  # timestamps of the decision being executed
    audit_at: Optional[float] = None
    audit_pending: bool = False        # live mode, from the start until that comparison has finished: no arming before it

    def __init__(self, cfg: BotConfig):
        self.cfg = cfg
        self.boot_id = uuid.uuid4().hex
        self.drift, self.audit_at = [], None
        self.signer = kalshi.Signer(*credentials())
        # Live mode keeps its own ledger, started at the real-money budget; the paper account is not touched.
        self.live = cfg.MODE == 'live'
        self.audit_pending = self.live   # cleared by audit(); until then switched_on() is False and the page cannot arm
        self.broker = PaperBroker(cfg.LIVE_DB_PATH, cfg.LIVE_BUDGET) if self.live else PaperBroker(cfg.DB_PATH, cfg.START_BANKROLL)
        self.switch = live.Switch(Path(cfg.LIVE_DB_PATH).with_name('bot-live.json'))
        self.armed = False               # refreshed every 10 s, and read again from the file right before an order
        self.tripped: Optional[float] = None  # when the bot last switched itself off (ms); only a later switch-on by the owner counts
        self.boot_disarm()
        self.selling = False             # early sales allowed (on, or switched off by the bot itself): refreshed like `armed`
        self.balance: Optional[float] = None  # the Kalshi account's cash in dollars (live mode), read every 10 s
        self.balance_at = 0.0
        self.peaks: Dict[str, float] = {}       # highest bid seen for the side held, per round
        self.exit_since: Dict[str, float] = {}  # when the exit condition first held without a break
        self.exit_wait: Dict[str, float] = {}   # no new sell attempt before this time
        self.exit_tries: Dict[str, int] = {}
        self.pricer = Pricer(cfg)
        self.markets: Dict[str, Market] = {}
        self.subscribed: set = set()
        self.ws = None
        self.next_id = 10
        self.seqs: Dict[int, int] = {}   # last sequence number seen on each subscription id
        self.book_sids: set = set()      # subscription ids that carry order-book messages
        self.delay = FeedDelay()
        self.last_value_ms = 0.0      # local receive time of the newest BRTI value
        self.print_ms = 0.0           # ... of the newest 1 Hz print, and of the newest 5 Hz value: the age guard is on the one priced off
        self.fast_ms = 0.0
        self.pending: Optional[str] = None  # ticker with an order in flight
        self.cooldown: Dict[str, float] = {}
        self.stats = {'messages': 0, 'evals': 0, 'reasons': {}}
        self.hit_target = self.broker.equity >= cfg.TARGET
        self.view: Optional[tuple] = None  # the latest look at the round: (ticker, secs_left, p_yes, yes_ask, no_ask, verdict, intent)
        self.connected = False
        self.started = time.time()
        self.status_path = Path(cfg.DB_PATH).with_name('bot-status.json')

    def now(self) -> float:
        """Kalshi's time in seconds (this PC's clock plus the offset read from Kalshi's responses): what a round's open
        and close times are compared with."""
        return kalshi.clock.now()

    def boot_disarm(self) -> None:
        """Every start begins switched off. An arming left in the file by an earlier run could not trade anyway (it names
        that run's boot_id); writing the file off as well makes the Bot page say so. Off by the owner is left as it is."""
        if not self.live:
            return
        try:
            if self.switch.read()['armed']:
                self.switch.off('The bot restarted, so real trading was switched off. Switch it on again to continue.')
                log('real-trading-off', note='boot: an earlier arming was cleared', boot_id=self.boot_id)
        except Exception as e:
            log('switch-write-error', message=repr(e))

    def expire(self) -> None:
        """An arming that is not good for this run any more (run out, or made for another run) is written off, with the
        reason, so the Bot page shows it. It is not a fault: the next switch-on needs nothing more than a valid arming."""
        s = self.switch.read()
        why = self.switch.why_off(self.boot_id, time.time() * 1000, self.cfg.ARM_MAX_HOURS, s)
        if s['armed'] and why is not None:
            tripped = self.tripped
            self.disarm(f'Real trading was switched off: {why}. Switch it on again to continue.')
            self.tripped = tripped

    # ---------- market list ----------
    async def refresh_markets(self) -> None:
        now = self.now()
        data = await kalshi.get(f'/markets?series_ticker={self.cfg.SERIES}&min_close_ts={int(now)}&max_close_ts={int(now) + 3600}&limit=100')
        for m in data.get('markets', []):
            if m['ticker'] in self.markets:
                self.markets[m['ticker']].update(m)
            else:
                self.markets[m['ticker']] = Market(m)
        soon = sorted((m for m in self.markets.values() if m.close > now), key=lambda m: m.open)[:2]
        for m in soon:
            if m.strike is None and m.open <= now:  # the strike is published shortly after the open
                m.update((await kalshi.get('/markets/' + m.ticker)).get('market', {}))
        for t in [t for t, m in self.markets.items() if m.close < now - 3600 and t not in self.broker.positions]:
            del self.markets[t]
            for memo in (self.peaks, self.exit_since, self.exit_wait, self.exit_tries, self.cooldown):
                memo.pop(t, None)
        await self.subscribe([m.ticker for m in soon])

    def current(self, now: float) -> Optional[Market]:
        for m in self.markets.values():
            if m.open <= now < m.close:
                return m
        return None

    async def reconcile(self, ticker: str) -> None:
        """Live mode: book whatever Kalshi shows as sold of this round's position, by the bot or by the owner by hand."""
        row = self.broker.db.execute('SELECT side FROM fills WHERE ticker = ? ORDER BY id LIMIT 1', (ticker,)).fetchone()
        if row is None:
            return
        n, cash = live.sold(await live.read_fills(self.signer, f'ticker={ticker}&limit=200', tries=2), row[0])
        added = self.broker.exits(ticker, n, cash, time.time()) if n > 0 else 0.0
        if added:
            log('real-sale-booked', ticker=ticker, sold=n, cash=round(cash, 4), added=round(added, 4), equity=round(self.broker.equity, 4))

    async def reconcile_all(self, recent_s: float = 0.0) -> None:
        tickers = set(self.broker.open_tickers())
        if recent_s:  # also rounds settled lately, in case a sale by hand was missed while the bot was down
            tickers |= {r[0] for r in self.broker.db.execute('SELECT ticker FROM fills WHERE ts > ?', (time.time() - recent_s,))}
        for ticker in sorted(tickers):
            try:
                await self.reconcile(ticker)
            except Exception as e:
                log('reconcile-error', ticker=ticker, message=repr(e))

    async def settle(self) -> None:
        if self.live:
            await self.reconcile_all()
        for ticker in self.broker.open_tickers():
            m = self.markets.get(ticker)
            if m is not None and self.now() < m.close + 5:
                continue
            market = (await kalshi.get('/markets/' + ticker)).get('market', {})
            result = settled_result(market)
            if result is not None:
                pnl = self.broker.settle(ticker, result, time.time())
                eq = self.broker.equity
                log('settled', ticker=ticker, result=result, kalshi_result=market.get('result'), pnl=round(pnl, 4), equity=round(eq, 4))
                if not self.hit_target and eq >= self.cfg.TARGET:
                    self.hit_target = True
                    log('target-reached', equity=round(eq, 2), target=self.cfg.TARGET)

    async def refresh_balance(self) -> None:
        """Live mode: the account's real cash. An order is never larger than this, whatever the bot's own record says."""
        if not self.live:
            return
        b = await kalshi.signed_get(self.signer, '/portfolio/balance')
        cash = float(b['balance']) / 100     # cents, as the engine reads it (src/engine/account.ts)
        if not (math.isfinite(cash) and cash >= 0):
            raise ValueError(f'unsupported balance {b.get("balance")!r}')
        self.balance, self.balance_at = cash, time.time()

    async def audit(self) -> None:
        """Live mode, at start: compare the record with Kalshi and say where they differ, instead of drifting apart
        unnoticed. Each of the latest AUDIT_ROUNDS recorded rounds is checked against Kalshi's fills for that market
        (contracts and dollars bought and sold), and the record's cash against the account's cash. Nothing is changed
        here: sales found on Kalshi are booked by reconcile(), which runs first; what is still different is logged
        ('ledger-drift') and shown on the Bot page for the owner to look at before switching on."""
        if not self.live:
            self.audit_pending = False
            return
        try:
            await self._audit()
        except Exception as e:  # the comparison itself failed: say so on the page instead of blocking arming for good
            log_crash('audit', e)
            self.drift, self.audit_at = [{'ticker': None, 'error': f'the comparison with Kalshi failed: {e!r}'}], time.time()
        finally:
            self.audit_pending = False

    async def _audit(self) -> None:
        found: List[dict] = []
        rows = self.broker.db.execute('SELECT ticker, side, contracts, contracts * price, fee, exit_n, exit_cash FROM fills ORDER BY id DESC LIMIT ?', (self.cfg.AUDIT_ROUNDS,)).fetchall()
        for ticker, side, n, paid, fee, exit_n, exit_cash in reversed(rows):
            try:
                fills = await live.read_fills(self.signer, f'ticker={ticker}&limit=200')
                d = live.drift({'ticker': ticker, 'side': side, 'contracts': n, 'paid': paid, 'fee': fee, 'exit_n': exit_n, 'exit_cash': exit_cash}, fills)
            except Exception as e:
                d = {'ticker': ticker, 'error': repr(e)}
            if d is not None:
                found.append(d)
                log('ledger-drift', **d)
            await asyncio.sleep(1.0)  # one read a second: Kalshi answers 429 to quicker signed reads (seen 2026-11-18), and the engine shares the limit
        cash = self.broker.cash
        if self.balance is None:
            found.append({'ticker': None, 'error': 'the Kalshi balance could not be read'})
            log('ledger-drift', error='the Kalshi balance could not be read')
        elif self.balance < cash - 0.01:  # the record is a budget inside the account: the account can hold more, never less
            found.append({'ticker': None, 'balance_short': round(cash - self.balance, 4)})
            log('ledger-drift', balance=self.balance, ledger_cash=round(cash, 4), balance_short=round(cash - self.balance, 4))
        self.drift, self.audit_at = found, time.time()
        log('ledger-audit', rounds=len(rows), differences=len(found), ledger_cash=round(cash, 4), balance=self.balance,
            account_minus_ledger=None if self.balance is None else round(self.balance - cash, 4))

    async def resolve_pending(self) -> None:
        """Live mode: settle every real order whose outcome is not booked yet (see resolve_order)."""
        if not self.live:
            return
        for p in self.broker.pending_orders():
            if p['ticker'] == self.pending:  # the order path is handling this one right now
                continue
            try:
                note = await self.resolve_order(p)
                if note is not None:
                    log('pending-order-resolved', ticker=p['ticker'], cid=p['cid'], note=note)
            except Exception as e:
                log('pending-order-error', ticker=p['ticker'], message=repr(e))

    async def resolve_order(self, p: dict) -> Optional[str]:
        """Look one real order up on Kalshi by the client id it was sent with, and book what it bought. Only that order is
        read, so a trade by hand on the same round is never mistaken for the bot's. Returns a note once the order is
        settled in the record, or None while Kalshi does not show it (or all its fills) yet. An order Kalshi still does
        not show after PENDING_GIVE_UP_S switches real trading off with a note to check the account."""
        t, side = p['ticker'], p['side']
        orders = (await kalshi.signed_get(self.signer, f'/portfolio/orders?ticker={t}&limit=200')).get('orders') or []
        order = next((o for o in orders if o.get('client_order_id') == p['cid']), None)
        if order is None:
            if time.time() - p['ts'] < PENDING_GIVE_UP_S:
                return None
            self.broker.drop_pending(p['cid'])
            note = (f'An order on {t} that got no clear answer is still not on Kalshi {PENDING_GIVE_UP_S // 60:g} minutes later, '
                    'so nothing is in the record for it: check Kalshi for a position in this round.')
            self.disarm(note)
            return note
        want = float(order.get('fill_count_fp') or order.get('fill_count') or 0)
        n, paid, fees = live.from_fills(await live.read_fills(self.signer, f"order_id={order['order_id']}", want=want), side)
        if n < want - 0.005:
            return None                      # Kalshi says more filled than its fills show yet: look again in 10 s
        booked = n > 0 and not self.broker.has_fill(t)  # one buy a round: an order already booked is never booked twice
        if booked:
            context = {k: p[k] for k in ('q', 'edge', 'p_yes', 'secs_left')}
            fill = self.broker.record(t, side, n, paid, fees, p['limit_price'], p['wanted'], time.time(), **context)
            if self.balance is not None:
                self.balance -= paid + fees
            log('real-fill-recovered', ticker=t, side=side, contracts=fill.contracts, price=round(fill.price, 4), fee=round(fill.fee, 4), cash=round(self.broker.cash, 4))
        self.broker.drop_pending(p['cid'])
        return f'Kalshi shows {n:g} contracts bought; they are in the record.' if n > 0 else 'Kalshi shows nothing bought.'

    async def housekeeping(self) -> None:
        tick = 0
        while True:
            for name, job in (('markets', self.refresh_markets), ('balance', self.refresh_balance), ('pending', self.resolve_pending), ('settle', self.settle)):
                try:
                    await job()
                except Exception as e:
                    log(name + '-error', message=repr(e))
            tick += 1
            if self.live:
                try:
                    self.expire()
                except Exception as e:
                    log('expire-error', message=repr(e))
            self.armed = self.live and self.switched_on()
            self.selling = self.live and self.may_sell()
            try:
                self.write_status()
            except Exception as e:
                log('status-error', message=repr(e))
            if tick % 6 == 0:
                try:  # a log line: never worth stopping the bot over (an error here would end the whole process)
                    s = self.broker.summary()
                    log('status', equity=round(s['equity'], 4), rounds=s['rounds'], wins=s['wins'], open=s['open'], misses=s['misses'],
                        book_delay_ms=round(self.delay.ms), vol_ready=self.pricer.ready, messages=self.stats['messages'], evals=self.stats['evals'],
                        reasons=self.stats['reasons'])
                except Exception as e:
                    log('status-error', message=repr(e))
                self.stats = {'messages': 0, 'evals': 0, 'reasons': {}}
            await asyncio.sleep(10)

    def write_status(self) -> None:
        """A small file the dashboard's Bot page reads (written every 10 s, replaced atomically)."""
        now = time.time()
        v, cfg, m = self.view, self.cfg, self.current(self.now())
        data = {'time': now * 1000, 'started': self.started * 1000, 'connected': self.connected, 'ready': self.pricer.ready,
                'bootId': self.boot_id, 'armMaxHours': cfg.ARM_MAX_HOURS, 'maxContracts': cfg.MAX_CONTRACTS_PER_ROUND,
                'clockOffsetMs': round(kalshi.clock.offset_ms) if kalshi.clock.synced else None,
                'drift': self.drift if self.live else None, 'auditPending': self.audit_pending, 'auditAt': None if self.audit_at is None else self.audit_at * 1000,
                'mode': cfg.MODE, 'armed': self.armed, 'switch': self.switch.read() if self.live else None, 'budget': cfg.LIVE_BUDGET,
                'balance': self.balance if self.live and now - self.balance_at <= BALANCE_MAX_AGE_S else None, 'selling': self.selling,
                'warmup': [self.pricer.vol.count, cfg.VOL_MIN_SAMPLES], 'bookDelayMs': round(self.delay.ms),
                'valueAgeMs': round(now * 1000 - self.last_value_ms) if self.last_value_ms else None,
                'round': None if m is None else {'ticker': m.ticker, 'close': m.close * 1000, 'strike': m.strike, 'held': m.ticker in self.broker.positions},
                'view': None if v is None or m is None or v[0] != m.ticker else {'secsLeft': v[1], 'pYes': v[2], 'yesAsk': v[3], 'noAsk': v[4], 'verdict': v[5],
                                                                               **best_side(v[2], v[3], v[4], v[6])},
                'config': {'start': self.broker.start, 'target': cfg.TARGET, 'minEdge': cfg.MIN_EDGE, 'minAsk': cfg.MIN_ASK, 'maxAsk': cfg.MAX_ASK,
                           'midBand': [cfg.MID_BAND_LOW, cfg.MID_BAND_HIGH] if cfg.BLOCK_MID_BAND else None, 'window': [cfg.MIN_SECS_LEFT, cfg.MAX_SECS_LEFT],
                           'kelly': cfg.KELLY_FRAC, 'maxRisk': cfg.MAX_RISK_FRAC, 'latencyMs': cfg.LATENCY_MS,
                           'exit': {'below': cfg.EXIT_BELOW, 'up': cfg.EXIT_UP, 'back': cfg.EXIT_BACK} if self.live else None}}
        tmp = self.status_path.with_suffix('.tmp')
        tmp.write_text(json.dumps(data), encoding='utf-8')
        os.replace(tmp, self.status_path)

    # ---------- websocket ----------
    async def subscribe(self, tickers: list) -> None:
        new = [t for t in tickers if t not in self.subscribed]
        ws, subscribed = self.ws, self.subscribed
        if not new or ws is None:
            return
        self.next_id += 1
        # Marked before the send: housekeeping and a reconnect can both get here, and a round subscribed twice would get
        # every book change twice. A failed send unmarks them (on the same connection's set) so a later call tries again.
        subscribed.update(new)
        try:
            # use_yes_price: NO levels arrive quoted as YES prices (what the engine uses); they are converted back on receipt.
            await ws.send(json.dumps({'id': self.next_id, 'cmd': 'subscribe', 'params': {'channels': ['orderbook_delta'], 'market_tickers': new, 'use_yes_price': True}}))
        except BaseException:
            subscribed.difference_update(new)
            raise
        log('subscribed', tickers=new)

    async def stream(self) -> None:
        backoff = 0.5
        while True:
            try:
                async with websockets.connect(kalshi.WS, additional_headers=self.signer.headers(kalshi.WS_PATH), ping_interval=5, ping_timeout=10,
                                              max_size=2 ** 22, max_queue=4096, open_timeout=10) as ws:
                    self.ws, self.subscribed, self.seqs, self.book_sids = ws, set(), {}, set()
                    for m in self.markets.values():
                        m.book.valid = False
                    await ws.send(json.dumps({'id': 1, 'cmd': 'subscribe', 'params': {'channels': ['cfbenchmarks_value'], 'index_ids': ['BRTI']}}))
                    await ws.send(json.dumps({'id': 2, 'cmd': 'subscribe', 'params': {'channels': ['cfbenchmarks_value_5hz'], 'index_ids': ['BRTI']}}))
                    now = self.now()
                    await self.subscribe([m.ticker for m in sorted(self.markets.values(), key=lambda m: m.open) if m.close > now][:2])
                    self.connected = True
                    log('connected')
                    backoff = 0.5
                    async for raw in ws:
                        self.on_message(json.loads(raw))
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log('stream-error', message=repr(e))
            self.ws, self.connected = None, False
            for m in self.markets.values():
                m.book.valid = False
            await asyncio.sleep(backoff)
            backoff = min(30.0, backoff * 2)

    def on_message(self, m: dict) -> None:
        self.stats['messages'] += 1
        kind, d = m.get('type'), m.get('msg') or {}
        now_ms = time.time() * 1000
        # Kalshi numbers every message on a subscription (acks included), separately per subscription id. A later
        # subscribe for the next round may join the first id or get its own, so every id is tracked. A skipped number on
        # an id that carries book messages is a lost book update: every book is distrusted until fresh snapshots arrive.
        sid, seq = m.get('sid'), m.get('seq')
        if kind in ('orderbook_delta', 'orderbook_snapshot') and isinstance(sid, int):
            self.book_sids.add(sid)
        if isinstance(sid, int) and isinstance(seq, int):
            last = self.seqs.get(sid)
            self.seqs[sid] = seq
            if last is not None and seq != last + 1:
                log('sequence-gap', sid=sid, seq=seq, expected=last + 1, book=sid in self.book_sids)
                if sid in self.book_sids:
                    for market in self.markets.values():
                        market.book.valid = False
                    spawn(self.resync(), 'resync')
                    return
        if kind in ('orderbook_delta', 'orderbook_snapshot'):
            market = self.markets.get(d.get('market_ticker'))
            if isinstance(m.get('sending_ts_ms'), (int, float)):
                self.delay.observe(m['sending_ts_ms'], now_ms)
                if market is not None:
                    market.book_ts_ms = float(m['sending_ts_ms'])
            if market is None:
                return
            if kind == 'orderbook_snapshot':
                market.book.snapshot(d.get('yes_dollars_fp') or [], [(1 - float(p), q) for p, q in (d.get('no_dollars_fp') or [])])
            else:
                price = float(d['price_dollars'])
                if not market.book.delta(d['side'], 1 - price if d['side'] == 'no' else price, float(d['delta_fp'])):
                    log('book-invalid', ticker=market.ticker)
                    spawn(self.resync(), 'resync')
                    return
            self.evaluate(market)
        elif kind in ('cfbenchmarks_value', 'cfbenchmarks_value_5hz'):
            if d.get('index_id') != 'BRTI':
                return
            raw = d.get('data')
            raw = json.loads(raw) if isinstance(raw, str) else raw
            if not raw or raw.get('id') != 'BRTI' or raw.get('type') != 'value':
                return
            ts_ms, price = int(raw['time']), float(raw['value'])
            if kind == 'cfbenchmarks_value':
                if ts_ms % 1000 == 0 and self.pricer.on_print(ts_ms // 1000, price):
                    self.last_value_ms = self.print_ms = now_ms
            elif self.pricer.on_fast(ts_ms / 1000, price):
                self.last_value_ms = self.fast_ms = now_ms
            market = self.current(ts_ms / 1000)
            if market is not None:
                self.evaluate(market)
        elif kind == 'subscribed':
            if d.get('channel') == 'orderbook_delta' and isinstance(d.get('sid'), int):
                self.book_sids.add(d['sid'])
        elif kind == 'error':
            log('ws-error', detail=d)

    async def resync(self) -> None:
        """A lost or impossible book message: drop the connection; the reconnect starts from fresh snapshots."""
        if self.ws is not None:
            await self.ws.close()

    # ---------- decisions ----------
    def skip(self, why: str) -> None:
        self.stats['reasons'][why] = self.stats['reasons'].get(why, 0) + 1

    def evaluate(self, market: Market) -> None:
        self.stats['evals'] += 1
        now = time.time()        # this PC's clock: ages of what was received, cooldowns
        know = self.now()        # Kalshi's clock: where the round is between its open and its close
        pos = self.broker.positions.get(market.ticker)
        if pos is not None and self.live and self.selling and self.pending is None:
            hit = self.exit_signal(market, pos, know)  # on Kalshi's clock: the rules count the time left in the round
            if hit is not None:
                self.pending = market.ticker
                spawn(self.execute_exit(market, pos, *hit, marks={'book_ts_ms': market.book_ts_ms, 'decision_ts_ms': now * 1000}), 'execute_exit')
            return
        if self.pending is not None or market.ticker in self.broker.positions or self.cooldown.get(market.ticker, 0) > now:
            return
        if not (market.open <= know < market.close):
            return
        if market.strike is None:
            return self.skip('strike not published yet')
        if not market.book.valid or market.book.crossed:
            return self.skip('book not valid')
        if self.delay.ms > self.cfg.MAX_BOOK_DELAY_MS:
            return self.skip('Kalshi stream running behind')
        if now * 1000 - self.last_value_ms > self.cfg.MAX_PRINT_AGE_MS:
            return self.skip('BRTI value stale')
        priced = self.pricer.fair(market.strike, int(round(market.close)))
        if priced is None:
            return self.skip('model warming up')
        # The pricer uses a 5 Hz value only within 1.5 s of the last 1 Hz print; past that it prices off the print. A fresh
        # 5 Hz value must not pass the age guard for a print that stopped arriving.
        if now * 1000 - (self.fast_ms if self.pricer.spot_fast else self.print_ms) > self.cfg.MAX_PRINT_AGE_MS:
            return self.skip('BRTI value stale')
        fv, left = priced
        yes_ask, no_ask = market.book.ask('yes'), market.book.ask('no')
        intent, why = decide(self.cfg, fv, left, yes_ask, no_ask, self.broker.equity)
        self.view = (market.ticker, left, fv.p_yes, yes_ask, no_ask, why, intent)
        if intent is None:
            return self.skip(why)
        if self.broker.traded(market.ticker):
            return
        if self.live and not self.armed:
            return self.skip('real trading is switched off')
        self.pending = market.ticker
        spot = self.pricer.fast if self.pricer.spot_fast else self.pricer.last  # the BRTI value this decision was priced on
        marks = {'spot_ts_ms': None if spot is None else spot[0] * 1000, 'book_ts_ms': market.book_ts_ms, 'decision_ts_ms': now * 1000}
        self.decision_marks = marks  # picked up by execute(): one order is in flight at a time (self.pending)
        spawn(self.execute(market, intent, now), 'execute')

    def note_attempt(self, market: Market, kind: str, side: str, outcome: str, marks: Optional[dict], **more) -> None:
        """One row in the attempts table: what was decided, what became of it and the timestamps along the way. Never
        allowed to disturb the order path: a failure to write it is only logged."""
        try:
            self.broker.attempt(market.ticker, kind, side, outcome, **{**(marks or {}), 'clock_offset_ms': kalshi.clock.offset_ms if kalshi.clock.synced else None, **more})
        except Exception as e:
            log('attempt-write-error', ticker=market.ticker, message=repr(e))

    async def execute(self, market: Market, intent: Intent, decided: float, marks: Optional[dict] = None) -> None:
        """The paper order: immediate-or-cancel at the decided ask, against the book LATENCY_MS after the decision."""
        if marks is None:
            marks, self.decision_marks = self.decision_marks, None
        marks = {'decision_ts_ms': decided * 1000, **(marks or {}), 'limit_price': intent.limit, 'edge': intent.edge, 'secs_left': intent.secs_left}
        if self.live:
            try:
                await self.execute_live(market, intent, decided, marks)
            except Exception as e:  # nothing unexpected may leave the switch on
                log_crash('execute_live', e)
                self.note_attempt(market, 'buy', intent.side, 'error', marks, note=repr(e))
                self.disarm(f'Unexpected error while ordering on {market.ticker}: {e!r}. Check Kalshi before switching back on.')
                self.cooldown[market.ticker] = market.close
            finally:
                self.pending = None
            return
        try:
            await asyncio.sleep(self.cfg.LATENCY_MS / 1000)
            now = time.time()
            usable = market.book.valid and not market.book.crossed and self.delay.ms <= self.cfg.MAX_BOOK_DELAY_MS and self.now() < market.close
            asks = market.book.asks(intent.side) if usable else []
            fill = self.broker.buy(market.ticker, intent.side, intent.limit, intent.contracts, asks, now, q=intent.q, edge=intent.edge, p_yes=intent.p_yes,
                                   secs_left=intent.secs_left, latency_ms=(now - decided) * 1000)
            # A paper order is "sent" at the decision and "answered" when the simulated fill is taken off the book.
            self.note_attempt(market, 'paper', intent.side, 'missed' if fill is None else 'filled', marks, wanted=intent.contracts,
                              filled=0.0 if fill is None else fill.contracts, order_send_ts_ms=decided * 1000, order_ack_ts_ms=now * 1000, note='simulated')
            if fill is None:
                self.broker.miss(market.ticker, intent.side, intent.limit, asks[0][0] if asks else None, intent.edge, intent.secs_left, now)
                self.cooldown[market.ticker] = now + 1.0
                log('missed', ticker=market.ticker, side=intent.side, decided_ask=intent.limit, ask_then=asks[0][0] if asks else None)
            else:
                log('paper-fill', ticker=market.ticker, side=fill.side, contracts=fill.contracts, price=round(fill.price, 4), fee=round(fill.fee, 4),
                    q=round(intent.q, 4), edge=round(intent.edge, 4), secs_left=round(intent.secs_left, 1), cash=round(self.broker.cash, 4))
        finally:
            self.pending = None

    def exit_signal(self, market: Market, pos, now: float) -> Optional[Tuple[str, float]]:
        """(reason, bid) when the position should be sold now: its bid has halved from the entry, or it was up and has
        fallen back from its high. The condition must hold for EXIT_HOLD_S without a break. None otherwise."""
        cfg, t, left = self.cfg, market.ticker, market.close - now
        usable = market.book.valid and not market.book.crossed and self.delay.ms <= cfg.MAX_BOOK_DELAY_MS and market.open <= now < market.close
        bid = market.book.best_bid(pos.side) if usable else None
        if bid is None or bid < 0.01 or pos.left <= 0 or self.exit_wait.get(t, 0) > now or self.exit_tries.get(t, 0) >= 3:
            self.exit_since.pop(t, None)
            return None
        peak = self.peaks[t] = max(self.peaks.get(t, pos.price), bid)
        why = None
        if cfg.EXIT_BELOW > 0 and left >= cfg.EXIT_MIN_SECS_LEFT and bid <= cfg.EXIT_BELOW * pos.price:
            why = 'down to half its entry'
        elif cfg.EXIT_BACK > 0 and left >= cfg.EXIT_REVERSAL_MIN_SECS_LEFT and peak >= pos.price + cfg.EXIT_UP and bid <= cfg.EXIT_BACK * peak:
            why = 'reversing from its high'
        if why is None:
            self.exit_since.pop(t, None)
            return None
        return (why, bid) if now - self.exit_since.setdefault(t, now) >= cfg.EXIT_HOLD_S else None

    async def execute_exit(self, market: Market, pos, why: str, bid: float, marks: Optional[dict] = None) -> None:
        """One real sale of what is held, immediate-or-cancel at the bid, reduce_only (it can only close the position).
        The ledger then books whatever Kalshi shows as sold. A sale cannot spend money, so a problem here is logged
        and tried again (three attempts a round) instead of switching real trading off. It also runs after the bot
        switched itself off (a sale can only reduce what is held), but not after the owner switched trading off."""
        t = market.ticker
        try:
            if not self.may_sell():
                self.selling = False
                return
            self.exit_wait[t], self.exit_tries[t] = time.time() + 20.0, self.exit_tries.get(t, 0) + 1
            self.exit_since.pop(t, None)
            body = live.sell_body(t, pos.side, bid, pos.left)
            marks = {**(marks or {}), 'limit_price': bid, 'wanted': pos.left, 'cid': body['client_order_id'], 'note': why}
            log('real-sell-sent', why=why, held=pos.side, entry=round(pos.price, 4), bid=bid, **body)
            marks['order_send_ts_ms'] = time.time() * 1000
            try:
                reply = await kalshi.post(self.signer, live.ORDERS, body)
                marks['order_ack_ts_ms'] = time.time() * 1000
                log('real-sell-result', ticker=t, round_trip_ms=round(marks['order_ack_ts_ms'] - marks['order_send_ts_ms'], 1),
                    **{k: reply.get(k) for k in ('order_id', 'fill_count', 'remaining_count', 'average_fill_price', 'average_fee_paid')})
                try:
                    sold_n = float(reply.get('fill_count') or 0)
                except (TypeError, ValueError):
                    sold_n = None
                self.note_attempt(market, 'sell', pos.side, 'unclear' if sold_n is None else 'filled' if sold_n > 0 else 'missed', marks, filled=sold_n)
            except Exception as e:
                marks['order_ack_ts_ms'] = time.time() * 1000
                log('real-sell-problem', ticker=t, message=repr(e))
                self.note_attempt(market, 'sell', pos.side, 'refused' if isinstance(e, kalshi.Refused) else 'unclear', marks, note=f'{why}: {e!r}')
            await asyncio.sleep(1.0)
            await self.reconcile(t)
        except Exception as e:
            log('real-sell-error', ticker=t, message=repr(e))
        finally:
            self.pending = None

    def switched_on(self) -> bool:
        """The switch file says on, and the owner switched it on after the bot last switched itself off. The second part
        keeps the bot off when its own write to the file failed (a file held open by another program, say)."""
        if self.audit_pending:
            return False  # the start-up comparison with Kalshi has not finished: nothing is bought before its result is on the page
        s = self.switch.read()
        if self.switch.why_off(self.boot_id, time.time() * 1000, self.cfg.ARM_MAX_HOURS, s) is not None:
            return False  # off, armed for another run of the bot, no end time, or run out (live.Switch.why_off)
        return self.tripped is None or (isinstance(s['time'], (int, float)) and s['time'] > self.tripped)

    def may_sell(self) -> bool:
        """Early sales: while trading is on, and after the bot switched itself off (the file says off 'by bot', or its
        write failed and the file still says on). Off by the owner stops them too."""
        s = self.switch.read()
        return s['armed'] or s['by'] == 'bot'

    def disarm(self, note: str) -> None:
        self.armed, self.tripped, self.selling = False, time.time() * 1000, self.live
        try:
            self.switch.off(note)
        except Exception as e:
            log('switch-write-error', message=repr(e))
        finally:
            log('real-trading-off', note=note)

    async def execute_live(self, market: Market, intent: Intent, decided: float, marks: Optional[dict] = None) -> None:
        """One real order: immediate-or-cancel at the decided ask, sent once. Kalshi's fills are what the ledger records.
        Anything other than a clean answer switches real trading off until the owner switches it on again."""
        t, now = market.ticker, time.time()
        attempt = lambda outcome, **more: self.note_attempt(market, 'buy', intent.side, outcome, marks, **more)
        if not self.switched_on():  # the file is the authority: off on the page is off here, at once
            self.armed = False
            attempt('not-sent', note='real trading is switched off')
            return
        if not (market.book.valid and not market.book.crossed and self.delay.ms <= self.cfg.MAX_BOOK_DELAY_MS and self.now() < market.close - 5):
            self.cooldown[t] = now + 1.0
            attempt('not-sent', note='book not usable, or the round is closing')
            return
        # Never more than the ledger's cash, nor than the account's real cash (read every 10 s): the size is cut to what
        # both can pay at the limit, fee included. With no recent balance the bot does not order at all.
        if self.balance is None or now - self.balance_at > BALANCE_MAX_AGE_S:
            self.cooldown[t] = now + 10.0
            attempt('not-sent', note='Kalshi balance not known')
            return self.skip('Kalshi balance not known')
        # Plumbing-test sizing: a flat MAX_CONTRACTS_PER_ROUND contracts, whatever the Kelly size says (0 = the rule's size).
        want = self.cfg.MAX_CONTRACTS_PER_ROUND if self.cfg.MAX_CONTRACTS_PER_ROUND > 0 else intent.contracts
        count = walk([(intent.limit, want)], intent.limit, want, min(self.broker.cash, self.balance))[0]
        if count <= 0:
            short = self.balance < self.broker.cash  # the account, not the record, is what is short: it may be topped up
            self.cooldown[t] = now + 10.0 if short else market.close
            attempt('not-sent', wanted=want, note='cash cannot pay for this order')
            return self.skip('Kalshi balance cannot pay for this order' if short else 'budget cannot pay for this order')
        body = live.order_body(t, intent.side, intent.limit, count)
        context = dict(q=intent.q, edge=intent.edge, p_yes=intent.p_yes, secs_left=intent.secs_left)
        self.cooldown[t] = market.close  # no second order this round, unless this one fills nothing (below)
        # Written before the send: if the answer is unclear, or the bot stops before booking it, this order is looked up
        # on Kalshi later by its client id (resolve_order) and whatever it bought is booked then.
        cid = body['client_order_id']
        self.broker.add_pending(cid, now, t, intent.side, intent.limit, count, **context)
        log('real-order-sent', **body)
        sent = time.time() * 1000
        timing = lambda: {'wanted': count, 'cid': cid, 'order_send_ts_ms': sent, 'order_ack_ts_ms': time.time() * 1000}
        try:
            reply = await kalshi.post(self.signer, live.ORDERS, body)
            acked = timing()
        except kalshi.Refused as e:
            attempt('refused', **timing(), note=str(e))
            self.broker.drop_pending(cid)
            log('real-order-refused', ticker=t, message=str(e))
            if e.status != 429:
                self.disarm(f'Kalshi refused an order on {t} ({e}). Nothing was bought.')
            return
        except Exception as e:
            # Sent, no clear answer: it may or may not have filled. Look this order up on Kalshi and book what it bought;
            # if Kalshi does not show it yet, housekeeping keeps looking every 10 s.
            attempt('unclear', **timing(), note=repr(e))
            log('real-order-unclear', ticker=t, message=repr(e))
            note = f'An order on {t} got no clear answer from Kalshi ({e!r}). '
            try:
                await asyncio.sleep(1.5)
                found = await self.resolve_order({'cid': cid, 'ts': now, 'ticker': t, 'side': intent.side, 'limit_price': intent.limit, 'wanted': count, **context})
                note += found if found is not None else 'Kalshi does not show it yet; the bot keeps checking and books anything it bought.'
            except Exception as e2:
                note += f'It could not be looked up ({e2!r}); the bot keeps trying and books anything it bought. Check Kalshi for a position in this round.'
            self.disarm(note)
            return
        log('real-order-result', ticker=t, round_trip_ms=round(acked['order_ack_ts_ms'] - sent, 1),
            **{k: reply.get(k) for k in ('order_id', 'fill_count', 'remaining_count', 'average_fill_price', 'average_fee_paid')})
        if marks is not None:
            marks.update(acked)  # an error from here on is written with this order's timing (execute)
        filled = float(reply.get('fill_count') or 0)
        attempt('filled' if filled > 0 else 'missed', filled=filled)
        if filled <= 0:
            self.broker.drop_pending(cid)
            self.broker.miss(t, intent.side, intent.limit, market.book.ask(intent.side), intent.edge, intent.secs_left, time.time())
            # Nothing bought (the price moved first): like the paper bot, the round may be tried again a second later, as
            # a new order at the new ask and only if the edge still holds there. An order itself is never resent.
            self.cooldown[t] = time.time() + 1.0
            return
        try:
            n, paid, fees = live.from_fills(await live.read_fills(self.signer, f"order_id={reply['order_id']}", want=filled), intent.side)
            if abs(n - filled) > 0.005:
                raise ValueError(f'fills show {n:g} contracts, the order reply {filled:g}')
        except Exception as e:
            log('real-fills-unread', ticker=t, message=repr(e))
            n, paid, fees = live.from_reply(reply, intent.side)
        fill = self.broker.record(t, intent.side, n, paid, fees, intent.limit, count, time.time(), latency_ms=acked['order_ack_ts_ms'] - decided * 1000, **context)
        self.broker.drop_pending(cid)
        self.balance -= paid + fees
        log('real-fill', ticker=t, side=fill.side, contracts=fill.contracts, price=round(fill.price, 4), fee=round(fill.fee, 4), cash=round(self.broker.cash, 4))
        if paid + fees > count * intent.limit * 1.08 + 0.02:
            self.disarm(f'The fill on {t} cost more than the order allowed (${paid + fees:.2f}). Check Kalshi before switching back on.')

    async def run(self) -> None:
        log('bot-start', mode=self.cfg.MODE, equity=round(self.broker.equity, 4), target=self.cfg.TARGET, latency_ms=self.cfg.LATENCY_MS,
            priority=lower_priority() if self.cfg.PRIORITY == 'low' else 'normal', db=self.cfg.DB_PATH)
        asyncio.get_running_loop().set_exception_handler(
            lambda loop, ctx: log_crash('event loop: ' + str(ctx.get('message')), ctx['exception']) if ctx.get('exception') else log('loop-error', message=str(ctx.get('message'))))
        try:
            self.write_status()  # at once: the Bot page arms real trading for the boot id in this file
        except Exception as e:
            log('status-error', message=repr(e))
        try:
            await self.refresh_markets()  # also the first reading of Kalshi's clock (kalshi.clock); every later REST call refreshes it
        except Exception as e:
            log('markets-error', message=repr(e))
        log('clock', synced=kalshi.clock.synced, offset_ms=round(kalshi.clock.offset_ms), boot_id=self.boot_id)
        if self.live:
            await self.reconcile_all(recent_s=86400)
            for name, job in (('balance', self.refresh_balance), ('pending', self.resolve_pending)):
                try:
                    await job()
                except Exception as e:
                    log(name + '-error', message=repr(e))
            # Beside the stream, not before it (it is paced: up to about a minute). Real trading cannot be switched on
            # until it has finished: audit_pending keeps switched_on() False and the Bot page refuses to arm (PR 16 review).
            spawn(self.audit(), 'audit')
        await asyncio.gather(self.stream(), self.housekeeping())
