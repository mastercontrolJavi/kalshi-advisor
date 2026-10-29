# One-sided final-minute books (2026-10-28)

The execution study (docs/RESEARCH-ENGINE-2026-10-23.md) needs both bid ladders to compute a spread, and most final-minute checkpoints have only one. This note records what those books are, how they were checked against Kalshi's own trade record, and the shadow arm added to test them. Nothing here changes live advice, order execution, sizing or safety gates.

## Observed (journal through 2026-10-29 04:20 UTC; 429 frozen checkpoints, 145 rounds from 2026-10-23)

- **265 of 429 checkpoints (62%) are one-sided**, in 121 of 145 rounds; 48 rounds had nothing else. By horizon: 47 of 144 at 60 s, 98 of 142 at 30 s, 120 of 143 at 10 s. On the first 402 rows this is 246, the same as Codex's count.
- **Every one is pinned.** The ladder that exists is the favourite's bids, best bid exactly 99.9¢, 20 recorded levels, median ~517k contracts (10th percentile ~203k). The longshot's bid ladder is empty. Never the reverse, and the present side never switched within a round. No one-sided book below the ceiling occurred at a checkpoint.
- **All sit on the model's bound.** brtiP is exactly 0.01 or 0.99, quantP 0.99 for the favourite (with no mid the quant uses the model alone), marketP and candidateP are null.
- **The favourite won every time** (262 of 262 on the 2026-10-28 count, 119 rounds).
- **Not a capture artifact.** All were valid, ≤ 1 s old and ≤ 2 s delayed; all but 2 came from the stream, and the 2 from the REST backup were pinned too.
- **Pinning is close to absorbing.** Within ±2 s, 11 of 262 had a two-sided capture (Codex: 10 of 246); all 11 were 1.6–1.9 s before the checkpoint with the favourite at 99.8¢ and a 0.1¢ longshot bid, one tick short of pinned. Only 4 of 262 became two-sided again in the next 30 s. The pinned share of final-minute captures rises from 30% (60–70 s left) to 89% (last 15 s).
- **Kalshi's own 1-minute candles agree:** in the backtest history (data/history.db), the closing candle of all 108 rounds that overlap the journal shows no ask for the favourite (ask 1.00), including all 88 the journal had pinned at 10 s. Candles are one quote per minute, so this confirms the state at the close, not at each checkpoint.

## Why the missing ladder cannot exist

Kalshi books are two bid ladders; buying a side consumes the other side's bids, so a YES ask is 1 − the best NO bid. With the favourite bid at 99.9¢, any longshot bid of 0.1¢ or more adds up to $1 with it and trades at once. So while a round is pinned no one can rest an offer of the favourite: the empty ladder is structurally absent, not thin liquidity and not missing data. The spread is undefined because an ask would have to be $1 or more. The market's statement is "the favourite is at least 99.9%". The only trade a pinned book allows is buying the longshot at 0.1¢ (or deeper, when a large order sweeps the favourite's bids).

## Independent check: Kalshi's public trade tape

`npm run tape:check` (scripts/one-sided-tape-check.ts) rebuilds the journal's pinned runs in exchange time (capture time + recorded clock offset − transport delay, shrunk by a margin at each end) and fetches Kalshi's public trades for the same windows. Against a pinned book every trade must be a taker buying the longshot; a taker buying the favourite needs a resting longshot bid, so the capture missed something.

Run on 2026-10-29 (145 rounds, no fetch errors, 500-ms margin):

- 160 pinned runs, 6,098 s in all; 38,208 public trades fell inside them.
- **38,192 (99.96%) were a taker buying the longshot**, the only trade a pinned book allows; 59 of them swept below the ceiling.
- **16 trades (1,737 contracts) were a taker buying the favourite, in 2 rounds:** 9 in KXBTC15M-26OCT231745-45 at 31 s left and 7 in KXBTC15M-26OCT260245-45 at 7 s left, each burst within ~30 ms. The favourite was briefly offered at 99.9¢ between the journal's four-per-second captures.
- With a 250-ms margin, 345 such trades appear in 15 rounds, all at the edges of runs (the moments a book becomes pinned). They are timing, not missed liquidity, and fall to the same 16 from 500 ms to 1,000 ms.

The tape only shows liquidity that traded: a quote cancelled before anyone hit it cannot be detected this way. Windows rely on the recorded clock offset and delay.

## Effect on the v1 execution study

- One-sided books were nearly all of v1's `missing-decision-depth` exclusions. That label is now split into `pinned-book`, `one-sided-book` and `empty-book`; v1's decisions are unchanged (tested).
- Even without the exclusion, the only buyable side is the longshot at 0.1¢, and with its probability stuck at 1% `executionLimitPrice` finds no positive price at the 4¢ edge. **Excluding these books cost v1 no decision.**
- The probability bound matters in both directions. For the favourite it understates the edge (conservative). For the longshot, 1% against 0.1¢ looks like +0.9¢ before fees — an artifact of the clip, which a lower minimum edge would turn into losing trades (the longshot lost 262 of 262).
- At 0.1¢ the fee is $0.0001 a contract at the account's 0.0001 precision (10% of the price) and $0.009 at cent precision (9× the price).
- The calibrated challenger and the market-referenced Brier scores only ever see two-sided books (candidateP needs marketP). Their results are conditional on a two-sided book, which excludes 62% of checkpoints, the near-certain ones.
- Two-sided books at the extremes (108 checkpoints, spreads mostly 0.1¢) went to the favourite 106 times. In one of the two losses BRTI said 1% at 60 s while Kalshi said 12.5%, and YES won: the bound is not always "certain".

## Shadow arm: execution-study-v1.1-one-sided

Fixed before any one-sided P&L was looked at (src/engine/quant/execution-study.ts, src/engine/quant/one-sided.ts; tests/one-sided.test.ts):

1. **Classified from the decision-time book only:** two-sided, pinned (best bid at the 99.9¢ ceiling), one-sided (one ladder below it), empty or invalid. Tick metadata is not recorded, so a 99¢ bid on a 1¢-tick market is labelled one-sided, the conservative label.
2. **Executability:** only the side opposite the recorded ladder can be bought, against recorded levels only. The favourite of a pinned book is never filled, never given a made-up ask at the ceiling and never counted as a zero-return trade.
3. **Probabilities:** a method on the 1%/99% bound is excluded as `censored-probability`. The market has no point estimate on a one-sided book (`market-point-undefined`); the candidate needs one.
4. **No spread is imputed.** The bought side has no bid, so it has no mark before settlement; replay values it at settlement, as v1 does.
5. **Causal selection:** in time order, the first checkpoint per market and method that qualifies under v1 (two-sided) or these rules. It never waits for a later v1 entry, so it cannot condition on future books. Markets it takes earlier than v1 are listed as moved; markets v1 never traded as added. The arm is never pooled into the v1 headline.
6. **Scenarios:** v1's 250 ms / 1 s / 3 s / 1 s + 1¢, plus the same 1 s fills recharged at 1¢ fee rounding, whole-order fills (one fee rounding for all 5 contracts) and half the displayed depth. First capture after arrival only; no later capture can rescue an attempt.
7. **Not simulated:** a resting bid for the favourite at 99.9¢ behind ~500k contracts. Queue position is not recorded.

**Result on the journal through 2026-10-29 04:20 UTC:** 0 one-sided decisions for every method. brtiP: 254 censored; quantP: 265 censored; marketP: 265 market-point-undefined; candidateP: 265 missing. No market was moved or added. The arm's totals equal v1's.

**Power:** with no longshot win in 119 pinned rounds, the 95% upper bound on the longshot's win rate per round is about 2.5% (rule of three), against a break-even of about 0.11% at 0.1¢. Today's data cannot say whether those longshots are cheap or dear; that would take thousands of rounds.

## Not verified (hypotheses)

- The mechanism: bidders piling in at 99.9¢ once the closing average is effectively decided.
- That the brief favourite offers seen in the tape are cancel-and-requote gaps.
- That the pattern holds in other volatility regimes, and that KXBTC15M uses 0.1¢ ticks near the extremes everywhere (inferred from observed prices).

## Running it

- `npm run execution:study` — read-only; v1 plus the one-sided section in output/EXECUTION-STUDY.md and .json. The arm runs only here: the engine's calibration worker skips it (`executionStudy(db, asOf)` without `{oneSided:true}`), so the engine does no extra work. On the live journal the worker's study takes 39 ms median, against 40 ms before this change and 72 ms with the arm on.
- `npm run tape:check` — read-only journal, unsigned public GETs to Kalshi's REST host with redirects refused, about 3 requests a second (~15 min for 145 rounds); output/ONE-SIDED-TAPE-CHECK.md and .json. It shares the network with the engine, so run it when not trading. Options: `--db`, `--through`, `--margin` (ms, default 500), `--markets` (most recent N rounds).

## Possible next steps

- Record the market's tick structure and the unclipped model probability as research-only fields, so pinned classification and censoring do not rest on inference.
- Re-run the tape check periodically; a rising favourite-taker share would mean the capture misses liquidity.
