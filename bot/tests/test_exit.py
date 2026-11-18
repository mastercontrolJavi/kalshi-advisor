"""Selling before settlement, checked with a fake Kalshi: no test here sends anything.  uv run --project bot pytest bot/tests"""
import asyncio
import json
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from bot import kalshi, live  # noqa: E402
from bot.book import FeedDelay  # noqa: E402
from bot.config import BotConfig  # noqa: E402
from bot.paper import PaperBroker  # noqa: E402
from bot.runner import Bot, Market  # noqa: E402


def test_sell_body_mirrors_the_buy_and_can_only_reduce():
    yes = live.sell_body('T', 'yes', 0.12, 2.5, 'id')
    assert yes['side'] == 'ask' and yes['price'] == '0.1200' and yes['count'] == '2.50' and yes['reduce_only'] is True and yes['time_in_force'] == 'immediate_or_cancel'
    no = live.sell_body('T', 'no', 0.12, 2.5, 'id')
    assert no['side'] == 'bid' and no['price'] == '0.8800' and no['reduce_only'] is True     # selling NO at 12c = buying YES at 88c


def test_sold_counts_the_other_sides_fills_at_this_sides_price():
    fills = [{'outcome_side': 'no', 'count_fp': '1.98', 'yes_price_dollars': '0.8100', 'no_price_dollars': '0.1900', 'fee_cost': '0.0214'},   # the buy of NO
             {'outcome_side': 'yes', 'count_fp': '1.98', 'yes_price_dollars': '0.4800', 'no_price_dollars': '0.5200', 'fee_cost': '0.0346'}]  # NO sold at 52c
    n, cash = live.sold(fills, 'no')
    assert n == 1.98 and math.isclose(cash, 1.98 * 0.52 - 0.0346)
    assert live.sold(fills[:1], 'no') == (0.0, 0.0)


def test_ledger_books_a_sale_once_and_settles_the_rest(tmp_path):
    b = PaperBroker(str(tmp_path / 'l.db'), 15.0, now=0)
    b.record('T', 'no', 4.0, 4 * 0.25, 0.05, 0.25, 4.0, 1.0)
    cost = 1.05
    assert math.isclose(b.exits('T', 1.0, 0.10, 2.0), 0.10) and math.isclose(b.cash, 15 - cost + 0.10) and b.positions['T'].left == 3.0
    assert b.exits('T', 1.0, 0.10, 3.0) == 0.0                                    # the same sale stated again
    b2 = PaperBroker(str(tmp_path / 'l.db'), 15.0)                                # a restart keeps the part sold
    assert b2.positions['T'].left == 3.0 and math.isclose(b2.positions['T'].exit_cash, 0.10)
    assert math.isclose(b2.settle('T', 'no', 4.0), 0.10 + 3.0 - cost) and math.isclose(b2.cash, 15 - cost + 0.10 + 3.0)
    b2.record('U', 'yes', 2.0, 0.60, 0.03, 0.30, 2.0, 5.0)
    cash = b2.cash
    assert math.isclose(b2.exits('U', 2.0, 0.20, 6.0), 0.20) and 'U' not in b2.positions and b2.traded('U')   # all sold: the round is closed
    assert b2.db.execute("SELECT result, payout, pnl FROM fills WHERE ticker = 'U'").fetchone() == ('sold', 0.20, 0.20 - 0.63)
    assert b2.settle('U', 'yes', 7.0) is None and math.isclose(b2.cash, cash + 0.20)
    s = b2.summary()
    assert s['rounds'] == 2 and math.isclose(s['pnl'], s['equity'] - 15.0)


def test_a_sale_found_after_settlement_restates_the_round(tmp_path):
    b = PaperBroker(':memory:', 15.0, now=0)
    b.record('T', 'no', 1.98, 1.98 * 0.19, 0.0214, 0.19, 1.98, 1.0)
    cost = 1.98 * 0.19 + 0.0214
    assert math.isclose(b.settle('T', 'yes', 2.0), -cost)                          # booked as held to the end and lost
    added = b.exits('T', 1.98, 1.98 * 0.52 - 0.0346, 3.0)                          # in fact it was sold by hand at 52c
    assert math.isclose(added, 1.98 * 0.52 - 0.0346) and math.isclose(b.cash, 15 - cost + added)
    assert math.isclose(b.db.execute("SELECT pnl FROM fills WHERE ticker = 'T'").fetchone()[0], added - cost)
    b.record('W', 'yes', 2.0, 0.50, 0.02, 0.25, 2.0, 4.0)
    b.settle('W', 'yes', 5.0)                                                      # held and won $2
    cash = b.cash
    assert math.isclose(b.exits('W', 1.0, 0.40, 6.0), 0.40 - 1.0) and math.isclose(b.cash, cash - 0.60)   # half had been sold at 40c: one contract's win goes
    b.record('X', 'yes', 1.0, 0.20, 0.01, 0.20, 1.0, 7.0)
    assert math.isclose(b.exits('X', 3.0, 0.90, 8.0), 0.30)                        # more sold on the account than this position: its share only


def make(tmp_path, entry=0.28, n=2.0, side='yes', **cfg):
    bot = Bot.__new__(Bot)
    bot.cfg, bot.live, bot.signer = BotConfig(MODE='live', **cfg), True, object()
    bot.broker = PaperBroker(':memory:', 15.0, now=0)
    bot.switch = live.Switch(tmp_path / 'bot-live.json')
    bot.switch.path.write_text(json.dumps({'armed': True}))
    bot.armed, bot.delay, bot.cooldown, bot.pending, bot.stats, bot.tripped = True, FeedDelay(), {}, None, {'reasons': {}, 'evals': 0}, None
    bot.selling, bot.balance, bot.balance_at = True, 1000.0, time.time()
    bot.peaks, bot.exit_since, bot.exit_wait, bot.exit_tries = {}, {}, {}, {}
    now = time.time()
    iso = lambda t: time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(t))
    m = Market({'ticker': 'T', 'open_time': iso(now - 300), 'close_time': iso(now + 600), 'floor_strike': 1})
    bot.broker.record('T', side, n, n * entry, 0.0, entry, n, now)
    return bot, m, bot.broker.positions['T'], now


def book(m, yes_bid):
    m.book.snapshot([(f'{yes_bid:.2f}', '100')], [(round(1 - yes_bid - 0.02, 2), '100')])


def test_exit_signal_needs_the_fall_to_last(tmp_path):
    bot, m, pos, now = make(tmp_path)
    book(m, 0.20)
    assert bot.exit_signal(m, pos, now) is None                                    # 20c is not half of 28c
    book(m, 0.14)
    assert bot.exit_signal(m, pos, now) is None                                    # just got there
    assert bot.exit_signal(m, pos, now + 10) is None
    book(m, 0.20)
    assert bot.exit_signal(m, pos, now + 12) is None                               # came back: the clock starts again
    book(m, 0.13)
    assert bot.exit_signal(m, pos, now + 13) is None
    assert bot.exit_signal(m, pos, now + 29) == ('down to half its entry', 0.13)
    assert bot.exit_signal(m, pos, m.close - 100) is None                          # under two minutes left: held
    bot.exit_tries['T'] = 3
    assert bot.exit_signal(m, pos, now + 40) is None                               # three attempts a round at most


def test_exit_signal_on_a_reversal_from_the_high(tmp_path):
    bot, m, pos, now = make(tmp_path, EXIT_HOLD_S=0.0)
    book(m, 0.35)
    assert bot.exit_signal(m, pos, now) is None                                    # up 7c: not enough to arm it
    book(m, 0.50)
    assert bot.exit_signal(m, pos, now + 1) is None and bot.peaks['T'] == 0.50
    book(m, 0.32)
    assert bot.exit_signal(m, pos, now + 2) is None                                # 64% of the high
    book(m, 0.30)
    assert bot.exit_signal(m, pos, now + 3) == ('reversing from its high', 0.30)   # 60% of the high, still above the entry
    assert bot.exit_signal(m, pos, m.close - 30) is None                           # last minute: held
    bot2, m2, pos2, now2 = make(tmp_path, EXIT_HOLD_S=0.0, EXIT_BACK=0.0, EXIT_BELOW=0.0)
    book(m2, 0.50); bot2.exit_signal(m2, pos2, now2); book(m2, 0.05)
    assert bot2.exit_signal(m2, pos2, now2 + 1) is None                            # both rules off
    bot3, m3, pos3, now3 = make(tmp_path, side='no', entry=0.25, EXIT_HOLD_S=0.0)
    book(m3, 0.88)                                                                 # YES bid 88c, so NO bid is 1 - 0.90 ask = 10c
    assert bot3.exit_signal(m3, pos3, now3) == ('down to half its entry', 0.10)


def run_exit(bot, m, pos, post, fills):
    sent = []

    async def fake_post(signer, path, body):
        sent.append(body)
        if isinstance(post, Exception):
            raise post
        return post

    async def fake_fills(signer, query, want=0.0, tries=4):
        return fills

    old = kalshi.post, live.read_fills, asyncio.sleep
    kalshi.post, live.read_fills = fake_post, fake_fills

    async def go():
        real = old[2]
        asyncio.sleep = lambda s: real(0)
        try:
            await bot.execute_exit(m, pos, 'down to half its entry', 0.13)
        finally:
            asyncio.sleep = real
    try:
        asyncio.run(go())
    finally:
        kalshi.post, live.read_fills = old[0], old[1]
    return sent


def test_a_sale_is_sent_once_and_booked_from_kalshis_fills(tmp_path):
    bot, m, pos, now = make(tmp_path)
    fills = [{'outcome_side': 'yes', 'count_fp': '2.00', 'yes_price_dollars': '0.2800', 'no_price_dollars': '0.7200', 'fee_cost': '0'},
             {'outcome_side': 'no', 'count_fp': '2.00', 'yes_price_dollars': '0.1300', 'no_price_dollars': '0.8700', 'fee_cost': '0.0158'}]
    sent = run_exit(bot, m, pos, {'order_id': 's1', 'fill_count': '2.00'}, fills)
    assert len(sent) == 1 and sent[0]['side'] == 'ask' and sent[0]['price'] == '0.1300' and sent[0]['count'] == '2.00' and sent[0]['reduce_only'] is True
    assert 'T' not in bot.broker.positions and math.isclose(bot.broker.cash, 15 - 0.56 + 0.26 - 0.0158) and bot.pending is None and bot.switch.armed


def test_a_failed_sale_changes_nothing_and_leaves_trading_on(tmp_path):
    bot, m, pos, now = make(tmp_path)
    buy = [{'outcome_side': 'yes', 'count_fp': '2.00', 'yes_price_dollars': '0.2800', 'no_price_dollars': '0.7200', 'fee_cost': '0'}]
    sent = run_exit(bot, m, pos, kalshi.Refused(400, 'no position'), buy)
    assert len(sent) == 1 and bot.broker.positions['T'].left == 2.0 and math.isclose(bot.broker.cash, 15 - 0.56)
    assert bot.switch.armed and bot.pending is None and bot.exit_tries['T'] == 1 and bot.exit_wait['T'] > time.time()


def test_switched_off_by_the_owner_does_not_sell(tmp_path):
    bot, m, pos, now = make(tmp_path)
    bot.switch.path.write_text(json.dumps({'armed': False, 'by': 'user', 'time': time.time() * 1000}))
    assert run_exit(bot, m, pos, {'order_id': 's'}, []) == [] and not bot.selling and bot.broker.positions['T'].left == 2.0


def test_switched_off_by_the_bot_still_sells_what_it_holds(tmp_path):
    bot, m, pos, now = make(tmp_path)
    bot.disarm('Kalshi refused an order (insufficient balance)')                   # no new buys from here on ...
    assert not bot.switched_on() and bot.selling and bot.may_sell()
    fills = [{'outcome_side': 'yes', 'count_fp': '2.00', 'yes_price_dollars': '0.2800', 'no_price_dollars': '0.7200', 'fee_cost': '0'},
             {'outcome_side': 'no', 'count_fp': '2.00', 'yes_price_dollars': '0.1300', 'no_price_dollars': '0.8700', 'fee_cost': '0.0158'}]
    sent = run_exit(bot, m, pos, {'order_id': 's2', 'fill_count': '2.00'}, fills)
    assert len(sent) == 1 and sent[0]['reduce_only'] is True and 'T' not in bot.broker.positions   # ... but a losing position is still sold
    bot.switch.path.write_text(json.dumps({'armed': False, 'by': 'user', 'time': time.time() * 1000}))
    assert not bot.may_sell()                                                      # the owner's off stops sales too


def test_a_voided_round_returns_its_cost(tmp_path):
    from bot.runner import settled_result
    assert settled_result({'result': 'yes', 'status': 'finalized'}) == 'yes' and settled_result({'result': '', 'status': 'active'}) is None
    assert settled_result({'result': '', 'status': 'determined'}) is None                          # not final yet
    assert settled_result({'result': 'void'}) == 'void' and settled_result({'result': '', 'status': 'finalized'}) == 'void'
    assert settled_result({'result': 'scalar', 'status': 'finalized', 'settlement_value_dollars': '1.0000'}) == 'yes'
    assert settled_result({'result': 'scalar', 'status': 'finalized', 'settlement_value_dollars': '0.0000'}) == 'no'
    assert settled_result({'result': 'scalar', 'status': 'finalized', 'settlement_value_dollars': '0.4200'}) is None  # left for the owner
    b = PaperBroker(':memory:', 10.0, now=0)
    b.record('V', 'yes', 2.0, 0.60, 0.02, 0.30, 2.0, 1.0)
    assert math.isclose(b.settle('V', 'void', 2.0), 0.0) and math.isclose(b.cash, 10.0) and 'V' not in b.positions
    b.record('W', 'no', 2.0, 0.60, 0.02, 0.30, 2.0, 3.0)
    b.exits('W', 1.0, 0.20, 4.0)                                                   # half sold early for 20c
    assert math.isclose(b.settle('W', 'void', 5.0), 0.20 + 0.31 - 0.62) and math.isclose(b.equity, 10.0 - 0.11)
    assert math.isclose(b.exits('W', 2.0, 0.40, 6.0), 0.20 - 0.31)                 # a late sale found after the void restates it
