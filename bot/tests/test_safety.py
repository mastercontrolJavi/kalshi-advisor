"""The 2026-11-18 safety work: arming that ends and does not survive a restart, flat test sizing, the log file, order
timestamps, the kept-open Kalshi connection, Kalshi's clock, the tighter data guards and the start-up comparison with
Kalshi. Nothing here touches the network: Kalshi is a fake transport.  uv run --project bot pytest bot/tests"""
import asyncio
import json
import math
import sqlite3
import sys
import time
from email.utils import formatdate
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from bot import kalshi, live, runner  # noqa: E402
from bot.config import BotConfig  # noqa: E402
from bot.paper import PaperBroker  # noqa: E402
from bot.runner import Bot  # noqa: E402

from test_bot import _evaluate, _priced_bot  # noqa: E402
from test_live import FILL_25, NO, arming, fake_kalshi, make, quick, run  # noqa: E402

HOUR = 3600_000


# ---------- 1. arming ----------
def test_arming_needs_this_run_of_the_bot_and_an_end_time(tmp_path):
    s, now = live.Switch(tmp_path / 'bot-live.json'), 1_000_000.0
    write = lambda **d: s.path.write_text(json.dumps(d))
    assert s.why_off('b1', now, 4) == 'switched off'                                        # no file
    write(armed=True, by='user')
    assert s.armed and 'earlier run' in s.why_off('b1', now, 4)                             # the old file format: on, but for no run
    write(armed=True, boot_id='b0', expires_at=now + HOUR)
    assert 'earlier run' in s.why_off('b1', now, 4)                                         # armed before a restart
    assert 'earlier run' in s.why_off(None, now, 4)                                         # a bot with no boot id trusts nothing
    write(armed=True, boot_id='b1')
    assert 'without an end time' in s.why_off('b1', now, 4)
    write(armed=True, boot_id='b1', expires_at=True)
    assert 'without an end time' in s.why_off('b1', now, 4)
    write(armed=True, boot_id='b1', expires_at=now + HOUR)
    assert s.why_off('b1', now, 4) is None                                                  # good: this run, an hour left
    assert 'run out' in s.why_off('b1', now + HOUR, 4)                                      # ... and not a millisecond after
    write(armed=True, boot_id='b1', expires_at=now + 5 * HOUR)
    assert 'longer than the 4 hours' in s.why_off('b1', now, 4)                             # nobody arms for longer than the limit
    assert s.why_off('b1', now, 6) is None
    s.off('why')
    assert s.read() == {'armed': False, 'time': s.read()['time'], 'by': 'bot', 'note': 'why', 'expires_at': None, 'boot_id': None}


def test_a_restart_begins_switched_off(tmp_path):
    bot, m = make(tmp_path)                                      # armed for 'boot-1'
    assert bot.switched_on()
    bot.boot_id = 'boot-2'                                       # the bot crashed and came back: a new run
    assert not bot.switched_on()
    sent, _ = run(bot, m, NO, {'order_id': 'x', 'fill_count': '4.00'})
    assert sent == [] and not bot.broker.positions               # the stale arming buys nothing
    bot.boot_disarm()
    s = bot.switch.read()
    assert not s['armed'] and s['by'] == 'bot' and 'restarted' in s['note']                 # ... and the page is told why
    bot.switch.path.write_text(arming(boot_id='boot-2'))
    assert bot.switched_on()                                     # only a new switch-on for this run counts


def test_boot_leaves_the_owners_off_alone(tmp_path):
    bot, _ = make(tmp_path, armed=False)
    before = bot.switch.path.read_text()
    bot.boot_disarm()
    assert bot.switch.path.read_text() == before and bot.switch.read()['by'] == 'user'      # still off by the owner: no early sales either
    assert not bot.may_sell()


def test_an_arming_that_has_run_out_switches_itself_off(tmp_path):
    bot, m = make(tmp_path)
    bot.expire()
    assert bot.switch.armed and bot.switched_on()                # an hour left: nothing happens
    bot.switch.path.write_text(arming(hours=-0.001))
    assert not bot.switched_on()                                 # at once, before the file is rewritten
    sent, _ = run(bot, m, NO, {'order_id': 'x', 'fill_count': '4.00'})
    assert sent == []
    bot.expire()
    s = bot.switch.read()
    assert not s['armed'] and 'run out' in s['note'] and bot.tripped is None
    bot.switch.path.write_text(arming())
    assert bot.switched_on()                                     # running out is not a fault: a fresh switch-on is enough


def test_live_orders_are_one_flat_contract_by_default(tmp_path):
    assert BotConfig().MAX_CONTRACTS_PER_ROUND == 0.0 and BotConfig().ARM_MAX_HOURS == 10.0   # 2026-11-20: Kelly by default
    bot, m = make(tmp_path, MAX_CONTRACTS_PER_ROUND=1.0)         # the default; NO would be 4 contracts by the rule
    sent, _ = run(bot, m, NO, {'order_id': 'o1', 'fill_count': '0.00'})
    assert sent[0][1]['count'] == '1.00'
    small = NO.__class__('no', 0.28, 0.4, 0.36, 0.06, 0.64, 400.0)                         # flat, not a ceiling: 0.4 by the rule is 1 too
    bot, m = make(tmp_path, MAX_CONTRACTS_PER_ROUND=1.0)
    sent, _ = run(bot, m, small, {'order_id': 'o2', 'fill_count': '0.00'})
    assert sent[0][1]['count'] == '1.00'
    bot, m = make(tmp_path, cash=0.20, MAX_CONTRACTS_PER_ROUND=1.0)                         # ... still never more than the cash
    sent, _ = run(bot, m, NO, {'order_id': 'o3', 'fill_count': '0.00'})
    assert 0 < float(sent[0][1]['count']) < 1
    bot, m = make(tmp_path, MAX_CONTRACTS_PER_ROUND=2.5)
    sent, _ = run(bot, m, NO, {'order_id': 'o4', 'fill_count': '0.00'})
    assert sent[0][1]['count'] == '2.50'
    with pytest.raises(ValueError):
        BotConfig(MAX_CONTRACTS_PER_ROUND=-1)
    with pytest.raises(ValueError):
        BotConfig(ARM_MAX_HOURS=0)


# ---------- 2. log file and timestamps ----------
def test_every_log_line_goes_to_a_rotating_file(tmp_path, capsys):
    path = tmp_path / 'logs' / 'bot.log'
    runner.open_log(str(path), max_mb=0.0005, backups=2)          # 500 bytes a file
    try:
        runner.log('hello', n=1)
        assert json.loads(path.read_text(encoding='utf-8').splitlines()[0])['event'] == 'hello'
        for i in range(40):
            runner.log('filler', i=i, pad='x' * 60)
        files = sorted(p.name for p in path.parent.iterdir())
        assert files == ['bot.log', 'bot.log.1', 'bot.log.2']     # rotated, and never more than the backups asked for
    finally:
        runner.close_log()
    runner.log('after-close')                                     # no file any more: still prints, never raises
    assert 'after-close' in capsys.readouterr().out


def test_a_crash_leaves_its_traceback_in_the_file(tmp_path, monkeypatch):
    path = tmp_path / 'bot.log'
    monkeypatch.setenv('BOT_LOG_PATH', str(path))

    class Boom:
        def __init__(self, cfg):
            pass

        async def run(self):
            raise RuntimeError('the 05:53 crash')
    monkeypatch.setattr(runner, 'Bot', Boom)
    monkeypatch.setattr(sys, 'argv', ['bot', 'run'])
    from bot.__main__ import main
    with pytest.raises(RuntimeError):                             # the process still ends with an error code
        main()
    line = json.loads(path.read_text(encoding='utf-8').splitlines()[-1])
    assert line['event'] == 'crash' and line['where'] == 'main' and 'the 05:53 crash' in line['error']
    assert 'Traceback' in line['traceback'] and 'in run' in line['traceback']
    assert runner._file_log is None                               # closed again


def test_a_failed_background_task_is_logged(tmp_path):
    path = tmp_path / 'bot.log'
    runner.open_log(str(path))

    async def bad():
        raise ValueError('lost task')

    async def go():
        runner.spawn(bad(), 'execute')
        await asyncio.sleep(0)
        await asyncio.sleep(0)
    try:
        asyncio.run(go())
    finally:
        runner.close_log()
    line = json.loads(path.read_text(encoding='utf-8').splitlines()[-1])
    assert line['event'] == 'crash' and line['where'] == 'execute' and 'lost task' in line['traceback']


def attempts(bot):
    cols = [r[1] for r in bot.broker.db.execute('PRAGMA table_info(attempts)')]
    return [dict(zip(cols, r)) for r in bot.broker.db.execute('SELECT * FROM attempts ORDER BY id')]


def test_a_real_order_is_written_with_its_timestamps(tmp_path):
    bot, m = make(tmp_path)
    marks = {'spot_ts_ms': 1000.0, 'book_ts_ms': 1100.0, 'decision_ts_ms': 1200.0}
    fills = [{'outcome_side': 'no', 'count_fp': '4.00', 'yes_price_dollars': '0.7300', 'no_price_dollars': '0.2700', 'fee_cost': '0.0552'}]
    sent, _, restore = fake_kalshi({'order_id': 'o1', 'fill_count': '4.00'}, fills)
    before = time.time() * 1000
    try:
        quick(lambda: bot.execute(m, NO, 1.2, marks))
    finally:
        restore()
    (a,) = attempts(bot)
    assert (a['ticker'], a['kind'], a['side'], a['outcome'], a['filled'], a['wanted']) == ('T', 'buy', 'no', 'filled', 4.0, 4.0)
    assert (a['spot_ts_ms'], a['book_ts_ms'], a['decision_ts_ms']) == (1000.0, 1100.0, 1200.0)
    assert before <= a['order_send_ts_ms'] <= a['order_ack_ts_ms'] <= time.time() * 1000
    assert math.isclose(a['round_trip_ms'], a['order_ack_ts_ms'] - a['order_send_ts_ms']) and a['round_trip_ms'] >= 0
    assert a['cid'] == sent[0][1]['client_order_id'] and a['limit_price'] == 0.28 and a['edge'] == 0.06 and a['secs_left'] == 400.0
    # decision -> booked uses the answer's time, not the later read of the fills
    latency = bot.broker.db.execute('SELECT latency_ms FROM fills').fetchone()[0]
    assert math.isclose(latency, a['order_ack_ts_ms'] - 1200.0)


def test_every_outcome_of_an_order_is_written(tmp_path):
    def refuse(body):
        raise kalshi.Refused(400, 'insufficient_balance')

    def timeout(body):
        raise TimeoutError('timed out')
    cases = [({'order_id': 'o', 'fill_count': '0.00'}, None, 'missed'), (refuse, None, 'refused'), (timeout, FILL_25, 'unclear'),
             ({'order_id': 'o', 'fill_count': 'abc'}, None, 'error')]
    for post, fills, outcome in cases:
        bot, m = make(tmp_path)
        run(bot, m, NO, post, fills, shown='2.50' if fills else None)
        (a,) = attempts(bot)
        assert a['outcome'] == outcome and a['kind'] == 'buy', outcome
        assert a['order_send_ts_ms'] is not None and a['order_ack_ts_ms'] is not None and a['round_trip_ms'] is not None, outcome
    bot, m = make(tmp_path, armed=False)                          # decided, but never sent
    run(bot, m, NO, {'order_id': 'o', 'fill_count': '4.00'})
    (a,) = attempts(bot)
    assert a['outcome'] == 'not-sent' and a['order_send_ts_ms'] is None and a['round_trip_ms'] is None and 'switched off' in a['note']


def test_a_paper_fill_and_a_decision_carry_their_timestamps():
    bot, m = _priced_bot(0.3, 0.1)
    bot.cfg = bot.cfg.__class__(**{**bot.cfg.__dict__, 'LATENCY_MS': 0})
    m.book_ts_ms = 4242.0

    async def go():
        bot.evaluate(m)
        for _ in range(5):
            await asyncio.sleep(0)
    asyncio.run(go())
    (a,) = attempts(bot)
    assert a['kind'] == 'paper' and a['outcome'] == 'filled' and a['note'] == 'simulated' and a['book_ts_ms'] == 4242.0
    assert math.isclose(a['spot_ts_ms'], bot.pricer.fast[0] * 1000)                         # the 5 Hz value it priced on, by its own clock
    assert a['spot_ts_ms'] < a['decision_ts_ms'] <= a['order_ack_ts_ms'] and a['round_trip_ms'] >= 0
    assert bot.decision_marks is None and bot.pending is None


def test_a_sale_is_written_with_its_round_trip(tmp_path):
    from test_exit import book, make as make_held
    bot, m, pos, now = make_held(tmp_path)
    book(m, 0.13)
    sent, _, restore = fake_kalshi({'order_id': 's1', 'fill_count': '2.00'})
    try:
        quick(lambda: bot.execute_exit(m, pos, 'down to half its entry', 0.13, marks={'book_ts_ms': 7.0, 'decision_ts_ms': 8.0}))
    finally:
        restore()
    (a,) = attempts(bot)
    assert (a['kind'], a['side'], a['outcome'], a['filled'], a['book_ts_ms'], a['decision_ts_ms']) == ('sell', 'yes', 'filled', 2.0, 7.0, 8.0)
    assert a['round_trip_ms'] >= 0 and a['note'] == 'down to half its entry' and a['limit_price'] == 0.13


def test_an_older_ledger_gets_the_attempts_table(tmp_path):
    path = tmp_path / 'old.db'
    b = PaperBroker(str(path), 15.0, now=0)
    b.db.execute('DROP TABLE attempts')                           # a ledger written before this change
    b.db.commit()
    b.db.close()
    b = PaperBroker(str(path), 15.0)
    b.attempt('T', 'buy', 'yes', 'filled', order_send_ts_ms=10.0, order_ack_ts_ms=95.5, filled=1.0, unknown_key='ignored')
    assert b.db.execute('SELECT round_trip_ms, filled FROM attempts').fetchone() == (85.5, 1.0)
    b.reset(15.0)
    assert b.db.execute('SELECT COUNT(*) FROM attempts').fetchone()[0] == 0


# ---------- 3. connection, clock, guards, start-up comparison ----------
class FakeHost:
    """Kalshi behind an httpx mock transport: counts requests, answers from a list."""

    def __init__(self, *answers, date=None):
        self.requests, self.answers, self.date = [], list(answers), date

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        a = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(a, Exception):
            raise a
        status, body = a
        return httpx.Response(status, json=body, headers={'date': self.date} if self.date else {})


@pytest.fixture
def host(monkeypatch):
    def use(*answers, date=None):
        h = FakeHost(*answers, date=date)
        monkeypatch.setattr(kalshi, '_client', httpx.Client(transport=httpx.MockTransport(h)))
        monkeypatch.setattr(kalshi, 'clock', kalshi.Clock())
        return h
    yield use


class FakeSigner:
    def headers(self, path, method='GET', now_ms=None):
        return {'KALSHI-ACCESS-KEY': 'k', 'X-Signed': method + ' ' + path}


def test_every_request_uses_the_one_kept_open_client(host):
    h = host((200, {'ok': 1}))
    first = kalshi.client()
    assert kalshi._get('/markets?limit=1') == {'ok': 1}
    assert kalshi._signed(FakeSigner(), 'POST', '/portfolio/events/orders', {'ticker': 'T'}) == {'ok': 1}
    assert kalshi._signed(FakeSigner(), 'GET', '/portfolio/balance') == {'ok': 1}
    assert kalshi.client() is first and len(h.requests) == 3     # no new client (so no new handshake) per call
    get, post, _ = h.requests
    assert str(get.url) == kalshi.REST + '/markets?limit=1' and 'KALSHI-ACCESS-KEY' not in get.headers
    assert post.method == 'POST' and json.loads(post.content) == {'ticker': 'T'} and post.headers['content-type'] == 'application/json'
    assert post.headers['x-signed'] == 'POST /trade-api/v2/portfolio/events/orders'          # signed over the full path
    for bad in ('markets', 'https://evil.example/x', '/a://b'):
        with pytest.raises(ValueError):
            kalshi._get(bad)
        with pytest.raises(ValueError):
            kalshi._signed(FakeSigner(), 'POST', bad, {})
    assert len(h.requests) == 3


def test_the_real_client_keeps_connections_and_follows_no_redirect(monkeypatch):
    monkeypatch.setattr(kalshi, '_client', None)
    c = kalshi.client()
    try:
        assert kalshi.client() is c and not c.follow_redirects and c.timeout.connect == 5.0
        pool = c._transport._pool                                # httpx's connection pool: connections are kept, not closed per call
        assert pool._keepalive_expiry == kalshi.KEEPALIVE_S and pool._max_keepalive_connections >= 1 and pool._http2
    finally:
        kalshi.close()
    assert kalshi._client is None


def test_an_order_is_sent_once_whatever_the_answer(host):
    h = host((400, {'error': {'code': 'insufficient_balance', 'message': 'not enough'}}))
    with pytest.raises(kalshi.Refused) as e:
        kalshi._signed(FakeSigner(), 'POST', '/portfolio/events/orders', {})
    assert e.value.status == 400 and 'not enough' in str(e.value) and len(h.requests) == 1
    h = host((429, {}))
    with pytest.raises(kalshi.Refused) as e:                      # a signed request is never retried, even on a rate limit
        kalshi._signed(FakeSigner(), 'POST', '/portfolio/events/orders', {})
    assert e.value.status == 429 and len(h.requests) == 1
    h = host((503, {}))
    with pytest.raises(httpx.HTTPStatusError):                    # the server failed: the outcome is not known, and it is not resent
        kalshi._signed(FakeSigner(), 'POST', '/portfolio/events/orders', {})
    assert len(h.requests) == 1
    h = host(httpx.ReadTimeout('no answer'))
    with pytest.raises(httpx.ReadTimeout):                        # sent, no answer: unclear, not resent
        kalshi._signed(FakeSigner(), 'POST', '/portfolio/events/orders', {})
    assert len(h.requests) == 1
    h = host(httpx.ConnectError('no route'))
    with pytest.raises(kalshi.Refused) as e:                      # never connected: nothing was sent, and that is certain
        kalshi._signed(FakeSigner(), 'POST', '/portfolio/events/orders', {})
    assert e.value.status == 0 and 'not sent' in str(e.value) and len(h.requests) == 1


def test_a_public_read_waits_out_a_rate_limit(host, monkeypatch):
    monkeypatch.setattr(time, 'sleep', lambda s: None)
    h = host((429, {}), (429, {}), (200, {'markets': []}))
    assert kalshi._get('/markets') == {'markets': []} and len(h.requests) == 3
    h = host((500, {}))
    with pytest.raises(httpx.HTTPStatusError):
        kalshi._get('/markets')


def test_kalshis_clock_is_read_from_its_answers(host):
    ahead = formatdate(time.time() + 30, usegmt=True)             # Kalshi's clock half a minute ahead of this PC's
    host((200, {}), date=ahead)
    assert not kalshi.clock.synced and kalshi.clock.offset_ms == 0
    kalshi._get('/exchange/status')
    assert kalshi.clock.synced and 29_000 <= kalshi.clock.offset_ms <= 31_000                # second resolution, + half a second
    assert abs(kalshi.clock.now() - time.time() - kalshi.clock.offset_ms / 1000) < 0.01
    c = kalshi.Clock()
    date = lambda t: formatdate(t, usegmt=True)
    c.observe(date(1000), 999.0, 999.2)                           # server second 1000, asked around local 999.1
    assert math.isclose(c.offset_ms, 1_000_000 + 500 - 999_100)
    first = c.offset_ms
    c.observe(date(1001), 999.0, 999.2)                           # a second of header noise: kept, so the clock does not jitter
    assert c.offset_ms == first
    c.observe(date(1010), 999.0, 999.2)                           # a real jump (sleep/wake, a clock change): taken
    assert c.offset_ms == first + 10_000
    c.observe('not a date', 0, 0)
    c.observe(None, 0, 0)
    assert c.offset_ms == first + 10_000


def test_requests_are_signed_on_kalshis_clock(tmp_path, monkeypatch):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ed25519
    key = tmp_path / 'k.pem'
    key.write_bytes(ed25519.Ed25519PrivateKey.generate().private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    signer = kalshi.Signer('id', key)
    clock = kalshi.Clock()
    clock.offset_ms, clock.synced = 5000.0, True
    monkeypatch.setattr(kalshi, 'clock', clock)
    ts = int(signer.headers('/trade-api/v2/portfolio/balance')['KALSHI-ACCESS-TIMESTAMP'])
    assert 4900 <= ts - time.time() * 1000 <= 5100


def test_a_round_is_open_or_closed_by_kalshis_clock(monkeypatch):
    bot, m = _priced_bot(0.3, 0.1)                                # closes in 300 s by this PC's clock
    assert len(_evaluate(bot, m)) == 1
    bot, m = _priced_bot(0.3, 0.1)
    clock = kalshi.Clock()
    clock.offset_ms, clock.synced = 301_000.0, True               # ... but Kalshi's clock says it closed a second ago
    monkeypatch.setattr(kalshi, 'clock', clock)
    assert math.isclose(bot.now(), time.time() + 301, abs_tol=0.05)
    assert _evaluate(bot, m) == [] and bot.stats['reasons'] == {}


def test_the_data_guards_are_half_a_second(monkeypatch):
    cfg = BotConfig()
    assert cfg.MAX_BOOK_DELAY_MS == 500 and cfg.MAX_PRINT_AGE_MS == 500
    bot, m = _priced_bot(0.3, 0.1)
    bot.cfg = cfg.__class__(**{**bot.cfg.__dict__, 'MAX_BOOK_DELAY_MS': 500, 'MAX_PRINT_AGE_MS': 500})
    bot.delay.ms = 600.0                                          # passed the old 1500 ms guard
    assert _evaluate(bot, m) == [] and bot.stats['reasons'] == {'Kalshi stream running behind': 1}
    bot, m = _priced_bot(0.9, 0.7)                                # newest index value 700 ms old: fresh under the old guard
    bot.cfg = cfg.__class__(**{**bot.cfg.__dict__, 'MAX_BOOK_DELAY_MS': 500, 'MAX_PRINT_AGE_MS': 500})
    assert _evaluate(bot, m) == [] and bot.stats['reasons'] == {'BRTI value stale': 1}
    bot, m = _priced_bot(0.9, 0.7)
    bot.cfg = cfg.__class__(**{**bot.cfg.__dict__, 'MAX_PRINT_AGE_MS': 1500})               # still a setting (BOT_MAX_PRINT_AGE_MS)
    assert len(_evaluate(bot, m)) == 1
    from bot.config import load_config
    assert load_config({'BOT_MAX_BOOK_DELAY_MS': '250'}, dotenv=None).MAX_BOOK_DELAY_MS == 250
    with pytest.raises(ValueError):
        BotConfig(MAX_BOOK_DELAY_MS=0)


BUY = {'outcome_side': 'no', 'count_fp': '2.00', 'yes_price_dollars': '0.7500', 'no_price_dollars': '0.2500', 'fee_cost': '0.0263'}
SALE = {'outcome_side': 'yes', 'count_fp': '2.00', 'yes_price_dollars': '0.9000', 'no_price_dollars': '0.1000', 'fee_cost': '0.0126'}
ROW = {'ticker': 'T', 'side': 'no', 'contracts': 2.0, 'paid': 0.50, 'fee': 0.0263, 'exit_n': 0.0, 'exit_cash': 0.0}


def test_drift_is_what_kalshi_shows_minus_the_record():
    assert live.drift(ROW, [BUY]) is None                                                    # they agree
    assert live.drift({**ROW, 'exit_n': 2.0, 'exit_cash': 2 * 0.10 - 0.0126}, [BUY, SALE]) is None
    d = live.drift(ROW, [BUY, SALE])                                                         # a sale the record does not have
    assert d['ticker'] == 'T' and d['sold'] == 2.0 and math.isclose(d['sold_cash'], 0.1874) and d['contracts'] == 0
    d = live.drift(ROW, [BUY, BUY])                                                          # a second buy by hand on the same round
    assert d['contracts'] == 2.0 and math.isclose(d['paid'], 0.50)
    assert live.drift(ROW, [])['contracts'] == -2.0                                          # Kalshi has no trace of a recorded buy
    assert live.drift({**ROW, 'fee': 0.0263 + 0.004}, [BUY]) is None                         # under a cent: rounding, not drift


def audit(bot, fills_by_ticker):
    async def fake_fills(signer, query, want=0.0, tries=4):
        ticker = query.split('ticker=')[1].split('&')[0]
        got = fills_by_ticker[ticker]
        if isinstance(got, Exception):
            raise got
        return got
    old, live.read_fills = live.read_fills, fake_fills
    try:
        quick(bot.audit)
    finally:
        live.read_fills = old


def test_the_start_up_comparison_flags_differences_and_changes_nothing(tmp_path):
    bot, _ = make(tmp_path)
    bot.broker.record('A', 'no', 2.0, 0.50, 0.0263, 0.25, 2.0, 1.0)                           # matches Kalshi
    bot.broker.record('B', 'no', 2.0, 0.50, 0.0263, 0.25, 2.0, 2.0)                           # Kalshi shows twice as much bought
    bot.broker.record('C', 'no', 2.0, 0.50, 0.0263, 0.25, 2.0, 3.0)                           # Kalshi could not be read
    cash, positions = bot.broker.cash, dict(bot.broker.positions)
    bot.balance = cash + 2.0                                      # the account holds more than the budget: that is allowed
    audit(bot, {'A': [BUY], 'B': [BUY, BUY], 'C': RuntimeError('down')})
    assert [d['ticker'] for d in bot.drift] == ['B', 'C'] and bot.drift[0]['contracts'] == 2.0 and 'down' in bot.drift[1]['error']
    assert bot.broker.cash == cash and bot.broker.positions == positions and bot.audit_at is not None   # reported, not "fixed"
    bot.balance = cash - 1.0                                      # the account cannot cover the record's cash
    audit(bot, {'A': [BUY], 'B': [BUY], 'C': [BUY]})
    assert bot.drift == [{'ticker': None, 'balance_short': 1.0}]
    bot.balance = None
    audit(bot, {'A': [BUY], 'B': [BUY], 'C': [BUY]})
    assert 'could not be read' in bot.drift[0]['error']
    bot.balance, bot.cfg = cash, BotConfig(MODE='live', AUDIT_ROUNDS=1)
    audit(bot, {'C': [BUY]})                                      # only the latest AUDIT_ROUNDS rounds are asked for
    assert bot.drift == []
    bot.live = False
    bot.drift = ['untouched']
    quick(bot.audit)                                              # paper mode: nothing to compare
    assert bot.drift == ['untouched']


def test_the_status_file_carries_the_boot_id_and_the_drift(tmp_path):
    from bot.strategy import Pricer
    bot, _ = make(tmp_path)
    bot.pricer, bot.markets, bot.view, bot.connected, bot.started = Pricer(bot.cfg), {}, None, True, time.time()
    bot.last_value_ms, bot.status_path, bot.drift = 0.0, tmp_path / 'bot-status.json', [{'ticker': 'B', 'contracts': 2.0}]
    bot.write_status()
    s = json.loads(bot.status_path.read_text(encoding='utf-8'))
    assert s['bootId'] == 'boot-1' and s['armMaxHours'] == 10.0 and s['drift'] == [{'ticker': 'B', 'contracts': 2.0}] and s['mode'] == 'live'
    assert s['maxContracts'] == 0 and 'clockOffsetMs' in s


def test_no_arming_before_the_start_up_comparison_has_finished(tmp_path):
    bot, m = make(tmp_path)                                      # a valid arming for this run
    bot.broker.record('A', 'no', 2.0, 0.50, 0.0263, 0.25, 2.0, 1.0)
    bot.audit_pending = True                                     # as __init__ leaves a live bot
    assert not bot.switched_on()
    sent, _ = run(bot, m, NO, {'order_id': 'x', 'fill_count': '4.00'})
    assert sent == [] and 'T' not in bot.broker.positions        # an arming that slipped in early buys nothing
    bot.pricer, bot.markets, bot.view, bot.connected, bot.started = __import__('bot.strategy', fromlist=['Pricer']).Pricer(bot.cfg), {}, None, True, time.time()
    bot.last_value_ms, bot.status_path = 0.0, tmp_path / 'bot-status.json'
    bot.write_status()
    assert json.loads(bot.status_path.read_text(encoding='utf-8'))['auditPending'] is True      # the page is told, and refuses to arm
    bot.balance = bot.broker.cash
    audit(bot, {'A': [BUY]})
    assert not bot.audit_pending and bot.audit_at is not None and bot.drift == [] and bot.switched_on()
    bot.write_status()
    assert json.loads(bot.status_path.read_text(encoding='utf-8'))['auditPending'] is False


def test_a_comparison_that_fails_outright_is_reported_and_does_not_block_for_good(tmp_path):
    bot, _ = make(tmp_path)
    bot.audit_pending = True

    async def boom():
        raise RuntimeError('ledger unreadable')
    bot._audit = boom
    quick(bot.audit)
    assert not bot.audit_pending and 'ledger unreadable' in bot.drift[0]['error'] and bot.audit_at is not None
    paper, _ = make(tmp_path)
    paper.live, paper.audit_pending = False, True
    quick(paper.audit)
    assert not paper.audit_pending                               # paper mode has nothing to compare
