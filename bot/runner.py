"""The live loop: one signed Kalshi websocket carrying the order book of the current round and the BRTI index (1 Hz
settlement prints and the 5 Hz value). Every BRTI value and every book change re-prices the round; a decision becomes a
paper fill LATENCY_MS later, against the book as it stands at that moment."""
from __future__ import annotations

import asyncio
import json
import sys
import time
from datetime import datetime, timezone
from typing import Dict, Optional

import websockets

from . import kalshi
from .book import Book, FeedDelay
from .config import BotConfig, credentials
from .paper import PaperBroker
from .strategy import Intent, Pricer, decide


def log(event: str, **data) -> None:
    print(json.dumps({'time': datetime.now(timezone.utc).isoformat(timespec='milliseconds'), 'event': event, **data}, default=str), flush=True)


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


class Market:
    def __init__(self, m: dict):
        self.ticker: str = m['ticker']
        self.open = parse_ts(m['open_time'])
        self.close = parse_ts(m['close_time'])
        self.strike: Optional[float] = None
        self.update(m)
        self.book = Book()

    def update(self, m: dict) -> None:
        k = m.get('floor_strike')
        if k is not None and float(k) > 0:
            self.strike = float(k)


class Bot:
    def __init__(self, cfg: BotConfig):
        self.cfg = cfg
        self.signer = kalshi.Signer(*credentials())
        self.broker = PaperBroker(cfg.DB_PATH, cfg.START_BANKROLL)
        self.pricer = Pricer(cfg)
        self.markets: Dict[str, Market] = {}
        self.subscribed: set = set()
        self.ws = None
        self.next_id = 10
        self.book_sid: Optional[int] = None
        self.book_seq: Optional[int] = None
        self.delay = FeedDelay()
        self.last_value_ms = 0.0      # local receive time of the newest BRTI value
        self.pending: Optional[str] = None  # ticker with an order in flight
        self.cooldown: Dict[str, float] = {}
        self.stats = {'messages': 0, 'evals': 0, 'reasons': {}}
        self.hit_target = self.broker.equity >= cfg.TARGET

    # ---------- market list ----------
    async def refresh_markets(self) -> None:
        now = time.time()
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
        await self.subscribe([m.ticker for m in soon])

    def current(self, now: float) -> Optional[Market]:
        for m in self.markets.values():
            if m.open <= now < m.close:
                return m
        return None

    async def settle(self) -> None:
        for ticker in self.broker.open_tickers():
            m = self.markets.get(ticker)
            if m is not None and time.time() < m.close + 5:
                continue
            market = (await kalshi.get('/markets/' + ticker)).get('market', {})
            if market.get('result') in ('yes', 'no'):
                pnl = self.broker.settle(ticker, market['result'], time.time())
                eq = self.broker.equity
                log('settled', ticker=ticker, result=market['result'], pnl=round(pnl, 4), equity=round(eq, 4))
                if not self.hit_target and eq >= self.cfg.TARGET:
                    self.hit_target = True
                    log('target-reached', equity=round(eq, 2), target=self.cfg.TARGET)

    async def housekeeping(self) -> None:
        tick = 0
        while True:
            for name, job in (('markets', self.refresh_markets), ('settle', self.settle)):
                try:
                    await job()
                except Exception as e:
                    log(name + '-error', message=repr(e))
            tick += 1
            if tick % 6 == 0:
                s = self.broker.summary()
                log('status', equity=round(s['equity'], 4), rounds=s['rounds'], wins=s['wins'], open=s['open'], misses=s['misses'],
                    book_delay_ms=round(self.delay.ms), vol_ready=self.pricer.ready, messages=self.stats['messages'], evals=self.stats['evals'],
                    reasons=self.stats['reasons'])
                self.stats = {'messages': 0, 'evals': 0, 'reasons': {}}
            await asyncio.sleep(10)

    # ---------- websocket ----------
    async def subscribe(self, tickers: list) -> None:
        new = [t for t in tickers if t not in self.subscribed]
        if not new or self.ws is None:
            return
        self.next_id += 1
        # use_yes_price: NO levels arrive quoted as YES prices (what the engine uses); they are converted back on receipt.
        await self.ws.send(json.dumps({'id': self.next_id, 'cmd': 'subscribe', 'params': {'channels': ['orderbook_delta'], 'market_tickers': new, 'use_yes_price': True}}))
        self.subscribed.update(new)
        log('subscribed', tickers=new)

    async def stream(self) -> None:
        backoff = 0.5
        while True:
            try:
                async with websockets.connect(kalshi.WS, additional_headers=self.signer.headers(kalshi.WS_PATH), ping_interval=5, ping_timeout=10,
                                              max_size=2 ** 22, max_queue=4096, open_timeout=10) as ws:
                    self.ws, self.subscribed, self.book_sid, self.book_seq = ws, set(), None, None
                    for m in self.markets.values():
                        m.book.valid = False
                    await ws.send(json.dumps({'id': 1, 'cmd': 'subscribe', 'params': {'channels': ['cfbenchmarks_value'], 'index_ids': ['BRTI']}}))
                    await ws.send(json.dumps({'id': 2, 'cmd': 'subscribe', 'params': {'channels': ['cfbenchmarks_value_5hz'], 'index_ids': ['BRTI']}}))
                    now = time.time()
                    await self.subscribe([m.ticker for m in sorted(self.markets.values(), key=lambda m: m.open) if m.close > now][:2])
                    log('connected')
                    backoff = 0.5
                    async for raw in ws:
                        self.on_message(json.loads(raw))
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log('stream-error', message=repr(e))
            self.ws = None
            for m in self.markets.values():
                m.book.valid = False
            await asyncio.sleep(backoff)
            backoff = min(30.0, backoff * 2)

    def on_message(self, m: dict) -> None:
        self.stats['messages'] += 1
        kind, d = m.get('type'), m.get('msg') or {}
        now_ms = time.time() * 1000
        # Kalshi numbers every message on a subscription (acks included); a skipped number is a lost book update.
        sid, seq = m.get('sid'), m.get('seq')
        if self.book_sid is not None and sid == self.book_sid and isinstance(seq, int):
            if self.book_seq is not None and seq != self.book_seq + 1:
                log('book-gap', seq=seq, expected=self.book_seq + 1)
                self.book_seq = None
                asyncio.get_running_loop().create_task(self.resync())
                return
            self.book_seq = seq
        if kind in ('orderbook_delta', 'orderbook_snapshot'):
            market = self.markets.get(d.get('market_ticker'))
            if isinstance(m.get('sending_ts_ms'), (int, float)):
                self.delay.observe(m['sending_ts_ms'], now_ms)
            if market is None:
                return
            if kind == 'orderbook_snapshot':
                market.book.snapshot(d.get('yes_dollars_fp') or [], [(1 - float(p), q) for p, q in (d.get('no_dollars_fp') or [])])
            else:
                price = float(d['price_dollars'])
                if not market.book.delta(d['side'], 1 - price if d['side'] == 'no' else price, float(d['delta_fp'])):
                    log('book-invalid', ticker=market.ticker)
                    asyncio.get_running_loop().create_task(self.resync())
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
                    self.last_value_ms = now_ms
            else:
                self.pricer.on_fast(ts_ms / 1000, price)
                self.last_value_ms = now_ms
            market = self.current(ts_ms / 1000)
            if market is not None:
                self.evaluate(market)
        elif kind == 'subscribed':
            if d.get('channel') == 'orderbook_delta' and self.book_sid is None:
                self.book_sid, self.book_seq = d.get('sid'), None
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
        now = time.time()
        if self.pending is not None or market.ticker in self.broker.positions or self.cooldown.get(market.ticker, 0) > now:
            return
        if not (market.open <= now < market.close):
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
        fv, left = priced
        intent, why = decide(self.cfg, fv, left, market.book.ask('yes'), market.book.ask('no'), self.broker.equity)
        if intent is None:
            return self.skip(why)
        if self.broker.traded(market.ticker):
            return
        self.pending = market.ticker
        asyncio.get_running_loop().create_task(self.execute(market, intent, now))

    async def execute(self, market: Market, intent: Intent, decided: float) -> None:
        """The paper order: immediate-or-cancel at the decided ask, against the book LATENCY_MS after the decision."""
        try:
            await asyncio.sleep(self.cfg.LATENCY_MS / 1000)
            now = time.time()
            usable = market.book.valid and not market.book.crossed and self.delay.ms <= self.cfg.MAX_BOOK_DELAY_MS and now < market.close
            asks = market.book.asks(intent.side) if usable else []
            fill = self.broker.buy(market.ticker, intent.side, intent.limit, intent.contracts, asks, now, q=intent.q, edge=intent.edge, p_yes=intent.p_yes,
                                   secs_left=intent.secs_left, latency_ms=(now - decided) * 1000)
            if fill is None:
                self.broker.miss(market.ticker, intent.side, intent.limit, asks[0][0] if asks else None, intent.edge, intent.secs_left, now)
                self.cooldown[market.ticker] = now + 1.0
                log('missed', ticker=market.ticker, side=intent.side, decided_ask=intent.limit, ask_then=asks[0][0] if asks else None)
            else:
                log('paper-fill', ticker=market.ticker, side=fill.side, contracts=fill.contracts, price=round(fill.price, 4), fee=round(fill.fee, 4),
                    q=round(intent.q, 4), edge=round(intent.edge, 4), secs_left=round(intent.secs_left, 1), cash=round(self.broker.cash, 4))
        finally:
            self.pending = None

    async def run(self) -> None:
        log('bot-start', mode='paper', equity=round(self.broker.equity, 4), target=self.cfg.TARGET, latency_ms=self.cfg.LATENCY_MS,
            priority=lower_priority() if self.cfg.PRIORITY == 'low' else 'normal', db=self.cfg.DB_PATH)
        try:
            await self.refresh_markets()
        except Exception as e:
            log('markets-error', message=repr(e))
        await asyncio.gather(self.stream(), self.housekeeping())
