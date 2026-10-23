# Quantitative engine changes · October 23, 2026

## What changed

The main logistic learner previously used modulo-market folds, allowing later outcomes into the training set used to assess earlier predictions. It now uses four expanding chronological blocks. Outcomes must be observed before each test block with a further 60-second embargo. The optimizer starts from its prior in each fold. Multiple snapshots share a total likelihood weight of one per market.

The learned candidate must beat the default blend and the usable market baseline by at least 0.002 Brier, with positive paired 95% hour-block bootstrap lower bounds, non-worse log loss, at least 60 held-out markets and 20 hour blocks, positive gains in at least three blocks including the latest two. These are conservative promotion requirements, not a claim of statistical certainty under unlimited repeated testing. Prospective evaluation remains necessary. The current dataset keeps the default blend active.

The late-round learner now preserves the exact midpoint input including intentional missingness. Legacy reconstruction respects recorded book validity, stale age, and transport delay; a fresh REST backup is assessed using its own delay. New ticks save the complete stack inputs and local evaluation timestamp for reproducible research. Old records are not rewritten.

## Official index and the settlement formula

An independent read-only socket subscribes to `cfbenchmarks_value` and `cfbenchmarks_value_5hz` for BRTI. A live account probe received 12 one-second and 59 five-Hz updates in approximately 12 seconds. REST historical access was also verified using existing credentials. No API order method is involved.

The shadow forecast uses only complete official one-second observations, a two-minute contiguous warm-up, trailing EWMA/realized volatility, and a minute-scale variance-ratio estimate shrunk toward one. The proxy model's empirical variance-ratio prior remains 1.5. Its active formula is preserved to avoid claiming a new sigma rule has proven itself.

For observed settlement values `L`, remaining times `t_i` measured from the latest observed index price `S`, per-square-root-second volatility `sigma`, and 60 equal weights:

```text
E[A]   = (sum(L) + N*S) / 60
Var[A] = (S*sigma)^2 / 60^2 * sum_i sum_j min(t_i, t_j)
P(YES) ≈ Phi((E[A] - K) / sqrt(Var[A]))
```

The double sum preserves shared-path covariance. The documented final-minute window is `(close−60 seconds, close]`; it includes 60 one-second observations, including the close endpoint. The five-Hz feed improves visibility of index movement but does not supply extra settlement slots. Missing past index observations are never filled with proxy prices or fabricated future values. The zero-drift arithmetic Brownian assumption remains a model assumption; jumps, regime changes, residual publication delays and the contract's cent rounding are not eliminated by exact covariance.

The legacy probability function also accepts an optional dollar standard deviation for proxy-to-settlement residuals, adding its squared value to diffusion variance. It defaults to zero and has not been enabled from a full-sample estimate. Such uncertainty must be estimated with prior outcomes and independently evaluated.

## Why the screenshot does not justify adding two option trees

Cox–Ross–Rubinstein and Leisen–Reimer are option valuation and convergence methods under assumed dynamics. They are useful numerical methods, but their names do not supply a physical directional signal. A vanilla terminal-price tree also misses this contract's arithmetic-average payoff unless adapted to path dependence. Under the current Gaussian approximation, the conditional average covariance above is available directly; extra trees would add numerical approximation without new predictive information.

The screenshot's more consequential idea was the actual reference feed. That is now connected and its forecasts are being recorded independently. Historical replay covered 209 hours and 6,639 candidate checkpoints; the report discloses every horizon, missing inputs and uncertainty. Historical index values were fetched after settlement, so replay cannot prove contemporaneous delivery or executable profit.

## Verification

Unit tests cover the full covariance matrix, endpoint schedules, subsecond future offsets, final-second uncertainty, malformed values, channel separation, stale/future/out-of-order ticks, clock offsets, missing official seconds, immutable forecast capture, retrospective capture rejection, and paired scoring. Learning tests check settlement embargoes, future-label isolation, repeated-snapshot weighting and rejection when the candidate fails to beat the market. Full test suite, TypeScript and a production Next.js build passed during this change. Live verification checks that official values are recorded and the new fields reach the dashboard.

## Primary references

- [Kalshi crypto settlement explanation](https://help.kalshi.com/en/articles/13823838-crypto-markets).
- [Official one-second feed and exact averaging windows](https://docs.kalshi.com/websockets/cfbenchmarks-value).
- [Official five-Hz feed](https://docs.kalshi.com/websockets/cfbenchmarks-value-5hz).
- [Authenticated historical passthrough](https://docs.kalshi.com/cfbenchmarks/rest-passthrough).
- [CF Benchmarks historical-value revision caveat](https://docs.cfbenchmarks.com/api/rest/values/).
- [Cox, Ross and Rubinstein, original option-pricing paper](https://bpb-us-w2.wpmucdn.com/u.osu.edu/dist/7/36891/files/2017/07/CRR79-1yy8av8.pdf).
- [Leisen's convergence-analysis paper and discussion of Leisen–Reimer](https://www.wiwi.uni-bonn.de/bgsepapers/old%20series/bonsfb/bonsfb366.pdf).
