# Markets Stage 3: Outside References Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every held non-Bitcoin market, and every leg of a held combo, gets an outside reference probability when one can be matched:
- **Polymarket** (public, no key): sports games and totals, plus politics and other events.
- **Sportsbook consensus** from The Odds API: only when `ODDS_API_KEY` is set.

The position card shows the reference next to Kalshi. A trusted reference (sports auto-match, or a match you confirmed) feeds the hold value and the hold-or-sell verdict. Combos are also valued at outside odds. Non-sports matches are suggested with ✓/✗. Reference snapshots are stored, so the Record tab can compare accuracy as matched markets settle.

**Architecture:** New pure modules: `src/markets/teams.ts` (team-name matching), `src/markets/devig.ts`, `src/markets/match.ts` (Kalshi market → reference market) and `src/markets/similarity.ts` (title similarity). Source fetchers: `src/markets/sources/polymarket.ts` and `src/markets/sources/odds.ts`. Matches and reference snapshots live in `data/markets.db`. `src/markets/holdsell.ts` and `src/markets/state.ts` consume a `Reference`. A new `POST /match` endpoint stores ✓/✗. The position card and combo legs show the references.

**Spec:** `docs/superpowers/specs/2026-10-09-markets-advisor-design.md` §2.1 (Reference, hold value), §2.3 item 3, §3 (sources and budgets), §5 (matching rules), §6 (stale data and source health), stage 3 of §8.

## Research findings (2026-10-09) that shape this plan

- **Polymarket Gamma** (`https://gamma-api.polymarket.com`), no key:
  - `GET /events?active=true&closed=false&tag_slug=<league>&end_date_min&end_date_max&limit=500` lists game events. League slugs: `nfl`, `cfb`, `mlb`, `nba`, `nhl`, `wnba`, `cbb`.
  - Each game event has markets with a `sportsMarketType`: `moneyline` (outcomes are the two team names), `totals` (with `line`, outcomes Over/Under), `spreads`, and many props.
  - Markets carry `bestBid`/`bestAsk` for outcome 0, `outcomePrices`, and `gameStartTime`.
  - The slug looks like `cfb-iowa-wash-2026-10-09`.
  - `GET /public-search?q=…` returns `{events:[…]}` for text search.
- **Kalshi vs Polymarket naming:**
  - Kalshi event titles: "PHI Eagles vs JAC Jaguars" (NFL), "Chicago WS vs Cleveland" (MLB), "New York R vs Washington" (NHL), "Florida St. vs Louisville" (CFB).
  - Polymarket titles: "Eagles vs. Jaguars", "Chicago White Sox vs. Cleveland Guardians", "Flyers vs. Bruins", "Iowa vs. Washington".
  - Codes differ too (Kalshi JAC, Polymarket jax). Matching therefore uses every name string either side gives (codes, words, initials) and requires both teams to pair uniquely inside a game-time window.
- **Kalshi game time:** `expected_expiration_time` ≈ the end of the game (stage 2 finding). Polymarket `gameStartTime` is the start. A candidate's start must fall within [Kalshi expected end − 8 h, Kalshi expected end + 1 h].
- **The user's open 8-leg combo is fully covered by Polymarket:** 7 college-football moneylines plus the Georgia–Alabama O/U 51.5 (Polymarket Over 0.485 vs Kalshi mid 0.475).
- **`ODDS_API_KEY` is not set yet.** The Odds API source is built against fixtures; its live check waits for the key. The budget policy is the spec's: only sports the user holds, every 30 min within 3 h of a held game, otherwise every 6 h, `h2h,totals`, and no fetch when fewer than 50 requests remain.

## Global Constraints

- Read-only everywhere. Outside sources get no credentials except the Odds API key, which goes only to `api.the-odds-api.com`. Use `redirect:'error'` and a 10 s timeout, as the Kalshi client does.
- **References are trusted only when the match is `auto` (sports, unique pairing) or `confirmed` (the user's ✓).** `suggested` matches are shown in grey and never change values or verdicts.
- **Stale references never count:** Polymarket older than 15 min, Odds API older than 2 h (spec §6). They are shown as stale.
- **A reference market only counts when it is tradable:** spread ≤ 10¢, or no book at all but a last price. Otherwise there is no reference.
- Spreads (handicaps) and props are not matched in stage 3. Only moneyline and full-game totals with an exactly equal line.
- **The Odds API is optional:** without the key the source shows "no key" and is never called.
- **Hold value with a trusted reference uses the reference probability, and the card shows both numbers.** SELL BEATS HOLD uses the same margin rule as stage 1, measured against that probability.
- **UI follows the stage 1 checklist.** The reference line is `text-sm` with `num` values. Source names: "Polymarket" and "Sportsbooks". ✓/✗ are `Button size="sm"` (`variant="outline"` and `variant="ghost"`) with aria-labels. Links open the reference market in a new tab with `rel="noreferrer"`.

## Review Focus

1. **Two games on one day with a shared team-name word** (e.g. "Iowa" and "Iowa State" both playing): the match must be unique on both teams, or there is none. Never a wrong pairing. Test in Task 1.
2. **A Kalshi market whose reference has gone stale or whose book is too wide:** it falls back to Kalshi odds, and the card says why. Test in Task 4.
3. **The user rejects a suggestion:** it is never suggested again for that Kalshi market, even after a restart. Test in Task 3.
4. **The Odds API returns 401/429, or the budget runs out:** the source shows its state, no further calls are made, and nothing else breaks. Test in Task 3.
5. **A combo where only some legs have references:** its outside value uses each leg's reference where trusted and Kalshi otherwise, and labels the mix. Test in Task 4.

---

### Task 1: Team and game matching (pure)

**Files:** Create `src/markets/teams.ts`, `src/markets/match.ts`; Test `tests/markets-match.test.ts`

**Interfaces:**
- `normTokens(s:string):string[]`: lower-case; split on non-letters/digits; drop stop words (`vs`, `the`, `fc`, `game`, `winner`, `st`, `state`, `university`, `of`); keep tokens of 2 or more characters.
- `teamMatches(kalshi:string[],ref:string[]):boolean`: true when any pair of strings matches. A pair matches on: an equal normalized code (a 2–4 letter token on both sides); or a shared token of 3 or more letters; or the Kalshi token being the initials of consecutive reference tokens (`WS` ↔ `White Sox`).
- `interface RefGame {id:string;league:string;start:number;teams:[string[],string[]];url:string;markets:RefMarket[]}`
- `interface RefMarket {id:string;kind:'moneyline'|'totals';line:number|null;outcomes:string[];probs:number[];spread:number|null}`. `probs[i]` is the outcome's probability: the mid when the spread is ≤ 10¢, else the last/outcome price, else NaN.
- `interface KalshiGame {league:string;expectedEnd:number;teams:[string[],string[]];yesTeam:0|1|null;kind:'moneyline'|'totals';line:number|null;yesIsOver:boolean|null}`
- `matchGame(k:KalshiGame,games:RefGame[]):{game:RefGame;swap:boolean}|null`. Candidates: same league, start in [expectedEnd − 8 h, expectedEnd + 1 h], with Kalshi team 0 matching ref team 0 and team 1 matching team 1, or crossed (`swap`). Exactly one candidate with exactly one assignment is required; otherwise null.
- `refProb(k:KalshiGame,m:{game:RefGame;swap:boolean}):{prob:number;market:RefMarket}|null`:
  - moneyline: the prob of the outcome that is the Kalshi YES team.
  - totals: the market with an equal line; the Over prob if YES is Over.
  - null if the prob is NaN.
- `leagueOf(series:string):string|null`: KXNFL*→nfl, KXNCAAF*→cfb, KXMLB*→mlb, KXNBA*→nba, KXNHL*→nhl, KXWNBA*→wnba, KXNCAAMB*→cbb; else null.

**Tests (written first):**
- The NFL game: Kalshi teams `['PHI Eagles','Philadelphia','PHI']` / `['JAC Jaguars','Jacksonville','JAC']`, expected end 2026-10-11T16:30Z. Polymarket games: `nfl-phi-jax` (start 13:30Z, teams `['Eagles','phi']`/`['Jaguars','jax']`) and `nfl-cin-mia` (start 17:00Z). It matches `nfl-phi-jax` with `swap:false`, and `refProb` for YES = PHI returns outcome 0.
- MLB `['Chicago WS','CWS']` vs `['Chicago White Sox','cws']` matches through the code and through the initials WS. A same-day `Chicago Cubs` game in the window does not create ambiguity, because the other team must match too.
- Two CFB games in the window, "Iowa vs Washington" and "Iowa State vs BYU". Kalshi `['Iowa']/['Washington']` matches only the first. Kalshi `['Iowa']/['Nebraska']` matches neither, so null.
- A candidate outside the time window is ignored. A candidate where only one team matches gives null.
- Totals: Kalshi line 51.5, YES = Over, against Polymarket totals 49.5/51.5/53.5 picks the 51.5 market's Over prob. A line of 52 gives null.
- `leagueOf('KXNCAAFTOTAL')==='cfb'`, `leagueOf('KXATPMATCH')===null`.

**Steps:**
1. Write the tests.
2. Run them to make sure they fail.
3. Implement.
4. Run them to make sure they pass.
5. Commit with "markets match: team-name and game matching across venues".

### Task 2: De-vig and title similarity (pure)

**Files:** Create `src/markets/devig.ts`, `src/markets/similarity.ts`; Test `tests/markets-devig.test.ts`

**Interfaces:**
- `devig(decimalOdds:number[]):number[]`: multiplicative; each implied probability 1/odds, normalized to sum to 1. Returns [] for an invalid input (any odds ≤ 1, or not finite).
- `consensus(books:number[][]):number[]|null`: the median per outcome of the de-vigged books, re-normalized. Null when there are no books.
- `similarity(a:string,b:string):number`: token-set Jaccard on `normTokens`, plus 0.1 when they share a number token (a year or threshold), capped at 1.
- `SUGGEST_MIN=0.6`.

**Tests:**
- `devig([1.91,1.91])` → [.5,.5].
- `devig([1.5,2.8])` sums to 1, with the favourite at ≈0.651.
- Odds ≤ 1 → [].
- The consensus median of 3 books.
- "Will the Fed cut rates in October 2026?" vs "Fed rate cut in October 2026" ≥ 0.6; vs "Will Bitcoin hit 150k in 2026?" < 0.3.

**Commit:** "markets: de-vig consensus and title similarity".

### Task 3: Sources, matches and snapshots

**Files:**
- Create: `src/markets/sources/polymarket.ts`, `src/markets/sources/odds.ts`, `src/markets/references.ts` (the orchestrator)
- Modify: `src/markets/journal.ts` (`matches`, `refs` tables)
- Test: `tests/markets-references.test.ts`

**Journal:**
- `matches(ticker TEXT, source TEXT, ref_id TEXT, method TEXT, status TEXT, score REAL, title TEXT, url TEXT, decided_at INTEGER, PRIMARY KEY(ticker,source))`
- `refs(ticker TEXT, source TEXT, time INTEGER, prob REAL, PRIMARY KEY(ticker,source,time))`
- Methods:
  - `setMatch(m)`, `getMatches(ticker?)`
  - `decideMatch(ticker,source,status:'confirmed'|'rejected',now)`
  - `rejected(ticker,source,refId):boolean`: a rejected `ref_id` is never suggested again.
  - `putRefs(rows)`, `refSeries(ticker,source,since)`

**Sources (thin; take an injected `fetchJson(url)` so tests use fixtures):**
- `polymarketGames(fetchJson,league,from,to):Promise<RefGame[]>`:
  - reads `/events?active=true&closed=false&tag_slug=…&end_date_min=…&end_date_max=…&limit=500`;
  - keeps events with a `moneyline` market;
  - teams: the moneyline outcomes plus the slug codes (`slug.split('-')[1..2]`);
  - markets: moneyline plus `totals`, with `line` and probs from bestBid/bestAsk (outcome 0; outcome 1 = 1 − mid), else `outcomePrices`;
  - url: `https://polymarket.com/event/<slug>`.
- `polymarketSearch(fetchJson,q):Promise<{id,title,prob,url,end}[]>` reads `/public-search?q=…`. Within each event it takes the single market whose question best matches, with prob = the Yes mid.
- `oddsGames(fetchJson,sportKey,key):Promise<{games:RefGame[];remaining:number|null}>`:
  - reads `/v4/sports/{key}/odds?regions=us&markets=h2h,totals&oddsFormat=decimal&apiKey=…`;
  - moneyline probs = the consensus over books;
  - totals = per line, the consensus over books quoting that line;
  - `remaining` comes from the `x-requests-remaining` header (the fetchJson wrapper returns `{body,headers}` for this source).
  - Sport keys: `americanfootball_nfl`, `americanfootball_ncaaf`, `baseball_mlb`, `basketball_nba`, `icehockey_nhl`, `basketball_wnba`, `basketball_ncaab`.

**Orchestrator `References` (`src/markets/references.ts`):**
- `constructor(journal,{oddsKey,fetchJson,log})`
- `refresh(held:{ticker,quote,event:KalshiGame|null}[],now)`:
  - **Sports (`event` present):**
    - fetch the leagues it needs: Polymarket every 5 min, the Odds API on the budget rule;
    - `matchGame` + `refProb`;
    - store `auto` matches;
    - put the probs in a `latest` map (`ticker → {source,prob,time,url,title,status}`);
    - append ref snapshots every 5 min.
  - **Non-sports:**
    - with no match row, run `polymarketSearch(kalshi title)`;
    - store the best result with similarity ≥ `SUGGEST_MIN` as `suggested`, unless rejected;
    - for `confirmed`, refresh that Polymarket market's prob every 5 min.
  - **Source health:** `health():{name,ok,updated,error,detail}[]`. Detail is e.g. "no key", "412 requests left", or "budget reached, resets <date>".
- `reference(ticker,now):Reference|null`, where `Reference={source:'polymarket'|'sportsbooks';prob:number;time:number;stale:boolean;status:'auto'|'confirmed'|'suggested';title:string;url:string}`. Sportsbooks win over Polymarket when both are fresh (lower vig, more books).
- **Odds budget:**
  - persist `oddsRemaining` and `oddsResetAt` (1st of next month UTC) in meta;
  - skip when remaining < 50;
  - on 401, mark "key rejected" and stop until restart;
  - on 429, back off 1 h.

**Tests (fixtures, no network):**
- Polymarket fixture parsing: the moneyline outcome-1 prob = 1 − mid; totals lines.
- The orchestrator stores an `auto` sports match and returns a fresh reference. After 16 min with no refresh it is `stale:true`.
- A non-sports suggestion is stored as `suggested` and reported as not trusted. After `decideMatch(...,'rejected')`, a later refresh with the same search result does not suggest it again. The same holds after re-creating `References` with the same journal (restart).
- Odds API:
  - with no key, no call is made and health says "no key";
  - with remaining 40, no call;
  - a 401 marks "key rejected" and stops further calls.
- Snapshots are written at most once per 5 min per ticker and source.

**Commit:** "markets references: Polymarket and Odds API sources, matches, snapshots, budget".

### Task 4: References in values and verdicts

**Files:** Modify `src/markets/holdsell.ts` (input `reference`), `src/markets/state.ts` (pass references, per-leg references, outside combo value); Test: append to `tests/markets-holdsell.test.ts` and `tests/markets-state.test.ts`

**Rules:**
- `PositionInput.reference?:Reference|null`. Trusted = status `auto` or `confirmed`, not stale, `prob` finite.
- **Single market:** a trusted reference makes `winProb` the reference prob (on the position's side) and `probSource` `'reference'`. `marketProb` keeps the Kalshi value, and `reason` names both numbers ("Polymarket 41.5% vs Kalshi 42.5%"). Otherwise stage 1 behaviour, with a reason suffix when the reference is untrusted ("Polymarket match not confirmed" or "Polymarket price is stale").
- **Combo:** `LegView` gains `ref:number|null` and `refSource`. `ComboView` gains `refValue` (the product using each leg's trusted ref where present, else its Kalshi p) and `refLegs` (how many legs used a reference). The combo's `winProb` uses `refValue` when `refLegs>0`, and the reason says "x of n legs at outside odds".
- **New `PositionView` fields:** `reference`, `marketProb`.

**Tests:**
- A trusted reference changes `holdValue` and the verdict (bid .66 vs ref .55 → SELL BEATS HOLD).
- A suggested or stale reference leaves stage 1 values unchanged, and the reason explains why.
- A NO position uses 1 − ref.
- A combo with 2 of 3 legs referenced: `refValue` equals the product of the two refs and one Kalshi p, and `refLegs` is 2.

**Commit:** "markets: trusted outside references drive hold value and verdict; combos at outside odds".

### Task 5: Process wiring and `/match`

**Files:** Modify `src/markets/index.ts`, `src/markets/kalshi-data.ts` (event titles for team names), `src/markets/state.ts` (`MarketsState.sources`)

- **`kalshi-data`:**
  - `eventInfo(eventTicker)` fetches `/events/{ticker}?with_nested_markets=true` once per event: title, market `yes_sub_title`s and codes.
  - For TOTAL/SPREAD events it uses the sibling GAME event (series `…TOTAL`/`…SPREAD` → `…GAME`, same suffix) for team names.
  - `kalshiGame(quote)` builds a `KalshiGame`:
    - league from `leagueOf`;
    - teams from the event title split on " vs ", each team's market `yes_sub_title` and ticker code;
    - `yesTeam` from the quote's ticker code;
    - totals: `line` parsed from `yes_sub_title` ("Over 51.5 points" → 51.5), `yesIsOver` true.
- **`index.ts`:**
  - `references.refresh(...)` every 60 s for held markets and combo legs. Each source keeps its own rate rule.
  - `buildPositions` gets `reference: t=>references.reference(t,now)`.
  - `state.sources = references.health()`.
- **`POST /match`** with body `{ticker,source,status:'confirmed'|'rejected'}`:
  - Origin check exactly as in the engine (`origin` host must equal the `x-forwarded-host` or `host`);
  - the body is capped at 4 KB;
  - it is logged.
- `web.ts` already forwards POST.

**Tests:** None new; the wiring is covered by the Task 3 and 4 tests. Smoke-run: on a side instance, `curl /state` shows the user's combo legs with Polymarket references. Rule this explicitly in the ledger.

**Commit:** "markets process: references every minute, source health, POST /match".

### Task 6: UI

**Files:** Modify `src/components/position-card.tsx`, `src/components/markets.tsx` (source strip)

UI checklist additions (same family as stage 1):

| Role | Answer |
|---|---|
| Reference line under the cost line | `text-sm`: "{Source} {pct} · Kalshi {pct} · gap {±pts} · {age} ago". `Pill tone="neutral"` reads "auto match" or "you confirmed"; a stale reference adds `text-warn` "stale"; the source name links to the market (`target=_blank rel=noreferrer`, `text-info hover:underline`) |
| Suggestion | `text-sm text-muted`: "Possible match on Polymarket: “{title}” ({pct})", then `Button size="sm" variant="outline"` "✓ Same market" and `variant="ghost"` "✗ Not it", each with an aria-label. Both POST to `/api/markets/match` and the card updates on the next push |
| Hold value stat sub | "outside odds × $1" when `probSource==='reference'`, plus "Kalshi: {dollars}" as a second sub-line |
| Combo legs table | New column "Outside", the leg's ref pct with a source initial (P/S), "—" when none. The footnote adds "x of n legs at outside odds" |
| Source strip | One line in the summary card: "Polymarket ✓ 1 min ago · Sportsbooks — no key (add ODDS_API_KEY to .env.local)". The `text-xs text-muted`/`text-warn` tones are the existing ones |

**Steps:**
1. Implement.
2. Typecheck and build.
3. Browser check on a side instance at desktop and 375 px: the user's combo shows 8 legs with Polymarket references.
4. Self-check against the checklist (no separate agent; say so).
5. Commit.

### Task 7: Record comparison, docs, verification

- **`src/markets/record.ts`: `compareSources(rows):{source,n,brierKalshi,brierRef,diff,ci}`**, over settled markets that have both a Kalshi snapshot and a ref snapshot ≥ 1 h before close. It uses the last snapshot of each before that time; the CI is a bootstrap over markets.
  - Test: two settled markets with known probabilities give the exact Brier scores.
  - `/record` includes it. The Record tab shows a "Who was more accurate" card with n and a note. Below 10 markets it reads "not enough matched markets have settled yet".
- **README:** a Markets references bullet.
- **DECISIONS 48:**
  - Polymarket first (free, with sports);
  - Odds API optional with its budget;
  - moneyline and totals only;
  - trusted = auto or confirmed;
  - staleness limits;
  - the matching rules and the time window.
- **VERIFICATION:** the live result for the user's combo.
- **Commit.**
