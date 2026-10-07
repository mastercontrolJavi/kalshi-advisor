# Kalshi Bitcoin 15-minute advisor

Local, read-only research and trading discipline dashboard for KXBTC15M. It does not send orders. No hosting or paid feed is required. A median of four public spot venues approximates BRTI; it is not the official index. Fair value is an uncalibrated diffusion estimate. The journal is designed to measure whether that estimate has an edge.

## Setup

Requires Node.js 22.12+ (tested with 24), npm, and a Kalshi API key (Ed25519 or RSA PEM saved under keys/). Windows needs network access for the better-sqlite3 prebuilt binary; if unavailable, npm needs local C++ build tools.

```powershell
npm install
# If .env.local does not exist, copy .env.example to .env.local.
# Put the private PEM under keys/ and enter the key ID and path in .env.local.
# Set DASHBOARD_USER and a strong DASHBOARD_PASSWORD.
npm run check
npm run dev:all
# Or for the tested production launcher:
npm run trade
```

Open http://localhost:3000 and use the credentials from .env.local. Engine binds 127.0.0.1:3001; dashboard binds 127.0.0.1:3000. Basic auth is enforced before every HTTP request and WebSocket upgrade. Use the custom launcher, not `next start`, which bypasses that wrapper. Do not forward raw HTTP outside this computer; [phone setup](docs/PHONE.md) uses Tailscale HTTPS.

`.env.example` contains all environment variables. Credentials are server-only and requests carrying signatures go exclusively to fixed official Kalshi hosts; redirects fail. Public venue connections receive no credentials. v1 refuses `ENABLE_EXECUTOR=true`. `Executor` defines the future integration boundary, but this version has no API write method. keys/, .env.local and SQLite files are Git-ignored.

`npm run trade` runs tests, TypeScript validation and the production build, requests an OS wake lock, then supervises engine and web. Crashes restart with bounded backoff. Ctrl+C stops it. Startup failures stop launch. Logs are in logs/ and the events table. Do not run trade and dev:all simultaneously on the same ports.

## Architecture

```text
Coinbase / Kraken / Bitstamp / Gemini public WS
                  | quote age filter → median → 1s history
Kalshi read-only REST + signed WS → local sequenced orderbooks
                  |
     tsx engine → volatility → average moments → fair probability
                  |           → fee-aware taker/maker → guardrails
                  +→ SQLite journal / paper fills / outcomes / calibration
                  |
              authenticated loopback WS (3001)
                  |
       authenticated custom Next.js server (3000)
                  |
      desktop browser / Tailscale HTTPS → phone
```

Files: `src/engine/feeds/` owns reconnecting sockets, quote median, signing, REST, and books. `model/` holds pure volatility, conditional-average math and fee functions. `signals.ts` holds gates and Kelly sizing; `guardrails.ts` holds discipline; `account.ts` ingests real records; `journal.ts` owns SQLite; `calibration.ts` computes metrics. `src/app/` contains App Router pages; `src/components/` contains charts, settings and shadcn-style primitives. `scripts/web.ts` authenticates and bridges WS; `scripts/trade.mjs` supervises; `tests/` contains pure and journal tests. [Verified API notes](docs/kalshi-notes.md) and [decisions](DECISIONS.md) explain current protocol differences and assumptions.

## Reading the dashboard

- The engine evaluates and pushes state 4× per second on live quotes; ticks and signals are journaled once per second. Kalshi and exchange feeds are push WebSockets, so on-screen data is typically under ~300 ms old plus browser render time.
- Countdown is seconds to contractual close, corrected against Kalshi server Date. At close it rolls automatically. Opening **K ✓** comes from floor_strike; **estimated** means a complete proxy opening-minute average. Missing K blocks the model.
- Proxy is the median of live venues. A venue is live while its WebSocket answers within 2 s (pinged every second) and its last quote is under 15 s old — venues push quotes only when prices change, so a quiet quote on a live link is valid. A green dot means a connected venue with a fresh quote. Quote age and transport lag are different; lag is unavailable when a source has no exchange timestamp.
- Distance is current proxy minus K in dollars. Sigma units are standardized expected-average distance in log space. Sigma is volatility per square-root-second, not annual volatility. The regime percentile compares recent rolling estimates and begins with limited history.
- Model UP is the probability the closing average clears K, clipped 1–99%. It blends EWMA and one-hour return variance. Warm-up requires 120 contiguous one-second returns. In the final minute, observed proxy seconds contribute to the conditional average; missing seconds suppress it. The locked counter is proxy coverage, not confirmed BRTI.
- Net YES/NO edge subtracts the ask and one-contract taker fee from the corresponding probability. BUY appears only after all configured gates pass. The reason explains a failed gate or the model/ask/fee comparison.
- Suggested contracts use quarter Kelly, capped at 2% of cash balance and 25 contracts. Spend and maximum loss include the fee rounded on the whole proposed order. No authenticated balance means zero sized suggestions and no taker entries. Existing position exposure is shown in the account data but the v1 size cap is per trade, not a full portfolio risk optimizer.
- **Your positions · hold or sell** values each open KXBTC15M position (Kalshi `position_fp`: positive = YES, negative = NO) two ways: *hold* = contracts × model P(your side wins), settling at $1 with no exit fee; *sell now* = contracts × your side's best bid − taker fee. It says SELL NOW only when selling beats holding by at least `exitMargin` (default 2¢/contract), otherwise HOLD, and suggests a resting sell at fair value + maker margin as a middle path. Positions in markets without a ready model show NO MODEL. It maximizes expected value under an uncalibrated model; it cannot guarantee the most profitable exit.
- **Sound alerts** (speaker icon in the header; full panel under *Sound alerts*): distinct synthesized sounds for BUY YES / BUY NO, SELL NOW on your position (repeats every 15 s while it lasts), HOLD (new position or back from sell), win / loss (realized P&L today rises / falls), live-call flips, new window, entry window (5:00 left), final minute, data unreliable / connection lost (max once per 30 s) and guardrail lock. Per-category toggles, volume and Test buttons; saved per browser. Browsers require one click on the page before audio can play.
- **Desktop shortcut**: `npm run shortcut` creates *Kalshi Advisor* on the desktop. It starts the app in a minimized window (close it to stop) if it is not already running or starting, waits for it, then opens Chrome at http://localhost:3000.
- **Quant engine** (`src/engine/quant/`): the forecast used for calls, signals and hold/sell is a Bayesian logistic blend of the diffusion model, the Kalshi midpoint and momentum/flow features: `logit q = b + a·logit(model) + c·(logit(Kalshi) − logit(model)) + Σβ·features`. With no evidence it is an equal logit-average of model and market with zero feature weight; it is refit after every settled window and the learned weights are adopted only when they beat the default blend out of sample (leave-one-market-out) with ≥ 30 markets. Turn *Use quant forecast for signals* off to trade on the raw model. The proxy→BRTI basis (proxy ran ≈ $3 below the official average) is learned automatically from settlements (*Auto basis*).
- **Next window** previews the following 15-minute window. Its opening price K is this window's settlement average, so during the final minute the head start `S_close − A` becomes partly known; before that the preview is ≈ 50% plus learned momentum effects. Snapshots at 1:00 and 0:10 before it opens are scored.
- **Scalp & dip** (priced after fees): *scalp* = buy a side the market sells well below fair value and rest a sell at a target halfway to fair (≥ 2¢ above entry), with a bail level; *dip* = a side's ask fell ≥ 8¢ in a minute while fair value did not (overreaction → buy, target the half retrace) versus a drop the model agrees with (*falling knife*). Every setup is paper-traded: target fill if the bid reached it before close, otherwise held to settlement.
- **Analytics page** (`/analytics`): real Kalshi P&L per market — totals, today / 7 / 30 days, win rate, money won vs lost, profit factor, average per market, drawdown, fees, streaks, cumulative curve, daily bars, rolling 10-market trends, breakdowns by side / entry price / time of day / advisor idea vs own call / held vs sold, full trade history and plain-English takeaways. Balance snapshots accumulate for an equity curve.
- **Paper-only signals**: with *Show signals below 1 contract* on (default), BUY fires whenever the market checks pass even if your risk budget rounds to 0 contracts. It is labelled *paper only*, the Size check turns blue (informational) instead of amber, and the signal is still logged as a 1-contract paper trade so the taker evidence on the Calibration page accumulates regardless of account size.
- **Timing** shows a clock (*waiting*, with a countdown) before the entry window and during the final minute: that is the schedule, not a fault, and it is not counted as a failing check.
- **Trade checks** list every gate behind BUY / NO TRADE (market, feeds, book, K, model, account, guardrails, edge, timing, spread, depth, size) with the observed value; failing ones are amber. A test guarantees the checklist agrees with the decision.
- **Live call** re-runs the opening-call formula on current data ~3×/s. Direction only flips once P(up) clears 50% by 2 points, so it does not flicker; *held* and *flips* show its stability. It pauses when data is unreliable (model warming, fewer than 2 live price feeds, or estimated K) and shows a DEGRADED badge for softer issues (a feed down, Kalshi REST fallback, stale book, clock unsynced). Snapshots at 10:00, 5:00, 2:00 and 1:00 left are journaled (`live_calls`) and scored per horizon on the Calibration page; late horizons naturally look accurate because the outcome is mostly decided, so compare them with the Kalshi column, not the coin flip.
- **Opening call** is one UP/DOWN forecast per window, made in the window's first minute and then frozen. It starts from Model UP at the open (≈50%, since spot ≈ K) and adds a lean of at most ±10 points from BTC's 30-s and 2-min move (in σ units), top-3 Kalshi book imbalance, and 30-s Kalshi trade flow. The lean weights are an untested hypothesis. The call never feeds BUY signals. "On track / Behind now" compares live proxy to K. If the engine was not running in a window's first minute, that window has no call.
- Maker limit is fair probability minus margin, rounded down to a legal tick and below the ask. Queue ahead includes orders at the limit and better prices. The conditional edge does not account for uncalibrated adverse selection or guarantee a fill.
- The chart compares model UP with the YES midpoint. Book ladders show YES and NO bids; each opposite bid implies an ask at 1−bid. Depth can be fractional. REST fallback is explicitly labeled.
- Session P&L is realized net dollars from KXBTC15M account records, with actual fees. Trades count distinct fill order IDs. Win rate and streak use realized closing orders (partial fills grouped by order) and residual market settlements. Canonical directional fills net complementary positions; missing actual fees or unsupported records suppress account readiness. Guardrails suppress advice, not trades placed manually elsewhere.
- Daily lock persists through restarts until the next America/Los_Angeles day unless the typed override is logged. Initial-day balance is the first observed cash balance and is labeled in the event journal; exact historical midnight cash cannot be reconstructed reliably from trading records alone (deposits/transfers). Subsequent days capture the balance when first observed after midnight.
- Enable browser audio with a click, then toggle audio/notifications in Settings. Every numeric threshold and model parameter is editable and persisted. Dollars rather than cents are used in settings, so 0.04 means 4¢.

## The proof engine

SQLite WAL database: ./data/advisor.db. ticks record every active-market second, including missing inputs and the reason in context; signals deduplicate market/style/side/price; paper_trades use one contract; outcomes store official results and proxy average; real_trades retain normalized fills and settlements. account_raw and events retain reconciliation/audit evidence. Only ticks are pruned after 30 days; other data is retained forever.

Paper takers enter at observed ask plus fee. Maker simulations fill only on an opposite aggressor trade strictly through the resting price, with one contract deducted from observed volume per simulated fill. Quotes touching a limit do not count. They expire at close and settle on an official result. Public REST fallback cannot observe all trade-throughs; it will undercount maker fills. Simulations ignore exchange queue cancellations and partial execution dynamics.

Calibration uses one paired tick nearest 180s remaining (±30s) per settled market for reliability/Brier. Lower Brier is better; model minus market below zero indicates better paired forecasts in this sample. Profit curves use realized paper/real outcomes. Realized EV per filled signal has a 95% market-cluster bootstrap CI (2,000 resamples), unavailable below two independent markets. Predicted EV is the original model edge. Time, regime and edge breakdowns distinguish styles. Basis error is proxy closing average minus official numeric expiration value; it stays missing if either input is absent. Opening calls are scored separately: hit rate with a Wilson 95% CI, and Brier against a coin flip (0.25), the same call without the lean ("model only"), and the Kalshi mid at the moment of the call. Export all six tables (the five required plus opening_calls) from the calibration page.

## Verification

`npm run check` validates fees at 1/50/99¢, probability symmetry, final-minute average weights, Kelly caps, guardrail triggers, signed paths, book gaps, paper fills, pruning, auth and calibration independence. Live verification is recorded in docs/VERIFICATION.md. Authentication and account/tier checks require your credentials; Tailscale phone delivery requires your tailnet login. No profitability claim follows from a small sample.
