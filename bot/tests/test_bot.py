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

CFG = BotConfig(KELLY_FRAC=0.5, MAX_RISK_FRAC=0.10)   # the sizing these numbers were worked out for; the live default may differ


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


def test_walk_respects_limit_cash_and_hundredths():
    asks = [(0.20, 2.9), (0.21, 10)]
    assert walk(asks, 0.20, 5, 100)[0] == 2.9          # only what rests at the limit
    asks = [(0.20, 2), (0.21, 10)]
    assert walk(asks, 0.21, 0.36, 100)[0] == 0.36      # a part of a contract
    n, paid, fee = walk(asks, 0.21, 5, 100)
    assert n == 5 and math.isclose(paid, 2 * 0.20 + 3 * 0.21) and math.isclose(fee, order_fee(0.20, 2) + order_fee(0.21, 3))
    assert walk(asks, 0.19, 5, 100)[0] == 0            # ask moved above the limit
    n, paid, fee = walk(asks, 0.21, 5, 0.45)           # cash runs out part-way through the second level
    assert 2 < n < 2.2 and paid + fee <= 0.45 + 1e-9 and paid + fee + 0.01 * 0.21 + order_fee(0.21, n - 2 + 0.01) - order_fee(0.21, n - 2) > 0.45


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


def test_size_is_fractional_and_capped():
    cost = 0.22 + taker_fee(0.22)
    n = size(CFG, 0.30, 0.22, 15.0)                      # half Kelly: 4.4% of $15
    assert math.isclose(n, math.floor(0.5 * (0.30 - cost) / (1 - cost) * 15 / cost * 100) / 100) and 2.8 < n < 2.9
    assert 0 < size(CFG, 0.95, 0.90, 5.0) < 1            # part of a 90c contract on a $5 bankroll
    assert size(CFG, 0.86, 0.80, 15.0) == 1.84           # a big edge is capped at 10% of $15, not rounded to 1
    assert size(CFG, 0.845, 0.80, 15.0) == 1.65          # between whole numbers: exactly what the rule asks for
    n = size(CFG, 0.60, 0.20, 1000.0)
    assert n * 0.20 + order_fee(0.20, n) <= 100.0 + 1e-9 and (n + 0.01) * 0.20 + order_fee(0.20, n + 0.01) > 100.0
    assert size(CFG, 0.20, 0.22, 1000.0) == 0            # no edge, no size


def test_decide_rules():
    ok, why = decide(CFG, fv(0.30), 300, 0.22, 0.79, 15.0)
    assert ok and ok.side == 'yes' and math.isclose(ok.edge, 0.30 - 0.22 - taker_fee(0.22)) and 2.8 < ok.contracts < 2.9
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


def test_shown_side_is_the_one_picked_not_the_models_favourite():
    from bot.runner import best_side
    # Model says 45% YES, YES asks 10c, NO asks 60c: the bot buys YES although NO is the favourite.
    intent, why = decide(replace(CFG, MIN_ASK=0.05), fv(0.45), 300, 0.10, 0.60, 15.0)
    assert why == 'trade' and intent.side == 'yes'
    assert best_side(0.45, 0.10, 0.60, intent) == {'side': 'yes', 'edge': intent.edge}
    shown = best_side(0.45, 0.10, 0.60, None)              # no trade: still the side with the larger edge
    assert shown['side'] == 'yes' and math.isclose(shown['edge'], 0.45 - 0.10 - taker_fee(0.10))
    assert best_side(0.45, None, None, None) == {'side': None, 'edge': None}


def test_sequence_gap_on_a_later_subscription_distrusts_the_books():
    import asyncio
    from bot.runner import Bot, Market
    bot = Bot.__new__(Bot)                                  # message handling only: no key, no socket
    bot.stats, bot.seqs, bot.book_sids, bot.markets, bot.resynced = {'messages': 0}, {}, set(), {}, 0
    for t in ('A', 'B'):
        bot.markets[t] = Market({'ticker': t, 'open_time': '2026-01-01T00:00:00Z', 'close_time': '2026-01-01T00:15:00Z', 'floor_strike': 1})
    bot.evaluate = lambda market: None
    bot.delay = __import__('bot.book', fromlist=['FeedDelay']).FeedDelay()

    async def resync():
        bot.resynced += 1
    bot.resync = resync

    def snap(sid, seq, t):
        return {'type': 'orderbook_snapshot', 'sid': sid, 'seq': seq, 'msg': {'market_ticker': t, 'yes_dollars_fp': [['0.4', '5']], 'no_dollars_fp': []}}

    def delta(sid, seq, t):
        return {'type': 'orderbook_delta', 'sid': sid, 'seq': seq, 'msg': {'market_ticker': t, 'side': 'yes', 'price_dollars': '0.4', 'delta_fp': '1'}}

    async def run():
        bot.on_message(snap(1, 1, 'A'))
        bot.on_message(snap(2, 1, 'B'))                    # the next round arrives on its own subscription id
        bot.on_message(delta(1, 2, 'A'))
        bot.on_message(delta(2, 2, 'B'))
        assert bot.markets['A'].book.valid and bot.markets['B'].book.valid and bot.resynced == 0
        bot.on_message(delta(2, 4, 'B'))                   # seq 3 on the second id was lost
        await asyncio.sleep(0)
        assert not bot.markets['B'].book.valid and not bot.markets['A'].book.valid and bot.resynced == 1
    asyncio.run(run())


def _priced_bot(print_age_s, fast_age_s):
    """A bot with a warm pricer whose newest 1 Hz print and 5 Hz value arrived print_age_s and fast_age_s ago (local and
    exchange time alike), BRTI 500 above the strike and YES asking 90c: a trade if the data is fresh."""
    import time
    from bot.runner import Bot, Market
    now = time.time()
    bot = Bot.__new__(Bot)
    bot.cfg, bot.live, bot.armed, bot.pending, bot.cooldown, bot.view = replace(CFG, VOL_MIN_SAMPLES=5), False, False, None, {}, None
    bot.stats, bot.delay, bot.broker = {'evals': 0, 'reasons': {}}, FeedDelay(), PaperBroker(':memory:', 15.0, now=0)
    bot.pricer = Pricer(bot.cfg)
    last = int(now - print_age_s)
    for t in range(last - 20, last + 1):
        bot.pricer.on_print(t, 100_500.0 + (t % 2))
    bot.pricer.on_fast(now - fast_age_s, 100_500.0)
    bot.print_ms, bot.fast_ms = (now - print_age_s) * 1000, (now - fast_age_s) * 1000
    bot.last_value_ms = max(bot.print_ms, bot.fast_ms)
    iso = lambda t: time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(t))
    m = Market({'ticker': 'T', 'open_time': iso(now - 400), 'close_time': iso(now + 300), 'floor_strike': 100_000})
    m.book.snapshot([('0.05', '100')], [(0.10, '100')])
    assert m.book.ask('yes') == 0.90
    return bot, m


def _evaluate(bot, m):
    import asyncio
    orders = []

    async def execute(market, intent, decided):
        orders.append(intent)
    bot.execute = execute

    async def go():
        bot.evaluate(m)
        await asyncio.sleep(0)
    asyncio.run(go())
    return orders


def test_a_fresh_print_trades():
    bot, m = _priced_bot(0.3, 0.1)
    assert len(_evaluate(bot, m)) == 1 and bot.pricer.spot_fast


def test_a_stale_1hz_print_does_not_trade_although_the_5hz_value_is_fresh():
    # The 1 Hz prints stopped 5 s ago while the 5 Hz values kept coming. The pricer ignores a 5 Hz value that far ahead
    # of the last print, so the round would be priced on the 5-second-old print: no trade.
    bot, m = _priced_bot(5.0, 0.1)
    assert _evaluate(bot, m) == [] and bot.stats['reasons'].get('BRTI value stale') == 1


def test_two_callers_never_subscribe_the_same_round_twice():
    import asyncio
    import json as _json
    from bot.runner import Bot
    bot = Bot.__new__(Bot)
    bot.subscribed, bot.next_id, sent = set(), 10, []

    class FakeWs:
        async def send(self, text):
            await asyncio.sleep(0)                          # a real send can yield to the other task
            sent.append(_json.loads(text)['params']['market_tickers'])
    bot.ws = FakeWs()

    async def go():
        await asyncio.gather(bot.subscribe(['A', 'B']), bot.subscribe(['A', 'B']))   # housekeeping and a reconnect at once
    asyncio.run(go())
    assert sent == [['A', 'B']] and bot.subscribed == {'A', 'B'}


def test_a_failed_subscribe_is_tried_again_later():
    import asyncio
    from bot.runner import Bot
    bot = Bot.__new__(Bot)
    bot.subscribed, bot.next_id = set(), 10

    class BrokenWs:
        async def send(self, text):
            raise ConnectionError('closed')
    bot.ws = BrokenWs()
    try:
        asyncio.run(bot.subscribe(['A']))
        assert False
    except ConnectionError:
        pass
    assert bot.subscribed == set()


def test_housekeeping_survives_a_failing_status_summary():
    import asyncio
    from bot.runner import Bot
    bot = Bot.__new__(Bot)
    bot.live, ticks = False, []

    async def nothing():
        return None
    bot.refresh_markets = bot.settle = nothing
    bot.write_status = lambda: None

    def broken():
        raise RuntimeError('database is locked')
    bot.broker = type('B', (), {'summary': staticmethod(broken)})()

    class Done(Exception):
        pass

    async def fake_sleep(s):
        ticks.append(s)
        if len(ticks) >= 8:
            raise Done
    old = asyncio.sleep
    asyncio.sleep = fake_sleep
    try:
        asyncio.run(bot.housekeeping())
        assert False
    except Done:
        pass
    finally:
        asyncio.sleep = old
    assert len(ticks) == 8                                  # kept going past the sixth tick, where the summary failed
