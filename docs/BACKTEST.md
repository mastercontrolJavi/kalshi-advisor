# Backtest: 2026-07-10 to 2026-10-08

Generated 2026-10-08 02:16 UTC by `npm run backtest`. Data: 8,529 settled KXBTC15M rounds with Kalshi 1-minute YES bid/ask candles, 1,407 KXBTCD hours (2026-08-09 to 2026-10-08, strikes within $600 of spot), Coinbase BTC-USD 1-minute candles. Every result is per 1 contract after Kalshi's taker fee on entry and on any early exit, with one trade per round (per hour for hourly) so the 95% ranges are honest.

## What this says

- **Forecast accuracy (15-min).** Over 8,529 rounds, Kalshi's price was significantly more accurate at 14 min, 13 min, 12 min, 10 min, 9 min, 8 min, 7 min, 6 min, 5 min, 4 min, 3 min, 2 min, 1 min left; the app's model was significantly more accurate at no horizon; the rest are ties. Overall Brier: model 0.1572, quant blend 0.1551, Kalshi 0.1546 (0.25 = coin flip).
- **The app's BUY rule (15-min)** made 2,483 trades averaging -0.6¢ per contract (95% range -2.2¢ … +0.9¢): not distinguishable from zero.
- **No strategy tested (32) was profitable with 95% confidence after fees.**
- **Lose money with 95% confidence:** App BUY rule · fixed exits (TP 25 % / SL 50 % / win chance < 25 %) (-1.9¢); App BUY rule · current trailing exits (-1.5¢); Raw diffusion model, ≥ 4¢ edge · hold (-1.2¢); Raw model, ≥ 8¢ edge · hold (-1.4¢); Minute 1: buy the market favorite · hold (-2.2¢); Minute 1: buy the market favorite · trailing exits (-2.8¢); Minute 1: buy the underdog · hold (-2.1¢); Minute 1: buy the side BTC has moved toward · hold (-1.6¢); Any time: buy a 40–60¢ side · hold (-2.6¢); Favorite at 80–90¢, 1–5 min left · hold (-3.0¢); Favorite at 90–97¢, 1–5 min left · hold (-1.0¢); Longshot at ≤ 10¢, ≥ 2 min left · hold (-1.0¢); App hourly rule · current trailing exits (-2.7¢); Longshot strike at ≤ 10¢, ≥ 5 min left · hold (-1.8¢).
- **Exit plans vs holding the same entries:** fixed take-profit/stop-loss -1.3¢ per trade (95% range -2.5¢ … -0.1¢), current trailing plan -0.9¢ (-1.9¢ … +0.1¢). Selling early pays a second fee and sells at the bid.
- **Volatility scale.** The model's Brier was best with variance ×0.8 (×0.6: 0.1572, ×0.8: 0.1569, ×1: 0.1572, ×1.25: 0.1582, ×1.5: 0.1593, ×2: 0.1618).
- **Final minute (live journal, 60 rounds so far).** The model beat Kalshi's price at no 10-s bucket left and lost at none; a ≥ 4¢-edge entry in the last minute averaged -3.0¢ per contract over 18 trades (95% range -25.6¢ … +19.9¢). With 18 trades the range is still wide; a few hundred rounds are needed before it can show an edge of a few cents.
- **Coinbase→BRTI basis** (K minus Coinbase in the minute before the open): median $4.04, middle half $-0.00 to $8.00.

## 1. Who forecasts better: the app or Kalshi? (15-min)

Brier score (lower is better; 0.25 = coin flip). One sample per round per minute; 95% range of the model − Kalshi difference resamples whole rounds.

| Time left | Samples | App model | App quant blend | Kalshi price | Model − Kalshi | 95% range | Better |
|---|---:|---:|---:|---:|---:|---|---|
| 14 min | 8529 | 0.2361 | 0.2352 | 0.2350 | +0.0011 | 0.0003 … 0.0018 | **Kalshi** |
| 13 min | 8529 | 0.2242 | 0.2233 | 0.2232 | +0.0011 | 0.0002 … 0.0019 | **Kalshi** |
| 12 min | 8528 | 0.2111 | 0.2098 | 0.2095 | +0.0016 | 0.0007 … 0.0024 | **Kalshi** |
| 11 min | 8529 | 0.1999 | 0.1990 | 0.1992 | +0.0007 | -0.0002 … 0.0016 | tie |
| 10 min | 8529 | 0.1894 | 0.1883 | 0.1885 | +0.0009 | 0.0001 … 0.0018 | **Kalshi** |
| 9 min | 8529 | 0.1761 | 0.1748 | 0.1748 | +0.0012 | 0.0004 … 0.0020 | **Kalshi** |
| 8 min | 8529 | 0.1639 | 0.1621 | 0.1616 | +0.0023 | 0.0014 … 0.0031 | **Kalshi** |
| 7 min | 8528 | 0.1516 | 0.1496 | 0.1491 | +0.0026 | 0.0017 … 0.0035 | **Kalshi** |
| 6 min | 8529 | 0.1396 | 0.1370 | 0.1360 | +0.0036 | 0.0026 … 0.0045 | **Kalshi** |
| 5 min | 8528 | 0.1265 | 0.1237 | 0.1228 | +0.0037 | 0.0026 … 0.0046 | **Kalshi** |
| 4 min | 8524 | 0.1101 | 0.1075 | 0.1068 | +0.0034 | 0.0023 … 0.0044 | **Kalshi** |
| 3 min | 8489 | 0.0947 | 0.0916 | 0.0906 | +0.0041 | 0.0029 … 0.0052 | **Kalshi** |
| 2 min | 8050 | 0.0798 | 0.0763 | 0.0752 | +0.0046 | 0.0034 … 0.0058 | **Kalshi** |
| 1 min | 5612 | 0.0604 | 0.0541 | 0.0522 | +0.0082 | 0.0063 … 0.0101 | **Kalshi** |

## 2. Is Kalshi's price fair? (15-min)

Every quote, both sides, bought at the ask and held to settlement. A positive number means contracts at that price won more often than the price plus fee implies.

**5–14 minutes left**

| Price paid | Buys | Avg price | Won | P&L per contract after fee | 95% range | Return on money spent |
|---|---:|---:|---:|---:|---|---:|
| 0–5¢ | 4859 | 3.0¢ | 2.4% | **-0.7¢** | -1.3¢ … -0.0¢ | -25% |
| 5–10¢ | 6362 | 7.4¢ | 5.9% | **-2.0¢** | -2.9¢ … -1.1¢ | -27% |
| 10–20¢ | 11901 | 15.1¢ | 12.6% | **-3.5¢** | -4.4¢ … -2.6¢ | -23% |
| 20–30¢ | 15903 | 24.7¢ | 22.2% | **-3.7¢** | -4.8¢ … -2.6¢ | -15% |
| 30–40¢ | 20138 | 34.7¢ | 32.9% | **-3.4¢** | -4.3¢ … -2.4¢ | -10% |
| 40–50¢ | 23515 | 44.6¢ | 43.1% | **-3.2¢** | -4.0¢ … -2.4¢ | -7% |
| 50–60¢ | 24244 | 54.4¢ | 54.8% | **-1.3¢** | -1.9¢ … -0.7¢ | -2% |
| 60–70¢ | 21013 | 64.3¢ | 64.7% | **-1.3¢** | -2.2¢ … -0.3¢ | -2% |
| 70–80¢ | 16581 | 74.3¢ | 75.7% | **+0.1¢** | -1.0¢ … +1.1¢ | +0% |
| 80–90¢ | 13511 | 84.3¢ | 86.0% | **+0.8¢** | -0.2¢ … +1.8¢ | +1% |
| 90–95¢ | 7342 | 92.1¢ | 93.4% | **+0.8¢** | -0.1¢ … +1.6¢ | +1% |
| 95–100¢ | 5207 | 97.0¢ | 97.4% | **+0.2¢** | -0.4¢ … +0.9¢ | +0% |

**1–5 minutes left**

| Price paid | Buys | Avg price | Won | P&L per contract after fee | 95% range | Return on money spent |
|---|---:|---:|---:|---:|---|---:|
| 0–5¢ | 15779 | 1.5¢ | 1.4% | **-0.3¢** | -0.5¢ … -0.0¢ | -17% |
| 5–10¢ | 3843 | 7.2¢ | 7.2% | **-0.5¢** | -1.4¢ … +0.5¢ | -6% |
| 10–20¢ | 3623 | 14.5¢ | 15.8% | **+0.4¢** | -1.0¢ … +1.9¢ | +3% |
| 20–30¢ | 2748 | 24.2¢ | 25.4% | **-0.2¢** | -2.2¢ … +1.7¢ | -1% |
| 30–40¢ | 2340 | 34.4¢ | 35.4% | **-0.6¢** | -2.6¢ … +1.6¢ | -2% |
| 40–50¢ | 2114 | 44.5¢ | 43.0% | **-3.2¢** | -5.4¢ … -1.0¢ | -7% |
| 50–60¢ | 2145 | 54.5¢ | 54.9% | **-1.3¢** | -3.2¢ … +0.6¢ | -2% |
| 60–70¢ | 2247 | 64.6¢ | 62.8% | **-3.3¢** | -5.3¢ … -1.3¢ | -5% |
| 70–80¢ | 2661 | 74.7¢ | 72.3% | **-3.7¢** | -5.5¢ … -1.8¢ | -5% |
| 80–90¢ | 3647 | 84.9¢ | 82.8% | **-3.0¢** | -4.5¢ … -1.6¢ | -4% |
| 90–95¢ | 4127 | 92.4¢ | 91.8% | **-1.1¢** | -2.1¢ … -0.1¢ | -1% |
| 95–100¢ | 16082 | 98.5¢ | 98.6% | **-0.1¢** | -0.3¢ … +0.2¢ | -0% |

## 3. Strategies (15-min)

| Strategy (1 contract, taker fees both ways) | Trades | Win rate | Avg P&L per contract | 95% range | Total per contract | First half | Second half |
|---|---:|---:|---:|---|---:|---:|---:|
| App BUY rule (quant blend, ≥ 4¢ edge) · hold to settle | 2483 | 41.1% | **-0.6¢** | -2.2¢ … +0.9¢ | −$15.87 | -0.2¢ | -1.2¢ |
| App BUY rule · fixed exits (TP 25 % / SL 50 % / win chance < 25 %) | 2483 | 45.1% | **-1.9¢** | -3.0¢ … -0.9¢ | −$47.63 | -1.2¢ | -2.9¢ |
| App BUY rule · current trailing exits | 2483 | 37.8% | **-1.5¢** | -2.8¢ … -0.4¢ | −$38.09 | -0.8¢ | -2.5¢ |
| Raw diffusion model, ≥ 4¢ edge · hold | 6765 | 40.4% | **-1.2¢** | -2.1¢ … -0.2¢ | −$80.49 | -1.5¢ | -0.9¢ |
| Quant blend, ≥ 2¢ edge · hold | 5522 | 40.5% | **-0.6¢** | -1.7¢ … +0.4¢ | −$35.26 | -0.3¢ | -1.0¢ |
| Quant blend, ≥ 8¢ edge · hold | 505 | 46.7% | **-1.9¢** | -5.5¢ … +2.1¢ | −$9.45 | +2.0¢ | -5.9¢ |
| Quant blend, ≥ 12¢ edge · hold | 157 | 42.7% | **-4.1¢** | -11.3¢ … +3.3¢ | −$6.48 | +2.3¢ | -11.2¢ |
| Quant blend, ≥ 20¢ edge · hold | 29 | 41.4% | **+1.7¢** | -16.2¢ … +20.6¢ | $0.50 | +4.0¢ | -2.5¢ |
| Raw model, ≥ 8¢ edge · hold | 3534 | 33.4% | **-1.4¢** | -2.6¢ … -0.1¢ | −$48.09 | -0.7¢ | -2.3¢ |
| Raw model, ≥ 12¢ edge · hold | 1666 | 30.9% | **-0.7¢** | -2.5¢ … +1.2¢ | −$11.23 | +0.5¢ | -2.6¢ |
| Raw model, ≥ 20¢ edge · hold | 380 | 26.8% | **-2.4¢** | -6.6¢ … +1.7¢ | −$9.04 | +1.2¢ | -9.5¢ |
| Minute 1: buy the market favorite · hold | 8529 | 59.5% | **-2.2¢** | -3.2¢ … -1.2¢ | −$189.43 | -2.8¢ | -1.7¢ |
| Minute 1: buy the market favorite · trailing exits | 8529 | 49.5% | **-2.8¢** | -3.5¢ … -2.1¢ | −$237.24 | -3.6¢ | -2.0¢ |
| Minute 1: buy the underdog · hold | 8529 | 40.5% | **-2.1¢** | -3.1¢ … -1.1¢ | −$179.44 | -1.5¢ | -2.7¢ |
| Minute 1: buy the side BTC has moved toward · hold | 8529 | 59.8% | **-1.6¢** | -2.6¢ … -0.6¢ | −$138.81 | -2.1¢ | -1.2¢ |
| Any time: buy a 40–60¢ side · hold | 7337 | 48.0% | **-2.6¢** | -3.7¢ … -1.5¢ | −$194.25 | -2.0¢ | -3.3¢ |
| Favorite at 80–90¢, 5–14 min left · hold | 6042 | 84.5% | **+0.2¢** | -0.8¢ … +1.1¢ | $10.20 | -0.3¢ | +0.6¢ |
| Favorite at 90–97¢, 5–14 min left · hold | 4269 | 92.9% | **+0.3¢** | -0.4¢ … +1.1¢ | $14.88 | +0.1¢ | +0.6¢ |
| Favorite at 80–90¢, 1–5 min left · hold | 2851 | 82.7% | **-3.0¢** | -4.4¢ … -1.6¢ | −$85.35 | -2.5¢ | -3.5¢ |
| Favorite at 90–97¢, 1–5 min left · hold | 4716 | 93.0% | **-1.0¢** | -1.7¢ … -0.3¢ | −$47.04 | -0.8¢ | -1.2¢ |
| Heavy favorite at 97–99.9¢ · hold | 6597 | 98.5% | **+0.0¢** | -0.3¢ … +0.3¢ | $2.80 | +0.0¢ | +0.0¢ |
| Longshot at ≤ 10¢, ≥ 2 min left · hold | 6795 | 6.1% | **-1.0¢** | -1.6¢ … -0.4¢ | −$68.35 | -1.2¢ | -0.8¢ |

## 4. Calibration and volatility (15-min)

| Forecast range | Model: avg forecast | Model: actual | Kalshi: avg price | Kalshi: actual |
|---|---:|---:|---:|---:|
| 0–5% | 1.8% (10262) | 2.7% | 1.9% (10197) | 1.7% |
| 5–10% | 7.5% (3993) | 8.2% | 7.4% (5030) | 7.0% |
| 10–20% | 15.0% (8090) | 13.5% | 15.1% (8576) | 14.4% |
| 20–30% | 25.2% (9613) | 22.2% | 25.1% (9593) | 23.5% |
| 30–40% | 35.2% (11805) | 32.7% | 35.1% (11475) | 34.4% |
| 40–50% | 45.1% (14713) | 43.2% | 45.1% (12993) | 43.5% |
| 50–60% | 54.8% (14402) | 55.7% | 54.8% (13041) | 54.7% |
| 60–70% | 64.7% (11728) | 67.6% | 64.9% (11399) | 65.7% |
| 70–80% | 74.8% (9130) | 78.7% | 74.9% (9391) | 76.0% |
| 80–90% | 84.9% (7774) | 88.7% | 84.9% (8355) | 86.8% |
| 90–95% | 92.6% (3995) | 93.2% | 92.6% (5201) | 93.8% |
| 95–100% | 98.2% (10457) | 98.1% | 98.2% (10711) | 98.4% |

Model Brier by variance multiplier: ×0.6 0.1572 · ×0.8 0.1569 · ×1 0.1572 · ×1.25 0.1582 · ×1.5 0.1593 · ×2 0.1618.

## 5. Bet size: what happens to $40

Each row replays 2,000 random 100-trade sequences drawn from the strategy's real backtest trades, staking a fixed share of the current balance every time.

| Strategy | Stake per trade | Median after 100 trades | Bad case (10th pct) | Good case (90th pct) | Fell below $2 at some point | Ended below $20 |
|---|---:|---:|---:|---:|---:|---:|
| App BUY rule (quant blend, ≥ 4¢ edge) · hold to settle | **all of it** | $0.00 | $0.00 | $0.00 | 100.0% | 100.0% |
| App BUY rule (quant blend, ≥ 4¢ edge) · hold to settle | 50% of balance | $1.46 | $1.12 | $1.89 | 100.0% | 100.0% |
| App BUY rule (quant blend, ≥ 4¢ edge) · hold to settle | 25% of balance | $1.78 | $1.57 | $1.98 | 93.7% | 97.5% |
| App BUY rule (quant blend, ≥ 4¢ edge) · hold to settle | 10% of balance | $9.42 | $1.92 | $74.96 | 20.2% | 68.2% |
| App BUY rule (quant blend, ≥ 4¢ edge) · hold to settle | 2% of balance | $36.60 | $23.48 | $62.36 | 0.0% | 3.6% |
| Minute 1: buy the market favorite · hold | **all of it** | $0.00 | $0.00 | $0.00 | 100.0% | 100.0% |
| Minute 1: buy the market favorite · hold | 50% of balance | $1.55 | $1.13 | $1.91 | 99.1% | 99.5% |
| Minute 1: buy the market favorite · hold | 25% of balance | $1.92 | $1.61 | $24.97 | 62.6% | 88.3% |
| Minute 1: buy the market favorite · hold | 10% of balance | $20.05 | $7.05 | $55.24 | 0.4% | 49.9% |
| Minute 1: buy the market favorite · hold | 2% of balance | $36.73 | $30.06 | $45.17 | 0.0% | 0.0% |

## 6. Hourly (KXBTCD)

1,407 hours, strikes within $600 of the spot at each minute; samples resample whole hours.

| Time left | Samples | App model | App quant blend | Kalshi price | Model − Kalshi | 95% range | Better |
|---|---:|---:|---:|---:|---:|---|---|
| 50–59 min | 1407 | 0.1150 | 0.1137 | 0.1131 | +0.0019 | 0.0013 … 0.0025 | **Kalshi** |
| 40–50 min | 1407 | 0.1106 | 0.1093 | 0.1088 | +0.0019 | 0.0012 … 0.0024 | **Kalshi** |
| 30–40 min | 1407 | 0.1047 | 0.1033 | 0.1027 | +0.0020 | 0.0014 … 0.0026 | **Kalshi** |
| 20–30 min | 1406 | 0.0944 | 0.0931 | 0.0926 | +0.0018 | 0.0012 … 0.0024 | **Kalshi** |
| 10–20 min | 1405 | 0.0893 | 0.0876 | 0.0869 | +0.0024 | 0.0018 … 0.0031 | **Kalshi** |
| 5–10 min | 1398 | 0.0883 | 0.0856 | 0.0846 | +0.0037 | 0.0029 … 0.0044 | **Kalshi** |
| 1–5 min | 1376 | 0.0880 | 0.0841 | 0.0833 | +0.0047 | 0.0033 … 0.0062 | **Kalshi** |

**Is the hourly price fair?** (any time with ≥ 1 min left)

| Price paid | Buys | Avg price | Won | P&L per contract after fee | 95% range | Return on money spent |
|---|---:|---:|---:|---:|---|---:|
| 0–5¢ | 189469 | 2.7¢ | 1.4% | **-1.5¢** | -1.8¢ … -1.1¢ | -54% |
| 5–10¢ | 119757 | 6.7¢ | 5.2% | **-2.0¢** | -2.6¢ … -1.3¢ | -29% |
| 10–20¢ | 120325 | 14.0¢ | 11.7% | **-3.1¢** | -3.9¢ … -2.3¢ | -22% |
| 20–30¢ | 78726 | 24.3¢ | 22.0% | **-3.6¢** | -4.5¢ … -2.6¢ | -15% |
| 30–40¢ | 64430 | 34.4¢ | 32.8% | **-3.2¢** | -4.0¢ … -2.3¢ | -9% |
| 40–50¢ | 58880 | 44.5¢ | 43.4% | **-2.8¢** | -3.3¢ … -2.2¢ | -6% |
| 50–60¢ | 58595 | 54.5¢ | 54.1% | **-2.1¢** | -2.6¢ … -1.6¢ | -4% |
| 60–70¢ | 62687 | 64.6¢ | 65.1% | **-1.1¢** | -1.9¢ … -0.2¢ | -2% |
| 70–80¢ | 74704 | 74.7¢ | 75.8% | **-0.2¢** | -1.2¢ … +0.7¢ | -0% |
| 80–90¢ | 107235 | 84.9¢ | 86.2% | **+0.4¢** | -0.5¢ … +1.3¢ | +0% |
| 90–95¢ | 91322 | 92.2¢ | 93.1% | **+0.4¢** | -0.4¢ … +1.1¢ | +0% |
| 95–100¢ | 249378 | 97.6¢ | 97.9% | **+0.1¢** | -0.3¢ … +0.4¢ | +0% |

| Strategy (1 contract, taker fees both ways) | Trades | Win rate | Avg P&L per contract | 95% range | Total per contract | First half | Second half |
|---|---:|---:|---:|---|---:|---:|---:|
| App hourly rule (quant blend, ≥ 4¢ edge, last 15 min or ≥ 8¢) · hold | 624 | 27.2% | **-2.4¢** | -5.4¢ … +0.9¢ | −$14.78 | -0.9¢ | -3.8¢ |
| App hourly rule · current trailing exits | 624 | 26.0% | **-2.7¢** | -4.9¢ … -0.3¢ | −$16.98 | -0.4¢ | -5.0¢ |
| Raw model, ≥ 4¢ edge · hold | 1363 | 25.3% | **-1.8¢** | -3.8¢ … +0.1¢ | −$24.71 | -0.6¢ | -3.0¢ |
| Quant blend, ≥ 8¢ edge, any time · hold | 124 | 42.7% | **-1.5¢** | -8.8¢ … +5.9¢ | −$1.92 | +4.4¢ | -5.9¢ |
| Quant blend, ≥ 12¢ edge, any time · hold | 29 | 37.9% | **-6.5¢** | -20.7¢ … +7.2¢ | −$1.89 | +6.3¢ | -15.6¢ |
| Quant blend, ≥ 20¢ edge, any time · hold | 2 | 0.0% | **-18.5¢** | -27.4¢ … -9.6¢ | −$0.37 | -9.6¢ | -27.4¢ |
| Favorite strike at 80–90¢, last 15 min · hold | 1355 | 86.7% | **+0.7¢** | -1.2¢ … +2.4¢ | $9.02 | +1.2¢ | +0.1¢ |
| Favorite strike at 90–97¢, last 15 min · hold | 1385 | 94.7% | **+0.2¢** | -1.0¢ … +1.3¢ | $2.96 | -0.1¢ | +0.6¢ |
| Any strike at 40–60¢, 30+ min left · hold | 1372 | 49.6% | **-2.0¢** | -4.6¢ … +0.5¢ | −$27.68 | -1.0¢ | -3.0¢ |
| Longshot strike at ≤ 10¢, ≥ 5 min left · hold | 1407 | 6.0% | **-1.8¢** | -3.0¢ … -0.6¢ | −$25.89 | -1.8¢ | -1.8¢ |

## 7. Final minute (live journal, second by second)

60 settled rounds the app watched (2026-10-07 to 2026-10-08), 3,476 seconds with a model price. The model sees the locked part of the settlement average here; the 1-minute history above cannot. Entries take the ask the second the forecast beats it by ≥ 4¢ after the fee (5–59 s left), one per round, held to settlement.

| Time left | Samples | App model | App quant blend | Kalshi price | Model − Kalshi | 95% range | Better |
|---|---:|---:|---:|---:|---:|---|---|
| 50–59 s | 37 | 0.1032 | 0.1061 | 0.1090 | -0.0058 | -0.0302 … 0.0137 | tie |
| 40–50 s | 33 | 0.0698 | 0.0663 | 0.0600 | +0.0098 | -0.0133 … 0.0367 | tie |
| 30–40 s | 30 | 0.0422 | 0.0421 | 0.0486 | -0.0065 | -0.0408 … 0.0183 | tie |
| 20–30 s | 26 | 0.0345 | 0.0364 | 0.0352 | -0.0007 | -0.0092 … 0.0074 | tie |
| 10–20 s | 19 | 0.0019 | 0.0225 | 0.0656 | -0.0637 | -0.1998 … 0.0023 | tie |
| 1–10 s | 9 | 0.0001 | 0.0063 | 0.1358 | -0.1357 | -0.3705 … 0.0001 | tie |

| Strategy (1 contract, taker fees both ways) | Trades | Win rate | Avg P&L per contract | 95% range | Total per contract | First half | Second half |
|---|---:|---:|---:|---|---:|---:|---:|
| Final minute: model edge ≥ 4¢ · hold | 18 | 50.0% | **-3.0¢** | -25.6¢ … +19.9¢ | −$0.54 | -19.0¢ | +7.2¢ |
| Final minute: quant blend edge ≥ 4¢ · hold | 15 | 40.0% | **-7.4¢** | -34.2¢ … +18.6¢ | −$1.10 | -19.0¢ | +2.9¢ |

## Method and limits

- Decisions happen at the end of each Kalshi 1-minute candle using its closing YES bid/ask, so the final minute (where the live model sees the locked average) is not tested here; the live journal keeps measuring it second by second.
- Spot is Coinbase, corrected to BRTI by the rolling median of (K − Coinbase) over the previous 96 rounds. The live app uses a 4-venue median each second, so live forecasts differ slightly.
- Volatility: EWMA (30-minute half-life) of 1-minute log returns blended 25% with the trailing 2-hour mean; no parameter was tuned on this data except the variance-multiplier table, which is reported, not used.
- Fills assume the closing ask was available for 1 contract; Kalshi's books hold thousands of contracts per level, so size up to tens of contracts would not move this, but latency would: a manual trader acts seconds later than the candle close.
- Order-book depth, feed-health and guardrail gates are not modelled. Maker (resting) orders are not simulated.
- "First half / second half" splits the period at its midpoint; an edge that is real should show up in both.