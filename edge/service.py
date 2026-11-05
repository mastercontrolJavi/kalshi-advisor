"""The edge layer's per-second decision: spot -> vol -> fair value (p_base, p_engine) -> EV gate -> risk governor -> log.

Advisory only. The engine uses `gate` and `real_risk` from the response to veto real KXBTC15M orders; nothing here
places an order. In shadow mode a TRADE is paper-filled at the next observed ask (the next tick) with the exact fee."""
from __future__ import annotations

import math
import time as _time
from typing import Any, Dict, Optional

from .config import EdgeConfig
from .db import EdgeDB
from .ev_gate import Decision, evaluate, market_prob
from .fair_value import FinalWindowTracker, engine_drift, fair_value
from .risk import Book, RiskGovernor
from .spot import SpotSeries
from .vol import EwmaVol


def _num(x: Any) -> Optional[float]:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _prob(x: Any) -> Optional[float]:
    v = _num(x)
    return v if v is not None and 0 <= v <= 1 else None


def _ask(x: Any) -> Optional[float]:
    v = _num(x)
    return v if v is not None and 0 < v < 1 else None


class EdgeService:
    def __init__(self, cfg: EdgeConfig, db: Optional[EdgeDB] = None, governor: Optional[RiskGovernor] = None, log=print):
        self.cfg = cfg
        self.db = db or EdgeDB(cfg.DB_PATH)
        self.governor = governor or RiskGovernor(cfg)
        self.log = log
        self.spot = SpotSeries()
        self.vol = EwmaVol(cfg.VOL_HALFLIFE_S, cfg.VOL_FLOOR_ANN, cfg.TAIL_MULT, cfg.VOL_MIN_SAMPLES)
        self.ticker: Optional[str] = None
        self.tracker: Optional[FinalWindowTracker] = None
        self.target: Optional[float] = None
        self.logged_minutes: set = set()
        self.disagree_minutes: set = set()
        # Slow-changing reads, refreshed at most every 30 s (or when a trade/settlement changes them): per-tick cost stays ~1 ms.
        self._slow_at = -1e18
        self._slow: Dict[str, Any] = {}
        self._book_cache: Optional[tuple] = None
        self.last_tick_ts: Optional[float] = None
        self.last_received: Optional[float] = None
        self.last_response: Optional[dict] = None
        self.ticks = 0
        self._tick_ms: list = []  # last 600 handling times, for /health
        self.errors = 0
        self.aborted = 0  # replies the engine stopped waiting for (300 ms timeout)
        self.recent_errors: list = []

    # window bookkeeping
    def _roll(self, ticker: str, close_ts: int) -> None:
        if self.ticker == ticker:
            return
        if self.ticker is not None:
            self._save_window()
            self.db.expire_unfilled(self.ticker)
        self.ticker, self.tracker, self.target = ticker, FinalWindowTracker(close_ts), None
        self.logged_minutes = set()
        self.disagree_minutes = set()

    def _save_window(self) -> None:
        if self.ticker is None or self.tracker is None:
            return
        src = self.spot.last.source if self.spot.last else 'none'
        self.db.upsert_window(self.ticker, self.tracker.close_ts, self.target, self.tracker.average(), self.tracker.n, self.tracker.carried, src)

    def _real_book(self, real: Dict[str, Any]) -> Optional[Book]:
        if not isinstance(real, dict):
            return None
        vals = {k: _num(real.get(k)) for k in ('day_pnl', 'week_pnl', 'start_day', 'start_week', 'windows_today')}
        if any(v is None for v in vals.values()):
            return None
        return Book(vals['day_pnl'], vals['week_pnl'], vals['start_day'], vals['start_week'], int(vals['windows_today']), bool(real.get('in_window')))

    def tick(self, t: Dict[str, Any], received: Optional[float] = None) -> Dict[str, Any]:
        received = _time.time() if received is None else received
        ts_ms, close_ms, secs_left = _num(t.get('ts_ms')), _num(t.get('close_ms')), _num(t.get('secs_left'))
        ticker = t.get('ticker')
        if ts_ms is None or close_ms is None or secs_left is None or not isinstance(ticker, str) or not ticker:
            raise ValueError('tick needs ts_ms, close_ms, secs_left and ticker')
        ts, close_ts = int(ts_ms // 1000), int(close_ms // 1000)
        self.ticks += 1
        self.last_tick_ts, self.last_received = ts_ms / 1000, received
        self._roll(ticker, close_ts)

        spot, source, degraded = _num(t.get('spot')), str(t.get('source') or 'proxy'), bool(t.get('degraded', True))
        carried_in = bool(t.get('carried'))
        for p in self.spot.add(ts, spot, source, degraded or carried_in):
            self.vol.update(p.ts, p.price, p.source, p.carried or carried_in and p.ts == ts)
            self.tracker.add(p.ts, p.price, p.carried)
        # Official prints from the engine (Kalshi's BRTI feed) replace this layer's own for the same seconds.
        for item in t.get('final_prints') or []:
            try:
                pts, price = int(float(item[0]) // 1000), float(item[1])
            except (TypeError, ValueError, IndexError):
                continue
            self.tracker.put(pts, price)
        last = self.spot.last
        spot_now = last.price if last and last.ts == ts else None
        carried = bool(last and last.ts == ts and last.carried)
        degraded = degraded or carried

        target = _num(t.get('target'))
        if target is not None and target > 0:
            self.target = target
        yes_ask, no_ask, mid = _ask(t.get('yes_ask')), _ask(t.get('no_ask')), _prob(t.get('mid'))
        q, q_raw, p_math = _prob(t.get('q')), _prob(t.get('q_raw')), _prob(t.get('p_math'))
        engine_call = t.get('engine_call') if t.get('engine_call') in ('UP', 'DOWN') else None
        engine_conf = str(t.get('engine_confidence'))[:20] if t.get('engine_confidence') else None
        balance = _num(t.get('balance'))
        bankroll = self.cfg.BANKROLL if self.cfg.BANKROLL is not None else (balance or 0.0)

        # Paper fill of the previous TRADE at the ask observed now (the next tick after the signal).
        filled = None
        pending = self.db.pending_fill(ticker)
        if pending is not None and secs_left > 0:
            ask_now = yes_ask if pending['side'] == 'yes' else no_ask
            if ask_now is not None:
                fee = self.db.fill(pending['id'], ask_now, ts_ms / 1000, pending['contracts'])
                filled = {'id': pending['id'], 'side': pending['side'], 'price': ask_now, 'contracts': pending['contracts'], 'fee': fee}
                self.log({'event': 'shadow-fill', **filled, 'ticker': ticker})

        fv = fv_engine = None
        sigma = self.vol.sigma_usd(spot_now) if spot_now else None
        status, reason = 'OK', None
        if spot_now is None:
            status, reason = 'NO_DATA', 'no spot price this second'
        elif self.target is None:
            status, reason = 'NO_DATA', 'Target not published yet'
        elif not self.vol.ready:
            status, reason = 'WARMING', f'volatility warming ({self.vol.count}/{self.vol.min_samples} s)'
        else:
            fixed = self.tracker.fixed_before(ts) if secs_left <= 60 else []
            fv = fair_value(spot_now, self.target, secs_left, sigma, fixed, 0.0)
            if q_raw is not None:
                drift = engine_drift(q_raw, spot_now, self.target, secs_left, sigma, fixed)
                fv_engine = fair_value(spot_now, self.target, secs_left, sigma, fixed, drift)

        p_base = fv.p_yes if fv else None
        p_engine = fv_engine.p_yes if fv_engine else None
        use_engine = self.cfg.ENGINE_VALIDATED and p_engine is not None
        p_use = p_engine if use_engine else p_base

        market = market_prob(mid, yes_ask, no_ask)

        def gate_for(capital: float) -> Decision:
            if p_use is None:
                return Decision('NO_EDGE', None, None, None, None, 0, reason or 'no fair value')
            if t.get('book_stale'):
                return Decision('BLOCKED', None, None, p_use, None, 0, f"stale book: {t.get('stale_reason') or 'Kalshi book or BRTI behind'}")
            if secs_left < 1:
                return Decision('NO_EDGE', None, None, p_use, None, 0, 'market closing')
            return evaluate(p_use, yes_ask, no_ask, capital, self.cfg, market)

        gate = gate_for(bankroll)
        # The real-order veto reads `gate` in the reply: it is always sized on the live Kalshi account value, so a
        # notional EDGE_BANKROLL (shadow sizing) can never turn a real order's NO_EDGE into a TRADE.
        real_gate = gate if self.cfg.BANKROLL is None else gate_for(balance or 0.0)

        # Governor on the book this mode trades: the paper book (shadow) or your real fills (live).
        now_s = ts_ms / 1000
        key = (int(now_s // 60), ticker, self.db.version)
        if self._book_cache is None or self._book_cache[0] != key:
            self._book_cache = (key, self.db.shadow_book(now_s, ticker))
        sd, sw, before_day, before_week, s_windows, s_in = self._book_cache[1]
        base = bankroll
        shadow_book = Book(sd, sw, base + before_day, base + before_week, s_windows, s_in)
        real_book = self._real_book(t.get('real') or {})
        book = shadow_book if self.cfg.MODE == 'shadow' else (real_book or shadow_book)
        allowed, risk_reason = self.governor.check(now_s, book)
        if real_book is not None:
            real_allowed, real_reason = self.governor.check(now_s, real_book)
            real_stop = self.governor.stops(real_book)
        else:
            real_allowed, real_reason, real_stop = False, 'real P&L not sent by the engine', None

        decision = gate
        if gate.action == 'TRADE' and not allowed:
            decision = Decision('BLOCKED', gate.side, gate.ask, gate.q, gate.edge, 0, f'risk: {risk_reason}')

        # Logging: one snapshot per window per minute-left bucket, plus every TRADE.
        minute = int(max(0.0, secs_left) // 60)
        z = (fv.mean_final - self.target) / fv.sd_final if fv and fv.sd_final > 1e-9 else None
        row = {'ts': now_s, 'sd_final': fv.sd_final if fv else None, 'z': z, 'sigma_ann': self.vol.sigma_ann, 'tail_mult': self.cfg.TAIL_MULT, 'ticker': ticker, 'secs_left': secs_left, 'spot': spot_now, 'target': self.target, 'sigma': sigma,
               'regime': fv.regime if fv else None, 'p_base': p_base, 'p_engine': p_engine, 'p_math': p_math, 'q': q, 'q_raw': q_raw,
               'engine_call': engine_call, 'engine_confidence': engine_conf, 'market_mid': mid, 'yes_ask': yes_ask, 'no_ask': no_ask,
               'action': decision.action, 'side': decision.side, 'ask': decision.ask, 'edge': decision.edge, 'contracts': decision.contracts,
               'reason': decision.reason, 'mode': self.cfg.MODE, 'degraded': int(degraded), 'source': last.source if last else None, 'carried': int(carried)}
        logged = None
        if decision.action == 'TRADE':
            logged = self.db.insert_signal({**row, 'kind': 'trade'})
            self.log({'event': 'edge-trade', 'id': logged, 'ticker': ticker, 'side': decision.side, 'ask': decision.ask, 'edge': decision.edge, 'contracts': decision.contracts, 'mode': self.cfg.MODE})
        elif decision.action == 'MODEL_DISAGREE' and minute not in self.disagree_minutes:
            logged = self.db.insert_signal({**row, 'kind': 'disagree'})  # one per window per minute, for diagnosis
            self.disagree_minutes.add(minute)
            self.logged_minutes.add(minute)
        elif minute not in self.logged_minutes and status != 'NO_DATA':
            logged = self.db.insert_signal({**row, 'kind': 'snapshot'})
        if logged is not None:
            self.logged_minutes.add(minute)
        if secs_left <= 61:
            self._save_window()

        if received - self._slow_at >= 30 or self._slow.get('version') != self.db.version:
            self._slow = {'version': self.db.version, 'proxy': self.db.proxy_check(), 'unsettled': self.db.unsettled(now_s - 120)}
            self._slow_at = received
        n_proxy, agree, mean_abs = self._slow['proxy']
        response = {
            **decision.as_dict(), 'p_base': p_base, 'p_engine': p_engine, 'p_math': p_math, 'q_raw': q_raw, 'q_blend': q,
            'p_used': 'engine' if use_engine else 'base', 'regime': fv.regime if fv else None, 'sigma': sigma,
            'sigma_ann': self.vol.sigma_ann, 'status': status, 'ticker': ticker, 'ts': now_s, 'secs_left': secs_left,
            'spot': spot_now, 'target': self.target, 'mean_final': fv.mean_final if fv else None, 'sd_final': fv.sd_final if fv else None,
            'final_avg': self.tracker.average(), 'final_n': self.tracker.n, 'degraded': degraded, 'carried': carried,
            'source': last.source if last else None, 'market_mid': mid, 'yes_ask': yes_ask, 'no_ask': no_ask,
            'engine': {'call': engine_call, 'confidence': engine_conf},
            'gate': real_gate.as_dict(), 'shadow_gate': gate.as_dict(),
            'risk': {'allowed': allowed, 'reason': risk_reason, 'book': self.cfg.MODE if self.cfg.MODE == 'shadow' or real_book is None else 'real',
                     'day_pnl': book.day_pnl, 'daily_stop_usd': self.cfg.DAILY_STOP * book.start_day_bankroll, 'week_pnl': book.week_pnl,
                     'weekly_stop_usd': self.cfg.WEEKLY_STOP * book.start_week_bankroll, 'windows_used': book.windows_today,
                     'max_windows': self.cfg.MAX_WINDOWS, 'in_window': book.in_window},
            'real_risk': {'allowed': real_allowed, 'reason': real_reason, 'stop_hit': real_stop is not None, 'stop_reason': real_stop},
            'proxy_check': {'windows': n_proxy, 'agree': agree, 'mean_abs_usd': mean_abs,
                            'failing': n_proxy >= self.cfg.PROXY_MIN_WINDOWS and agree is not None and agree < self.cfg.PROXY_MIN_AGREE},
            'unsettled': self._slow['unsettled'], 'z': z,
            'filled': filled, 'logged': logged,
            'config': {'mode': self.cfg.MODE, 'engine_validated': self.cfg.ENGINE_VALIDATED, 'min_edge': self.cfg.MIN_EDGE,
                       'block_mid_band': self.cfg.BLOCK_MID_BAND, 'bankroll': bankroll},
        }
        self.last_response = response
        return response

    def note_error(self, path: str, code: int, message: str) -> None:
        """Counted and kept (last 10) so GET /health shows what went wrong without the sidecar's console."""
        self.errors += 1
        self.recent_errors = (self.recent_errors + [{'time': _time.strftime('%Y-%m-%dT%H:%M:%S'), 'path': path, 'code': code, 'message': message[:300]}])[-10:]
        self.log({'event': 'edge-request-error', 'path': path, 'code': code, 'message': message[:300]})

    def record_ms(self, ms: float) -> None:
        self._tick_ms.append(ms)
        if len(self._tick_ms) > 600:
            del self._tick_ms[:100]

    def settle(self, s: Dict[str, Any], now: Optional[float] = None) -> Dict[str, Any]:
        ticker, result = s.get('ticker'), s.get('result')
        if not isinstance(ticker, str) or result not in ('yes', 'no'):
            raise ValueError('settle needs ticker and result yes|no')
        if ticker == self.ticker:
            self._save_window()
        out = self.db.settle(ticker, result, _num(s.get('expiration_value')), _num(s.get('proxy_avg')), _time.time() if now is None else now)
        self.log({'event': 'edge-settle', **out})
        return out

    def health(self, now: Optional[float] = None) -> Dict[str, Any]:
        now = _time.time() if now is None else now
        age = None if self.last_received is None else now - self.last_received
        return {'status': 'OK' if age is not None and age <= 2 else 'IDLE', 'last_tick_ts': self.last_tick_ts, 'last_tick_age_s': age,
                'ticks': self.ticks, 'errors': self.errors, 'ticker': self.ticker, 'vol_samples': self.vol.count, 'mode': self.cfg.MODE,
                'engine_validated': self.cfg.ENGINE_VALIDATED, 'tick_ms': self._timing(),
                'aborted': self.aborted, 'recent_errors': self.recent_errors}

    def _timing(self) -> Optional[Dict[str, float]]:
        xs = sorted(self._tick_ms)
        if not xs:
            return None
        return {'n': len(xs), 'p50': round(xs[len(xs) // 2], 2), 'p95': round(xs[int(len(xs) * 0.95)], 2), 'max': round(xs[-1], 2)}
