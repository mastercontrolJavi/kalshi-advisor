# Edge study — 2026-10-15

Question: does the advisor have an edge, and if not, can the model or engine be changed so it does?

Short answer: **no edge on Bitcoin 15-minute or hourly markets.** Kalshi's price is the best forecast we can make from public data, live or historical. No change to the model tested here produces a profit after fees on data it was not fitted to. The engine now says so: it shows only signals whose rule has proven itself (DECISIONS 56).

## Data

- 9,188 settled KXBTC15M rounds with 1-minute Kalshi bid/ask candles and Coinbase 1-minute BTC (Jul 10 – Oct 14), and 1,569 KXBTCD hours.
- 358k seconds of the live journal: order book, 4-venue spot, model and quant forecast every second, on 446 rounds (Oct 4 – Oct 15).
- Every real fill and settlement since Oct 4 (883 fills, 130 rounds).
- The markets process: 2,413 settled scanner and sharp-copy flags, plus 720 scored rounds of the sharps' Bitcoin lean.

Every result is per contract after Kalshi's fees, with 95% ranges that resample whole rounds, hours or games.

## Your record (KXBTC15M, Oct 4 – Oct 13)

| | Rounds | Net | Fees |
|---|---:|---:|---:|
| All | 130 | −$194.39 | $101.36 |
| Entered with 10–15 min left | 92 | −$229.28 | $84.26 |
| Entered with 5–10 min left | 21 | −$91.09 | $9.15 |
| Entered with 2–5 min left | 16 | +$130.98 | $7.62 |

- You won 32% of rounds: wins averaged +$6.92 and losses −$5.51.
- One 5¢ ticket on Oct 4 paid +$155. Without it the total is −$364.
- 877 of 883 fills were taker fills, so fees alone were about half the loss.

## Tests

| Hypothesis | Result |
|---|---|
| The model forecasts better than Kalshi | No. Kalshi is better at 13 of 14 minute horizons (9,182 rounds) and at every 1-s live bucket. |
| Anything adds information beyond Kalshi's price: model gap, BTC momentum, Kalshi's own momentum, volatility, US session, weekend, favourite/longshot curvature | No. Held-out Brier was never better than Kalshi alone (0.15696); held-out trading on each was within noise or negative. |
| Resting limit (maker) orders, which have no fee on KXBTC15M | No. Fills are adversely selected, so the result is about level with taking. A maker version of the app's BUY rule: −0.7¢ (−2.2 … +1.0). |
| Kalshi lags Bitcoin by seconds (a bot could be faster) | No. The mid absorbs ~96% of a model move within 1 s; taking on "unpriced" moves loses or is noise. |
| Favourites at 90–97¢ with 5–14 min left | +0.4¢ (−0.4 … +1.1). Not distinguishable from zero, and tiny even if real. |
| Model/Kalshi blend weight | The history fit is 0.91 toward Kalshi. At that weight the few remaining "edges" lost −11¢ held out. |
| Live paper: 15-min taker, hourly | +0.7¢ first per round (−5.4 … +6.6, 192 rounds); hourly +5.8¢ (−2.3 … +14.0, 94 hours) live vs −1.7¢ over 698 hours of history. |
| Live paper: scalps, dips, makers | −3.1¢, −9.2¢ and −1.2¢: all lose with 95% confidence. |
| Sharps' Bitcoin 15-min lean | +1 to +7¢ at different horizons, every range spans zero, and the second half is weaker. |
| Sharp-copy flags on sports | **13–3 on 16 games** where prices implied ~9.7 wins (one-sided p ≈ 0.04 before allowing for how many things were tested). The one lead; needs ~100 games. |

Scripts to re-run as data grows: `npx tsx scripts/edge-study.ts`, `scripts/maker-study.ts` (`LIFE=minutes`), `scripts/blend-study.ts`.

## What changed

1. **Quant prior 0.5 → 0.9 toward Kalshi.** The forecast on the dashboard is now as accurate as Kalshi's price instead of slightly worse.
2. **Evidence gate, on by default** (Settings → Entry rules → Only show proven signals). BUY, hourly ideas and scalp/dip setups show, and make sound, only after their rule has made money over 100+ trades, with a 95% range above zero and a profit in both halves of the record. Hidden signals are still paper-traded and scored, so a rule that starts working comes back by itself.

## What it would take to have an edge

- **Information Kalshi's market makers don't have.** On Bitcoin that's unlikely: they see the same BRTI feed, faster.
- **A slower, less professional market.** Sports and other event markets, priced against sharper outside sources. The sharp-copy flags are the one place in this data where that shows up. Let them reach ~100 games before risking money on them.
- **Lower costs.** Maker orders avoid the fee, but on these markets the fills you get are the bad ones, so the saving doesn't survive.
