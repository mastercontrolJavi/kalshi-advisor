"""Real-money mode, checked with a fake Kalshi: no test here sends anything.  uv run --project bot pytest bot/tests"""
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
from bot.strategy import Intent  # noqa: E402
from edge.ev_gate import order_fee  # noqa: E402


def test_order_body_quotes_both_sides_from_the_yes_leg():
    yes = live.order_body('T', 'yes', 0.27, 2.314, 'id-1')
    assert yes == {'ticker': 'T', 'client_order_id': 'id-1', 'side': 'bid', 'count': '2.31', 'price': '0.2700', 'time_in_force': 'immediate_or_cancel',
                   'self_trade_prevention_type': 'taker_at_cross', 'cancel_order_on_pause': True}
    no = live.order_body('T', 'no', 0.25, 4, 'id-2')
    assert no['side'] == 'ask' and no['price'] == '0.7500' and no['count'] == '4.00'   # buying NO at 25c = selling YES at 75c
    assert live.order_body('T', 'yes', 0.5, 1)['client_order_id'] != live.order_body('T', 'yes', 0.5, 1)['client_order_id']
    for bad in (('maybe', 0.5, 1), ('yes', 1.0, 1), ('yes', 0.5, 0)):
        try:
            live.order_body('T', *bad)
            assert False
        except ValueError:
            pass


def test_fills_and_reply_give_contracts_cost_and_fees():
    fills = [{'outcome_side': 'no', 'count_fp': '1.50', 'yes_price_dollars': '0.7600', 'no_price_dollars': '0.2400', 'fee_cost': '0.0192'},
             {'outcome_side': 'no', 'count_fp': '0.50', 'yes_price_dollars': '0.7500', 'no_price_dollars': '0.2500', 'fee_cost': '0.0066'},
             {'outcome_side': 'yes', 'count_fp': '9.00', 'yes_price_dollars': '0.7500', 'no_price_dollars': '0.2500', 'fee_cost': '1'}]
    n, paid, fees = live.from_fills(fills, 'no')
    assert n == 2.0 and math.isclose(paid, 1.5 * 0.24 + 0.5 * 0.25) and math.isclose(fees, 0.0258)
    n, paid, fees = live.from_reply({'fill_count': '2.00', 'average_fill_price': '0.7600', 'average_fee_paid': '0.0128'}, 'no')
    assert n == 2.0 and math.isclose(paid, 0.48) and math.isclose(fees, 0.0256)
    assert live.from_reply({'fill_count': '0.00', 'remaining_count': '0.00'}, 'yes') == (0.0, 0.0, 0.0)


def test_switch_is_off_unless_the_file_says_armed(tmp_path):
    s = live.Switch(tmp_path / 'bot-live.json')
    assert not s.armed                                           # no file
    s.path.write_text('not json')
    assert not s.armed
    s.path.write_text(json.dumps({'armed': 'true'}))             # only the boolean true counts
    assert not s.armed
    s.path.write_text(json.dumps({'armed': True, 'by': 'user'}))
    assert s.armed
    s.off('why')
    assert not s.armed and s.read()['by'] == 'bot' and s.read()['note'] == 'why'


def arming(armed=True, boot_id='boot-1', hours=1.0, **more):
    """What the Bot page writes when the owner switches on: for this run of the bot, with an end time."""
    return json.dumps({'armed': armed, 'by': 'user', 'boot_id': boot_id, 'expires_at': time.time() * 1000 + hours * 3600_000, **more})


def make(tmp_path, cash=15.0, armed=True, **cfg):
    bot = Bot.__new__(Bot)                                       # no key, no socket
    # MAX_CONTRACTS_PER_ROUND=0: these tests are about the rule's own size; the flat test size is in test_safety.py
    bot.cfg, bot.live, bot.signer = BotConfig(MODE='live', **{'MAX_CONTRACTS_PER_ROUND': 0, **cfg}), True, object()
    bot.broker = PaperBroker(':memory:', cash, now=0)
    bot.switch, bot.boot_id = live.Switch(tmp_path / 'bot-live.json'), 'boot-1'
    bot.switch.path.write_text(arming(armed))
    bot.armed, bot.delay, bot.cooldown, bot.pending, bot.stats, bot.tripped = armed, FeedDelay(), {}, None, {'reasons': {}}, None
    bot.selling, bot.balance, bot.balance_at = armed, 1000.0, time.time()   # a Kalshi account with plenty of cash, just read
    now = time.time()
    iso = lambda t: time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(t))
    m = Market({'ticker': 'T', 'open_time': iso(now - 300), 'close_time': iso(now + 600), 'floor_strike': 1})
    m.book.snapshot([('0.72', '100')], [(0.24, '100')])         # YES bid 72c, NO bid 24c: YES asks 76c, NO asks 28c
    assert m.book.ask('no') == 0.28 and not m.book.crossed
    return bot, m


def fake_kalshi(post=None, fills=None, shown=None, extra_orders=()):
    """Patch kalshi.post, kalshi.signed_get and live.read_fills. `shown`: None = Kalshi lists none of the bot's orders;
    else the fill_count_fp it lists for each order the bot sent (or for each client id in extra_orders). Order u-<cid>'s
    fills are `fills`; any other query (a hand trade's order, say) has none. Returns (sent, asked, restore)."""
    sent, asked = [], []

    async def fake_post(signer, path, body):
        sent.append((path, body))
        return post(body) if callable(post) else post

    async def fake_get(signer, path):
        asked.append(path)
        if isinstance(fills, Exception):
            raise fills
        cids = [b['client_order_id'] for _, b in sent] + list(extra_orders)
        return {'orders': [] if shown is None else [{'client_order_id': c, 'order_id': 'u-' + c, 'fill_count_fp': shown} for c in cids]
                + [{'client_order_id': 'by-hand', 'order_id': 'hand', 'fill_count_fp': '9.00'}]}

    async def fake_fills(signer, query, want=0.0, tries=4):
        asked.append(query)
        if isinstance(fills, Exception):
            raise fills
        return (fills or []) if query.startswith('order_id=u-') or query.startswith('order_id=o') else []

    old = kalshi.post, kalshi.signed_get, live.read_fills
    kalshi.post, kalshi.signed_get, live.read_fills = fake_post, fake_get, fake_fills

    def restore():
        kalshi.post, kalshi.signed_get, live.read_fills = old
    return sent, asked, restore


def quick(coro):
    async def go():
        real_sleep = asyncio.sleep
        asyncio.sleep = lambda s: real_sleep(0)
        try:
            return await coro()
        finally:
            asyncio.sleep = real_sleep
    return asyncio.run(go())


def run(bot, m, intent, post, fills=None, shown=None):
    sent, asked, restore = fake_kalshi(post, fills, shown)
    try:
        quick(lambda: bot.execute(m, intent, time.time()))
    finally:
        restore()
    return sent, asked


NO = Intent('no', 0.28, 4.0, 0.36, 0.06, 0.64, 400.0)


def test_a_filled_order_is_booked_from_kalshis_fills(tmp_path):
    bot, m = make(tmp_path)
    fills = [{'outcome_side': 'no', 'count_fp': '4.00', 'yes_price_dollars': '0.7300', 'no_price_dollars': '0.2700', 'fee_cost': '0.0552'}]
    sent, asked = run(bot, m, NO, {'order_id': 'o1', 'fill_count': '4.00', 'remaining_count': '0.00', 'average_fill_price': '0.7300', 'average_fee_paid': '0.0138'}, fills)
    assert len(sent) == 1 and sent[0][0] == '/portfolio/events/orders' and sent[0][1]['side'] == 'ask' and sent[0][1]['price'] == '0.7200' and sent[0][1]['count'] == '4.00'
    assert asked == ['order_id=o1']
    pos = bot.broker.positions['T']
    assert pos.side == 'no' and pos.contracts == 4.0 and math.isclose(pos.cost, 4 * 0.27 + 0.0552) and math.isclose(bot.broker.cash, 15 - pos.cost)
    assert bot.switch.armed and bot.pending is None and bot.cooldown['T'] == m.close      # still on; no second order this round
    assert math.isclose(bot.broker.settle('T', 'no', 1.0), 4 - pos.cost)


def test_switched_off_sends_nothing(tmp_path):
    bot, m = make(tmp_path, armed=False)
    bot.armed = True                                             # the cached flag is stale: the file is the authority
    sent, _ = run(bot, m, NO, {'order_id': 'x', 'fill_count': '4.00'})
    assert sent == [] and not bot.armed and not bot.broker.positions and bot.broker.cash == 15


def test_a_refused_order_buys_nothing_and_switches_off(tmp_path):
    bot, m = make(tmp_path)

    def refuse(body):
        raise kalshi.Refused(400, 'insufficient_balance')
    sent, asked = run(bot, m, NO, refuse)
    assert len(sent) == 1 and asked == [] and not bot.broker.positions and bot.broker.cash == 15
    assert not bot.switch.armed and 'insufficient_balance' in bot.switch.read()['note'] and bot.pending is None


def timeout(body):
    raise TimeoutError('timed out')


FILL_25 = [{'outcome_side': 'no', 'count_fp': '2.50', 'yes_price_dollars': '0.7200', 'no_price_dollars': '0.2800', 'fee_cost': '0.0353'}]


def test_an_unclear_answer_looks_the_order_up_books_it_and_switches_off(tmp_path):
    bot, m = make(tmp_path)
    sent, asked = run(bot, m, NO, timeout, FILL_25, shown='2.50')
    cid = sent[0][1]['client_order_id']
    assert len(sent) == 1 and asked == ['/portfolio/orders?ticker=T&limit=200', f'order_id=u-{cid}']   # sent once; only this order is read
    assert bot.broker.positions['T'].contracts == 2.5 and not bot.switch.armed and '2.5 contracts bought' in bot.switch.read()['note']
    assert bot.broker.pending_orders() == []
    bot2, m2 = make(tmp_path)
    run(bot2, m2, NO, timeout, RuntimeError('down'))
    assert not bot2.broker.positions and not bot2.switch.armed and 'Check Kalshi' in bot2.switch.read()['note']
    assert len(bot2.broker.pending_orders()) == 1                                           # kept: looked up again later


def test_an_unclear_order_kalshi_does_not_show_yet_is_booked_when_it_appears(tmp_path):
    bot, m = make(tmp_path)
    sent, _ = run(bot, m, NO, timeout, FILL_25, shown=None)
    assert not bot.broker.positions and 'keeps checking' in bot.switch.read()['note'] and len(bot.broker.pending_orders()) == 1
    assert bot.broker.traded('T')                                                           # no second order on the round meanwhile
    _, _, restore = fake_kalshi(fills=FILL_25, shown='2.50', extra_orders=[sent[0][1]['client_order_id']])
    try:
        quick(bot.resolve_pending)
        quick(bot.resolve_pending)                                                          # repeating it books nothing twice
    finally:
        restore()
    assert bot.broker.positions['T'].contracts == 2.5 and bot.broker.pending_orders() == []
    assert bot.broker.db.execute('SELECT COUNT(*) FROM fills').fetchone()[0] == 1


def test_an_order_kalshi_never_shows_is_reported_after_the_wait(tmp_path):
    bot, m = make(tmp_path)
    bot.broker.add_pending('lost', time.time() - 400, 'T', 'no', 0.28, 4.0)
    _, _, restore = fake_kalshi(shown=None)
    try:
        quick(bot.resolve_pending)
    finally:
        restore()
    assert bot.broker.pending_orders() == [] and not bot.broker.positions
    assert not bot.switch.armed and 'check Kalshi for a position' in bot.switch.read()['note']


def test_a_fill_left_unbooked_by_a_stop_is_booked_at_start_and_only_once(tmp_path):
    bot, m = make(tmp_path)
    bot.broker.add_pending('c1', time.time() - 5, 'T', 'no', 0.28, 4.0, q=0.36)             # sent, then the bot stopped
    _, asked, restore = fake_kalshi(fills=FILL_25, shown='2.50', extra_orders=['c1'])
    try:
        quick(bot.resolve_pending)
    finally:
        restore()
    assert bot.broker.positions['T'].contracts == 2.5 and 'order_id=hand' not in asked and bot.switch.armed
    assert bot.broker.pending_orders() == []
    bot.broker.add_pending('c2', time.time(), 'T', 'no', 0.28, 4.0)                          # booked already: dropped, not booked twice
    _, _, restore = fake_kalshi(fills=FILL_25, shown='2.50', extra_orders=['c2'])
    try:
        quick(bot.resolve_pending)
    finally:
        restore()
    assert bot.broker.db.execute('SELECT COUNT(*) FROM fills').fetchone()[0] == 1 and bot.broker.pending_orders() == []


def test_the_order_is_never_larger_than_the_real_balance(tmp_path):
    bot, m = make(tmp_path)
    bot.balance = 0.60                                                                      # the record says $15, the account has 60c
    sent, _ = run(bot, m, NO, {'order_id': 'o8', 'fill_count': '0.00'})
    n = float(sent[0][1]['count'])
    assert 0 < n < 4 and n * 0.28 + order_fee(0.28, n) <= 0.60 + 1e-9
    bot, m = make(tmp_path)
    bot.balance = 0.001
    sent, _ = run(bot, m, NO, {'order_id': 'o9', 'fill_count': '4.00'})
    assert sent == [] and bot.switch.armed and bot.stats['reasons'] == {'Kalshi balance cannot pay for this order': 1}
    assert bot.cooldown['T'] < m.close                                                      # the account may be topped up: tried again soon
    bot, m = make(tmp_path)
    bot.balance_at = time.time() - 120                                                      # no recent balance: no order
    sent, _ = run(bot, m, NO, {'order_id': 'o10', 'fill_count': '4.00'})
    assert sent == [] and bot.stats['reasons'] == {'Kalshi balance not known': 1}


def test_a_fill_comes_off_the_known_balance(tmp_path):
    bot, m = make(tmp_path)
    fills = [{'outcome_side': 'no', 'count_fp': '4.00', 'yes_price_dollars': '0.7300', 'no_price_dollars': '0.2700', 'fee_cost': '0.0552'}]
    run(bot, m, NO, {'order_id': 'o1', 'fill_count': '4.00'}, fills)
    assert math.isclose(bot.balance, 1000 - 4 * 0.27 - 0.0552) and bot.broker.pending_orders() == []


def test_nothing_filled_is_a_miss_and_stays_on(tmp_path):
    bot, m = make(tmp_path)
    sent, asked = run(bot, m, NO, {'order_id': 'o2', 'fill_count': '0.00', 'remaining_count': '0.00'})
    assert len(sent) == 1 and asked == [] and not bot.broker.positions and bot.broker.cash == 15 and bot.switch.armed
    assert bot.broker.db.execute('SELECT COUNT(*) FROM misses').fetchone()[0] == 1


def test_the_order_is_never_larger_than_the_ledgers_cash(tmp_path):
    bot, m = make(tmp_path, cash=0.60)
    sent, _ = run(bot, m, NO, {'order_id': 'o3', 'fill_count': '0.00'})
    n = float(sent[0][1]['count'])
    assert 0 < n < 4 and n * 0.28 + order_fee(0.28, n) <= 0.60 + 1e-9
    bot, m = make(tmp_path, cash=0.001)
    sent, _ = run(bot, m, NO, {'order_id': 'o4', 'fill_count': '0.00'})
    assert sent == [] and bot.switch.armed


def test_an_unexpected_error_switches_off(tmp_path):
    bot, m = make(tmp_path)
    sent, _ = run(bot, m, NO, {'order_id': 'o5', 'fill_count': 'abc'})
    assert len(sent) == 1 and not bot.switch.armed and bot.pending is None and bot.cooldown['T'] == m.close


def test_paper_mode_never_touches_the_order_path(tmp_path):
    bot, m = make(tmp_path)
    bot.live, bot.cfg = False, BotConfig(LATENCY_MS=0)
    sent, _ = run(bot, m, NO, {'order_id': 'o6', 'fill_count': '4.00'})
    assert sent == [] and bot.broker.positions['T'].contracts == 4.0                         # a paper fill against the book


def test_switching_off_holds_even_if_the_file_cannot_be_written(tmp_path):
    bot, m = make(tmp_path)

    def locked(note):
        raise PermissionError('file in use')
    bot.switch.off = locked                                      # e.g. the file held open by another program for a moment

    def refuse(body):
        raise kalshi.Refused(400, 'insufficient balance')
    sent, _ = run(bot, m, NO, refuse)
    assert len(sent) == 1 and bot.switch.read()['armed']         # the file still says on ...
    assert not bot.switched_on() and bot.pending is None         # ... but the bot keeps itself off
    m2 = Market({'ticker': 'U', 'open_time': '2020-01-01T00:00:00Z', 'close_time': '2099-01-01T00:00:00Z', 'floor_strike': 1})
    m2.book.snapshot([('0.72', '100')], [(0.24, '100')])
    sent, _ = run(bot, m2, NO, {'order_id': 'o7', 'fill_count': '4.00'})
    assert sent == []                                            # no order on the next round either
    bot.switch.path.write_text(arming(time=time.time() * 1000 + 1000))
    assert bot.switched_on()                                     # the owner switching it on again is what counts
