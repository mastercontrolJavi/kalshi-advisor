# bot/ — trading bot for KXBTC15M

A Python program (asyncio + websockets) that trades Kalshi's 15-minute BTC market. By default it trades **on paper**:
it starts with $15, the first goal is $100, and it keeps its own ledger in `data/bot.db`. With `BOT_MODE=live` and the
switch on the Bot page on, the same rule places real orders ("Real money" below); nothing else in this folder can.

```powershell
npm run bot            # run it (also started by the desktop shortcut / npm run launch; BOT=off in .env.local skips it)
npm run bot:status     # bankroll, record, last ten trades (the dashboard's Bot page shows the same, live)
npm run bot:backtest   # replay on the recorded journal -> output/bot-backtest.md
npm run bot:test
uv run --project bot python -m bot reset   # back to $15 (stop the bot first)
```

It needs [uv](https://docs.astral.sh/uv/) and the same Kalshi API key the advisor uses (`.env.local`); Kalshi's
streams only accept signed connections. In paper mode the key is used to connect, never to trade.

## What it does

One signed websocket carries the order book of the current round and the BRTI index (the 1 Hz prints Kalshi settles
on, and the 5 Hz value). On every index value and every book change it:

1. prices the round with `edge/fair_value.py` (probability that the last-minute BRTI average finishes at or above the
   strike, with the measured variance of BRTI);
2. compares that with each side's ask after the taker fee (`0.07 x P x (1 - P)` a contract);
3. buys the better side if the edge is at least 3c, the ask is 1-30c or 70-97c, and 2-10 minutes are left (tickets
   under 10c since 2026-11-19, the owner's request: `MIN_ASK` 0.01, was 0.10; the replay and its limits are in
   `config.py`);
4. sizes it at `KELLY_FRAC` of Kelly (0.75), at most `MAX_RISK_FRAC` (15%) of the bankroll, in hundredths of a
   contract (Kalshi fills fractions). Real orders ignore this and are a flat 1 contract (`MAX_CONTRACTS_PER_ROUND`);
5. holds to settlement. One buy a round. There are no exits on paper, and since 2026-11-19 none in live mode either:
   the two rules that sold a losing or reversing position early are switched off (below).

The paper order is immediate-or-cancel at the ask the bot decided on, filled against the book as it stands
`LATENCY_MS` (300 ms) later. If the ask has moved away it is recorded as a miss and nothing is bought.

Every setting is in `config.py`; `BOT_<NAME>` in `.env.local` overrides one.

## What to expect

The project's studies found no forecast that beats Kalshi's price and no gain from resting orders. What is left is
speed: the model's disagreement with the price is worth something for about a second after an index value arrives.
That is out of reach by hand and is the one thing a program can test.

Replay of the recorded journal (`npm run bot:backtest`, 616 rounds, 2026-10-23 to 11-11):

| fill | net per contract | 95% range | $15 became |
|---|---:|---:|---:|
| same second | +2.2c | -1.3..+5.6c | $31 |
| 1 s later | +1.6c | -1.8..+5.1c | $18 |
| 2 s later | +1.7c | -1.7..+5.1c | $14 |

None of these is distinguishable from zero, and the time window and price bands were chosen on most of the same
rounds, which flatters them. If the same-second result were the truth, $15 would reach $100 within 30 days about
about five times in six and go bust about one time in fourteen; if the truth is zero edge, the account drifts down by the
fee. Judge the live paper record at 300+ settled rounds, by cents per contract and its range in `bot:status`, not by
the bankroll.

Paper fills are kinder than real ones in one way that cannot be simulated: a real order competes with other programs
for the same quote. The miss rate hints at it but does not measure it.

## Files

| File | What it does |
|---|---|
| `config.py` | Every setting, with the evidence behind each rule |
| `strategy.py` | `Pricer` (BRTI -> probability) and `decide()` (rules and sizing). No I/O; shared by live and replay |
| `book.py` | Order book from Kalshi's snapshots and deltas; stream-delay measure |
| `paper.py` | Paper account in SQLite: fills, fees, settlement, summary |
| `kalshi.py` | Request signing, one kept-open HTTP connection for every REST call, Kalshi's clock |
| `live.py` | The real-money switch, Kalshi's order format, reading fills back, the record-vs-Kalshi comparison |
| `runner.py` | The live loop: websocket, market rollover, guards, paper and real execution, the log file |
| `backtest.py` | Replay through the same strategy and account code, and the goal projection |

## Real money (`BOT_MODE=live`, 2026-11-17)

Added at the owner's request after the paper record (319 rounds: no clear edge, -0.6c a contract weighted by contracts).
The same rule and sizing, with real Kalshi orders.

- **Two locks.** `BOT_MODE=live` in `.env.local` puts the bot in real-money mode, where it only watches. It orders only
  while the switch on the Bot page is on (`data/bot-live.json`, written by the page's button and nothing else). The bot
  reads the file again right before every order, so off is immediate.
- **Switching on ends by itself** (2026-11-18). It is good for one run of the bot and for `ARM_MAX_HOURS` (4) at most:
  the file carries the bot's `boot_id` (a new one at every start) and `expires_at` (UTC ms), and the bot refuses an
  arming without both. Every start, a restart after a crash included, begins switched off, and an arming that has run
  out is written off with the reason.
- **Real orders are a flat `MAX_CONTRACTS_PER_ROUND` contracts** (1), cut to what the cash can pay, instead of the Kelly
  size: the paper record shows no edge, so real money only tests the plumbing. `0` goes back to the rule's size.
- **Budget.** It spends from its own record, `data/bot-live.db`, which starts at `LIVE_BUDGET` ($15) and grows only by
  its own wins. An order is cut to what that cash can pay, fee included, and never more than the account's real cash
  (`GET /portfolio/balance`, read every 10 s; with no reading in the last minute it does not order). The rest of the
  Kalshi balance is never counted.
- **The order** (`live.py`, Kalshi Create Order V2, `POST /portfolio/events/orders`): immediate-or-cancel at the ask it
  decided on. An order is sent once and never resent. One buy a round: an order that fills nothing (the price moved
  first) is a miss, and like the paper bot it may try again a second later, as a new order at the new ask and only if the
  edge still holds there. YES is a bid at the YES price; NO is an ask at 1 - the NO price. The record is written from
  Kalshi's own fills for that order.
- **Every order is written down before it is sent** (the `pending` table, with its client order id) and crossed off once
  its answer is booked. An order with no clear answer, or one the bot stopped before booking, is looked up on Kalshi by
  that id every 10 s and at start, and what it bought is booked. Only that order is read, so a trade by hand on the same
  round is never taken for the bot's. One Kalshi does not show after 5 minutes is reported on the Bot page.
- **It switches itself off** after any refused order, any order with no clear answer, any fill dearer than the order
  allowed, and any unexpected error. The reason is shown on the Bot page. Only the owner switches it back on. While
  switched off by the bot it buys nothing but still sells a position early by the rules below (a sale can only reduce
  what is held); switched off by the owner, it does neither.
- **Voided rounds** return what is still held at its cost (Kalshi: "all positions returned at original cost"). A round
  counts as voided when its result is `void`, or it is `finalized` with neither yes nor no and no settlement value. A
  fractional settlement value (a scalar settlement) is left open and logged for the owner. Checked 2026-11-17: every one
  of 6,480 settled BTC15 markets read `finalized` with `yes` or `no`, so this path has never run for real.
- **Checked against the real API (read-only, 2026-11-17):** `GET /portfolio/orders?ticker=` lists the bot's orders with
  the `client_order_id` it sent (hand orders have it empty), `order_id` and `fill_count_fp`, including canceled ones
  that filled nothing; `GET /portfolio/balance` gives `balance` in cents.
- **Not tested against the exchange.** The tests use a fake Kalshi (`tests/test_live.py`); nothing was sent during the
  build. The first order with the switch on is the live test.

### Selling before settlement (live mode, 2026-11-17)

The owner asked for it after closing three real rounds by hand: "instead of always letting it go to zero, get some
money back".

- **Losing:** the bid for the side held stays at or under half the entry price for 15 s, with 2+ minutes left.
- **Reversing:** the bid has been 10c or more above the entry and stays at or under 60% of its highest for 15 s, with
  1+ minute left.
- Either one sells everything held at the bid: immediate-or-cancel and `reduce_only`, so it can only close the position.
  Three attempts a round at most. A failed sale does not switch real trading off (it cannot spend money).
- **What the replay says** (minute candles; the bot's 302 entries and 5,312 cheap-side entries from every recorded
  round): both rules together average the same as holding (-3.8c vs -3.9c a contract; +1.3c vs +0.8c on the bot's
  cheap entries) with smaller swings (27c vs 37c). Selling at a fixed gain cost about 2c a contract, so there is none.
  The exits trim the swings; they do not create an edge.
- **Both rules are off since 2026-11-19 (owner's choice; `EXIT_BELOW` = 0 and `EXIT_BACK` = 0).** In the first 73 real
  trades the bot's own 34 sales booked -$14.64 where the same positions held to settlement were -$0.39 (95% of the
  difference: +$2.30..+$28.92; the side sold went on to win 10 of 34 times, sold at 13.5c on average). A replay on the
  journal's one-second books (883 entries of the rule, 2026-10-14 to 11-18) put selling at -1.35c a contract against
  holding (95% -3.10..+0.30): 54% of positions were sold, each paying a second fee and crossing the spread, and the
  swing fell from 40c to 32c. The loss rule alone was -0.86c, the reversal rule alone -0.81c. The minute-candle replay
  above could not see a 15-second rule. To switch them back on: `BOT_EXIT_BELOW=0.5` and `BOT_EXIT_BACK=0.6` in
  `.env.local`.
- **The record follows Kalshi.** Every 10 s, and at start for the last day, the bot reads the account's fills for the
  rounds it holds and books whatever was sold, by itself or by the owner by hand (`PaperBroker.exits`, totals not
  additions, so it is safe to repeat; a sale found after settlement restates the round). Only fills after the bot's own
  buy count (`live.sold`, 2026-11-19): Kalshi reports a purchase of the other side exactly like a sale, and a hand
  purchase made before the bot bought had been booked as a sale of the bot's position (KXBTC15M-26NOV192315-15). A
  hand purchase of the other side after the bot's buy is still booked as a sale: on the account it is one. Trading the
  same round by hand therefore still shows up in the comparison at start; the bot's record is cleanest when it has
  the round to itself.

### Feature switches on the Bot page (2026-11-19)

The owner asked for buttons. The Bot page's **Features** card has three, each with one line on what the record shows:

| switch | what it sets | default |
|---|---|---|
| Buy tickets under 10c | `MIN_ASK` 0.01 (on) / 0.10 (off) | on |
| Sell losers early | `EXIT_BELOW` 0.5 and `EXIT_BACK` 0.6 (on) / both 0 (off) | off |
| Scalp cheap tickets | `SCALP_AT` 5 (on) / 0 (off): a ticket bought under 10c is sold at once when its bid reaches 5x the price paid, down to 5 s left | off |

A press writes `data/bot-features.json` (`POST /api/bot/features`, same origin and JSON only); the bot reads it every
10 s and lays it over the settings it started with (`bot/features.py`), so nothing is restarted. A switch that is not
in the file leaves `config.py` / `.env.local` as they are, and a file that cannot be read keeps what is running. The
switches never turn real trading on and never change the size. The last two sell, and the bot sells only in real-money
mode, so they are not shown for the paper account.

## Safety, log and timing (2026-11-18)

- **Log file.** Every line the bot prints also goes to `logs/bot.log` (`LOG_PATH`), rotated at `LOG_MAX_MB` (5) with
  `LOG_BACKUPS` (5) older files kept. A crash writes a `crash` line with its traceback before the process ends, and a
  failed background task does the same, so an exit code 1 is never without a reason again.
- **Timestamps.** Every decision that reaches the order path is one row in the `attempts` table of the ledger
  (`bot.db` / `bot-live.db`): `spot_ts_ms` (the BRTI value's own time), `book_ts_ms` (Kalshi's send time of the last
  book message), `decision_ts_ms`, `order_send_ts_ms`, `order_ack_ts_ms`, `round_trip_ms`, the outcome (`filled`,
  `missed`, `refused`, `unclear`, `not-sent`, `error`) and `clock_offset_ms`. The last three timestamps are this PC's
  clock; add `clock_offset_ms` to put them on Kalshi's. Paper fills are rows too (`kind = 'paper'`, simulated).
- **One kept-open connection.** REST calls go through one `httpx` client (HTTP/2; Kalshi's host offers it), so an order
  does not open a new TLS connection. Measured 2026-11-18 on a public read: 1,000 ms for the first request, 67 ms on
  the open connection. An order is still sent once and never retried. A request that could not connect at all counts
  as refused (nothing was sent).
- **Kalshi's clock.** Read from the `Date` header of every REST answer, as the engine does (1-second resolution, so it
  can be ~0.5 s off). Rounds open and close, and requests are signed, by that clock. This PC was 1.9 s behind it when
  measured.
- **Data guards.** No decision on a book more than `MAX_BOOK_DELAY_MS` (500, was 1,500) behind Kalshi's own send times,
  or on a BRTI value older than `MAX_PRINT_AGE_MS` (500, was 1,500). If the 5 Hz index channel stops, the bot can decide
  only in the half second after each 1 Hz print.
- **Record against Kalshi.** At start in live mode the latest `AUDIT_ROUNDS` (50) recorded rounds are compared with
  Kalshi's fills (contracts and dollars bought and sold) and the record's cash with the account's. Differences are
  logged (`ledger-drift`) and shown on the Bot page; nothing is changed automatically. It runs beside the stream at one
  read a second (up to about a minute), and real trading cannot be switched on until it has finished: the bot refuses
  to order and the Bot page refuses to arm while `auditPending` is true.
