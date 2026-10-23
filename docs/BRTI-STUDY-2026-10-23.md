# Official BRTI historical challenger study

Generated 2026-10-23T07:48:14.913Z; cutoff 2026-10-23T07:20:00.000Z. 3692/6639 paired checkpoints across 209 requested UTC hours.

Reproduce with `npm run benchmark:study`; cached rerun: `npm run benchmark:study -- --skip-fetch`. The production journal is read-only; reference history lives in `data/benchmark-history.db`. These retrospective source-level results do not enable trading.

| Time left | Paired rounds | BRTI Brier | Proxy Brier | Market Brier | BRTI gain vs proxy · 95% | BRTI gain vs market · 95% |
|---|---:|---:|---:|---:|---|---|
| Opening | 629 | 0.2449 | 0.2459 | 0.2441 | -0.0012 to 0.0035 | -0.0027 to 0.0011 |
| 600s | 650 | 0.1877 | 0.1877 | 0.1822 | -0.0025 to 0.0026 | -0.0087 to -0.0027 |
| 300s | 653 | 0.1371 | 0.1403 | 0.1333 | 0.0002 to 0.0063 | -0.0075 to -0.0000 |
| 120s | 627 | 0.0893 | 0.0914 | 0.0821 | -0.0016 to 0.0061 | -0.0138 to -0.0009 |
| 60s | 417 | 0.0567 | 0.0555 | 0.0502 | -0.0097 to 0.0074 | -0.0129 to -0.0010 |
| 50s | 234 | 0.0604 | 0.0659 | 0.0580 | -0.0033 to 0.0139 | -0.0093 to 0.0048 |
| 40s | 177 | 0.0488 | 0.0495 | 0.0471 | -0.0111 to 0.0141 | -0.0110 to 0.0079 |
| 30s | 156 | 0.0397 | 0.0547 | 0.0391 | -0.0045 to 0.0394 | -0.0128 to 0.0156 |
| 20s | 97 | 0.0256 | 0.0603 | 0.0362 | 0.0048 to 0.0773 | -0.0101 to 0.0379 |
| 10s | 52 | 0.0084 | 0.1002 | 0.0260 | 0.0159 to 0.1800 | -0.0015 to 0.0482 |

Positive gain favours BRTI; lower Brier is better. A better model forecast still needs to exceed the executable ask plus fees to support a trade.

- Historical data fetched after the outcome may differ from what was available live. Explicit amendments excluded; unknown historical latency/revisions cannot be excluded.
- One-second artificial publication delay; no actual live fills, book depth or latency replay.
- No tuning or promotion: exact discrete Brownian model and volatility settings fixed before this replay.
- Each horizon has at most one checkpoint per market. Hour-block 95% intervals; multiple horizon comparisons remain exploratory.
- One-hour trailing volatility includes only source observations before the decision. Missing recent seconds pause the forecast.

Sources: [Kalshi BRTI feed](https://docs.kalshi.com/websockets/cfbenchmarks-value), [history passthrough](https://docs.kalshi.com/cfbenchmarks/rest-passthrough).
