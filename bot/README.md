# bot/ — paper-trading bot for KXBTC15M

A Python program (asyncio + websockets) that trades Kalshi's 15-minute BTC market **on paper**. It starts with $15 and
the first goal is $100. There is no order-placing code in this folder: it reads Kalshi's streams and keeps its own
ledger in `data/bot.db`.

```powershell
npm run bot            # run it (also started by the desktop shortcut / npm run launch; BOT=off in .env.local skips it)
npm run bot:status     # bankroll, record, last ten trades (the dashboard's Bot page shows the same, live)
npm run bot:backtest   # replay on the recorded journal -> output/bot-backtest.md
npm run bot:test
uv run --project bot python -m bot reset   # back to $15 (stop the bot first)
```

It needs [uv](https://docs.astral.sh/uv/) and the same Kalshi API key the advisor uses (`.env.local`); Kalshi's
streams only accept signed connections. The key is used to connect, never to trade.

## What it does

One signed websocket carries the order book of the current round and the BRTI index (the 1 Hz prints Kalshi settles
on, and the 5 Hz value). On every index value and every book change it:

1. prices the round with `edge/fair_value.py` (probability that the last-minute BRTI average finishes at or above the
   strike, with the measured variance of BRTI);
2. compares that with each side's ask after the taker fee (`0.07 x P x (1 - P)` a contract);
3. buys the better side if the edge is at least 3c, the ask is 10-30c or 70-97c, and 2-10 minutes are left;
4. sizes it at half Kelly, at most 10% of the bankroll, in hundredths of a contract (Kalshi fills fractions);
5. holds to settlement. One buy a round, no exits (every exit rule tested in this project lost to holding).

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
| `kalshi.py` | Request signing and public REST reads |
| `runner.py` | The live loop: websocket, market rollover, guards, paper execution |
| `backtest.py` | Replay through the same strategy and account code, and the goal projection |

## Real money (`BOT_MODE=live`, 2026-11-17)

Added at the owner's request after the paper record (319 rounds: no clear edge, -0.6c a contract weighted by contracts).
The same rule and sizing, with real Kalshi orders.

- **Two locks.** `BOT_MODE=live` in `.env.local` puts the bot in real-money mode, where it only watches. It orders only
  while the switch on the Bot page is on (`data/bot-live.json`, written by the page's button and nothing else). The bot
  reads the file again right before every order, so off is immediate.
- **Budget.** It spends from its own record, `data/bot-live.db`, which starts at `LIVE_BUDGET` ($15) and grows only by
  its own wins. An order is cut to what that cash can pay, fee included. The rest of the Kalshi balance is never counted.
- **The order** (`live.py`, Kalshi Create Order V2, `POST /portfolio/events/orders`): immediate-or-cancel at the ask it
  decided on, one a round, sent once and never retried. YES is a bid at the YES price; NO is an ask at 1 - the NO price.
  The record is written from Kalshi's own fills for that order.
- **It switches itself off** after any refused order, any order with no clear answer (it then reads the account's fills
  for that round and books what it finds), any fill dearer than the order allowed, and any unexpected error. The reason
  is shown on the Bot page. Only the owner switches it back on.
- **Not tested against the exchange.** The tests use a fake Kalshi (`tests/test_live.py`); nothing was sent during the
  build. The first order with the switch on is the live test.
