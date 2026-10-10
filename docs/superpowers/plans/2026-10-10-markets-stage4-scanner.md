# Markets Stage 4: Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Scanner tab at `/markets/scan` that ranks liquid open Kalshi markets the user could trade.
- **Why it's listed:** each row shows its reason (a gap to an outside price, a sharp 1-hour move, or a price band with a proven history).
- **Paper-scored:** every flag is traded on paper and scored when its market settles.
- **Unproven by default:** every flag type is labelled "unproven" until it meets the bar: n ≥ 100, a 95% range above zero, and both halves positive.
- **Record tab:** shows the flag results.

**Architecture:**
- **Pure units:** `src/markets/flags.ts` (flag rules and cooldowns) and `src/markets/scoring.ts` (paper P&L, stats, the proven bar).
- **Orchestrator:** `src/markets/scanner.ts` sweeps open markets of the chosen series every 5 min, keeps the liquid ones, snapshots them, gets Polymarket references for the sports ones (through `References`), raises flags, stores them and builds the rows.
- **Journal:** flags and settlement.
- **Process and UI:** `GET /scan`, and a Scanner tab in `MarketsNav`.

**Spec:** `docs/superpowers/specs/2026-10-09-markets-advisor-design.md` §2.2 (scanner, flag table), §2.3 item 3 (flag results), §3 schedules, §4 `flags`, stage 4 of §8.

## Research (2026-10-10)

- **Universe:**
  - The top 20 series by lifetime volume in each group (stage 2 choice, Bitcoin and combos excluded) have 6,540 open markets.
  - Only 310 of those traded ≥ $1,000 in the last 24 h (`volume_24h_fp × mid`).
  - Listing them all takes 62 requests (~18 s at 5/s), so a 5-minute sweep is affordable.
- **Kalshi links:** `https://kalshi.com/markets/{series}/x/{event}` (lower case) redirects to the event page. Verified in the browser for two NFL events.
- **Combos never trade publicly** (stage 2), so there is no combo flag. This is ruling 1 below.

## Rulings carried in

1. **`combo-mispriced` is dropped.** Combos are priced by request-for-quote; there is no public book to scan, and settled combos show zero volume. Cost if wrong: a flag type the user never sees.
2. **Outside references in the scanner are Polymarket sports auto-matches only.**
   - No title searches for scanner markets: about 300 per sweep, each needing a ✓ that nobody would give.
   - The Odds API stays for held positions only, to protect the 500-per-month quota.
   - `References.refresh` learns which entries are held.
   - Cost if wrong: fewer `ref-gap` flags outside sports.
3. **`move-1h` excludes commodities & crypto.** Their price follows a spot price; a 10¢ move is the underlying moving, not news. Cost if wrong: fewer flags there.
4. **`category-bias` uses the stage 2 tables at 24 h before.** It fires only for a band with n ≥ 200 whose YES-return 95% range excludes zero. It trades the side opposite a losing YES or the same side as a winning one, and it is scored like every other flag. Cost if wrong: a flag type that shows itself unproven.

## Global Constraints

- **Scanner set:** open markets of the chosen series, plus the user's traded series, plus held markets. A market must have 24 h dollar volume ≥ $1,000 or be held. At most the 2,000 largest. Snapshotted every 5 min with `held=0`, unless held. Stage 1 pruning keeps 14 days.
- **`ref-gap-yes`/`ref-gap-no`:**
  - Needs a trusted, fresh reference.
  - Edge = ref chance of the side − (that side's ask + taker fee at the ask) ≥ 4¢.
  - Cooldown 6 h per market and side, unless the edge grows by ≥ 2¢.
- **`move-follow`/`move-fade`:**
  - The YES mid now vs the snapshot 55–65 min ago moved ≥ 10¢.
  - The hour's dollar volume (Δ cumulative `volume_fp` × mid) is ≥ $500.
  - If the market has a reference that moved ≥ 5 pts the same way, the move is explained and there is no flag.
  - Both rows are stored: follow buys the side that rose; fade buys the other side. Each at its ask.
  - Cooldown 6 h per market.
- **`bias-yes`/`bias-no`:** as in ruling 4. Cooldown 24 h per market.
- **Paper trade:** one contract at the flagged side's ask plus the taker fee (`takerFee`). P&L at settlement = (1 if the side won else 0) − ask − fee.
- **Scoring:**
  - per flag type × group: n settled, distinct markets, mean P&L per contract;
  - a 95% bootstrap range clustered by event (`clusterCI`);
  - first-half and second-half means by flag time;
  - proven = n ≥ 100 && low > 0 && first > 0 && second > 0.
- **Ranking:** markets with a proven flag first, then by best edge (ref-gap edge in ¢, move size, |bias return| × 0.1). One row per market, with its badges.
- **Copy:** "flag", "unproven", "paper result". The page says these are measured hints, not recommendations, and that a flag only becomes evidence after 100 settled trades.
- **UI:** the same family as Markets (`MarketsNav` gains Scanner). Rows go in a table in a `Card` with `overflow-x-auto`. Badges are `Pill`s: ref-gap = `yes`, move = `warn`, bias = `neutral`. Evidence is `text-xs`. Link: "Open on Kalshi" (`target=_blank rel=noreferrer`).

## Review Focus

1. **A flag must never be scored on a market Kalshi voids or settles to a non-binary value** (no `yes`/`no` result). It stays unsettled and is excluded. Test in Task 2.
2. **The Odds API must not be called for leagues the user only scans.** Test in Task 3.
3. **A re-flag inside the cooldown must not create a duplicate paper trade.** Test in Task 1.
4. **The sweep fails halfway (Kalshi 503):** the previous scanner rows remain, marked with their age. Test in Task 3.
5. **No flag on a market whose ask is missing** (nothing to buy). Test in Task 1.

---

### Task 1: Flag rules (pure)

**Files:** Create `src/markets/flags.ts`; Test `tests/markets-flags.test.ts`

**Interfaces:**
- `type FlagType='ref-gap-yes'|'ref-gap-no'|'move-follow'|'move-fade'|'bias-yes'|'bias-no'`
- `interface Flag {time:number;ticker:string;event:string;group:Group;type:FlagType;side:'yes'|'no';price:number;fee:number;edge:number;context:Record<string,unknown>}`
- `interface LastFlag {time:number;edge:number}`; `type LastLookup=(ticker:string,type:FlagType)=>LastFlag|null`
- `refGapFlags(m:{ticker,event,group,yesAsk,noAsk},refYes:number,now,last:LastLookup):Flag[]`
- `moveFlags(m:{ticker,event,group,yesAsk,noAsk},mids:{t:number;mid:number;volume:number|null}[],refMove:number|null,now,last):Flag[]`
- `biasFlags(m:{ticker,event,group,yesAsk,noAsk,mid},tables:AccuracyTables|null,now,last):Flag[]`

**Tests:**
- **ref-gap:**
  - ref .70 with yes ask .60 (fee ≈ 1.7¢) gives edge ≈ 8.3¢ → `ref-gap-yes`;
  - an edge of 3¢ gives none;
  - a NO side is computed from the no ask;
  - a missing ask gives none;
  - inside the 6 h cooldown nothing is raised unless the edge grew by ≥ 2¢;
  - after 6 h it is raised again.
- **move:**
  - mids .40 → .52 over 60 min with Δvolume × mid ≥ $500 gives follow = YES at the yes ask, fade = NO at the no ask;
  - a move of 8¢ gives none;
  - volume below $500 gives none;
  - a reference that moved +6 pts the same way gives none;
  - commodities give none;
  - no snapshot 55–65 min ago gives none.
- **bias:**
  - the sports p24 band 0–5¢ with n ≥ 200 and a range entirely below 0, at mid .03, gives `bias-no` at the no ask;
  - a band whose range crosses 0 gives none;
  - n < 200 gives none;
  - a 24 h cooldown applies.

**Steps:**
1. Write the tests.
2. Run them to make sure they fail.
3. Implement.
4. Run them to make sure they pass.
5. Commit with "markets flags: ref-gap, 1-hour move and price-band rules with cooldowns".

### Task 2: Scoring and journal (pure plus storage)

**Files:**
- Create: `src/markets/scoring.ts`
- Modify: `src/markets/journal.ts`
  - a `flags` table;
  - a `volume` column on `snapshots` via `ALTER TABLE` when missing;
  - `awaitingResult` includes flagged markets.
- Test: `tests/markets-scoring.test.ts`

**Interfaces:**
- **Journal:**
  - `putFlags(flags:Flag[])`
  - `lastFlag(ticker,type):LastFlag|null`
  - `openFlagTickers():string[]`
  - `settleFlags(ticker,result:'yes'|'no',now)`, which sets `result` and `pnl = (won?1:0) − price − fee` for that market's unsettled flags
  - `flagRows(since?):FlagRow[]`
  - the snapshot row gains `volume:number|null`
- **Scoring:**
  - `interface FlagStats {type:FlagType;group:string;n:number;markets:number;mean:number|null;low:number|null;high:number|null;first:number|null;second:number|null;proven:boolean}`
  - `flagStats(rows:FlagRow[]):FlagStats[]`: settled rows only, grouped by type × group plus type × 'all'
  - `evidence(stats,type,group):FlagStats|null`

**Tests:**
- `settleFlags` P&L for won and lost flags.
- A market with no binary result is never settled: `settleFlags` is not called and its rows stay out of `flagStats`.
- The proven bar is met only with n ≥ 100, low > 0 and both halves > 0, checked on a synthetic 120-row set with mean +3¢ and modest variance → proven. Flip the second half negative → not proven.
- The cluster range uses events, not rows.
- `awaitingResult` includes a flagged market past its close.

**Commit:** "markets scoring: paper P&L for flags, event-clustered ranges, proven bar".

### Task 3: Scanner orchestrator

**Files:**
- Create: `src/markets/scanner.ts`
- Modify: `src/markets/references.ts` (`HeldRef.held:boolean`; the Odds API only for leagues with a held entry; non-sports search only for held)
- Test: `tests/markets-scanner.test.ts`

**Interfaces:**
- `class Scanner {constructor(client:Pick<KalshiClient,'get'>,journal,refs:References,data:Pick<MarketsData,'kalshiGame'|'held'>,log);sweep(now:number):Promise<void>;rows(now):ScanRow[];updated:number;error:string|null}`
- `interface ScanRow {ticker,event,series,title,yesLabel,group,yesBid,yesAsk,spread,volume24h,dollarVolume,closeTime,ref:{source,prob,gap:number|null}|null,flags:{type,side,edge,time,evidence:FlagStats|null}[],url,score}`
- **Sweep:**
  1. list the open markets of `pickSeries(series,traded,20)` (series cached 6 h);
  2. parse and filter by dollar volume ≥ $1,000, or held;
  3. sort by dollar volume and take the top 2,000;
  4. snapshot them;
  5. build `HeldRef` (sports only, `held` true for held tickers) and refresh references;
  6. compute flags with `lastFlag`, `accuracy` (meta) and snapshot mids from the last 70 min (journal `recentMids`);
  7. `putFlags`;
  8. keep the market list for `rows()`.

  On an error the previous list stays, and `error` and `updated` say so.

**Tests (fake client and fake references):**
- A sweep keeps liquid and held markets only, and snapshots them.
- A ref-gap flag is raised once and not duplicated on the next sweep within the cooldown.
- The Odds API is not called for a league that only appears in the scan.
- A 503 midway keeps the previous rows, with `error` set.
- Rows rank a proven flag before a larger unproven one.
- The URL format is `https://kalshi.com/markets/kxnflgame/x/kxnflgame-…`.

**Commit:** "markets scanner: 5-minute sweep, liquid set, references, flags, ranked rows".

### Task 4: Process wiring

**Files:** Modify `src/markets/index.ts`, `src/markets/kalshi-data.ts` (`settleCheck` also settles flags)

- Run `scanner.sweep` every 5 min, the first time 2 min after boot.
- `GET /scan` returns `{rows,updated,error,stats:flagStats(journal.flagRows())}`, built at most once a minute.
- `settleCheck`: for each fetched market with a result, call `journal.settleFlags`. `awaitingResult` now includes open flags.
- `/record` gains `flags: flagStats(...)`.
- Smoke on a side instance: `/scan` returns rows from live data.
- **Commit.**

### Task 5: UI

**Files:**
- Create: `src/app/markets/scan/page.tsx`, `src/components/markets-scan.tsx`
- Modify: `src/components/markets-nav.tsx` (Scanner section), `src/components/markets-record.tsx` ("Flag results" card)

- **Scanner page:** the same holder as Record. Fetch `/api/markets/scan` every 60 s. `MarketsNav current="scan"` with the category chips (no counts).
  - Explainer `Card`: what a flag is, the proven bar, "not recommendations".
  - Table:
    - **Why** — badges, with the evidence beneath ("unproven · 12 settled" or "+2.1¢ (0.4 to 3.9) · 140 settled")
    - **Market** — title plus YES label, with a link
    - **Category**
    - **Bid / ask**
    - **Spread**
    - **24 h volume** ($)
    - **Closes**
    - **Outside** — ref % and gap
  - Empty and error states as on Record.
- **Record:** a "Flag results" table per type with n, markets, mean and range, halves, and proven or unproven.
- Typecheck, build, and a browser check at desktop and 375 px. Self-check against the checklist.
- **Commit.**

### Task 6: Docs and verification

- README: a Scanner bullet.
- DECISIONS 49: the rulings, thresholds and cooldowns.
- VERIFICATION: the live sweep counts and first flags.
- Merge.
