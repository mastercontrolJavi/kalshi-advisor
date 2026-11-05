# Edge layer (KXBTC15M)

A settlement-aware pricing, fee-aware gate, risk and scoring layer that sits **beside** the directional engine. It is
advisory and logs everything. It places no orders. Its one effect on real money is a **veto** in front of the existing
real-order path. DECISIONS 75 has the reasoning.

```
engine (Node, 3001) ──POST /tick once per second, 300 ms timeout, never awaited──▶ edge sidecar (Python, 127.0.0.1:3003)
      ◀────────────── decision JSON, cached on state.edge ─────────────────────────┘        └─ data/edge.db
settlements() ──POST /settle {ticker, result, expiration_value, proxy_avg}──▶ fills outcomes + proxy check
```

The port is **3003**, not 3002: the Markets process already listens on 3002. Change it with `EDGE_PORT`, which both
sides read.

## The directional engine is unchanged

The engine's stack, its live call (UP/DOWN with hysteresis and a confidence label) and its opening call are not
modified. They still show in the same places on the dashboard. The Edge layer panel also repeats the live call as
**Directional call**. The edge layer only reads the engine's numbers:

| field | meaning |
|---|---|
| `q` | the engine's blended forecast (about 90% Kalshi mid). Logged and scored, never used to build `p_engine`. |
| `q_raw` | the same stack with Kalshi's mid removed: `predict(forecast, {...inputs, mid: null})` in `src/engine/index.ts`. With `mid: null` the `kalshiShift` feature is 0, so this is the stack's own view before the market is blended in. No change to `stack.ts` was needed. |
| `p_math` | the existing `probability()` from `math.ts` (lognormal, the engine's σ). |
| `engine_call`, `engine_confidence` | the live call exactly as shown. |

**Adapter (probability → `drift_usd`).** The engine outputs a probability, not a dollar move. With base mean `m0`
(drift 0), sd and weight `w` (1 before the final minute, `r/(n+r)` inside it), the adapter is
`drift_usd = (target + sd·Φ⁻¹(q_raw) − m0) / w`. That makes `p_engine` exactly equal `q_raw` under this layer's σ.

Under the stack's current **prior** weights, `q_raw` equals `p_math`: the momentum and flow features carry no weight
until the stack's own refit adopts them. So `ENGINE: ADDS SIGNAL` is currently a test of the existing diffusion model
against the new `p_base`. It becomes a test of the full engine once the stack adopts fitted weights.

## Modules (`edge/`, Python 3.11+, standard library only)

| file | what it does |
|---|---|
| `config.py` | One typed `EdgeConfig`. Override any knob with `EDGE_<NAME>` in the environment or in `.env.local`. `ENGINE_VALIDATED` also works without the prefix. |
| `spot.py` | Exactly one price per second. A skipped second is carried forward and flagged `carried` (and degraded). Gaps over 10 s restart the series. The engine chooses the source: **BRTI** from Kalshi's CF Benchmarks feed when its 1-s print is fresh, otherwise the median of the Coinbase, Kraken and Bitstamp mids (plus the engine's learned proxy basis), flagged `degraded`. |
| `vol.py` | EWMA of 1-s log returns (half-life 300 s), floor 10% annualised, × `TAIL_MULT` 1.15. Carried seconds, gaps and source switches are not counted as returns. `sigma_usd(price)` is in dollars per √s. It needs 120 returns after a sidecar restart, so the first 2 minutes show `WARMING` and `NO_EDGE`. |
| `fair_value.py` | Your formulas. Before the final minute: `sd = σ√(secs_left − 40)`. Inside it: `(sum(fixed) + r(spot+drift))/(n+r)` and `sd = (r/(n+r))σ√(r/3)`. Normal CDF, clamped to [0.001, 0.999]. Ties resolve YES. Also contains `FinalWindowTracker` and the adapter. Official BRTI prints sent by the engine replace the sidecar's own prints for the same seconds. |
| `ev_gate.py` | `taker_fee = 0.07·p(1−p)`. Both sides are priced: `cost = ask + fee`, `edge = q − cost`. Below `MIN_EDGE` → NO_EDGE. An ask in 30–70¢ → BLOCKED. Size = min(quarter-Kelly, 1%) × bankroll / cost, floored. Under 1 contract → NO_EDGE. Recorded fees use Kalshi's whole-order rounding up to $0.0001 (`order_fee`). |
| `risk.py` | Blackouts: the US equity open 09:30–10:00 ET on weekdays, plus `edge/blackouts.json` (ET local times, maintained by hand). Then the daily stop (−3% of start-of-day bankroll), the weekly stop (−6%, weeks start Monday ET), one position per window, and 10 windows a day. |
| `db.py` | `data/edge.db`. `signals` stores one snapshot per window per minute-left bucket plus every TRADE. `windows` stores the proxy check: this layer's own 60-s average against Kalshi's settlement value and result. |
| `service.py` | The per-second pipeline. In shadow mode a TRADE is paper-filled at the **next** observed ask (the next tick) with the exact fee. A trade with no ask before close is marked `unfilled`. |
| `server.py`, `__main__.py` | `POST /tick`, `POST /settle`, `GET /health`, `GET /state`. Binds to loopback only. |
| `score.py` | The go/no-go CLI (below). |

**Decision JSON** (each `/tick` reply, cached as `state.edge`): `action side ask q edge contracts reason p_base p_engine
regime sigma status`, plus:
- `gate`: the pure EV-gate result, before the governor
- `risk`: the governor's view of this mode's book
- `real_risk`: the governor's view of your real Kalshi book
- `proxy_check`, `final_avg`/`final_n`, `degraded`, `unsettled`

**Missed settlements.** If the sidecar was down when a window settled, the reply lists that window as `unsettled`.
The engine then resends Kalshi's result from its own `outcomes` table, at most once every 30 s. Python never calls
Kalshi.

## The veto on real orders (`src/engine/edge-link.ts` → `realOrderVeto`)

It is checked twice: when the order is quoted and again when it is sent (`/real/quote`, `/real/order`).

- **KXBTC15M** needs all of the following:
  - the sidecar is online (a reply in the last 2 s)
  - a current decision for this market exists
  - `gate.action == TRADE` on **the same side**
  - the governor allows your **real** book (daily/weekly stop, one position per window, 10 windows, blackouts)

  If any one fails, the order is refused and the reason is shown and logged as `real-order-vetoed`.
- **Other markets** are checked only against the daily/weekly stop on your real P&L, using the last reply even when
  the sidecar is offline (up to 15 min old). If the sidecar is offline, these orders are not otherwise affected.
- **Real book:** the sum of `pnl` over your Kalshi fills and settlements per US Eastern day and Monday-start week.
  Start-of-day bankroll = current account value (cash + positions) minus today's P&L. Deposits and withdrawals during
  the day are not separated out.

The existing guardrails (`guardrails: false`, Oct 28) are untouched. This governor is separate.

## Config knobs (defaults)

`MIN_EDGE=0.01 BLOCK_MID_BAND=true (MID_BAND_LOW=0.30 MID_BAND_HIGH=0.70) KELLY_FRAC=0.25 MAX_RISK_FRAC=0.01
DAILY_STOP=-0.03 WEEKLY_STOP=-0.06 MAX_WINDOWS=10 EQUITY_OPEN_BLACKOUT=true VOL_HALFLIFE_S=300 VOL_FLOOR_ANN=0.10
VOL_MIN_SAMPLES=120 TAIL_MULT=1.15 ENGINE_VALIDATED=false MODE=shadow BANKROLL=<Kalshi account value>
PROXY_MIN_AGREE=0.95 PROXY_MIN_WINDOWS=10 PORT=3003 DB_PATH=data/edge.db`

- `MODE=shadow` records paper fills and runs the governor on the paper book.
- `MODE=live` records decisions only and runs the governor on your real book.
- `ENGINE_VALIDATED=true` switches the gate from `p_base` to `p_engine`. Set it by hand, and only after the scorer
  prints `ENGINE: ADDS SIGNAL`.
- With a small account the 1% cap can't buy one contract, so shadow mode will show `NO_EDGE (size < 1 contract)`.
  To collect paper fills, set `EDGE_BANKROLL=1000` (or any notional amount) in `.env.local`. It affects shadow sizing
  only.

## The PASS gate (`python -m edge.score`)

- Brier scores for `market_mid`, `p_base`, `p_math`, `q`, `q_raw` and `p_engine`, overall and by minutes left (0–1,
  1–3, 3–7, 7–15).
- Directional accuracy of the live call against the outcome, and against "always pick the side the market favours".
- For TRADE fills: net P&L per contract (win = 1 − price − fee, loss = −price − fee), SE, 90% lower bound,
  first-half and second-half means, max drawdown.
- **`PASS`** only if all of these hold: ≥ 300 fills, net ≥ +1.0¢ per contract, LB90 > 0, and both halves positive.
  Otherwise **`FAIL`**.
- **`ENGINE: ADDS SIGNAL`** only if the Brier of `q_raw` is below `p_base` on ≥ 500 settled windows. Otherwise
  `NOT PROVEN`. The blended `q` is reported but never used for this verdict, because it is mostly Kalshi's own price.
- Proxy check: the share of windows where this layer's 60-s average lands on the same side of the target as Kalshi's
  result, plus the mean and max |average − Kalshi value|. Only windows with at least 55 of 60 prints count. The banner
  turns on below 95% over the last 50 windows (once there are at least 10).

## Run

```bash
npm run launch                                   # everything, edge sidecar included (supervised, restarts logged)
python -m edge                                   # the sidecar alone (from the repo root)
python -m edge.score                             # the scorer (--db path to point elsewhere)
python -m unittest discover -s edge/tests -t .   # Python tests
npx vitest run tests/edge-link.test.ts           # TS adapter / veto tests
curl http://127.0.0.1:3003/health
```

`npm run launch` now also runs the Python tests before starting. A failing test blocks startup, as vitest does. Set
`EDGE_PYTHON` if `python` is not the right interpreter.
