"""python -m unittest discover -s edge/tests -t .   (stdlib only)"""
import math
import sqlite3
import unittest
from dataclasses import replace
from datetime import datetime, timezone

from edge.config import EdgeConfig, load_config
from edge.db import EdgeDB
from edge.ev_gate import evaluate, order_fee, taker_fee
from edge.fair_value import FinalWindowTracker, engine_drift, fair_value
from edge.risk import Blackout, Book, RiskGovernor
from edge.score import engine_verdict, fills_report, score, verdict
from edge.service import EdgeService
from edge.spot import SpotSeries
from edge.timeutil import et_to_ts, to_et
from edge.vol import EwmaVol

CFG = EdgeConfig(DB_PATH=':memory:', BLACKOUTS_PATH='')


class FairValueTests(unittest.TestCase):
    def test_symmetry_at_target(self):
        for secs in (900, 300, 61):
            self.assertAlmostEqual(fair_value(100000, 100000, secs, 5.0).p_yes, 0.5, places=9)

    def test_monotonic_in_spot(self):
        ps = [fair_value(s, 100000, 400, 5.0).p_yes for s in range(99800, 100201, 50)]
        self.assertEqual(ps, sorted(ps))
        self.assertLess(ps[0], ps[-1])

    def test_final_second_locked_above(self):
        fv = fair_value(100010, 100000, 1, 5.0, [100050.0] * 59)
        self.assertEqual(fv.regime, 'final_minute')
        self.assertGreater(fv.p_yes, 0.998)

    def test_sd_shrinks_to_zero(self):
        sds = [fair_value(100000, 100000, r, 5.0, [100000.0] * (60 - r)).sd_final for r in (60, 45, 30, 15, 5, 1)]
        self.assertEqual(sds, sorted(sds, reverse=True))
        self.assertLess(sds[-1], sds[0] / 100)

    def test_pre_window_formula(self):
        fv = fair_value(100100, 100000, 360, 2.0)
        self.assertAlmostEqual(fv.sd_final, 2.0 * math.sqrt(320))
        self.assertEqual(fv.regime, 'pre_window')

    def test_zero_sd_and_clamp(self):
        self.assertEqual(fair_value(100000, 100000, 0, 5.0, [100000.0] * 60).p_yes, 0.999)  # tie resolves YES
        self.assertEqual(fair_value(99999, 100000, 0, 5.0, [99999.0] * 60).p_yes, 0.001)

    def test_engine_adapter_reproduces_q(self):
        for secs, fixed in ((600, []), (30, [100020.0] * 30)):
            for q in (0.2, 0.5, 0.83):
                d = engine_drift(q, 100000, 100010, secs, 4.0, fixed)
                self.assertAlmostEqual(fair_value(100000, 100010, secs, 4.0, fixed, d).p_yes, q, places=9)

    def test_tracker_window(self):
        t = FinalWindowTracker(1000)
        self.assertFalse(t.add(939, 1.0))
        self.assertTrue(t.add(940, 2.0))
        self.assertFalse(t.add(1000, 3.0))
        t.add(941, 4.0)
        self.assertEqual(t.fixed_before(941), [2.0])
        self.assertEqual(t.average(), 3.0)


class SpotVolTests(unittest.TestCase):
    def test_carry_forward_flags(self):
        s = SpotSeries()
        s.add(10, 100.0, 'brti', False)
        out = s.add(13, 101.0, 'brti', False)
        self.assertEqual([(p.ts, p.price, p.carried) for p in out], [(11, 100.0, True), (12, 100.0, True), (13, 101.0, False)])
        self.assertTrue(all(p.degraded for p in out[:2]))
        self.assertEqual(s.add(13, 102.0, 'brti', False), [])

    def test_vol_floor_and_skips(self):
        v = EwmaVol(min_samples=2)
        for t in range(5):
            v.update(t, 100.0)
        self.assertAlmostEqual(v.sigma_ann, 0.10)  # flat prices hit the floor
        v2 = EwmaVol(min_samples=1)
        v2.update(0, 100.0)
        v2.update(1, 101.0, carried=True)
        v2.update(2, 105.0)
        self.assertEqual(v2.count, 0)  # carried second and the gap after it are not returns
        v2.update(3, 106.0, source='proxy')
        self.assertEqual(v2.count, 0)  # source switch

    def test_sigma_usd(self):
        v = EwmaVol(tail_mult=1.15)
        v.update(0, 100.0)
        v.update(1, 101.0)
        self.assertAlmostEqual(v.sigma_usd(100000), 100000 * abs(math.log(1.01)) * 1.15, places=6)


class GateTests(unittest.TestCase):
    def test_fee_at_half(self):
        self.assertAlmostEqual(taker_fee(0.5), 0.0175)
        self.assertEqual(order_fee(0.5, 10), 0.175)

    def test_mid_band_block(self):
        d = evaluate(0.80, 0.55, 0.47, 1000, CFG)
        self.assertEqual(d.action, 'BLOCKED')
        self.assertIn('mid band', d.reason)
        self.assertEqual(evaluate(0.80, 0.55, 0.47, 1000, replace(CFG, BLOCK_MID_BAND=False)).action, 'TRADE')

    def test_no_trade_below_min_edge(self):
        # q 0.90 vs ask 0.88 + fee 0.0074 -> edge 0.0126; q 0.895 -> 0.0076 < 0.01
        self.assertEqual(evaluate(0.90, 0.88, 0.13, 1000, CFG).action, 'TRADE')
        d = evaluate(0.895, 0.88, 0.13, 1000, CFG)
        self.assertEqual(d.action, 'NO_EDGE')

    def test_size_capped_at_one_percent(self):
        d = evaluate(0.99, 0.80, 0.21, 10000, CFG)
        cost = 0.80 + taker_fee(0.80)
        self.assertEqual(d.action, 'TRADE')
        self.assertEqual(d.contracts, math.floor(0.01 * 10000 / cost))
        self.assertLessEqual(d.contracts * cost, 0.01 * 10000)

    def test_too_small_bankroll(self):
        self.assertEqual(evaluate(0.99, 0.80, 0.21, 50, CFG).action, 'NO_EDGE')

    def test_no_side(self):
        d = evaluate(0.05, 0.08, 0.90, 10000, CFG)
        self.assertEqual((d.action, d.side), ('TRADE', 'no'))


class RiskTests(unittest.TestCase):
    gov = RiskGovernor(CFG, blackouts=[])
    quiet = et_to_ts(datetime(2026, 11, 4, 13, 0))  # Wednesday 1 PM ET
    ok = Book(0, 0, 1000, 1000, 0, False)

    def test_allowed(self):
        self.assertEqual(self.gov.check(self.quiet, self.ok), (True, 'ok'))

    def test_daily_and_weekly_stop(self):
        self.assertIn('daily stop', self.gov.check(self.quiet, replace(self.ok, day_pnl=-30))[1])
        self.assertTrue(self.gov.check(self.quiet, replace(self.ok, day_pnl=-29.99))[0])
        self.assertIn('weekly stop', self.gov.check(self.quiet, replace(self.ok, week_pnl=-60))[1])

    def test_window_cap_and_no_reentry(self):
        self.assertIn('window cap', self.gov.check(self.quiet, replace(self.ok, windows_today=10))[1])
        self.assertIn('no re-entry', self.gov.check(self.quiet, replace(self.ok, in_window=True))[1])

    def test_blackouts(self):
        open_ = et_to_ts(datetime(2026, 11, 4, 9, 45))
        self.assertIn('equity open', self.gov.check(open_, self.ok)[1])
        saturday = et_to_ts(datetime(2026, 11, 7, 9, 45))
        self.assertTrue(self.gov.check(saturday, self.ok)[0])
        fomc = RiskGovernor(CFG, [Blackout('FOMC', et_to_ts(datetime(2026, 12, 9, 14)), et_to_ts(datetime(2026, 12, 9, 15)))])
        self.assertIn('FOMC', fomc.check(et_to_ts(datetime(2026, 12, 9, 14, 30)), self.ok)[1])
        self.assertTrue(fomc.check(et_to_ts(datetime(2026, 12, 9, 15, 0)), self.ok)[0])

    def test_eastern_time_fallback_rule(self):
        # 2026-11-04 17:00 UTC is 12:00 EST (DST ended Nov 1); 2026-07-01 16:00 UTC is 12:00 EDT.
        utc = lambda *a: datetime(*a, tzinfo=timezone.utc).timestamp()
        self.assertEqual(to_et(utc(2026, 11, 4, 17), use_zoneinfo=False).hour, 12)
        self.assertEqual(to_et(utc(2026, 7, 1, 16), use_zoneinfo=False).hour, 12)
        self.assertEqual(to_et(utc(2026, 3, 8, 6, 59), use_zoneinfo=False).hour, 1)  # 01:59 EST, just before spring forward
        self.assertEqual(to_et(utc(2026, 3, 8, 7, 0), use_zoneinfo=False).hour, 3)


def synthetic_db(n_fills: int, win_rate: float, price: float = 0.80, windows: int = 0, raw_better: bool = False) -> sqlite3.Connection:
    db = EdgeDB(':memory:')
    for i in range(n_fills):
        outcome = 1 if (i * win_rate) % 1 + win_rate >= 1 else 0
        db.insert_signal({'ts': i, 'ticker': f'T{i}', 'kind': 'trade', 'action': 'TRADE', 'side': 'yes', 'fill_price': price, 'fill_ts': i,
                          'contracts': 1, 'contracts_filled': 1, 'fee': order_fee(price, 1), 'mode': 'shadow', 'outcome': outcome})
    for i in range(windows):
        y = i % 2
        db.insert_signal({'ts': 10000 + i, 'ticker': f'W{i}', 'kind': 'snapshot', 'action': 'NO_EDGE', 'mode': 'shadow', 'secs_left': 300,
                          'p_base': 0.5, 'q_raw': (0.7 if y else 0.3) if raw_better else (0.3 if y else 0.7), 'outcome': y})
    return db.db


class ScoreTests(unittest.TestCase):
    def test_pass_on_known_edge(self):
        s = score(synthetic_db(400, 0.90))  # 90% wins at 80c: +~9c/contract
        self.assertEqual(s['verdict'], 'PASS', s['fills'])

    def test_fail_too_few_fills(self):
        self.assertEqual(score(synthetic_db(200, 0.90))['verdict'], 'FAIL')

    def test_fail_no_edge(self):
        self.assertEqual(score(synthetic_db(400, 0.80))['verdict'], 'FAIL')  # fair price minus the fee

    def test_fill_math(self):
        f = fills_report([{'fill_price': 0.8, 'fee': 0.0112, 'contracts_filled': 1, 'side': 'yes', 'outcome': 1},
                          {'fill_price': 0.8, 'fee': 0.0112, 'contracts_filled': 1, 'side': 'yes', 'outcome': 0}])
        self.assertAlmostEqual(f['mean'], ((0.2 - 0.0112) + (-0.8 - 0.0112)) / 2)
        self.assertAlmostEqual(f['max_drawdown'], 0.8112)
        self.assertEqual(verdict(f), 'FAIL')

    def test_engine_verdict(self):
        self.assertEqual(score(synthetic_db(0, 0, windows=600, raw_better=True))['engine'][0], 'ENGINE: ADDS SIGNAL')
        self.assertEqual(score(synthetic_db(0, 0, windows=600, raw_better=False))['engine'][0], 'ENGINE: NOT PROVEN')
        self.assertEqual(score(synthetic_db(0, 0, windows=400, raw_better=True))['engine'][0], 'ENGINE: NOT PROVEN')


def tick(ts, **kw):
    base = {'ts_ms': ts * 1000, 'ticker': 'KXBTC15M-TEST', 'close_ms': 1000 * 1000, 'secs_left': 1000 - ts, 'spot': 100000 + (ts % 7),
            'source': 'brti', 'degraded': False, 'target': 100000, 'yes_ask': 0.52, 'no_ask': 0.49, 'mid': 0.515, 'q': 0.51, 'q_raw': 0.53,
            'p_math': 0.52, 'engine_call': 'UP', 'engine_confidence': 'Toss-up', 'balance': 1000,
            'real': {'day_pnl': 0, 'week_pnl': 0, 'start_day': 1000, 'start_week': 1000, 'windows_today': 0, 'in_window': False}}
    base.update(kw)
    return base


class ServiceTests(unittest.TestCase):
    def make(self, **cfg):
        return EdgeService(replace(CFG, VOL_MIN_SAMPLES=5, **cfg), EdgeDB(':memory:'), RiskGovernor(CFG, []), log=lambda *_: None)

    def test_window_logging_and_settle(self):
        svc = self.make()
        for ts in range(100, 1000):
            r = svc.tick(tick(ts), received=et_to_ts(datetime(2026, 11, 4, 13)))
        snaps = svc.db.rows("SELECT * FROM signals WHERE kind='snapshot'")
        self.assertGreaterEqual(len(snaps), 14)
        self.assertTrue(all(row['engine_call'] == 'UP' and row['q_raw'] == 0.53 for row in snaps))
        self.assertEqual(r['final_n'], 60)
        svc.settle({'ticker': 'KXBTC15M-TEST', 'result': 'yes', 'expiration_value': 100003.0, 'proxy_avg': 100002.0})
        w = svc.db.rows('SELECT * FROM windows')[0]
        self.assertEqual(w['sign_agree'], 1)
        self.assertIsNotNone(w['discrepancy'])
        self.assertTrue(all(row['outcome'] == 1 for row in svc.db.rows('SELECT outcome FROM signals')))

    def test_shadow_trade_fills_at_next_ask_once(self):
        svc = self.make()
        noon = et_to_ts(datetime(2026, 11, 4, 13))
        for ts in range(100, 950):
            svc.tick(tick(ts, spot=100000, yes_ask=0.5, no_ask=0.5), received=noon)
        # spot far above target in the final minute: YES is near-certain, ask 0.90
        r1 = svc.tick(tick(950, spot=100400, yes_ask=0.90, no_ask=0.11), received=noon)
        self.assertEqual(r1['action'], 'TRADE', r1['reason'])
        r2 = svc.tick(tick(951, spot=100400, yes_ask=0.91, no_ask=0.10), received=noon)
        self.assertEqual(r2['filled']['price'], 0.91)
        self.assertEqual(r2['action'], 'BLOCKED')
        self.assertIn('no re-entry', r2['reason'])
        self.assertEqual(r2['gate']['action'], 'TRADE')  # the pure gate stays visible for the real-order veto
        trades = svc.db.rows("SELECT * FROM signals WHERE kind='trade'")
        self.assertEqual(len(trades), 1)
        self.assertAlmostEqual(trades[0]['fee'], order_fee(0.91, trades[0]['contracts']))
        svc.settle({'ticker': 'KXBTC15M-TEST', 'result': 'yes'})
        t = svc.db.rows("SELECT * FROM signals WHERE kind='trade'")[0]
        self.assertAlmostEqual(t['pnl'], t['contracts_filled'] * 0.09 - t['fee'])

    def test_engine_flag_switches_probability(self):
        off, on = self.make(), self.make(ENGINE_VALIDATED=True)
        for svc in (off, on):
            for ts in range(100, 400):
                r = svc.tick(tick(ts, q_raw=0.9))
            svc.last = r
        self.assertEqual(off.last['p_used'], 'base')
        self.assertEqual(on.last['p_used'], 'engine')
        self.assertAlmostEqual(on.last['p_engine'], 0.9, places=6)

    def test_stale_book_blocks(self):
        svc = self.make()
        for ts in range(100, 300):
            r = svc.tick(tick(ts, book_stale=True, stale_reason='Kalshi book 900 ms behind'))
        self.assertEqual(r['action'], 'BLOCKED')
        self.assertIn('stale book', r['reason'])

    def test_real_risk_daily_stop(self):
        svc = self.make()
        for ts in range(100, 200):
            r = svc.tick(tick(ts, real={'day_pnl': -40, 'week_pnl': -40, 'start_day': 1000, 'start_week': 1000, 'windows_today': 1, 'in_window': False}))
        self.assertFalse(r['real_risk']['allowed'])
        self.assertTrue(r['real_risk']['stop_hit'])

    def test_bad_tick_rejected(self):
        with self.assertRaises(ValueError):
            self.make().tick({'ticker': 'X'})


class ConfigTests(unittest.TestCase):
    def test_env_overrides(self):
        cfg = load_config({'ENGINE_VALIDATED': 'true', 'EDGE_MIN_EDGE': '0.02', 'EDGE_BANKROLL': '500', 'EDGE_MAX_WINDOWS': '4'}, dotenv=None)
        self.assertTrue(cfg.ENGINE_VALIDATED)
        self.assertEqual((cfg.MIN_EDGE, cfg.BANKROLL, cfg.MAX_WINDOWS), (0.02, 500.0, 4))
        self.assertFalse(load_config({}, dotenv=None).ENGINE_VALIDATED)
        with self.assertRaises(ValueError):
            load_config({'EDGE_MODE': 'yolo'}, dotenv=None)


if __name__ == '__main__':
    unittest.main()
