# Markets advisor: positions, scanner and record for everything beyond Bitcoin

Date: 2026-10-09 · Status: approved in conversation; awaiting written-spec review

## 1. Intent

The user trades more on Kalshi than the two Bitcoin series this app covers. Their account history (`account_raw`) includes NFL, college football and MLB game winners; multivariate combos (`KXMVECROSSCATEGORY`, bought at 0.16–3¢, 4 of 4 settled ones lost); and Solana and gold 15-minute markets. One 8-leg combo is open now. They want the advisor to become a proper tool for all of Kalshi:

- **Monitor**: every open non-Bitcoin position, live, with alerts.
- **Advise**: hold-or-sell math for each position, plus a scanner over markets they could trade.
- **Learn**: collect data from launch and score every hint, so advice improves only where evidence backs it.

User decisions (2026-10-09):
- Monitor and scanner have equal priority.
- Outside reference prices come from free sources.
- Covered categories: sports singles, combos, politics & economics, commodities & other crypto.
- Architecture: a separate process.

**Constraints carried over from earlier work (memory, DECISIONS 37):**
- **Read-only.** No order placement. The app shows data, not tips. Claude is not a licensed financial advisor, so the UI frames everything as market data and arithmetic.
- **No edge claim without settled evidence.** Every scanner flag type stays *unproven* until ≥ 100 settled trades with a 95% range above zero and both halves of the sample positive (the final-minute study's bar).
- **The Bitcoin engine's 4 Hz loop must not slow down.** That is why this runs in a separate process.

**Non-goals:**
- Placing orders.
- A forecasting model for sports or politics outcomes.
- Changing the Bitcoin pages, apart from the shared nav item and the shared Markets sound category.

## 2. User-facing design

Nav gets one new item, **Markets**, which has three tabs. Each tab has category filter chips: All · Sports · Combos · Politics & economics · Commodities & crypto.

Category mapping uses Kalshi's `category` on the series:
- **Sports** → Sports
- **Combos** → any market with `mve_collection_ticker` / `mve_selected_legs`
- **Politics & economics** → Politics, Elections, Economics, Financials, World, Companies, Health, Science and Technology, Mentions, Entertainment, Social, Climate and Weather, Transportation and anything else not listed here
- **Commodities & crypto** → Commodities, Crypto (KXBTC15M and KXBTCD excluded)

### 2.1 Positions (`/markets`)

**Summary strip.** Four totals:
- total at risk (cost incl. fees);
- P&L if everything were sold at the bid now;
- value if held at market odds;
- today's realized P&L outside Bitcoin (America/Los_Angeles day, same as the guardrails).

**One card per open position.** KXBTC15M and KXBTCD are excluded, with a small link to their pages if any are open. Each card shows:
- **Header.** A plain-language title from the market and event titles, e.g. "Iowa beats Washington — YES". Side, contracts, and average cost per contract including the entry fees actually paid. Cost is FIFO over open fills, reusing the `OpenCost` logic from `account.ts`.
- **Live numbers.**
  - YES/NO bid and ask.
  - **P&L if sold now:** contracts × own-side bid − taker fee − cost.
  - **Value if held:** contracts × market-implied P(win) at the mid.
  - Settlement countdown, using `expected_expiration_time` and also the game start time when one can be derived.
  - A price sparkline since entry, from stored snapshots.
- **Reference.** The matched outside probability (sportsbook consensus or Polymarket), its age, and the gap to Kalshi's mid. Unconfirmed political matches show as grey "possible match" text.
- **Hold-or-sell verdict.**
  - Hold value uses the market mid by default, or the fresh reference probability when one is matched and confirmed. Both numbers are shown.
  - **SELL BEATS HOLD** appears only when (bid − fee) − P(win) ≥ 2¢ per contract, the existing `exitMargin`. Otherwise the verdict is HOLD.
  - With market odds alone the verdict is almost always HOLD, because selling costs half the spread plus the fee. That is correct, and the UI says so in one line. It flips mainly when an outside reference disagrees with Kalshi.
- **Heads-up notices.** The same triggers and hysteresis as Bitcoin hold mode, reusing the pure functions in `src/engine/exits.ts` where they generalise:
  - a gain past the ride level;
  - giving back half of such a gain;
  - a loss past −50%;
  - win chance down 25 points since entry.
  
  Each is logged.
- **Combos.**
  - A leg table: leg title, side, status (won / lost / live / upcoming), and bid/ask/mid.
  - **Independence value:** the product of each leg's own-side mid, with won legs = 1. A lost leg makes the combo **DEAD**: alerts stop and the card collapses to "settles at 0".
  - When two or more legs share an event or a game (e.g. a team win and that game's total), the card shows a **correlated legs** caveat and labels the independence value "rough".
  - The combo's own bid/ask (often a 0.1¢ bid) is shown next to the independence value and the user's cost.
  - An extra notice fires when one live leg remains.

### 2.2 Scanner (`/markets/scan`)

A ranked list of open markets. Each row shows:
- the reason badge or badges;
- the market and event title, and category;
- YES bid/ask, spread, 24-h volume, close time;
- the reference probability and the gap after fees, when a reference exists;
- the flag type's evidence badge: *unproven*, or its result with range;
- a link to the market on kalshi.com.

| Flag type | Fires when | Cooldown |
|---|---|---|
| `ref-gap-yes` / `ref-gap-no` | A fresh, confirmed or auto-matched reference probability exceeds Kalshi's ask for that side plus the taker fee by ≥ 4¢ | Per market/side, 6 h; re-flags only if the gap grows by ≥ 2¢ |
| `move-1h` | The YES mid moved ≥ 10¢ within an hour on ≥ $500 traded in that hour, with no reference move. Display-only context (no side). It is still recorded and scored as both "follow" and "fade" | — |
| `combo-mispriced` | A combo's YES ask is below its independence value by ≥ 30% relative, or its YES bid is above it by ≥ 30%. Only for combos the user holds or that appear in Kalshi's open MVE listing for series the user has traded. Correlated-leg combos never flag | — |
| `category-bias` | The market's category × price bucket has a backfilled calibration gap whose 95% range excludes zero (e.g. sports longshots under 5¢ win less often than priced) | — |

Rows are ranked by the gap in ¢ after fees; flags with proven results rank first. The list is limited to markets with ≥ $1,000 of 24-h volume, or ones the user holds.

### 2.3 Record (`/markets/record`)

- **Your record.** Non-Bitcoin P&L, win rate and return on money spent, by category and by entry-price bucket (0–5¢, 5–20¢, 20–50¢, 50–80¢, 80–100¢). Combos get their own row.
- **Kalshi's accuracy.** Per category × price bucket, from backfill plus live data: implied vs actual win rate with a Wilson 95% range, and n.
- **Flag results.** Per flag type × category: settled n, profit per contract after fees with a 95% market-clustered bootstrap range, first and second half, and the proven/unproven state.
- **Who's more accurate.** Brier scores of Kalshi mid vs each reference source on matched, settled events, at the last snapshot ≥ 1 h before close.

## 3. Architecture

```text
Kalshi REST (read-only, signed for /portfolio) ─┐
Polymarket Gamma/CLOB (public)                  │
The Odds API (free key)                         ├─► markets process (tsx, 127.0.0.1:3002)
EIA (optional free key) · Coinbase spot (public)│     ├ sources/*  (fetch + rate budget)
                                                ─┘     ├ pure core: combos, hold/sell, devig, matching, flags, scoring
                                                       ├ journal → data/markets.db (WAL)
                                                       └ HTTP /state, /record, /match  +  WS /ws (1 Hz)
                                                                │
                                   scripts/web.ts: /api/markets/* and WS /markets-ws (same auth rules)
                                                                │
                                         /markets · /markets/scan · /markets/record
```

**Process and files.** New directory `src/markets/`. It imports existing code rather than copying it:
- the Kalshi client and signing (`src/engine/feeds/kalshi.ts`);
- fees (`src/engine/model/fees.ts`);
- account normalisation and FIFO cost (`src/engine/account.ts`);
- exit-notice functions (`src/engine/exits.ts`).

Where those modules are coupled to the Bitcoin engine, the shared part is extracted into a pure function with tests. Unrelated refactors are out of scope.

| Unit | Responsibility | Pure? |
|---|---|---|
| `src/markets/index.ts` | Boot, schedulers, HTTP/WS server, state assembly | no |
| `src/markets/kalshi-data.ts` | Positions/fills/settlements sync; market + leg polling; event sweep; series metadata cache (category, fee type/multiplier) | no |
| `src/markets/sources/polymarket.ts` | Active markets list + prices | no |
| `src/markets/sources/odds.ts` | Odds per sport; reads `x-requests-remaining`, enforces monthly budget | no |
| `src/markets/sources/eia.ts` | WTI/Brent daily, US regular gasoline weekly (stage 5) | no |
| `src/markets/combos.ts` | Leg parsing, status, independence value, correlation detection, DEAD/one-left | yes |
| `src/markets/holdsell.ts` | Cost, P&L if sold, hold value, verdict with margin, notices (wraps exits.ts) | yes |
| `src/markets/devig.ts` | Multiplicative de-vig per book, median consensus across books | yes |
| `src/markets/matching.ts` | Sports: ticker → (league, date, teams) ↔ Odds API event via team table. Politics: title similarity → candidates | yes |
| `src/markets/teams.ts` | Team-code ↔ name table per league, generated from observed tickers and extended by tests | data |
| `src/markets/flags.ts` | Flag rules + cooldowns | yes |
| `src/markets/scoring.ts` | Flag P&L, Wilson/bootstrapped ranges, calibration buckets, Brier comparisons, proven bar | yes |
| `src/markets/journal.ts` | `data/markets.db` schema, writes, pruning, queries | no |
| `scripts/markets-backfill.ts` | Resumable 90-day backfill of settled non-Bitcoin markets (public GETs) | no |
| `src/app/markets/{page,scan/page,record/page}.tsx`, `src/components/markets/*` | UI, following the existing instrument-panel style (DECISIONS 18) | — |

**Schedules and budgets.** All Kalshi requests go through one serial limiter capped at 5 req/s, with 429 backoff. That leaves most of the account's read allowance to the Bitcoin engine.

| Job | Interval |
|---|---|
| Positions, fills and settlements sync | 30 s, and on demand after a detected position change |
| Held markets + all their combo legs | 5 s |
| Price snapshots of held markets/legs to DB | 30 s |
| Open-event sweep (`/events?status=open&with_nested_markets=true`, combos excluded) | 5 min |
| Scanner-set snapshots (top ~2,000 by 24-h volume + held) | 5 min |
| Polymarket | 5 min |
| Odds API | Budgeted: games the user holds every 30 min within 3 h of start; otherwise each tracked league every 6 h; stop non-held fetches when remaining < 50 |
| EIA | Daily |
| Settlement check for flagged/held/snapshotted markets | 15 min |
| Backfill refresh (child process, below-normal priority, like the backtest) | Daily |

**Live transport.**
- The process pushes a compact `MarketsState` at 1 Hz on its own `/ws`: summary, positions with combos, source health, notices.
- The scanner list and the record are fetched over HTTP (`/api/markets/scan` every 60 s while the tab is open; `/api/markets/record` once a minute), following DECISIONS 28.
- `scripts/web.ts` adds an `/api/markets/` HTTP proxy and a `/markets-ws` upgrade proxy to port 3002, with the same `authorized()` and origin checks.
- A `useMarketsLive()` hook mirrors `useLive()`.

**Supervision.**
- `scripts/trade.mjs` supervises a third child, `markets`.
- `dev:all` adds `tsx watch src/markets/index.ts`.
- The desktop launcher needs no change.
- `MARKETS_PORT` (default 3002) goes in `.env.example`.

**Sound.** A new **Markets** category in the sound panel, on by default, with its own toggle. The Bitcoin pages also open a lightweight `/markets-ws` subscription, used only for notice transitions, so Markets alerts play on any page.

New sounds:
- a Markets notice (reusing the hold-mode notice voices);
- **combo DEAD** (a falling tone);
- **one leg left**.

## 4. Data model (`data/markets.db`, WAL, synchronous=NORMAL)

| Table | Key columns |
|---|---|
| `markets` | ticker PK, event_ticker, series_ticker, category, group (sports/combos/politics/commodities), title, subtitle, close_time, expected_expiration, rules_url, is_combo, legs_json, result, settled_at, first_seen |
| `snapshots` | ticker, time, yes_bid, yes_ask, last, volume_24h, open_interest, held (bool), PK(ticker,time) |
| `refs` | source, ref_id, time, prob_yes, raw_json; index (source,ref_id,time) |
| `matches` | ticker, source, ref_id, method (auto/suggested), status (auto/suggested/confirmed/rejected), score, decided_at |
| `flags` | id, time, ticker, type, side, kalshi_price, fee, ref_prob, gap, context_json, result (null until settled), pnl_per_contract |
| `notices` | time, ticker, kind, context_json |
| `backfill` | ticker PK, category, group, close_time, result, price_t24h, price_t1h, price_close, is_combo, legs_json |
| `meta` | key/value (odds budget, last sweep, backfill cursor, schema version) |

**Pruning.**
- Snapshots of non-held markets are kept at full resolution for 14 days, then thinned to one per hour.
- Held markets' snapshots, and any market with a flag, are kept forever.
- Expected size is ~20–25 MB/day before thinning.

## 5. Matching rules

**Sports (auto).**
- Kalshi game tickers encode league, date and team codes, e.g. `KXNCAAFGAME-26OCT10USCPSU-USC`.
- `teams.ts` maps codes to The Odds API team names for each league.
- A match needs the same league, a commence date within ±1 day of the ticker date, and both teams mapped.
- Any ambiguity (two candidates, or an unmapped team) gives no match and logs the unmapped code, so the table can be extended.
- Totals and spreads match only when the line is equal.

**Politics, economics and events (suggested → confirm).**
- Candidates are Polymarket active markets ranked by token-set similarity of titles, plus close dates within 7 days.
- The best candidate with a score ≥ 0.6 is stored as `suggested` and shown grey with ✓/✗ buttons (`POST /api/markets/match`).
- Only `confirmed` or sports-`auto` matches feed flags, hold values and accuracy scoring.
- Every match shows both rule links. Unconfirmed ones say "different rules possible".

**Commodities (stage 5).** EIA series are shown as "spot vs strike" context on WTI and gas markets. They are not converted into a probability, so they never feed flags.

**Other crypto (stage 5).**
- KXSOL15M/KXETH15M-style markets are priced by the existing diffusion model, fed by public Coinbase and Kraken spot.
- Implementation must verify each series' settlement index and averaging rules (via `/series/{ticker}` rules) and refuse to model a series whose rules differ from the Bitcoin 15-minute ones.

## 6. Error handling

- Each source has a health record: last success, last error, age. Health is shown in a source strip on every Markets tab.
- **Stale data:**
  - a Kalshi market quote older than 30 s greys out the hold/sell math on that card;
  - a reference older than 2× its refresh interval (or 2 h for odds) is marked stale and never fires flags.
- A source failing or hitting its budget degrades to "no reference" for that source. Nothing else is blocked.
- **Odds budget:**
  - read from response headers and persisted in `meta`;
  - once the monthly budget is exhausted, the strip says so and lists the date it resets.
- **Kalshi failures:**
  - 429s back off and are journaled;
  - auth failures show "Kalshi credentials unavailable": positions are hidden, while the scanner and record keep working on public data.
- **Process unavailable:** if `/markets-ws` is down, the Markets pages show "markets engine offline" with the last update time. The Bitcoin pages are unaffected.
- **Incomplete combos:** missing legs (e.g. an unknown market) make the independence value "unavailable". It is never computed from partial data.

## 7. Testing and verification

Unit tests (vitest), pure modules first:
- `combos`:
  - all-live legs, legs already won or lost, a missing leg;
  - correlation detection (shared event);
  - the user's real open combo as a fixture: 8 legs, 1 won, value ≈ 0.62¢ at 2026-10-09 mids.
- `holdsell`:
  - fee via the existing fee functions with series multipliers;
  - FIFO cost with actual fees;
  - verdict margin and notice hysteresis (reusing the existing exits tests' cases).
- `devig`: two-way and three-way markets; consensus median.
- `matching`:
  - real ticker samples from `account_raw` (NFL, NCAAF, MLB);
  - an ambiguous case → no match;
  - title similarity thresholds.
- `flags`: each rule, its cooldowns, and stale-reference suppression.
- `scoring`:
  - Wilson and bootstrap ranges;
  - the proven bar (n ≥ 100, CI > 0, both halves > 0);
  - calibration buckets.
- `journal`: schema creation, pruning that keeps held and flagged markets.

Live verification, recorded in `docs/VERIFICATION.md`:
- the user's open combo shows legs and value;
- a real sports market matches an Odds API event;
- a Polymarket suggestion shows and can be confirmed;
- the source strip shows health;
- the process restarts under `npm run trade`;
- the Bitcoin engine's loop timing (`loopMs`) is unchanged with the markets process running;
- the pages are checked in the built-in browser at `127.0.0.1:3000/markets` (local auth off).

## 8. Delivery stages

Each stage ships usable on its own and ends with `npm run check` green.

1. **Positions.** The markets process, journal, Kalshi data, combos, hold/sell, notices with sound, snapshots, web proxy, supervision, and the `/markets` Positions tab.
2. **Record.** The backfill script plus daily refresh, and the Record tab: your record plus Kalshi accuracy.
3. **References.** Odds API and Polymarket sources, de-vig, matching with ✓/✗, references on position cards, and accuracy comparisons.
4. **Scanner.** The event sweep, flags with scoring, and the Scanner tab.
5. **Commodities & other crypto.** EIA context, and SOL/ETH model pricing (after verifying the rules).

**Setup the user does themselves** (before stage 3):
- create a free The Odds API key, and optionally an EIA key;
- put them in `.env.local` as `ODDS_API_KEY` and `EIA_API_KEY`;
- both are optional: without them, those sources show "no key".

## 9. Decisions to record in DECISIONS.md when built

- A separate process instead of in-engine. Reason: the 4 Hz loop's stall history (DECISIONS 25, 41).
- Hold value uses market odds unless a confirmed reference exists, so SELL BEATS HOLD is rare by design.
- The independence value is a rough upper bound when legs correlate; correlated combos never flag.
- Scanner flags are paper-scored; the proven bar matches the final-minute study.
- Odds API budget policy.
- Polymarket matches need user confirmation because settlement rules differ across venues.
