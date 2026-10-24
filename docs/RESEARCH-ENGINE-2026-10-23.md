# BTC research engine: order flow, final-minute calibration and execution

This extension runs alongside the existing advisor. Its new probabilities, order-flow features and simulated fills do not send orders or change the production entry, exit or sizing rules.

## What is being predicted?

The target is the contract's official settlement comparison: whether the final-minute BRTI average exceeds the opening threshold under the market's rules. A rising spot price, a rising YES quote, and a profitable purchase are three different quantities. A purchase also needs a sufficiently favorable executable price after costs.

Money flow may contain short-term directional information. Volatility describes uncertainty around the settlement average and changes how much confidence is appropriate. News can change both the expected path and uncertainty, but a news signal requires evidence of when it was actually available. These are candidate explanatory inputs, not independent votes that are automatically added to the forecast.

## Public order flow

`src/engine/feeds/microstructure.ts` opens an independent public Coinbase BTC-USD connection for `level2_batch`, `matches` and `heartbeat`.

- Stores source timestamps separately from local receive timestamps, plus session and ordinal. Initial snapshots have no source time; the code waits for a timestamped update instead of inventing one.
- Maintains absolute L2 sizes, spread, top-ten depth imbalance, microprice and a 30-second best-quote order-flow imbalance (OFI).
- Inverts Coinbase's **maker** side to obtain the aggressor's side, producing aggressive buy/sell volume and imbalance.
- Requires an uninterrupted 30-second window before reporting rolling flow. Duplicate trades, missing trade IDs, heartbeat gaps, source delays, reconnects and bounded-memory overflow invalidate the appropriate features.
- OFI is measured once per atomic 50-millisecond batch. It does not recover events hidden within the batch. A size decrease cannot be identified as a cancellation rather than an execution from L2 alone.
- No account identifiers, order IDs or authentication are needed for this feed. It represents Coinbase activity, not all global BTC capital flows, ETF flows or derivatives positioning.

For bid/ask prices `b,a` and sizes `qb,qa`, microprice is `(a*qb+b*qa)/(qb+qa)`. Depth imbalance is `(bidDepth-askDepth)/(bidDepth+askDepth)`. OFI uses the changes in displayed best bid/ask prices and quantities. Whether any of these adds information beyond Kalshi must be tested on later observations.

## Small final-minute calibration model

`src/engine/quant/benchmark-calibration.ts` learns a four-parameter ridge logistic correction around market odds. It uses BRTI-versus-market disagreement, market confidence, and disagreement interacted with remaining time and volatility. Parameters start at zero; each market receives equal total weight. Volatility normalization is estimated from training data only.

Only immutable 60/30/10-second BRTI checkpoints are eligible. Outcomes must have been observed at least 60 seconds before fitting. Four expanding chronological folds independently refit coefficients and normalization. At least 30 earlier markets are needed to produce a raw candidate. Supported shadow evidence additionally requires 60 later paired markets, 20 hourly blocks, positive block confidence bounds, stable Brier improvements over BRTI, market and current quant, and no log-loss regression. These are research requirements, not proof under unlimited repeated testing.

Raw candidate predictions and the market fallback are distinct fields. A missing/unfitted candidate stays missing. Neither becomes the production forecast. Calibration refits and execution reports run in the existing worker rather than on the live quote loop.

## Frozen execution protocol

`research_forecasts` freezes the decision-time probabilities, fee schedule, selected book, clock offset, calibration metadata and order-flow features. `research_books` records the top 20 levels once per second, and approximately four times per second in the final minute, using the local capture clock. The recorded `bookUpdated` and transport delay remain separate from capture time. Invalid book observations remain in the record so replay cannot silently skip an outage.

`npm run execution:study` reads the journal without migrations or writes to it, and produces `output/EXECUTION-STUDY.json` and `.md`. `--db` and `--through` select a database and fixed evaluation cutoff. The same calculation appears automatically on Calibration when frozen forecasts or settlements change.

The versioned protocol fixes the first qualifying 60/30/10-second decision per market and method, minimum after-fee edge of 4 cents, maximum spread of 6 cents, and caps of five contracts/$5. Methods are BRTI, market, current quant and the raw calibrated candidate. The submitted limit includes the captured fee schedule and is frozen before future depth or outcomes are examined.

Scenarios use 250/1,000/3,000 milliseconds of assumed delay, plus a 1,000-millisecond scenario with one cent of additional cost per contract. Each uses the first captured book after arrival, within a bounded wait. Invalid, stale, delayed or absent books are excluded; later favorable snapshots cannot rescue them. Replay consumes recorded depth, allows partial IOC fills and rounds fees per assumed one-contract fill. Stress costs reduce proceeds on otherwise valid fills; they cannot retroactively erase a fill because its edge deteriorated.

The reports disclose exclusions, pending exposure, same-decision execution comparisons, fee totals, descriptive hourly bootstrap intervals after at least 20 blocks, and drawdown across settled markets in decision order. Different models select different opportunities; their total P&L is not a paired probability comparison. Displayed liquidity is not a guaranteed fill, aggregated levels hide individual order fragmentation, and this does not model maker queue position, intratrade drawdown or full portfolio allocation.

## Recording and retention

Public events are queued with count and byte limits and written in batches. Overflow is recorded explicitly. A recorder exception is isolated from production evaluation. Raw public events retain 3 days, one-second flow features 30 days and execution depth 14 days. Frozen forecasts and gap records are retained. Existing `.gitignore` rules exclude databases, logs and output reports from Git.

## News and other next experiments

News is **not integrated as a live predictor in this version**. The next useful news experiment is a timestamped catalyst dataset, starting with official scheduled releases and distinguishing scheduled time, original publication time, local arrival time and later revisions. Candidate features could include proximity to a known release and the subsequent change in volatility or order flow. An LLM may classify text, but a retrospective summary of already-known events must never be treated as a historical live signal. Funding, open interest and liquidations are separate derivatives datasets, not substitutes for the spot flow recorded here.

## Sources

- [Coinbase WebSocket channels](https://docs.cdp.coinbase.com/exchange/websocket-feed/channels): L2 batch semantics, matches, maker side and heartbeat trade IDs.
- [Kalshi order-book updates](https://docs.kalshi.com/websockets/orderbook-updates): snapshots, deltas and sequencing.
- [Kalshi order-book responses](https://docs.kalshi.com/getting_started/orderbook_responses): bid ladders and complementary asks.
- [Kalshi official BRTI feed](https://docs.kalshi.com/websockets/cfbenchmarks-value): reference-index observations and final-minute averaging.
- [Cont, Kukanov and Stoikov: The Price Impact of Order Book Events](https://arxiv.org/abs/1011.6402): motivation for testing OFI. Its stock-market results do not establish a BTC trading edge.
- [Federal Reserve meeting calendar](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm) and [BLS release calendar](https://www.bls.gov/schedule/news_release/): primary-source candidates for a future scheduled-event dataset.
