# Baseline calibration

Generated 2026-11-02T06:20:58.131Z. Reproduce with `npm run calibrate`. Read-only; nothing here changes advice or orders.

## BTC volatility

Official BRTI, 1 s, 2026-10-07 → 2026-10-23 (751,200 s, 819 quarter-hours):

| Per second | 15 min (measured) | 15 min (√t from 1 s) | Variance ratio | 15 min in $ | Annualized |
|---:|---:|---:|---:|---:|---:|
| 0.468 bp | 15.2 bp | 14.0 bp | 1.18 | $126 | 26.3% |

Engine's live per-second σ (median of its EWMA estimate): 0.378 bp (p10 0.180, p90 0.771).

Settled KXBTC15M rounds 2026-07-10 → 2026-11-01 (10,878; YES 50.0%). Move = settlement average − target:

| | sd | p50 | p90 | p99 |
|---|---:|---:|---:|---:|
| Move, $ | 134.6 | -0.2 | 131.3 | 380.6 |
| |Move|, $ | — | 54.2 | 196.8 | 468.3 |
| Move, bp | 17.6 | -0.0 | 17.3 | 50.7 |

Rounds settling within: $5 6% · $10 12% · $25 28% · $50 47% · $100 72%.

By month (sd of move, bp): 2026-07 16.0 (2081) · 2026-08 18.6 (2937) · 2026-09 18.6 (2847) · 2026-10 16.8 (2936) · 2026-11 7.7 (77).

15-min BTC sd by hour (America/Los_Angeles, 1-min BTC, bp): 0h 14.6 · 1h 22.6 · 2h 17.1 · 3h 11.7 · 4h 14.2 · 5h 22.4 · 6h 26.2 · 7h 28.5 · 8h 26.9 · 9h 17.7 · 10h 16.8 · 11h 17.1 · 12h 13.3 · 13h 15.1 · 14h 13.2 · 15h 15.2 · 16h 13.5 · 17h 17.3 · 18h 19.6 · 19h 17.2 · 20h 13.1 · 21h 13.8 · 22h 15.9 · 23h 13.0.

## Kalshi spreads

Live journal, fresh books only (≤ 2 s behind), 805,540 seconds since 2026-10-07:

| Time left | Seconds | Median | Mean | p90 | At 1¢ | Median ask depth |
|---|---:|---:|---:|---:|---:|---:|
| 600–900 s | 284,395 | 1.0¢ | 0.99¢ | 1.0¢ | 100% | 4926 |
| 300–600 s | 286,123 | 1.0¢ | 0.82¢ | 1.0¢ | 100% | 3498 |
| 120–300 s | 171,198 | 0.4¢ | 0.56¢ | 1.0¢ | 99% | 2114 |
| 60–120 s | 46,109 | 0.1¢ | 0.45¢ | 1.0¢ | 97% | 1468 |
| 0–60 s | 17,215 | 0.1¢ | 0.54¢ | 1.0¢ | 92% | 839 |

| YES mid | Seconds | Median spread | p90 | Round trip at median (spread + 2 taker fees) |
|---|---:|---:|---:|---:|
| 0–10¢ | 98,973 | 0.1¢ | 0.1¢ | 0.77¢ |
| 10–30¢ | 120,253 | 1.0¢ | 1.0¢ | 3.24¢ |
| 30–70¢ | 359,245 | 1.0¢ | 1.0¢ | 4.50¢ |
| 70–90¢ | 129,367 | 1.0¢ | 1.0¢ | 3.24¢ |
| 90–100¢ | 97,702 | 0.1¢ | 0.1¢ | 0.77¢ |

1-min Kalshi candles, Jul → now (147,824 minutes): 600–900 s median 1.0¢ / mean 0.99¢ · 300–600 s median 1.0¢ / mean 0.79¢ · 120–300 s median 0.1¢ / mean 0.48¢ · 60–120 s median 0.1¢ / mean 0.40¢ · 0–60 s median 0.1¢ / mean 0.60¢.

## Pricing lag

994 rounds, 60 s < time left ≤ 840 s, fresh books, YES mid 5–95¢. Absorption = slope of Kalshi's mid change (s−1 → s+L) on the model's 1-s change; 1.00 = fully priced in.

| L (s) | 0 | 1 | 2 | 3 | 5 | 10 | 20 | 30 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| All model moves | 0.72 | 0.79 | 0.81 | 0.83 | 0.83 | 0.85 | 0.88 | 0.90 |
| Model moves ≥ 1¢ | 0.72 | 0.79 | 0.81 | 0.83 | 0.83 | 0.84 | 0.88 | 0.90 |

Cross-correlation corr(Δmodel(s), ΔKalshi(s+L)); a peak at L > 0 means Kalshi follows the model: -5: 0.032 · -3: 0.051 · -2: 0.079 · -1: 0.225 · 0: 0.596 · 1: 0.055 · 2: 0.017 · 3: 0.010 · 5: -0.000 · 10: 0.005.

When the model and Kalshi disagree, who moves next (non-overlapping events):

| Gap ≥ | Horizon | Events | Mean gap | Closed by Kalshi | Closed by model |
|---:|---:|---:|---:|---:|---:|
| 3¢ | 5 s | 76,083 | 7.0¢ | 1% | 7% |
| 3¢ | 10 s | 41,778 | 6.7¢ | 2% | 12% |
| 3¢ | 30 s | 16,149 | 6.2¢ | 3% | 21% |
| 5¢ | 5 s | 47,589 | 9.2¢ | 1% | 7% |
| 5¢ | 10 s | 26,709 | 8.8¢ | 2% | 11% |
| 5¢ | 30 s | 11,083 | 8.1¢ | 3% | 22% |
| 10¢ | 5 s | 14,141 | 15.6¢ | 1% | 5% |
| 10¢ | 10 s | 8,022 | 15.0¢ | 2% | 9% |
| 10¢ | 30 s | 3,491 | 13.9¢ | 4% | 18% |

## Spot proxy vs official BRTI

247,319 seconds with a BRTI value ≤ 1.5 s old (since 2026-10-23). Proxy − BRTI: median $-0.04, sd $9.31, |gap| p90 $9.60, p99 $41.42.

corr(Δproxy(s), ΔBRTI(s+L)); a peak at L > 0 means the proxy leads: -3: 0.046 · -2: 0.048 · -1: 0.133 · 0: 0.715 · 1: 0.235 · 2: 0.034 · 3: 0.024.

Settlement: on 940 rounds the engine's 60-s proxy average minus Kalshi's settlement value had median $0.14, sd $5.91, |error| p90 $6.28; the proxy called the wrong side 12 times.

Kalshi book delay (journal): median 2 ms, p99 1689 ms, > 2 s 0.75% of seconds.
