# Late-round study and the Kalshi feed delay — 2026-10-21

Question (user, after a $1,000 drawdown): make the quant engine and its directional calls much better; also consider a trader who runs a sub-second BRTI feed and prices with Leisen-Reimer and Cox-Ross-Rubinstein trees.

Short answer: **the app's model is already as good as those pricers, and better in the final minute. The defect that cost money was the data: the app's copy of Kalshi's book fell tens of seconds behind in a busy final minute while still updating, and nothing noticed.** That is fixed. Nothing in the data improves the forecast itself: Kalshi's price is still the best forecast before the final minute, and in the final minute the model ties it.

## What happened on Oct 21

- 5 rounds, $9,713 staked, −$543.70 net, $313.94 in fees. The account went from $1,866.61 (peak) to $570.14.
- The 7:45–8:00 PM PT round (KXBTC15M-26OCT212300) lost **−$1,049.59**. With 51 s left, BTC $17 below the target, you bought 1,139 NO at 82¢ ($935, about half the account). BTC rose $40 in 20 s; 19 s later you sold all of it at 9.7¢. It settled YES, $6.94 above the target, so holding would have lost the full $935.
- Kalshi's fill records against the app's journaled book:

| Time | Kalshi traded at | App's book showed |
|---|---|---|
| 7:49–7:55 (4 orders) | YES 66¢, 46¢, 32¢, 20¢ | the same, within 1¢ |
| 7:59:09 | YES 18¢ | YES 6¢ |
| 7:59:28 | YES 90.3¢ | YES 11–12¢ |

  The app's book kept updating every 0–10 s but showed prices from tens of seconds earlier. At 7:59:59 it showed YES 20¢, about where Kalshi had been ~50 s before. The quant forecast puts 90% weight on the book, so it sat at 15–19% YES while the raw model said 71–99% YES. It flipped between the two whenever the book went more than 5 s without an update. The same minute logged Kalshi REST timeouts (7:59:48, 8:00:00) and a Kraken disconnect.

## Why the book fell behind

- About 800 book updates and 100 trades per second arrive for the two subscribed rounds in a quiet stretch; a fast final minute is several times that.
- The engine re-filtered its whole 2-minute trade list on every trade message. At 1,000 trades/s that took ~45% of a CPU, and 57 s of every 60 s once the list filled (benchmark), so messages queued and the book fell behind. Network trouble on the same machine makes it worse.
- Every Kalshi message carries its send time (`sending_ts_ms`). The engine read it into `lag`, kept only the latest value, and never acted on it.

## Fixed (src/engine/feeds/orderbook.ts FeedDelay, feeds/kalshi.ts, signals.ts, index.ts)

1. **Delay meter.** Receive time minus Kalshi's send time, above the lowest value of the last 10 minutes. No clock sync is needed. More than 2 s behind counts as delayed.
2. **While delayed:**
   - the quant forecast uses the model alone;
   - the Kalshi book trade check fails ("Kalshi prices N s behind"), so no BUY;
   - scalp/dip ideas stop;
   - exit advice gets no bid instead of a stale one;
   - Trade decision and Your positions show a warning to check the price in Kalshi.
3. **Trade list** pruned once a second instead of on every trade (3 min at 1,000 trades/s now handles in well under 5 s; test).
4. **Journal.** Every tick stores `kalshiDelay` (ms), so the next study can measure how often this happens.

## Model tests (scripts/final-minute-study.ts)

646 settled rounds, 38,635 samples (one per round per 5 s, last 5 min). Tuned on the first half of rounds, scored on the second.

| | Result |
|---|---|
| Add the app-price → BRTI error to the model's uncertainty | **No.** Best on the first half was $0 (Brier rose steadily with it). The model is already calibrated: 24 of 3,631 final-minute calls at ≥ 97% lost (0.7%). |
| Point-settlement binary price (what Leisen-Reimer / CRR trees converge to) | **Worse** than the app's 60-s-average model in the final minute (60–31 s: −0.0054, range −0.0089 … −0.0012), and a tie earlier. Kalshi settles on the average of the last 60 s; a plain tree ignores that. |
| App model vs Kalshi's book | Kalshi significantly better from 5 to 1 min left (+0.0101, +0.0167 Brier). In the last minute they tie on samples with a tight book. |
| App BTC price vs BRTI (settlement minute) | Median miss $2.34, p90 $5.76, p99 $10.69; called the wrong winner in 8 of 619 rounds. |

A real BRTI feed would help only in rounds settled within a few dollars of the target. CF Benchmarks licenses the real-time index; the app replicates it from four exchanges instead.

## What the data still says

- No forecast here beats Kalshi's price before the final minute; the daily backtest (9,837 rounds) agrees at every minute horizon.
- The losses come from stake size, flips and fees, not the forecast. On Oct 21 one 82¢ bet risked $935 to win ~$200 with 51 s left; Kalshi itself priced the reversal that happened at about 1 in 5.
