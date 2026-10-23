# Bitcoin 15-minute quantitative evidence audit

Generated 2026-10-23T07:45:48.933Z. Data cutoff: **2026-10-23T07:20:00.000Z** (October 23, 2026, 12:20 AM America/Los_Angeles for the reference run).

Reproduce with `npx tsx scripts/quant-research.ts --through 2026-10-23T07:20:00Z`. The companion JSON contains all metrics and fitted weights. Databases are opened read-only and are closed before fitting; this command never promotes a strategy or edits the trading verdict.

## What was actually recorded

| Source | Rows | First observation UTC | Last observation UTC |
|---|---:|---|---|
| Live ticks | 609,879 | 2026-10-07T02:53:11.000Z | 2026-10-23T07:20:00.000Z |
| Live outcomes | 709 | 2026-10-07T03:00:21.388Z | 2026-10-23T07:15:10.323Z |
| Live opening_calls | 680 | 2026-10-07T05:30:24.000Z | 2026-10-23T07:15:02.000Z |
| Live live_calls | 2,683 | 2026-10-07T06:40:00.000Z | 2026-10-23T07:20:00.000Z |
| Live next_calls | 1,276 | 2026-10-07T17:14:00.000Z | 2026-10-23T07:14:55.000Z |
| Live price_forecasts | 17,520 | 2026-10-13T00:05:00.000Z | 2026-10-23T07:20:00.000Z |

The eligible frozen forecasts contain **699 distinct settled market groups**. Thousands of checkpoints and hundreds of thousands of ticks are repeated observations of these outcomes, not independent trials. 0 records lacked usable model inputs; 3150 checkpoints lacked a fresh exact-time book for the execution diagnostic.

The separate historical archive contains:

```json
{
  "markets": [
    {
      "series": "KXBTC15M",
      "n": 9946,
      "first": 1783642500000,
      "last": 1792707300000,
      "withCandles": 9940
    },
    {
      "series": "KXBTCD",
      "n": 70927,
      "first": 1786233600000,
      "last": 1792706400000,
      "withCandles": 34140
    }
  ],
  "spot": {
    "n": 151325,
    "first": 1783629000000,
    "last": 1792708500000
  }
}
```

## Frozen forecasts: what the user actually saw

All methods use exactly the same paired rows, with a usable decision-time Kalshi midpoint. Brier and log loss are proper probability scores: lower is better. Accuracy alone cannot establish profitable entries. Positive gain means the frozen quant forecast beat Kalshi. Confidence intervals resample entire one-hour blocks.

| Time left | Markets | Quant hit rate | Quant Brier | Raw model Brier | Kalshi Brier | Quant gain vs Kalshi | Gain 95% interval |
|---|---:|---:|---:|---:|---:|---:|---|
| Opening | 645 | 56.9% | 0.2451 | 0.2463 | 0.2443 | -0.0008 | -0.0019 to 0.0002 |
| 10 min | 664 | 72.1% | 0.1851 | 0.1887 | 0.1830 | -0.0021 | -0.0037 to -0.0005 |
| 5 min | 669 | 81.0% | 0.1367 | 0.1419 | 0.1351 | -0.0017 | -0.0037 to 0.0002 |
| 2 min | 641 | 87.2% | 0.0849 | 0.0927 | 0.0833 | -0.0016 | -0.0049 to 0.0015 |
| 1 min | 428 | 93.9% | 0.0519 | 0.0577 | 0.0523 | 0.0004 | -0.0036 to 0.0039 |

## Fixed chronological holdout for the current engine

488 training markets (2336 checkpoints); 210 held-out markets, 925 paired checkpoints. Holdout starts 2026-10-16T20:15:02.000Z. Last eligible training outcome: 2026-10-16T20:00:06.735Z. Each market has total weight one in aggregate probability scoring. The engine performs its own chronological validation inside training; its returned mode is **prior**. The fitted challenger is reported even when rejected, so a candidate cannot hide behind the safer deployed fallback.

| Method | Brier | Log loss | Hit rate | Gain vs Kalshi | Hour-block gain 95% | Day-block gain 95% |
|---|---:|---:|---:|---:|---|---|
| Frozen live forecast | 0.1462 | 0.4334 | 77.8% | -0.0002 | -0.0009 to 0.0006 | insufficient blocks |
| Raw diffusion | 0.1528 | 0.4573 | 77.9% | -0.0068 | -0.0134 to -0.0006 | insufficient blocks |
| Kalshi midpoint | 0.1460 | 0.4321 | 77.9% | 0.0000 | 0.0000 to 0.0000 | insufficient blocks |
| Default blend | 0.1462 | 0.4334 | 77.8% | -0.0002 | -0.0009 to 0.0006 | insufficient blocks |
| Validated engine | 0.1462 | 0.4334 | 77.8% | -0.0002 | -0.0009 to 0.0006 | insufficient blocks |
| Fitted challenger (shadow) | 0.1457 | 0.4320 | 77.2% | 0.0003 | -0.0004 to 0.0010 | insufficient blocks |
| Coin flip | 0.2500 | 0.6931 | 50.0% | -0.1040 | -0.1191 to -0.0877 | insufficient blocks |

## Ask-based execution diagnostic

A fixed 4¢ minimum predicted edge after the app fee, spread no wider than 6¢, at least 60 seconds left, exact-time book with measured transport delay ≤2 seconds and recorded quote age ≤3 seconds, and first qualifying checkpoint per market. Legacy timestamps allow up to two seconds of clock/rounding ambiguity; absent delay metadata is excluded. Hold one contract to the official outcome. The 1¢ stress is added to entry price before deciding and calculating fees. These are hypothetical quote-based fills; order depth, queue position, network latency and adverse selection are not replayed. These filters are deliberately fixed, with no parameter search.

| Method | Entries | Mean net P&L | Hour-block 95% | Net total | Entries with 1¢ stress | Mean with 1¢ stress |
|---|---:|---:|---|---:|---:|---:|
| Frozen live forecast | 0 | — | insufficient blocks | $0.00 | 0 | — |
| Raw diffusion | 22 | -2.29¢ | -15.03¢ to 10.37¢ | $-0.50 | 15 | -9.02¢ |
| Kalshi midpoint | 0 | — | insufficient blocks | $0.00 | 0 | — |
| Default blend | 0 | — | insufficient blocks | $0.00 | 0 | — |
| Validated engine | 0 | — | insufficient blocks | $0.00 | 0 | — |
| Fitted challenger (shadow) | 0 | — | insufficient blocks | $0.00 | 0 | — |
| Coin flip | 45 | -8.83¢ | -19.33¢ to 1.01¢ | $-3.97 | 44 | -10.05¢ |

## Settlement-source uncertainty

663 recorded proxy-minus-official settlement averages: mean $0.22, RMS $3.63, median $0.19, 5th–95th percentiles $-5.46 to $5.93. Proxy and official outcome disagreed on 8/663 paired outcomes. A proxy is therefore not an exact substitute for BRTI, especially near the strike in the final seconds. Any residual-uncertainty adjustment must be fit using earlier outcomes and then tested on later ones.

## What the broader archived test already found

The existing 2026-10-22T22:36:51.602Z verdict covered 9,935 historical 15-minute rounds. Its raw diffusion ≥4¢-edge rule averaged -1.34¢ per contract after fees (95% interval -2.26¢ to -0.39¢); Kalshi beat the model at 14/14 evaluated horizons. 0 strategies passed its positive-profit confidence test. This audit reads that existing result; it does not rerun or relabel it as an untouched holdout.

## Interpretation and limits

- The fixed holdout is retrospective; earlier repository changes may already have inspected these dates. It is not untouched prospective evidence.
- Frozen calls span older software versions. Aggregate metrics are market weighted; horizon metrics should be preferred.
- Minute archive cannot establish subsecond latency, BRTI availability, final-minute precision or executable fills.
- One-hour/day blocks reduce serial-dependence inflation but do not make 17 calendar days equivalent to years of regimes.
- No hyperparameter or edge-threshold search is performed. No source database or production verdict is modified.
- A more accurate high-probability direction is not automatically an edge: a 90% favorite bought above its fair probability plus costs can still lose money on average.
- Formula correctness and chronological validation improve reliability. Positive expected returns require independent, forward-recorded evidence after fees and executable prices; none is inferred from a promising retrospective point estimate.
- The frozen holdout and fitted shadow comparison are evidence for accepting or rejecting a change, not a guarantee of future profits. Continue immutable forward recording and require positive paired probability improvement and positive net trading evidence before treating a challenger as an established advantage.
