# Short-term Bitcoin price forecast

Implemented October 12, 2026. Targets: exchange proxy price strictly higher than the observation price 30, 60 or 180 seconds later. These are price forecasts, distinct from whether Kalshi's closing average clears its strike.

## Features and estimation

Require all 301 one-second prices in the preceding five minutes, with no interpolation or forward filling, and at least three currently healthy exchange feeds. Feature extraction only sees times up to the forecast observation. Candle body and wick pressure use the most recent fully closed, clock-aligned 15-second candle; other features measure 30-second and 2-minute momentum, position within the recent range, range expansion and momentum change.

For each horizon, ridge regression predicts future log return normalized by past volatility and the square root of that horizon. The model estimates residual uncertainty and converts the predicted normalized return into a Gaussian direction probability, clipped to 5–95%. The chart shows the implied expected price and a nominal 80% conditional log-price envelope. Distribution assumptions are approximations; empirical range coverage is shown rather than assuming the nominal range is calibrated.

Calibration (2026-10-12): the envelope width is the empirical 80th percentile of absolute training residuals divided by 1.2816, not the RMS residual. Rare price jumps inflated the RMS (1.95–2.50 normalized units against 1.26–1.61 for the percentile), so the first live day's band held 91–92% of later-data outcomes and 87–92% of live outcomes instead of 80%. With the percentile scale, later-data coverage on the same journal was 77–78% at 30 s, 1 m and 3 m, and the shaded range is about 35% narrower. Direction probabilities still use the RMS scale, so Brier scores and the activation gate are unchanged. On that data no horizon passed the gate (later-data Brier 0.2473, 0.2490 and 0.2502 against 0.250), so the display correctly stays UNCLEAR.

The projection is drawn with separate line series and a shaded canvas primitive. It never enters historical OHLC, training samples or journal observations. Future points match the selected candle interval where possible, so changing the horizon changes the visible projection length. Bitcoin projections are hidden on the Kalshi YES chart; the forecast panel remains clearly identified as Bitcoin.

## Validation and activation

The read-only worker uses at most the last 100,000 stored ticks within seven calendar days. Targets must have exact endpoint prices and occur on fixed, non-overlapping checkpoints within each horizon. The first half trains the first of three chronological expanding-window tests. Training labels are purged for three minutes before every test block. Only outcomes already available at fit time are eligible.

Directional activation requires all of:

- At least 300 training observations spanning six hours, and 120 non-flat later-data outcomes.
- Three completed test blocks, improvements in at least two, and improvement in the last block.
- A Brier improvement of at least 0.005 over the 50–50 baseline.
- A positive lower bound of a 95% bootstrap range for that improvement, resampling whole 15-minute blocks (at least 20 blocks).
- Observed frequencies within 12 percentage points of predicted probabilities in bins with at least 30 observations.

Until these pass, the displayed forecast uses zero directional drift: UNCLEAR and 50% up. A validated fit still abstains between 42% and 58%. Fits expire after 30 minutes without a refresh. No settings or entry/exit rules are modified by this feature, and no trading profit or guaranteed prediction is claimed.

The worker fits every five minutes and updates the live score summary every 30 seconds. Fitting and score aggregation run off the live quote thread. A crashed worker can restart on the next refresh; a hung request is replaced after one minute. Last fits persist in settings, subject to their expiry.

## Forward record

`price_forecasts` stores fixed observations before their outcomes: time, horizon, exact deadline, price, probability, direction, range, model activation, and original context. The `(time,horizon)` key is immutable: later estimates cannot overwrite it. Predictions are recorded at 30/60/180-second boundaries and can span market rollovers.

Outcomes require a healthy feed and an actual sample at the original deadline. There is a two-second grace for processing, not for substituting a different price. Missing deadlines, unhealthy endpoints, and observations missed during restarts are excluded and counted explicitly. Unchanged prices are flat; they contribute to range coverage but not directional accuracy or Brier. UNCLEAR forecasts are evaluated for probability error but never credited as correct directional calls.

The UI distinguishes candidate chronological scores from newly collected forward results. Export: `/api/engine/export/price_forecasts`. Summaries use the latest 2,000 records per horizon. Detailed journal rows persist independently of the summary window.

## Verification

Automated tests cover causal features, closed-candle inputs, missing prices, exact future targets, chronological purging, positive and negative controls, grouped confidence bounds, future-label exclusion, expiry, forecast range endpoints and timeframe spacing, immutable journaling, CSV export, abstentions, flat outcomes, unhealthy feeds and late restarts.

Initial read-only test on the recorded journal found approximately 2,510 / 1,256 / 415 training observations at 30 / 60 / 180 seconds. Candidate later-data Brier scores were approximately 0.2474 / 0.2498 / 0.2520 against 0.250 for a coin flip. None met the activation requirements. These are a point-in-time check; ongoing refits use the rolling dataset and can differ.

### Full flow checked on the running app

Story: loading the price chart and selecting a horizon renders `state.shortTerm` over the authenticated WebSocket; the engine captures fixed forecast checkpoints in SQLite, resolves exact deadline prices, and the worker returns measured results to the UI.

| Boundary | Status | Evidence |
| --- | --- | --- |
| UI renders | Passed | Production chart showed three horizon buttons, nominal range and a shaded future envelope. Desktop 1440×1000 and phone 390×844 inspected; phone had no document overflow and the plot remained on the first screen. |
| Client receives engine state | Passed | API and WebSocket state supplied three 50–50/UNCLEAR forecasts, chronological validation results and live score counts. Input warm-up was explicit and cleared after five uninterrupted minutes. |
| Engine persists predictions | Passed | Read-only SQLite query found immutable fixed checkpoints and pending outcomes at all three horizons. |
| Deadline resolves to actual data | Passed | First observed 180-second checkpoint was recorded at 17:06 PDT and scored at its exact 17:09 PDT deadline on October 12. At the final check there were 10 / 5 / 1 scored records for 30 / 60 / 180 seconds, each with the original target timestamp; no missing or flat outcomes at that snapshot. |
| Results return to UI | Passed | Measured results showed candidate Brier, range coverage and the separately accumulated live records. It credited no clear direction wins while the forecast was UNCLEAR. Summary updates trail SQLite by up to 30 seconds. |
| Controls and chart distinction | Passed | 30-second, 1-minute and 3-minute selection, score disclosure, Bitcoin/Kalshi switching, Latest, and responsive layout checked. The Kalshi chart explicitly retained Bitcoin-only forecast labeling. |
| Export and build | Passed | CSV endpoint returned HTTP 200 with forecast fields. All 283 tests, TypeScript checks, and the production build passed. No browser errors on the verified production page. |

The web process was rebuilt and restarted while the engine and markets collectors continued running. Final API check showed a live market, four healthy venues, solid data quality and an approximately 11 ms engine loop. Screenshots are saved locally under `output/price-forecast/`.

The forecast uses an exchange proxy, not official BRTI. Probability accuracy and interval coverage do not establish a profitable trading strategy; spread, fees, execution and the settlement target are separate questions. Repeated refitting can select transient relationships despite the evidence gates, so live forward results remain important.
