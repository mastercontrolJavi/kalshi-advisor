"""Accounting, book and decision checks for the paper bot.  uv run --project bot pytest bot/tests"""
import math
import sys
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from bot.book import Book, FeedDelay  # noqa: E402
from bot.config import BotConfig  # noqa: E402
from bot.paper import PaperBroker, walk  # noqa: E402
from bot.strategy import Pricer, decide, size  # noqa: E402
from edge.ev_gate import order_fee, taker_fee  # noqa: E402
from edge.fair_value import FairValue  # noqa: E402

CFG = BotConfig()


def fv(p):
    return FairValue(p, 0.0, 1.0, 'pre_window', 1.0)


def test_book_asks_come_from_the_other_sides_bids():
    b = Book()
    b.snapshot([('0.22', '100'), ('0.21', '50')], [(0.77, '30'), (0.76, '10')])
    assert b.ask('yes') == 0.23 and b.ask('no') == 0.78
    assert b.asks('yes') == [(0.23, 30.0), (0.24, 10.0)]
    assert not b.crossed
    assert b.delta('no', 0.77, -30) and b.ask('yes') == 0.24
    assert b.delta('yes', 0.23, 5) and b.ask('no') == 0.77
    assert not b.delta('yes', 0.5, -1) and not b.valid  # removing size that is not there


def test_feed_delay_is_measured_above_its_own_floor():
    d = FeedDelay()
    d.observe(1000, 1100)  # 100 ms of clock offset + network
    assert d.ms == 0
    d.observe(2000, 2100)
    assert d.ms == 0
    d.observe(3000, 5100)  # 2 s late
    assert d.ms == 2000


def test_walk_respects_limit_cash_and_whole_contracts():
    asks = [(0.20, 2.9), (0.21, 10)]
    assert walk(asks, 0.20, 5, 100)[0] == 2            # only whole contracts at the limit
    n, paid, fee = walk(asks, 0.21, 5, 100)
    assert n == 5 and math.isclose(paid, 2 * 0.20 + 3 * 0.21) and math.isclose(fee, order_fee(0.20, 2) + order_fee(0.21, 3))
    assert walk(asks, 0.19, 5, 100)[0] == 0            # ask moved above the limit
    assert walk(asks, 0.21, 5, 0.45)[0] == 2           # cash covers two contracts and their fee, not a third


def test_paper_account_round_trip_and_restart(tmp_path):
    path = str(tmp_path / 'bot.db')
    b = PaperBroker(path, 15.0, now=0)
    f = b.buy('T1', 'yes', 0.20, 3, [(0.20, 100)], 1.0, q=0.3, edge=0.09)
    cost = 3 * 0.20 + order_fee(0.20, 3)
    assert f.contracts == 3 and math.isclose(b.cash, 15 - cost) and math.isclose(b.equity, 15.0)
    assert b.buy('T1', 'no', 0.9, 1, [(0.9, 100)], 2.0) is None  # one position a round
    b2 = PaperBroker(path, 15.0)                                 # restart: the open position is still there
    assert b2.positions['T1'].contracts == 3 and math.isclose(b2.equity, 15.0)
    pnl = b2.settle('T1', 'yes', 3.0)
    assert math.isclose(pnl, 3 - cost) and math.isclose(b2.equity, 15 + 3 - cost)
    assert b2.traded('T1') and b2.settle('T1', 'yes', 4.0) is None
    b2.buy('T2', 'no', 0.80, 1, [(0.80, 5)], 5.0, q=0.9, edge=0.08)
    assert math.isclose(b2.settle('T2', 'yes', 6.0), -(0.80 + order_fee(0.80, 1)))
    s = b2.summary()
    assert s['rounds'] == 2 and s['wins'] == 1 and math.isclose(s['pnl'], s['equity'] - 15.0)


def test_size_is_capped_and_allows_one_contract_under_the_cap():
    assert size(CFG, 0.30, 0.22, 15.0) == 2              # half Kelly is 4.4% of $15 = two 23c contracts
    assert size(CFG, 0.86, 0.80, 15.0) == 1              # one 81c contract fits under 10% of $15
    assert size(CFG, 0.95, 0.90, 5.0) == 0               # one 90c contract is more than 10% of $5
    n = size(CFG, 0.60, 0.20, 1000.0)
    assert n * 0.20 + order_fee(0.20, n) <= 100.0 + 1e-9 and (n + 1) * 0.20 + order_fee(0.20, n + 1) > 100.0
    assert size(CFG, 0.20, 0.22, 1000.0) == 0            # no edge, no size


def test_decide_rules():
    ok, why = decide(CFG, fv(0.30), 300, 0.22, 0.79, 15.0)
    assert ok and ok.side == 'yes' and math.isclose(ok.edge, 0.30 - 0.22 - taker_fee(0.22)) and ok.contracts == 2
    assert decide(CFG, fv(0.30), 60, 0.22, 0.79, 15.0)[0] is None      # last two minutes
    assert decide(CFG, fv(0.30), 700, 0.22, 0.79, 15.0)[0] is None     # first five minutes
    assert decide(CFG, fv(0.24), 300, 0.22, 0.79, 15.0)[1] == 'no edge after the fee'
    assert decide(CFG, fv(0.60), 300, 0.50, 0.51, 15.0)[1] == 'mid band'
    assert decide(CFG, fv(0.15), 300, 0.05, 0.96, 15.0)[1] == 'ask outside the allowed prices'
    no, _ = decide(CFG, fv(0.10), 300, 0.20, 0.82, 15.0)
    assert no and no.side == 'no' and math.isclose(no.q, 0.90)
    assert decide(CFG, fv(0.30), 300, 0.22, 0.79, 0.5)[1] == 'bankroll below the bust level'
    assert decide(replace(CFG, BLOCK_MID_BAND=False), fv(0.60), 300, 0.50, 0.51, 15.0)[0] is not None


def test_pricer_needs_warmup_then_prices_and_uses_the_fresher_value():
    p = Pricer(replace(CFG, VOL_MIN_SAMPLES=5))
    t0 = 1_000_000
    assert p.fair(100_000.0, t0 + 600) is None
    for i in range(10):
        p.on_print(t0 + i, 100_000.0 + (i % 2) * 5)
    assert not p.on_print(t0 + 3, 1.0)                    # an old second is ignored
    fair, left = p.fair(100_000.0, t0 + 9 + 300)
    assert left == 300 and 0.4 < fair.p_yes < 0.6
    p.on_fast(t0 + 9.6, 100_400.0)                        # the 5 Hz value moved up before the next print
    fair2, left2 = p.fair(100_000.0, t0 + 9 + 300)
    assert math.isclose(left2, 299.4) and fair2.p_yes > fair.p_yes
    p.on_fast(t0 + 20, 90_000.0)                          # a value too far ahead of the last print is not used
    assert p.fair(100_000.0, t0 + 9 + 300)[1] == 300


def test_pricer_final_minute_uses_locked_prints():
    p = Pricer(replace(CFG, VOL_MIN_SAMPLES=5))
    close = 2_000_000
    for t in range(close - 200, close - 5):
        p.on_print(t, 100_000.0 + (t % 2))
    fair, left = p.fair(99_990.0, close)                  # 55 prints locked well above the strike
    assert left == 6 and fair.regime == 'final_minute' and fair.p_yes > 0.99
    q = Pricer(replace(CFG, VOL_MIN_SAMPLES=5))
    for t in list(range(close - 200, close - 50)) + list(range(close - 20, close - 5)):
        q.on_print(t, 100_000.0)
    assert q.fair(99_990.0, close) is None                # half the window's prints are missing
