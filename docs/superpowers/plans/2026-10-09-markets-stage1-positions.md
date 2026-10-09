# Markets Stage 1: Positions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A separate `markets` process and a `/markets` page that show every open non-Bitcoin Kalshi position live. Each position shows cost including fees, P&L if sold, value if held, a hold-or-sell verdict, combo legs with their independence value, heads-up notices with sound, and a price line saved since entry.

**Architecture:**
- A new tsx process (`src/markets/index.ts`, port 3002, `data/markets.db`) polls Kalshi read-only. It reuses the engine's Kalshi client, fees, account normalisation and exit notices.
- Pure modules (`categories`, `quotes`, `combos`, `holdsell`, `state`) hold all the arithmetic and are unit-tested.
- The web server proxies `/api/markets/*` and `/markets-ws`. The page reuses the dashboard's components, theme and sound system.

**Tech Stack:** TypeScript, Node 24, better-sqlite3, ws, Next.js 15 App Router, React 19, Tailwind 4, vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-markets-advisor-design.md` (sections 2.1, 3, 4, 6, 7, and stage 1 of section 8).

## Global Constraints

- Read-only. Only GET requests to Kalshi, through the existing `KalshiClient`, which allows no write methods. Nothing places orders.
- Data and arithmetic only, never tips. Copy says what selling or holding is worth; the user decides. Claude is not a licensed advisor.
- The Bitcoin engine (`src/engine/index.ts`) is not modified, apart from shared pure helpers it already imports. KXBTC15M and KXBTCD positions are excluded from Markets.
- Kalshi request rate from the markets process: ≤ 5/s, using `KalshiClient` spacing of 200 ms.
- Quote staleness: a held market's quote older than 30 s marks the card stale.
- Verdict margin: SELL BEATS HOLD when (net bid per contract − win probability) ≥ `max(0.0005, min(exitMargin, 0.2 × winProbability))`. `exitMargin` defaults to 0.02. This is the spec's 2¢, scaled down for sub-cent combos (decision recorded in DECISIONS).
- Notices reuse `holdNotice` from `src/engine/exits.ts` with the user's exit settings from `advisor.db` (read-only), falling back to `defaults`.
- Fees: series `fee_type` `quadratic`, `quadratic_with_maker_fees` and `quadratic_with_combo_maker_fees` all use the quadratic taker fee. This was verified on the user's real combo fill: 2,777.77 contracts at 0.33¢ paid $0.639559.
- Port `MARKETS_PORT` default 3002. DB `MARKETS_DB` default `./data/markets.db`.
- The UI follows the existing theme tokens in `src/app/globals.css`. No raw hex values in components, and no new font or spacing values. Reuse `Card`, `Pill`, `Stat`, `Heading`, `SiteHeader`, `SoundToggle` and the format helpers.

## Review Focus

1. **A combo leg whose market cannot be fetched** (delisted, or a typo in the legs): its value must be "unavailable", never a partial product. The test is in Task 3.
2. **A position that appears before its fills have synced:** cost falls back to (exposure + fees paid) / contracts, labelled "estimate". The test is in Task 4.
3. **Kalshi quotes stop updating:** the card is marked stale, and the verdict text says the prices are old. The test is in Task 4.
4. **A market that has settled but still shows in positions** (result present): it shows SETTLING with the payout, not sell math. The test is in Task 4.
5. **Two dashboard tabs open:** a Markets notice plays its sound in only one tab (cross-tab claim). The test is in Task 7.

## UI checklist

Reference: `src/components/hourly.tsx`, the newest live page, plus the Positions panel in `src/components/panels.tsx`. Theme: `@theme` tokens in `src/app/globals.css`. There is no DESIGN.md. Spacing uses Tailwind's 4-px scale.

| Role | Project answer | Settled by |
|---|---|---|
| Route file | `src/app/markets/page.tsx` exports `metadata={title:'Markets · Kalshi Advisor'}` and renders the default export of `src/components/markets.tsx` | 4 of 4 route files |
| Page holder | `<div aria-hidden className="ambient" data-tone=…/>` + `<SiteHeader current=…>` + `<main className="mx-auto max-w-[1400px] space-y-4 px-4 pt-4 pb-16 sm:px-6">` | hourly, dashboard |
| Header right | `<SoundToggle …/>` then a `Pill` showing Live / Stale / Reconnecting, same markup as hourly | hourly, dashboard |
| Section heading | `Heading` from panels (`h2.label`), exported | panels (12 uses) |
| Card | `Card` from `ui/card`. Live card border: `border-warn/50` when a notice stands, else `border-info/30` | Positions panel |
| Big verdict word | `font-display text-5xl leading-none font-bold uppercase`, toned by P&L in hold style | Positions panel |
| P&L next to verdict | `num text-2xl font-semibold` + toneText, "UP +$x (+y%)" | Positions panel |
| Stats column | `Stat` (exported from panels) ×3: P&L if sold / Sell now / Hold value | Positions panel |
| Notice box | Extract `Notice` from the Positions panel into an exported component and use it in both places | Copy in 2 places; the third use triggers extraction (autonomy granted) |
| Empty state | One-line `Card` with a `Wallet` icon, a `.label` and muted text on the right | Positions panel empty |
| Offline state | `Card` with a `text-sm` sentence, like hourly's "Live state unavailable." | hourly |
| Footnote | `Card className="flex items-start gap-3 text-xs text-muted"` with an `Info` icon | hourly |
| Filter chips | New. Written like nav links: `inline-flex min-h-10 items-center rounded-xl px-3 text-sm`, active `bg-surface-2 text-fg`, otherwise `text-muted hover:text-fg`. `aria-pressed`, `cursor-pointer` | site-header nav |
| Tables (legs) | `w-full text-sm`; `thead text-left text-xs text-muted`; rows `border-t border-line`; `th scope` used | hourly ladder |
| Numbers | `.num` for every figure; `cents(v,2)` below 1¢ | format.ts |
| Nav | Add `{href:'/markets',label:'Markets'}` after Hourly; links `px-2 sm:px-3` so 5 fit at 375 px (verified in the browser) | site-header |

New copy, for the user to read on the page: "Your other positions", "No open positions outside Bitcoin", "Markets engine unavailable.", verdict words HOLD / SELL BEATS HOLD / SETTLING / DEAD / NO PRICE, chip labels All · Sports · Combos · Politics & econ · Commodities & crypto.

---

### Task 1: Shared groundwork in the engine's pure helpers

**Files:**
- Modify: `src/engine/feeds/kalshi.ts`: `KalshiClient` constructor takes `spacingMs` (default 100); `effectiveFees` accepts the combo fee type.
- Modify: `src/engine/account.ts`: `normalizeAccount` `series` parameter accepts a predicate.
- Modify: `src/engine/exits.ts`: `holdNotice` takes an optional closing `note`.
- Test: `tests/markets-groundwork.test.ts`

**Interfaces:**
- Produces: `new KalshiClient(id?,keyPath?,spacingMs?:number)`. `normalizeAccount(fills,settlements,series:string[]|((ticker:string)=>boolean),open?)`. `holdNotice(...,prev,note?:string)`. `effectiveFees` returns `verified:true` for `quadratic_with_combo_maker_fees`.

- [ ] **Step 1: Write the failing tests**

```ts
import {it,expect} from 'vitest';
import {effectiveFees} from '../src/engine/feeds/kalshi';
import {normalizeAccount,type OpenCost} from '../src/engine/account';
import {holdNotice,type ExitConfig} from '../src/engine/exits';
import {fee} from '../src/engine/model/fees';
const cfg:ExitConfig={exitMode:'hold',exitMargin:.02,makerMargin:.03,takeProfitPct:.25,stopLossPct:.5,stopWinProb:.25,trailGiveback:.5,trailFloor:.05};
it('combo series fee type is the quadratic taker fee (real fill: 2,777.77 at 0.33¢ paid $0.639559)',()=>{
  const s=effectiveFees({fee_type:'quadratic_with_combo_maker_fees',fee_multiplier:1},[],'E',Date.now());
  expect(s.verified).toBe(true);expect(fee(.0033,2777.77,'taker',s)).toBeCloseTo(.6396,3);});
it('normalizeAccount takes a ticker predicate and returns FIFO open cost with fees for non-Bitcoin markets',()=>{
  const fills=[{fill_id:'1',ticker:'KXNFLGAME-26OCT04KCLV-KC',outcome_side:'yes',action:'buy',count_fp:'4.62',yes_price_dollars:'0.6700',fee_cost:'0.07',created_time:'2026-10-04T09:30:00Z'},
    {fill_id:'2',ticker:'KXBTC15M-26OCT04-00',outcome_side:'yes',action:'buy',count_fp:'1',yes_price_dollars:'0.5',fee_cost:'0.02',created_time:'2026-10-04T09:31:00Z'}];
  const open=new Map<string,OpenCost>();const events=normalizeAccount(fills,[],t=>!t.startsWith('KXBTC'),open);
  expect(events).toHaveLength(1);expect(open.get('KXNFLGAME-26OCT04KCLV-KC')!.avgCost).toBeCloseTo(.67+.07/4.62,6);expect(open.has('KXBTC15M-26OCT04-00')).toBe(false);});
it('holdNotice uses the caller note instead of the Bitcoin backtest sentence',()=>{
  const n=holdNotice(-6,-.6,null,.25,.2,.6,.2,4,10,cfg,null,'Your call.')!;expect(n.kind).toBe('loss');expect(n.text.endsWith('Your call.')).toBe(true);expect(n.text).not.toContain('backtest');});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/markets-groundwork.test.ts`
Expected: FAIL. The fee schedule is `verified:false`, the predicate is not callable, and the note is ignored.

- [ ] **Step 3: Implement**

In `src/engine/feeds/kalshi.ts`, in `effectiveFees`:
```ts
  const quadratic=['quadratic','quadratic_with_maker_fees','quadratic_with_combo_maker_fees'];
  return {...baseFees,takerMultiplier:m,makerMultiplier:type==='quadratic_with_maker_fees'||type==='quadratic_with_combo_maker_fees'?m:0,verified:quadratic.includes(type)&&Number.isFinite(m)&&m>=0};
```
Change the `KalshiClient` constructor to `constructor(private id=process.env.KALSHI_API_KEY_ID??'',private keyPath=process.env.KALSHI_PRIVATE_KEY_PATH??'',private spacingMs=100)`. In `get`, replace `setTimeout(r,100)` with `setTimeout(r,this.spacingMs)`.

In `src/engine/account.ts`:
```ts
export function normalizeAccount(fills:any[],settlements:any[],series:string[]|((ticker:string)=>boolean)=['KXBTC15M'],open?:Map<string,OpenCost>):RealEvent[]{
  const lots=new Map<string,{count:number;cost:number}[]>(),events:RealEvent[]=[],cashFlows=new Map<string,number>();
  const wanted=(ticker:unknown)=>typeof ticker==='string'&&(typeof series==='function'?series(ticker):series.some(s=>ticker.startsWith(s+'-')));
```

In `src/engine/exits.ts`, `holdNotice` gets a final parameter `note='In the backtest, selling early did worse than holding on average; your call.'`, and the local `backtest` constant becomes `const backtest=note;`.

- [ ] **Step 4: Run the whole suite**

Run: `npx vitest run`
Expected: all pass. Existing callers keep their defaults.

- [ ] **Step 5: Commit**

```bash
git add src/engine/feeds/kalshi.ts src/engine/account.ts src/engine/exits.ts tests/markets-groundwork.test.ts
git commit -m "markets groundwork: client spacing, combo fee type, ticker predicate, notice note"
```

### Task 2: Market parsing and categories

**Files:**
- Create: `src/markets/types.ts`, `src/markets/categories.ts`, `src/markets/quotes.ts`
- Test: `tests/markets-quotes.test.ts`

**Interfaces:**
- Produces:
  - `type Group='sports'|'combos'|'politics'|'commodities'`
  - `interface Leg {eventTicker:string;marketTicker:string;side:'yes'|'no'}`
  - `interface Quote {ticker;eventTicker;seriesTicker;title;yesLabel;status;result:'yes'|'no'|null;yesBid;yesAsk;noBid;noAsk;last:number|null;volume24h:number|null;closeTime:number|null;expectedExpiration:number|null;legs:Leg[]|null;updated:number}`
  - `seriesOf(ticker)`, `isBitcoin(ticker)`, `groupOf(category,isCombo):Group`
  - `parseMarket(m:any,now:number):Quote`
  - `sideBid(q,side)`, `sideProb(q,side):number|null`
  - `sideLabel(q,side):string`

- [ ] **Step 1: Write the failing tests**

```ts
import {it,expect} from 'vitest';
import {parseMarket,sideBid,sideProb,sideLabel} from '../src/markets/quotes';
import {groupOf,isBitcoin,seriesOf} from '../src/markets/categories';
const game={ticker:'KXNCAAFGAME-26OCT09IOWAWASH-IOWA',event_ticker:'KXNCAAFGAME-26OCT09IOWAWASH',title:'Iowa vs Washington Winner?',yes_sub_title:'Iowa',status:'active',result:'',yes_bid_dollars:'0.4200',yes_ask_dollars:'0.4300',no_bid_dollars:'0.5700',no_ask_dollars:'0.5800',last_price_dollars:'0.4300',volume_24h_fp:'1200.00',close_time:'2026-10-12T01:00:00Z',expected_expiration_time:'2026-10-10T04:00:00Z'};
it('parses a market into a quote with dollars as numbers and empty values as null',()=>{
  const q=parseMarket(game,1000);expect(q.seriesTicker).toBe('KXNCAAFGAME');expect(q.yesBid).toBe(.42);expect(q.noAsk).toBe(.58);expect(q.result).toBeNull();expect(q.legs).toBeNull();expect(q.closeTime).toBe(Date.parse('2026-10-12T01:00:00Z'));expect(q.updated).toBe(1000);
  const settled=parseMarket({...game,status:'finalized',result:'yes',yes_bid_dollars:'0.0000',yes_ask_dollars:'1.0000'},1);expect(settled.result).toBe('yes');expect(settled.yesBid).toBeNull();});
it('reads combo legs from mve_selected_legs',()=>{
  const q=parseMarket({...game,ticker:'KXMVECROSSCATEGORY-S1-A',event_ticker:'KXMVECROSSCATEGORY-S1',mve_selected_legs:[{event_ticker:'E1',market_ticker:'E1-X',side:'yes'}]},1);
  expect(q.legs).toEqual([{eventTicker:'E1',marketTicker:'E1-X',side:'yes'}]);});
it('side prices: NO bids are Kalshi no_bid; probability is the two-sided mid, else last; labels say Not X',()=>{
  const q=parseMarket(game,1);expect(sideBid(q,'no')).toBe(.57);expect(sideProb(q,'yes')).toBeCloseTo(.425);expect(sideProb(q,'no')).toBeCloseTo(.575);
  expect(sideProb(parseMarket({...game,yes_bid_dollars:'0',yes_ask_dollars:'0'},1),'yes')).toBeCloseTo(.43);
  expect(sideProb(parseMarket({...game,yes_bid_dollars:'0',yes_ask_dollars:'0',last_price_dollars:'0'},1),'yes')).toBeNull();
  expect(sideLabel(q,'yes')).toBe('Iowa');expect(sideLabel(q,'no')).toBe('Not Iowa');});
it('groups by Kalshi category; combos win over category; Bitcoin series are excluded',()=>{
  expect(groupOf('Sports',false)).toBe('sports');expect(groupOf('Exotics',true)).toBe('combos');expect(groupOf('Elections',false)).toBe('politics');expect(groupOf('Crypto',false)).toBe('commodities');expect(groupOf('Commodities',false)).toBe('commodities');expect(groupOf(null,false)).toBe('politics');
  expect(isBitcoin('KXBTCD-26OCT0912-T60000')).toBe(true);expect(isBitcoin('KXBTC15M-X')).toBe(true);expect(isBitcoin('KXSOL15M-X')).toBe(false);expect(seriesOf('KXNFLGAME-A-B')).toBe('KXNFLGAME');});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/markets-quotes.test.ts`
Expected: FAIL, because the modules are not found.

- [ ] **Step 3: Implement**

`src/markets/types.ts`:
```ts
/** Kalshi market data as the markets process uses it. Prices are dollars (0–1); null means Kalshi gave none. */
export type Group='sports'|'combos'|'politics'|'commodities';
export interface Leg {eventTicker:string;marketTicker:string;side:'yes'|'no'}
export interface Quote {ticker:string;eventTicker:string;seriesTicker:string;title:string;yesLabel:string;status:string;result:'yes'|'no'|null;yesBid:number|null;yesAsk:number|null;noBid:number|null;noAsk:number|null;last:number|null;volume24h:number|null;closeTime:number|null;expectedExpiration:number|null;legs:Leg[]|null;updated:number}
```

`src/markets/categories.ts`:
```ts
import type {Group} from './types';
/** The two Bitcoin series have their own pages; Markets covers everything else. */
export const BITCOIN_SERIES=['KXBTC15M','KXBTCD'];
export const seriesOf=(ticker:string)=>ticker.split('-')[0];
export const isBitcoin=(ticker:string)=>BITCOIN_SERIES.includes(seriesOf(ticker));
/** Kalshi series category → page group (spec §2). Combos are grouped by structure, whatever their category. */
export function groupOf(category:string|null|undefined,isCombo:boolean):Group{
  if(isCombo)return 'combos';
  if(category==='Sports')return 'sports';
  if(category==='Commodities'||category==='Crypto')return 'commodities';
  return 'politics';
}
export const groupLabels:Record<Group,string>={sports:'Sports',combos:'Combos',politics:'Politics & econ',commodities:'Commodities & crypto'};
```

`src/markets/quotes.ts`:
```ts
import type {Leg,Quote} from './types';
import {seriesOf} from './categories';
const price=(v:unknown)=>{const n=Number(v);return v===undefined||v===null||v===''||!Number.isFinite(n)?null:n;};
/** Kalshi shows an empty book as bid 0 / ask 1; neither is a price you can trade at. */
const bidOf=(v:unknown)=>{const n=price(v);return n!==null&&n>0?n:null;};
const askOf=(v:unknown)=>{const n=price(v);return n!==null&&n>0&&n<1?n:null;};
const time=(v:unknown)=>{const t=typeof v==='string'?Date.parse(v):NaN;return Number.isFinite(t)?t:null;};
export function parseMarket(m:any,now:number):Quote{
  const legs:Leg[]|null=Array.isArray(m.mve_selected_legs)&&m.mve_selected_legs.length?m.mve_selected_legs.map((l:any)=>({eventTicker:String(l.event_ticker),marketTicker:String(l.market_ticker),side:l.side==='no'?'no':'yes'})):null;
  return {ticker:String(m.ticker),eventTicker:String(m.event_ticker??''),seriesTicker:seriesOf(String(m.ticker)),title:String(m.title??''),yesLabel:String(m.yes_sub_title??m.title??''),status:String(m.status??''),
    result:m.result==='yes'||m.result==='no'?m.result:null,yesBid:bidOf(m.yes_bid_dollars),yesAsk:askOf(m.yes_ask_dollars),noBid:bidOf(m.no_bid_dollars),noAsk:askOf(m.no_ask_dollars),
    last:bidOf(m.last_price_dollars),volume24h:price(m.volume_24h_fp),closeTime:time(m.close_time),expectedExpiration:time(m.expected_expiration_time),legs,updated:now};
}
export const sideBid=(q:Quote,side:'yes'|'no')=>side==='yes'?q.yesBid:q.noBid;
/** Market-implied chance that `side` wins: the two-sided YES mid, else the last trade; null when Kalshi has neither. */
export function sideProb(q:Quote,side:'yes'|'no'):number|null{
  const yes=q.yesBid!==null&&q.yesAsk!==null&&q.yesAsk>=q.yesBid?(q.yesBid+q.yesAsk)/2:q.last;
  return yes===null?null:side==='yes'?yes:1-yes;
}
export const sideLabel=(q:Quote,side:'yes'|'no')=>side==='yes'?q.yesLabel:`Not ${q.yesLabel}`;
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run tests/markets-quotes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/markets/types.ts src/markets/categories.ts src/markets/quotes.ts tests/markets-quotes.test.ts
git commit -m "markets: quote parsing, side prices and category groups"
```

### Task 3: Combo math

**Files:**
- Create: `src/markets/combos.ts`
- Test: `tests/markets-combos.test.ts`

**Interfaces:**
- Consumes: `Quote`, `Leg`, `sideProb`, `sideLabel` (Task 2).
- Produces:
  - `type LegStatus='won'|'lost'|'pending'|'unknown'`
  - `interface LegView {ticker:string;side:'yes'|'no';label:string;status:LegStatus;p:number|null;bid:number|null;ask:number|null;game:string}`
  - `interface ComboView {legs:LegView[];value:number|null;won:number;lost:number;pending:number;unknown:number;dead:boolean;oneLeft:boolean;correlated:boolean}`
  - `comboView(legs:Leg[],quotes:Map<string,Quote>):ComboView`
  - `gameKey(eventTicker:string):string`

- [ ] **Step 1: Write the failing tests**

```ts
import {it,expect} from 'vitest';
import {comboView,gameKey} from '../src/markets/combos';
import {parseMarket} from '../src/markets/quotes';
import type {Leg,Quote} from '../src/markets/types';
const q=(ticker:string,bid:string,ask:string,extra:any={})=>parseMarket({ticker,event_ticker:ticker.split('-').slice(0,2).join('-'),yes_sub_title:ticker.split('-').at(-1),status:'active',result:'',yes_bid_dollars:bid,yes_ask_dollars:ask,...extra},1);
// The user's open 8-leg combo on 2026-10-09 (South Alabama already won).
const legs:Leg[]=['KXNCAAFGAME-26OCT08USAARST-USA','KXNCAAFGAME-26OCT09IOWAWASH-IOWA','KXNCAAFGAME-26OCT10ARIZWVU-ARIZ','KXNCAAFGAME-26OCT10HOUKSU-HOU','KXNCAAFGAME-26OCT10ILLMSU-MSU','KXNCAAFGAME-26OCT10MINNPUR-MINN','KXNCAAFGAME-26OCT10USCPSU-USC','KXNCAAFTOTAL-26OCT10UGAALA-52']
  .map(t=>({marketTicker:t,eventTicker:t.split('-').slice(0,2).join('-'),side:'yes'}));
const quotes=()=>new Map<string,Quote>([
  q(legs[0].marketTicker,'0','1',{status:'finalized',result:'yes'}),q(legs[1].marketTicker,'0.42','0.43'),q(legs[2].marketTicker,'0.59','0.60'),q(legs[3].marketTicker,'0.45','0.46'),
  q(legs[4].marketTicker,'0.43','0.44'),q(legs[5].marketTicker,'0.54','0.55'),q(legs[6].marketTicker,'0.47','0.48'),q(legs[7].marketTicker,'0.47','0.48')].map(x=>[x.ticker,x]));
it('values the real combo as the product of its legs, won legs counting 1',()=>{
  const c=comboView(legs,quotes());expect(c.won).toBe(1);expect(c.pending).toBe(7);expect(c.value!).toBeCloseTo(.006154,5);expect(c.dead).toBe(false);expect(c.oneLeft).toBe(false);expect(c.correlated).toBe(false);
  expect(c.legs[0]).toMatchObject({status:'won',label:'USA'});});
it('a lost leg kills the combo: value 0 and dead',()=>{
  const m=quotes();m.set(legs[1].marketTicker,q(legs[1].marketTicker,'0','1',{status:'finalized',result:'no'}));const c=comboView(legs,m);expect(c.dead).toBe(true);expect(c.value).toBe(0);expect(c.lost).toBe(1);});
it('a missing or unpriced leg makes the value unavailable, never a partial product',()=>{
  const m=quotes();m.delete(legs[2].marketTicker);expect(comboView(legs,m).value).toBeNull();expect(comboView(legs,m).unknown).toBe(1);
  const u=quotes();u.set(legs[3].marketTicker,q(legs[3].marketTicker,'0','1'));expect(comboView(legs,u).value).toBeNull();});
it('one pending leg left is flagged; a NO leg uses the NO probability',()=>{
  const two:Leg[]=[legs[0],{...legs[1],side:'no'}];const c=comboView(two,quotes());expect(c.oneLeft).toBe(true);expect(c.value!).toBeCloseTo(.575);expect(c.legs[1].label).toBe('Not IOWA');});
it('legs on the same game are correlated (winner + total of one matchup)',()=>{
  expect(gameKey('KXNCAAFTOTAL-26OCT10UGAALA')).toBe(gameKey('KXNCAAFGAME-26OCT10UGAALA'));
  const two:Leg[]=[{marketTicker:'KXNCAAFGAME-26OCT10UGAALA-UGA',eventTicker:'KXNCAAFGAME-26OCT10UGAALA',side:'yes'},legs[7]];
  expect(comboView(two,new Map([[two[0].marketTicker,q(two[0].marketTicker,'.6','.62')],[legs[7].marketTicker,q(legs[7].marketTicker,'.47','.48')]])).correlated).toBe(true);});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/markets-combos.test.ts`
Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement** `src/markets/combos.ts`:

```ts
import type {Leg,Quote} from './types';
import {sideProb,sideLabel} from './quotes';
export type LegStatus='won'|'lost'|'pending'|'unknown';
export interface LegView {ticker:string;side:'yes'|'no';label:string;status:LegStatus;p:number|null;bid:number|null;ask:number|null;game:string}
export interface ComboView {legs:LegView[];value:number|null;won:number;lost:number;pending:number;unknown:number;dead:boolean;oneLeft:boolean;correlated:boolean}
/** The matchup part of an event ticker: KXNCAAFGAME-26OCT10UGAALA and KXNCAAFTOTAL-26OCT10UGAALA are the same game. */
export const gameKey=(eventTicker:string)=>eventTicker.split('-').slice(1).join('-');
/**
 * A combo pays only if every leg wins. Valued as the product of each leg's market-implied chance (won = 1, lost = 0).
 * That assumes the legs are independent, so legs on the same game are flagged as correlated. A leg Kalshi did not
 * return, or one with no price, leaves the value unavailable: a partial product would overstate it.
 */
export function comboView(legs:Leg[],quotes:Map<string,Quote>):ComboView{
  const views=legs.map((l):LegView=>{const q=quotes.get(l.marketTicker),game=gameKey(l.eventTicker);
    if(!q)return {ticker:l.marketTicker,side:l.side,label:l.marketTicker,status:'unknown',p:null,bid:null,ask:null,game};
    const status:LegStatus=q.result?(q.result===l.side?'won':'lost'):'pending',p=status==='won'?1:status==='lost'?0:sideProb(q,l.side);
    return {ticker:l.marketTicker,side:l.side,label:sideLabel(q,l.side),status:status==='pending'&&p===null?'unknown':status,p,bid:l.side==='yes'?q.yesBid:q.noBid,ask:l.side==='yes'?q.yesAsk:q.noAsk,game};});
  const count=(s:LegStatus)=>views.filter(v=>v.status===s).length,lost=count('lost'),unknown=count('unknown'),pending=count('pending');
  const value=lost?0:unknown?null:views.reduce((x,v)=>x*(v.p as number),1);
  const games=views.map(v=>v.game);
  return {legs:views,value,won:count('won'),lost,pending,unknown,dead:lost>0,oneLeft:!lost&&!unknown&&pending===1,correlated:new Set(games).size<games.length};
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run tests/markets-combos.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/markets/combos.ts tests/markets-combos.test.ts
git commit -m "markets: combo legs, independence value, dead/one-left/correlated"
```

### Task 4: Hold-or-sell view per position

**Files:**
- Create: `src/markets/holdsell.ts`
- Test: `tests/markets-holdsell.test.ts`

**Interfaces:**
- Consumes: `Quote`, `sideBid`, `sideProb`, `sideLabel` (Task 2); `ComboView` (Task 3); `holdNotice`, `ExitConfig` (Task 1); `fee`, `FeeSchedule`; `OpenCost`.
- Produces:
  - `interface MarketNotice {kind:'gain'|'giveback'|'loss'|'odds'|'dead'|'one-left'|'leg-won';tone:'yes'|'warn'|'no';title:string;text:string}`
  - `interface MarketMemory {peak:number|null;trough:number|null;notice:MarketNotice['kind']|null;legsWon:number|null;legWonAt:number|null}`
  - `type Verdict='HOLD'|'SELL BEATS HOLD'|'SETTLING'|'DEAD'|'NO PRICE'`
  - `interface PositionView {ticker;side;contracts;avgCost:number|null;costSource:'fills'|'estimate'|null;bid:number|null;winProb:number|null;probSource:'market'|'legs'|'settled'|null;sellFee:number|null;sellValue:number|null;holdValue:number|null;unrealized:number|null;unrealizedPct:number|null;peakPct:number|null;troughPct:number|null;verdict:Verdict;reason:string;notice:MarketNotice|null;stale:boolean}`
  - `interface PositionInput {position:{ticker:string;position_fp:string;market_exposure_dollars?:string;fees_paid_dollars?:string};quote:Quote|null;combo:ComboView|null;open:OpenCost|undefined;schedule:FeeSchedule;cfg:ExitConfig;memory:MarketMemory|undefined;now:number}`
  - `positionView(i:PositionInput):{view:PositionView;memory:MarketMemory}|null`
  - `STALE_MS=30000`

- [ ] **Step 1: Write the failing tests**

```ts
import {it,expect} from 'vitest';
import {positionView,type PositionInput} from '../src/markets/holdsell';
import {parseMarket} from '../src/markets/quotes';
import {baseFees} from '../src/engine/model/fees';
import type {ExitConfig} from '../src/engine/exits';
import type {ComboView} from '../src/markets/combos';
const cfg:ExitConfig={exitMode:'hold',exitMargin:.02,makerMargin:.03,takeProfitPct:.25,stopLossPct:.5,stopWinProb:.25,trailGiveback:.5,trailFloor:.05};
const quote=(bid:string,ask:string,extra:any={},now=1000)=>parseMarket({ticker:'KXNFLGAME-X-KC',event_ticker:'KXNFLGAME-X',yes_sub_title:'Kansas City',status:'active',result:'',yes_bid_dollars:bid,yes_ask_dollars:ask,no_bid_dollars:(1-Number(ask)).toFixed(4),no_ask_dollars:(1-Number(bid)).toFixed(4),...extra},now);
const input=(over:Partial<PositionInput>={}):PositionInput=>({position:{ticker:'KXNFLGAME-X-KC',position_fp:'10',market_exposure_dollars:'6.00',fees_paid_dollars:'0.15'},quote:quote('.66','.68'),combo:null,
  open:{ticker:'KXNFLGAME-X-KC',side:'yes',contracts:10,avgCost:.615},schedule:baseFees,cfg,memory:undefined,now:1000,...over});
it('single market: cost from fills, sell value at the bid after the fee, hold value at the mid, HOLD',()=>{
  const {view}=positionView(input())!;expect(view.side).toBe('yes');expect(view.costSource).toBe('fills');expect(view.winProb).toBeCloseTo(.67);expect(view.probSource).toBe('market');
  expect(view.sellValue!).toBeCloseTo(10*.66-view.sellFee!,6);expect(view.holdValue!).toBeCloseTo(6.7);expect(view.unrealized!).toBeCloseTo(view.sellValue!-6.15,6);expect(view.verdict).toBe('HOLD');expect(view.stale).toBe(false);});
it('before fills sync, cost is exposure plus fees paid, labelled estimate',()=>{
  const {view}=positionView(input({open:undefined}))!;expect(view.costSource).toBe('estimate');expect(view.avgCost!).toBeCloseTo(.615);});
it('a NO position uses the NO bid and 1 − mid',()=>{
  const {view}=positionView(input({position:{ticker:'KXNFLGAME-X-KC',position_fp:'-5',market_exposure_dollars:'1.70',fees_paid_dollars:'0.05'},open:undefined}))!;
  expect(view.side).toBe('no');expect(view.bid).toBeCloseTo(.32);expect(view.winProb).toBeCloseTo(.33);});
it('a settled market shows SETTLING with the payout, not sell math',()=>{
  const {view}=positionView(input({quote:quote('0','1',{status:'finalized',result:'yes'})}))!;expect(view.verdict).toBe('SETTLING');expect(view.holdValue).toBe(10);expect(view.reason).toContain('$10.00');});
it('a quote older than 30 s is stale and says so',()=>{
  const {view}=positionView(input({now:1000+31000}))!;expect(view.stale).toBe(true);expect(view.reason).toContain('old');});
it('no price at all: NO PRICE',()=>{
  const {view}=positionView(input({quote:quote('0','0')}))!;expect(view.verdict).toBe('NO PRICE');});
it('SELL BEATS HOLD only when the bid nets more than the hold value by the margin',()=>{
  // A crossed or stale-looking book where the bid exceeds the mid used for hold value cannot happen; use a combo instead:
  const combo:ComboView={legs:[],value:.002,won:7,lost:0,pending:1,unknown:0,dead:false,oneLeft:true,correlated:false};
  const cq=quote('.03','.05');const {view}=positionView(input({quote:cq,combo,open:{ticker:'KXNFLGAME-X-KC',side:'yes',contracts:10,avgCost:.004}}))!;
  expect(view.probSource).toBe('legs');expect(view.winProb).toBeCloseTo(.002);expect(view.verdict).toBe('SELL BEATS HOLD');});
it('combo notices: dead stops everything; a newly won leg shows for 10 minutes; first sight is a silent baseline',()=>{
  const base:ComboView={legs:[{ticker:'L1',side:'yes',label:'Iowa',status:'won',p:1,bid:null,ask:null,game:'g1'},{ticker:'L2',side:'yes',label:'USC',status:'pending',p:.5,bid:.49,ask:.51,game:'g2'},{ticker:'L3',side:'yes',label:'Ohio',status:'pending',p:.5,bid:.49,ask:.51,game:'g3'}],value:.25,won:1,lost:0,pending:2,unknown:0,dead:false,oneLeft:false,correlated:false};
  const first=positionView(input({combo:base,quote:quote('.001','.9')}))!;expect(first.view.notice).toBeNull();expect(first.memory.legsWon).toBe(1);
  const won={...base,legs:[base.legs[0],{...base.legs[1],status:'won' as const,p:1},base.legs[2]],won:2,pending:1,value:.5,oneLeft:true};
  const second=positionView(input({combo:won,quote:quote('.001','.9'),memory:first.memory,now:2000}))!;expect(second.view.notice?.kind).toBe('one-left');
  const dead=positionView(input({combo:{...won,dead:true,lost:1,value:0},quote:quote('.001','.9'),memory:second.memory,now:3000}))!;expect(dead.view.verdict).toBe('DEAD');expect(dead.view.notice?.kind).toBe('dead');expect(dead.view.holdValue).toBe(0);});
it('single-market notices come from holdNotice with a neutral closing note',()=>{
  const {view}=positionView(input({quote:quote('.20','.22'),open:{ticker:'KXNFLGAME-X-KC',side:'yes',contracts:10,avgCost:.6}}))!;
  expect(view.notice?.kind).toBe('loss');expect(view.notice?.text).not.toContain('backtest');});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/markets-holdsell.test.ts`
Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement** `src/markets/holdsell.ts`:

```ts
import {fee,type FeeSchedule} from '../engine/model/fees';
import {holdNotice,type ExitConfig} from '../engine/exits';
import type {OpenCost} from '../engine/account';
import type {Quote} from './types';
import type {ComboView} from './combos';
import {sideBid,sideProb} from './quotes';
export const STALE_MS=30000,LEG_WON_MS=10*60000;
export interface MarketNotice {kind:'gain'|'giveback'|'loss'|'odds'|'dead'|'one-left'|'leg-won';tone:'yes'|'warn'|'no';title:string;text:string}
export interface MarketMemory {peak:number|null;trough:number|null;notice:MarketNotice['kind']|null;legsWon:number|null;legWonAt:number|null}
export type Verdict='HOLD'|'SELL BEATS HOLD'|'SETTLING'|'DEAD'|'NO PRICE';
export interface PositionView {ticker:string;side:'yes'|'no';contracts:number;avgCost:number|null;costSource:'fills'|'estimate'|null;bid:number|null;winProb:number|null;probSource:'market'|'legs'|'settled'|null;sellFee:number|null;sellValue:number|null;holdValue:number|null;unrealized:number|null;unrealizedPct:number|null;peakPct:number|null;troughPct:number|null;verdict:Verdict;reason:string;notice:MarketNotice|null;stale:boolean}
export interface PositionInput {position:{ticker:string;position_fp:string;market_exposure_dollars?:string;fees_paid_dollars?:string};quote:Quote|null;combo:ComboView|null;open:OpenCost|undefined;schedule:FeeSchedule;cfg:ExitConfig;memory:MarketMemory|undefined;now:number}
const c=(v:number)=>v<.01?`${(v*100).toFixed(2)}¢`:`${(v*100).toFixed(1)}¢`,usd=(v:number)=>`$${Math.abs(v).toFixed(2)}`;
const NOTE='Your call.';
/**
 * What an open position is worth sold now versus held. Hold value is the market-implied chance of winning (the YES mid,
 * or for a combo the product of its legs) × $1 per contract; selling pays the side's bid minus the taker fee. With market
 * odds alone, selling almost never beats holding (it costs half the spread plus the fee). SELL BEATS HOLD appears when
 * the bid exceeds what the position is worth by the margin: max(0.05¢, min(exitMargin, 20% of the win chance)).
 */
export function positionView(i:PositionInput):{view:PositionView;memory:MarketMemory}|null{
  const signed=Number(i.position.position_fp);if(!Number.isFinite(signed)||Math.abs(signed)<1e-9)return null;
  const side:'yes'|'no'=signed>0?'yes':'no',contracts=Math.abs(signed),q=i.quote,prev=i.memory;
  // Cost per contract including entry fees: FIFO over the still-open fills; until those sync, exposure + fees paid.
  const exposure=Number(i.position.market_exposure_dollars),paid=Number(i.position.fees_paid_dollars);
  const fromFills=i.open&&i.open.side===side&&Math.abs(i.open.contracts-contracts)<.011;
  const avgCost=fromFills?i.open!.avgCost:Number.isFinite(exposure)&&exposure>0?(exposure+(Number.isFinite(paid)?paid:0))/contracts:null;
  const costSource=fromFills?'fills' as const:avgCost!==null?'estimate' as const:null;
  const stale=!q||i.now-q.updated>STALE_MS,rawBid=q?sideBid(q,side):null,bid=rawBid!==null&&rawBid>0?rawBid:null;
  const sellFee=bid!==null?fee(bid,contracts,'taker',i.schedule):null,sellValue=bid!==null&&sellFee!==null?contracts*bid-sellFee:null;
  const unrealized=sellValue!==null&&avgCost!==null?sellValue-contracts*avgCost:null,unrealizedPct=unrealized!==null&&avgCost?unrealized/(contracts*avgCost):null;
  const peak=Math.max(prev?.peak??-Infinity,unrealizedPct??-Infinity),trough=Math.min(prev?.trough??Infinity,unrealizedPct??Infinity);
  const memory:MarketMemory={peak:Number.isFinite(peak)?peak:null,trough:Number.isFinite(trough)?trough:null,notice:null,legsWon:prev?.legsWon??null,legWonAt:prev?.legWonAt??null};
  const base={ticker:i.position.ticker,side,contracts,avgCost,costSource,bid,sellFee,sellValue,unrealized,unrealizedPct,peakPct:memory.peak,troughPct:memory.trough,stale};
  const old=stale?' Prices are more than 30 s old; these numbers may be out of date.':'';
  const done=(view:Omit<PositionView,keyof typeof base>)=>{memory.notice=view.notice?.kind??null;return {view:{...base,...view},memory};};
  if(q?.result){const won=q.result===side;
    return done({winProb:won?1:0,probSource:'settled',holdValue:won?contracts:0,verdict:'SETTLING',notice:null,reason:`Kalshi settled it ${won?'won':'lost'}: ${won?`${usd(contracts)} pays out`:'pays $0'}${avgCost!==null?` (${won?'+':'−'}${usd(won?contracts-contracts*avgCost:contracts*avgCost)} vs your cost)`:''}. Nothing to do.`});}
  const combo=i.combo;
  if(combo){
    // First sight is a silent baseline, so a restart does not announce legs that were already won.
    if(memory.legsWon===null)memory.legsWon=combo.won;else if(combo.won>memory.legsWon){memory.legsWon=combo.won;memory.legWonAt=i.now;}
    if(combo.dead){const lost=combo.legs.find(l=>l.status==='lost');
      return done({winProb:0,probSource:'legs',holdValue:0,verdict:'DEAD',reason:'A leg lost, so the combo settles at $0. Nothing to sell into or wait for.',notice:{kind:'dead',tone:'no',title:'Combo is dead',text:`${lost?.label??'A leg'} lost. The combo pays $0${avgCost!==null?`; ${usd(contracts*avgCost)} spent`:''}.`}});}
  }
  const p=combo?(combo.value===null?null:side==='yes'?combo.value:1-combo.value):q?sideProb(q,side):null;
  if(p===null)return done({winProb:null,probSource:null,holdValue:null,verdict:'NO PRICE',notice:null,reason:(combo?'A leg has no price or was not returned by Kalshi, so the combo cannot be valued.':'Kalshi shows no bid, ask or last trade for this market.')+old});
  const holdValue=contracts*p,net=sellValue!==null?sellValue/contracts:null,margin=Math.max(.0005,Math.min(i.cfg.exitMargin,.2*p));
  const verdict:Verdict=net!==null&&net-p>=margin?'SELL BEATS HOLD':'HOLD';
  const worth=combo?`Priced leg by leg, it is worth ${c(p)} a contract${combo.correlated?' (rough: some legs are on the same game)':''}`:`At market odds it is worth ${c(p)} a contract`;
  const reason=net===null?`${worth}. No ${side.toUpperCase()} bid to sell into.`:verdict==='SELL BEATS HOLD'?`The bid nets ${c(net)} a contract after the fee, ${c(net-p)} more than it is worth. ${worth}.`
    :`${worth}; selling at the bid nets ${c(net)} after the fee${combo?'':', so holding is worth more unless another source disagrees with Kalshi'}.`;
  let notice:MarketNotice|null=null;
  const lastLeg=combo?.oneLeft?combo.legs.find(l=>l.status==='pending'):undefined;
  if(combo&&lastLeg){const leg=lastLeg;notice={kind:'one-left',tone:'yes',title:'One leg left',text:`${leg.label} at ${leg.p!==null?`${Math.round(leg.p*100)}%`:'—'}. Pays ${usd(contracts)} if it wins.`};}
  else if(combo&&memory.legWonAt!==null&&i.now-memory.legWonAt<LEG_WON_MS)notice={kind:'leg-won',tone:'yes',title:`Leg won · ${combo.won} of ${combo.legs.length}`,text:`${combo.pending} still to play; worth ${usd(holdValue)} if the legs are independent.`};
  else if(!combo&&avgCost){
    const maxGain=(.99-fee(.99,contracts,'taker',i.schedule)/contracts-avgCost)/avgCost,arm=maxGain>0?Math.min(i.cfg.takeProfitPct,maxGain/2):null;
    const n=holdNotice(unrealized,unrealizedPct,memory.peak,arm,p,Math.min(1,avgCost),bid,sellValue,contracts,i.cfg,prev?.notice&&['gain','giveback','loss','odds'].includes(prev.notice)?prev.notice as 'gain':null,NOTE);
    notice=n?{...n}:null;}
  return done({winProb:p,probSource:combo?'legs':'market',holdValue,verdict,reason:reason+old,notice});
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run tests/markets-holdsell.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/markets/holdsell.ts tests/markets-holdsell.test.ts
git commit -m "markets: hold-or-sell view with costs, verdict margin, combo and hold notices"
```

### Task 5: Markets journal

**Files:**
- Create: `src/markets/journal.ts`
- Test: `tests/markets-journal.test.ts`

**Interfaces:**
- Consumes: `Quote`, `Group`.
- Produces `class MarketsJournal`:
  - `constructor(path=process.env.MARKETS_DB??'./data/markets.db')`, `db`
  - `log(event,context)`, `get<T>(key,fallback)`, `set(key,value)`
  - `upsertMarket(q:Quote,category:string|null,group:Group)`
  - `snapshot(rows:{ticker:string;time:number;yesBid:number|null;yesAsk:number|null;last:number|null;volume24h:number|null;held:boolean}[])`
  - `spark(ticker:string,since:number,points=120):{t:number;mid:number}[]`
  - `notice(time,ticker,kind,context)`
  - `putRaw(fills:any[],settlements:any[])`, `raw():{fills:any[];settlements:any[]}`
  - `prune(now=Date.now())`

- [ ] **Step 1: Write the failing tests**

```ts
import {it,expect} from 'vitest';
import {MarketsJournal} from '../src/markets/journal';
const row=(time:number,held:boolean,bid=.4,ask=.42)=>({ticker:'T',time,yesBid:bid,yesAsk:ask,last:.41,volume24h:10,held});
it('stores snapshots and returns a downsampled mid line since a time',()=>{
  const j=new MarketsJournal(':memory:');j.snapshot(Array.from({length:300},(_,k)=>row(k*1000,true,.4+k/1000,.42+k/1000)));
  const s=j.spark('T',100000,50);expect(s.length).toBeLessThanOrEqual(51);expect(s[0].t).toBeGreaterThanOrEqual(100000);expect(s.at(-1)!.t).toBe(299000);expect(s.at(-1)!.mid).toBeCloseTo(.709,3);j.db.close();});
it('prune keeps held snapshots forever and drops non-held ones after 14 days',()=>{
  const j=new MarketsJournal(':memory:'),day=86400000;j.snapshot([row(0,true),{...row(1,false),ticker:'U'}]);j.prune(15*day);
  expect((j.db.prepare('SELECT COUNT(*) n FROM snapshots').get() as any).n).toBe(1);j.db.close();});
it('raw account records round-trip and dedupe by id; meta get/set',()=>{
  const j=new MarketsJournal(':memory:');const f={fill_id:'a',created_time:'2026-10-04T00:00:00Z',ticker:'X'};j.putRaw([f,f],[{ticker:'X',settled_time:'2026-10-05T00:00:00Z'}]);
  expect(j.raw().fills).toHaveLength(1);expect(j.raw().settlements).toHaveLength(1);j.set('k',{a:1});expect(j.get('k',null)).toEqual({a:1});j.db.close();});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/markets-journal.test.ts`
Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement** `src/markets/journal.ts`:

```ts
import Database from 'better-sqlite3';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import type {Group,Quote} from './types';
const DAY=86400000;
/** data/markets.db: the markets process's own journal, so it never contends with the Bitcoin engine's writes. */
export class MarketsJournal {
  db:Database.Database;
  constructor(path=process.env.MARKETS_DB??'./data/markets.db'){
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});this.db=new Database(path);this.db.pragma('journal_mode = WAL');this.db.pragma('synchronous = NORMAL');this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS markets(ticker TEXT PRIMARY KEY,event_ticker TEXT,series_ticker TEXT,category TEXT,grp TEXT,title TEXT,yes_label TEXT,close_time INTEGER,expected_expiration INTEGER,is_combo INTEGER NOT NULL,legs TEXT,result TEXT,first_seen INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots(ticker TEXT NOT NULL,time INTEGER NOT NULL,yes_bid REAL,yes_ask REAL,last REAL,volume_24h REAL,held INTEGER NOT NULL,PRIMARY KEY(ticker,time));
      CREATE INDEX IF NOT EXISTS snapshots_time ON snapshots(time);
      CREATE TABLE IF NOT EXISTS notices(id INTEGER PRIMARY KEY,time INTEGER NOT NULL,ticker TEXT NOT NULL,kind TEXT NOT NULL,context TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_raw(id TEXT PRIMARY KEY,type TEXT NOT NULL,time INTEGER NOT NULL,context TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,time INTEGER NOT NULL,event TEXT NOT NULL,context TEXT NOT NULL);`);
  }
  log(event:string,context:unknown){this.db.prepare('INSERT INTO events(time,event,context) VALUES(?,?,?)').run(Date.now(),event,JSON.stringify(context));}
  get<T>(key:string,fallback:T):T{const row=this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as {value:string}|undefined;return row?JSON.parse(row.value):fallback;}
  set(key:string,value:unknown){this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key,JSON.stringify(value));}
  upsertMarket(q:Quote,category:string|null,group:Group){
    this.db.prepare(`INSERT INTO markets(ticker,event_ticker,series_ticker,category,grp,title,yes_label,close_time,expected_expiration,is_combo,legs,result,first_seen,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(ticker) DO UPDATE SET category=excluded.category,grp=excluded.grp,title=excluded.title,yes_label=excluded.yes_label,close_time=excluded.close_time,expected_expiration=excluded.expected_expiration,legs=excluded.legs,result=excluded.result,updated=excluded.updated`)
      .run(q.ticker,q.eventTicker,q.seriesTicker,category,group,q.title,q.yesLabel,q.closeTime,q.expectedExpiration,q.legs?1:0,q.legs?JSON.stringify(q.legs):null,q.result,q.updated,q.updated);
  }
  snapshot(rows:{ticker:string;time:number;yesBid:number|null;yesAsk:number|null;last:number|null;volume24h:number|null;held:boolean}[]){
    const put=this.db.prepare('INSERT OR IGNORE INTO snapshots VALUES(?,?,?,?,?,?,?)');
    this.db.transaction(()=>{for(const r of rows)put.run(r.ticker,r.time,r.yesBid,r.yesAsk,r.last,r.volume24h,r.held?1:0);})();
  }
  /** YES mid (or last trade) since `since`, thinned to about `points` values for a sparkline. */
  spark(ticker:string,since:number,points=120):{t:number;mid:number}[]{
    const rows=this.db.prepare('SELECT time AS t,CASE WHEN yes_bid IS NOT NULL AND yes_ask IS NOT NULL THEN (yes_bid+yes_ask)/2 ELSE last END AS mid FROM snapshots WHERE ticker=? AND time>=? ORDER BY time').all(ticker,since) as {t:number;mid:number|null}[];
    const valid=rows.filter((r):r is {t:number;mid:number}=>r.mid!==null),step=Math.max(1,Math.ceil(valid.length/points));
    const out=valid.filter((_,k)=>k%step===0);if(valid.length&&out.at(-1)!==valid.at(-1))out.push(valid.at(-1)!);return out;
  }
  notice(time:number,ticker:string,kind:string,context:unknown){this.db.prepare('INSERT INTO notices(time,ticker,kind,context) VALUES(?,?,?,?)').run(time,ticker,kind,JSON.stringify(context));}
  putRaw(fills:any[],settlements:any[]){
    const put=this.db.prepare('INSERT OR REPLACE INTO account_raw VALUES(?,?,?,?)');
    this.db.transaction(()=>{for(const f of fills)put.run('fill:'+(f.fill_id??f.trade_id),'fill',Date.parse(f.created_time),JSON.stringify(f));for(const s of settlements)put.run('settlement:'+s.ticker,'settlement',Date.parse(s.settled_time),JSON.stringify(s));})();
  }
  raw(){const rows=this.db.prepare('SELECT type,context FROM account_raw ORDER BY time').all() as {type:string;context:string}[];
    return {fills:rows.filter(r=>r.type==='fill').map(r=>JSON.parse(r.context)),settlements:rows.filter(r=>r.type==='settlement').map(r=>JSON.parse(r.context))};}
  /** Snapshots of markets you hold are kept for good; others (scanner, from stage 4) for 14 days. */
  prune(now=Date.now()){this.db.prepare('DELETE FROM snapshots WHERE held=0 AND time<?').run(now-14*DAY);}
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npx vitest run tests/markets-journal.test.ts`
Expected: PASS. (The sparkline test's last mid is (0.699+0.719)/2 = 0.709; fix the assertion to `toBeCloseTo(.709,3)` if the literal above disagrees.)

- [ ] **Step 5: Commit**

```bash
git add src/markets/journal.ts tests/markets-journal.test.ts
git commit -m "markets: SQLite journal with snapshots, sparkline, raw account records"
```

### Task 6: Kalshi data, state assembly and the process

**Files:**
- Create: `src/markets/kalshi-data.ts`, `src/markets/state.ts`, `src/markets/index.ts`
- Modify: `scripts/web.ts` (proxy `/api/markets/*` and `/markets-ws`), `scripts/trade.mjs` (supervise `markets`), `package.json` (`dev:all`, `markets` script), `.env.example` (`MARKETS_PORT=3002`)
- Test: `tests/markets-state.test.ts`, `tests/markets-data.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  - `class MarketsData {positions:any[];quotes:Map<string,Quote>;series:Map<string,{category:string|null;schedule:FeeSchedule}>;open:Map<string,OpenCost>;events:RealEvent[];positionsUpdated:number;quotesUpdated:number;error:{account:string|null;quotes:string|null};constructor(client:Pick<KalshiClient,'get'|'pages'|'authenticated'|'clockOffset'>,journal:MarketsJournal,log:(e:string,d:unknown)=>void);syncAccount():Promise<void>;pollQuotes(now:number):Promise<void>;held():any[]}`
  - `interface PositionCard extends PositionView {title:string;marketTitle:string;group:Group;closeTime:number|null;expectedExpiration:number|null;combo:ComboView|null;spark:{t:number;mid:number}[];seriesTicker:string}`
  - `interface MarketsState {time:number;status:'live'|'no-credentials'|'starting';error:string|null;positions:PositionCard[];bitcoin:number;summary:{count:number;atRisk:number;sellAll:number|null;holdAll:number|null;realizedToday:number|null};synced:{positions:number|null;quotes:number|null}}`
  - `buildPositions(args:{positions:any[];quotes:Map<string,Quote>;series:Map<string,{category:string|null;schedule:FeeSchedule}>;open:Map<string,OpenCost>;cfg:ExitConfig;memory:Map<string,MarketMemory>;now:number;spark:(ticker:string)=>{t:number;mid:number}[]}):{cards:PositionCard[];memory:Map<string,MarketMemory>}`
  - `summarize(cards:PositionCard[],events:RealEvent[],today:string,dayOf:(t:number)=>string):MarketsState['summary']`

- [ ] **Step 1: Write the failing tests**

`tests/markets-state.test.ts`:
```ts
import {it,expect} from 'vitest';
import {buildPositions,summarize} from '../src/markets/state';
import {parseMarket} from '../src/markets/quotes';
import {baseFees} from '../src/engine/model/fees';
import {defaults} from '../src/engine/config';
const now=10_000;
const quotes=new Map([['KXNFLGAME-X-KC',parseMarket({ticker:'KXNFLGAME-X-KC',event_ticker:'KXNFLGAME-X',title:'KC vs LV Winner?',yes_sub_title:'Kansas City',status:'active',result:'',yes_bid_dollars:'.6',yes_ask_dollars:'.62',no_bid_dollars:'.38',no_ask_dollars:'.4'},now)]]);
const series=new Map([['KXNFLGAME',{category:'Sports',schedule:baseFees}]]);
const positions=[{ticker:'KXNFLGAME-X-KC',position_fp:'4',market_exposure_dollars:'2.4',fees_paid_dollars:'.06'},{ticker:'KXBTC15M-Y',position_fp:'3',market_exposure_dollars:'1.5'},{ticker:'KXNFLGAME-Z-LV',position_fp:'0.00',market_exposure_dollars:'0'}];
it('builds one card per open non-Bitcoin position with title, group and spark',()=>{
  const {cards,memory}=buildPositions({positions,quotes,series,open:new Map(),cfg:defaults,memory:new Map(),now,spark:()=>[{t:1,mid:.5}]});
  expect(cards).toHaveLength(1);expect(cards[0]).toMatchObject({title:'Kansas City',marketTitle:'KC vs LV Winner?',group:'sports',verdict:'HOLD',seriesTicker:'KXNFLGAME'});expect(cards[0].spark).toHaveLength(1);expect(memory.has('KXNFLGAME-X-KC')).toBe(true);});
it('a combo position gets its legs and is titled by leg count',()=>{
  const combo=parseMarket({ticker:'KXMVECROSSCATEGORY-S-A',event_ticker:'KXMVECROSSCATEGORY-S',title:'yes Kansas City',yes_sub_title:'yes Kansas City',status:'active',result:'',yes_bid_dollars:'.001',yes_ask_dollars:'.9',mve_selected_legs:[{event_ticker:'KXNFLGAME-X',market_ticker:'KXNFLGAME-X-KC',side:'yes'}]},now);
  const q=new Map(quotes);q.set(combo.ticker,combo);
  const {cards}=buildPositions({positions:[{ticker:combo.ticker,position_fp:'100',market_exposure_dollars:'.5',fees_paid_dollars:'.01'}],quotes:q,series:new Map([...series,['KXMVECROSSCATEGORY',{category:'Exotics',schedule:baseFees}]]),open:new Map(),cfg:defaults,memory:new Map(),now,spark:()=>[]});
  expect(cards[0].group).toBe('combos');expect(cards[0].title).toBe('1-leg combo');expect(cards[0].combo!.value).toBeCloseTo(.61);});
it('summary sums cost, sell and hold values, and today\'s realized P&L',()=>{
  const {cards}=buildPositions({positions,quotes,series,open:new Map(),cfg:defaults,memory:new Map(),now,spark:()=>[]});
  const s=summarize(cards,[{id:'a',time:5,ticker:'X',type:'fill',pnl:1.5,contracts:1},{id:'b',time:1,ticker:'X',type:'fill',pnl:-9,contracts:1}],'D',t=>t>=5?'D':'C');
  expect(s.count).toBe(1);expect(s.atRisk).toBeCloseTo(2.46);expect(s.holdAll).toBeCloseTo(2.44);expect(s.realizedToday).toBeCloseTo(1.5);});
```

`tests/markets-data.test.ts`:
```ts
import {it,expect} from 'vitest';
import {MarketsData} from '../src/markets/kalshi-data';
import {MarketsJournal} from '../src/markets/journal';
const market=(ticker:string,extra:any={})=>({ticker,event_ticker:ticker.split('-').slice(0,2).join('-'),title:ticker,yes_sub_title:ticker,status:'active',result:'',yes_bid_dollars:'.4',yes_ask_dollars:'.42',...extra});
function fakeClient(){const calls:string[]=[];return {calls,authenticated:true,clockOffset:0,
  async get(path:string){calls.push(path);
    if(path.startsWith('/markets?tickers=')){const t=decodeURIComponent(path.split('tickers=')[1].split('&')[0]).split(',');return {markets:t.map(x=>x.startsWith('KXMVE')?market(x,{mve_selected_legs:[{event_ticker:'KXNFLGAME-A',market_ticker:'KXNFLGAME-A-KC',side:'yes'}]}):market(x))};}
    if(path.startsWith('/series/'))return {series:{category:path.includes('KXMVE')?'Exotics':'Sports',fee_type:'quadratic',fee_multiplier:1}};
    throw new Error('unexpected '+path);},
  async pages(path:string){calls.push(path);if(path.startsWith('/portfolio/positions'))return [{ticker:'KXMVECROSSCATEGORY-S-A',position_fp:'10',market_exposure_dollars:'.1'},{ticker:'KXBTC15M-Q',position_fp:'1'}];return [];}};}
it('polls held markets, then their combo legs, in batched requests; Bitcoin positions are ignored',async()=>{
  const c=fakeClient(),d=new MarketsData(c as any,new MarketsJournal(':memory:'),()=>{});await d.syncAccount();await d.pollQuotes(1000);
  expect(d.quotes.has('KXMVECROSSCATEGORY-S-A')).toBe(true);expect(d.quotes.has('KXNFLGAME-A-KC')).toBe(true);expect(d.quotes.has('KXBTC15M-Q')).toBe(false);
  expect(c.calls.filter(p=>p.startsWith('/markets?tickers=')).length).toBe(2);expect(d.series.get('KXNFLGAME')?.category).toBe('Sports');
  await d.pollQuotes(2000);expect(c.calls.filter(p=>p.startsWith('/markets?tickers=')).length).toBe(4);expect(c.calls.filter(p=>p.startsWith('/series/')).length).toBe(2);});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/markets-state.test.ts tests/markets-data.test.ts`
Expected: FAIL, because the modules are not found.

- [ ] **Step 3: Implement** `src/markets/kalshi-data.ts`:

```ts
import type {KalshiClient} from '../engine/feeds/kalshi';
import {effectiveFees} from '../engine/feeds/kalshi';
import {baseFees,type FeeSchedule} from '../engine/model/fees';
import {normalizeAccount,type OpenCost} from '../engine/account';
import type {RealEvent} from '../engine/guardrails';
import type {MarketsJournal} from './journal';
import type {Quote} from './types';
import {parseMarket} from './quotes';
import {isBitcoin,groupOf} from './categories';
type Client=Pick<KalshiClient,'get'|'pages'|'authenticated'|'clockOffset'>;
const BATCH=50;
/** Read-only Kalshi data for Markets: your positions and fills, and quotes for every held market and combo leg. */
export class MarketsData {
  positions:any[]=[];quotes=new Map<string,Quote>();series=new Map<string,{category:string|null;schedule:FeeSchedule}>();open=new Map<string,OpenCost>();events:RealEvent[]=[];
  positionsUpdated=0;quotesUpdated=0;error:{account:string|null;quotes:string|null}={account:null,quotes:null};private busy=false;
  constructor(private client:Client,private journal:MarketsJournal,private log:(e:string,d:unknown)=>void){}
  held(){return this.positions.filter(p=>!isBitcoin(String(p.ticker))&&Math.abs(Number(p.position_fp))>1e-9);}
  async syncAccount(){
    if(!this.client.authenticated||this.busy)return;this.busy=true;
    try{
      this.positions=await this.client.pages('/portfolio/positions','market_positions');this.positionsUpdated=Date.now();
      const fills=await this.client.pages('/portfolio/fills','fills');
      if(!this.journal.get('historicalBackfill',false))fills.push(...await this.client.pages('/historical/fills','fills'));
      const settlements=await this.client.pages('/portfolio/settlements','settlements');
      this.journal.putRaw(fills,settlements);this.journal.set('historicalBackfill',true);
      const raw=this.journal.raw(),open=new Map<string,OpenCost>();
      this.events=normalizeAccount(raw.fills,raw.settlements,t=>!isBitcoin(t),open);this.open=open;this.error.account=null;
    }catch(e){this.error.account=(e as Error).message;this.log('account-error',{message:this.error.account});}finally{this.busy=false;}
  }
  private async fetch(tickers:string[],now:number){
    for(let k=0;k<tickers.length;k+=BATCH){const chunk=tickers.slice(k,k+BATCH);
      const {markets}=await this.client.get('/markets?tickers='+encodeURIComponent(chunk.join(','))+'&limit='+BATCH);
      for(const m of markets??[]){const q=parseMarket(m,now);this.quotes.set(q.ticker,q);await this.seriesInfo(q.seriesTicker,q.eventTicker);this.journal.upsertMarket(q,this.series.get(q.seriesTicker)?.category??null,groupOf(this.series.get(q.seriesTicker)?.category,!!q.legs));}}
  }
  /** Category and fee type per series, fetched once. Per-event fee changes are not applied (stage 1). */
  private async seriesInfo(series:string,event:string){
    if(this.series.has(series))return;
    try{const {series:s}=await this.client.get('/series/'+encodeURIComponent(series));const schedule=effectiveFees(s,[],event,Date.now()+this.client.clockOffset);this.series.set(series,{category:s?.category??null,schedule:schedule.verified?schedule:baseFees});}
    catch(e){this.log('series-error',{series,message:(e as Error).message});this.series.set(series,{category:null,schedule:baseFees});}
  }
  /** Held markets first, then the legs of any held combo (known only once the combo's own quote arrives). */
  async pollQuotes(now:number){
    try{
      const held=this.held().map(p=>String(p.ticker));await this.fetch(held,now);
      const legs=[...new Set(held.flatMap(t=>this.quotes.get(t)?.legs??[]).map(l=>l.marketTicker))];await this.fetch(legs,now);
      this.quotesUpdated=now;this.error.quotes=null;
    }catch(e){this.error.quotes=(e as Error).message;this.log('quotes-error',{message:this.error.quotes});}
  }
}
```

`src/markets/state.ts`:
```ts
import type {FeeSchedule} from '../engine/model/fees';
import type {OpenCost} from '../engine/account';
import type {RealEvent} from '../engine/guardrails';
import type {ExitConfig} from '../engine/exits';
import type {Group,Quote} from './types';
import {comboView,type ComboView} from './combos';
import {positionView,type MarketMemory,type PositionView} from './holdsell';
import {groupOf,seriesOf} from './categories';
import {sideLabel} from './quotes';
import {baseFees} from '../engine/model/fees';
export interface PositionCard extends PositionView {title:string;marketTitle:string;group:Group;closeTime:number|null;expectedExpiration:number|null;combo:ComboView|null;spark:{t:number;mid:number}[];seriesTicker:string}
export interface MarketsState {time:number;status:'live'|'no-credentials'|'starting';error:string|null;positions:PositionCard[];bitcoin:number;summary:{count:number;atRisk:number;sellAll:number|null;holdAll:number|null;realizedToday:number|null};synced:{positions:number|null;quotes:number|null}}
export function buildPositions(a:{positions:any[];quotes:Map<string,Quote>;series:Map<string,{category:string|null;schedule:FeeSchedule}>;open:Map<string,OpenCost>;cfg:ExitConfig;memory:Map<string,MarketMemory>;now:number;spark:(ticker:string)=>{t:number;mid:number}[]}){
  const cards:PositionCard[]=[],memory=new Map<string,MarketMemory>();
  for(const p of a.positions){const ticker=String(p.ticker);if(seriesOf(ticker)==='KXBTC15M'||seriesOf(ticker)==='KXBTCD')continue;
    const q=a.quotes.get(ticker)??null,info=a.series.get(seriesOf(ticker)),combo=q?.legs?comboView(q.legs,a.quotes):null;
    const r=positionView({position:p,quote:q,combo,open:a.open.get(ticker),schedule:info?.schedule??baseFees,cfg:a.cfg,memory:a.memory.get(ticker),now:a.now});if(!r)continue;
    memory.set(ticker,r.memory);
    cards.push({...r.view,title:combo?`${combo.legs.length}-leg combo`:q?sideLabel(q,r.view.side):ticker,marketTitle:combo?combo.legs.map(l=>l.label).join(' · '):q?.title??'',
      group:groupOf(info?.category,!!q?.legs),closeTime:q?.closeTime??null,expectedExpiration:q?.expectedExpiration??null,combo,spark:a.spark(ticker),seriesTicker:seriesOf(ticker)});}
  // Most urgent first: a standing notice, then the largest amount at risk.
  cards.sort((x,y)=>Number(!!y.notice)-Number(!!x.notice)||(y.contracts*(y.avgCost??0))-(x.contracts*(x.avgCost??0)));
  return {cards,memory};
}
const sum=(xs:(number|null)[])=>xs.some(x=>x===null)?null:xs.reduce((s:number,x)=>s+(x as number),0);
export function summarize(cards:PositionCard[],events:RealEvent[],today:string,dayOf:(t:number)=>string):MarketsState['summary']{
  return {count:cards.length,atRisk:cards.reduce((s,c)=>s+c.contracts*(c.avgCost??0),0),sellAll:sum(cards.map(c=>c.verdict==='DEAD'?0:c.unrealized)),holdAll:sum(cards.map(c=>c.holdValue)),
    realizedToday:events.filter(e=>dayOf(e.time)===today).reduce((s,e)=>s+e.pnl,0)};
}
```

`src/markets/index.ts`:
```ts
import dotenv from 'dotenv';dotenv.config({path:'.env.local',quiet:true});
import {createServer} from 'node:http';
import Database from 'better-sqlite3';
import {WebSocketServer,WebSocket} from 'ws';
import {KalshiClient} from '../engine/feeds/kalshi';
import {authorized,requireDashboardCredentials} from '../engine/auth';
import {defaults,validateConfig,type Config} from '../engine/config';
import {dayKey} from '../engine/guardrails';
import {MarketsJournal} from './journal';
import {MarketsData} from './kalshi-data';
import {buildPositions,summarize,type MarketsState} from './state';
import type {MarketMemory} from './holdsell';
requireDashboardCredentials();
const journal=new MarketsJournal(),log=(event:string,data:unknown)=>{journal.log(event,data);console.log(JSON.stringify({time:new Date().toISOString(),event,...(data as object)}));};
// 200 ms between requests: at most 5 a second, leaving the account's read allowance to the Bitcoin engine.
const client=new KalshiClient(undefined,undefined,200),data=new MarketsData(client,journal,log);
let memory=new Map<string,MarketMemory>(Object.entries(journal.get<Record<string,MarketMemory>>('memory',{})));
/** Exit settings come from the dashboard's Settings (advisor.db), read-only; defaults if it is unavailable. */
let cfg:Config=defaults;
function loadConfig(){try{const db=new Database(process.env.ADVISOR_DB??'./data/advisor.db',{readonly:true,fileMustExist:true});try{const row=db.prepare("SELECT value FROM settings WHERE key='config'").get() as {value:string}|undefined;cfg=row?validateConfig(JSON.parse(row.value)):defaults;}finally{db.close();}}catch(e){log('config-unavailable',{message:(e as Error).message});}}
let state:MarketsState={time:Date.now(),status:client.authenticated?'starting':'no-credentials',error:null,positions:[],bitcoin:0,summary:{count:0,atRisk:0,sellAll:null,holdAll:null,realizedToday:null},synced:{positions:null,quotes:null}};
function build(){
  const now=Date.now(),{cards,memory:next}=buildPositions({positions:data.positions,quotes:data.quotes,series:data.series,open:data.open,cfg,memory,now,spark:t=>{const first=data.events.filter(e=>e.ticker===t&&e.type==='fill').at(0)?.time??now-86400000;return journal.spark(t,first);}});
  for(const c of cards){const before=memory.get(c.ticker)?.notice??null;if(c.notice&&c.notice.kind!==before)journal.notice(now,c.ticker,c.notice.kind,{notice:c.notice,bid:c.bid,winProb:c.winProb,unrealized:c.unrealized});}
  memory=next;
  state={time:now,status:!client.authenticated?'no-credentials':data.positionsUpdated?'live':'starting',error:data.error.account??data.error.quotes,positions:cards,
    bitcoin:data.positions.filter(p=>/^KXBTC(15M|D)-/.test(String(p.ticker))&&Math.abs(Number(p.position_fp))>1e-9).length,
    summary:summarize(cards,data.events,dayKey(now),t=>dayKey(t)),synced:{positions:data.positionsUpdated||null,quotes:data.quotesUpdated||null}};
}
const safe=(name:string,f:()=>unknown)=>{try{const r=f();if(r instanceof Promise)r.catch(e=>log(name,{message:(e as Error).message}));}catch(e){log(name,{message:(e as Error).message});}};
const server=createServer((req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(!authorized(req.headers.authorization,req)){res.writeHead(401,{'WWW-Authenticate':'Basic realm="Kalshi Advisor"'});res.end('Authentication required');return;}
  const path=new URL(req.url??'/','http://127.0.0.1').pathname;
  if(req.method==='GET'&&path==='/state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(state));return;}
  res.writeHead(404);res.end('Not found');
});
const wss=new WebSocketServer({noServer:true});
server.on('upgrade',(req,socket,head)=>{if(req.url!=='/ws'||!authorized(req.headers.authorization,req)){socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>{ws.send(JSON.stringify(state));});});
const port=Number(process.env.MARKETS_PORT??3002);
server.listen(port,'127.0.0.1',()=>log('markets-listening',{port,authenticated:client.authenticated}));
async function boot(){
  loadConfig();
  // Any public response carries the server Date, which the signed requests need first.
  try{await client.get('/exchange/status');}catch(e){log('clock-sync-error',{message:(e as Error).message});}
  await data.syncAccount();await data.pollQuotes(Date.now());build();
}
void boot();
setInterval(()=>safe('account-sync-error',()=>data.syncAccount()),30000);
setInterval(()=>safe('quotes-error',()=>data.pollQuotes(Date.now())),5000);
setInterval(()=>safe('snapshot-error',()=>{const now=Date.now(),held=new Set(data.held().map(p=>String(p.ticker)));
  journal.snapshot([...data.quotes.values()].map(q=>({ticker:q.ticker,time:now,yesBid:q.yesBid,yesAsk:q.yesAsk,last:q.last,volume24h:q.volume24h,held:true})).filter(r=>held.has(r.ticker)||data.quotes.has(r.ticker)));}),30000);
setInterval(()=>safe('memory-save-error',()=>journal.set('memory',Object.fromEntries(memory))),30000);
setInterval(()=>safe('config-error',loadConfig),60000);
setInterval(()=>safe('prune-error',()=>journal.prune()),3600000);
setInterval(()=>{safe('build-error',build);const message=JSON.stringify(state);for(const ws of wss.clients)if(ws.readyState===WebSocket.OPEN&&ws.bufferedAmount<1000000)ws.send(message);},1000);
const stop=()=>{try{journal.set('memory',Object.fromEntries(memory));journal.db.close();}catch{}process.exit(0);};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
```

`scripts/web.ts`: add `marketsPort=Number(process.env.MARKETS_PORT??3002)`. Generalise the HTTP proxy to a prefix → port table (`/api/engine/` → enginePort, `/api/markets/` → marketsPort, with an "unavailable" message for each). Generalise the WS upgrade to `{'/ws':enginePort,'/markets-ws':marketsPort}`, keeping the same origin check. The upstream path is `/ws` for both.

`scripts/trade.mjs`: after `supervise('web',…)`, add `supervise('markets',['--import','tsx','src/markets/index.ts']);`.

`package.json`: `"dev:all": "concurrently -k \"tsx watch src/engine/index.ts\" \"tsx watch src/markets/index.ts\" \"tsx scripts/web.ts --dev\""` and `"markets": "tsx src/markets/index.ts"`.

`.env.example`: add `MARKETS_PORT=3002` after `ENGINE_PORT`.

- [ ] **Step 4: Run the tests, then typecheck**

Run: `npx vitest run tests/markets-state.test.ts tests/markets-data.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Smoke-run the process against the live account** (read-only)

Run: `MARKETS_PORT=3012 npx tsx src/markets/index.ts`, then `curl -s http://127.0.0.1:3012/state` from this PC (local auth is off).
Expected: `status:"live"` and one card, the user's 8-leg combo, with `combo.value` ≈ the product of the leg mids. Stop it afterwards.

- [ ] **Step 6: Commit**

```bash
git add src/markets scripts/web.ts scripts/trade.mjs package.json .env.example tests/markets-state.test.ts tests/markets-data.test.ts
git commit -m "markets process: read-only Kalshi positions and quotes, state at 1 Hz, proxied and supervised"
```

### Task 7: Markets sounds and the live hook

**Files:**
- Modify: `src/components/use-live.ts` (path parameter), `src/components/sounds.ts` (markets category and 4 sounds), `src/components/alert-events.ts` (markets snapshot, events and cross-tab claim), `src/components/use-sound-alerts.ts` (markets argument)
- Test: `tests/alerts.test.ts` (append)

**Interfaces:**
- Produces:
  - `useLive(path='/ws')`
  - `SoundName` adds `'marketMove'|'comboDead'|'legWon'|'oneLeft'`; `Category` adds `'markets'`
  - `marketsSnapshot(m:any,fresh:boolean):Record<string,string|null>`
  - `detectMarketEvents(prev:Record<string,string|null>|null,next:Record<string,string|null>):{ticker:string;kind:string;sound:SoundName}[]`
  - `claimOnce(key:string,now:number,store:Pick<Storage,'getItem'|'setItem'>,windowMs=60000):boolean`
  - `useSoundAlerts(s,fresh,page:'15m'|'hourly'|'markets'='15m',markets?:{state:any;fresh:boolean})`

- [ ] **Step 1: Write the failing tests** (append to `tests/alerts.test.ts`)

```ts
import {marketsSnapshot,detectMarketEvents,claimOnce} from '../src/components/alert-events';
it('markets: a new notice kind on a position plays its sound once; first sight and clearing are silent',()=>{
  const s=(kind:string|null)=>marketsSnapshot({positions:[{ticker:'C',notice:kind?{kind}:null}]},true);
  expect(detectMarketEvents(null,s('dead'))).toEqual([]);
  expect(detectMarketEvents(s(null),s('one-left'))).toEqual([{ticker:'C',kind:'one-left',sound:'oneLeft'}]);
  expect(detectMarketEvents(s('one-left'),s('dead')).map(e=>e.sound)).toEqual(['comboDead']);
  expect(detectMarketEvents(s(null),s('leg-won')).map(e=>e.sound)).toEqual(['legWon']);
  expect(detectMarketEvents(s(null),s('loss')).map(e=>e.sound)).toEqual(['marketMove']);
  expect(detectMarketEvents(s('loss'),s(null))).toEqual([]);expect(detectMarketEvents(s(null),marketsSnapshot(null,false))).toEqual([]);});
it('claimOnce lets only one tab play a markets sound within the window',()=>{
  const m=new Map<string,string>(),store={getItem:(k:string)=>m.get(k)??null,setItem:(k:string,v:string)=>void m.set(k,v)};
  expect(claimOnce('C:dead',1000,store)).toBe(true);expect(claimOnce('C:dead',1500,store)).toBe(false);expect(claimOnce('C:dead',62000,store)).toBe(true);});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/alerts.test.ts`
Expected: FAIL, because the exports are missing.

- [ ] **Step 3: Implement**

`use-live.ts`: `export function useLive(path='/ws')`. Use `${location.host}${path}` in the socket URL and put `path` in the effect deps.

`sounds.ts`:
- `SoundName` adds the four names.
- `Category` adds `'markets'`.
- catalog entries:
  ```ts
  {name:'marketMove',label:'Big move on another market you hold',category:'markets'},{name:'oneLeft',label:'Combo: one leg left',category:'markets'},{name:'legWon',label:'Combo: a leg won',category:'markets'},{name:'comboDead',label:'Combo: a leg lost',category:'markets'}
  ```
- `categoryLabels.markets='Other markets'`.
- `defaultPrefs.categories.markets=true`.
- scores:
  ```ts
  marketMove:[[A4,0,.12,'triangle',.8],[E5,.14,.12,'triangle',.8],[A4,.28,.2,'triangle',.8]],
  oneLeft:[[C5,0,.12,'sine'],[E5,.12,.12,'sine'],[G5,.24,.12,'sine'],[G5,.4,.25,'sine',.7]],
  legWon:[[G5,0,.1,'triangle',.7],[C6,.1,.25,'triangle',.7]],
  comboDead:[[G4,0,.3,'sine',.8,B3],[B3,.3,.45,'sine',.7]]
  ```
- Add `'comboDead','oneLeft','marketMove','legWon'` to `priority` right after `'positionMove'`.

`alert-events.ts`:
```ts
const MARKET_SOUNDS:Record<string,SoundName>={dead:'comboDead','one-left':'oneLeft','leg-won':'legWon'};
/** Notice kind per held market on the Markets process; empty when its state is not fresh (silence, not a change). */
export function marketsSnapshot(m:any,fresh:boolean):Record<string,string|null>{return fresh&&m?Object.fromEntries((m.positions??[]).map((p:any)=>[p.ticker,p.notice?.kind??null])):{};}
export function detectMarketEvents(prev:Record<string,string|null>|null,next:Record<string,string|null>){
  if(!prev)return [];const out:{ticker:string;kind:string;sound:SoundName}[]=[];
  for(const [ticker,kind] of Object.entries(next))if(kind&&ticker in prev&&kind!==prev[ticker])out.push({ticker,kind,sound:MARKET_SOUNDS[kind]??'marketMove'});
  return out;
}
/** Every open dashboard tab sees the same markets notice; the first tab to claim it plays it. */
export function claimOnce(key:string,now:number,store:Pick<Storage,'getItem'|'setItem'>,windowMs=60000){
  try{const k='ka-claim:'+key,last=Number(store.getItem(k));if(Number.isFinite(last)&&now-last<windowMs)return false;store.setItem(k,String(now));return true;}catch{return true;}
}
```
A new position's ticker is absent from `prev`, so it is silent the first time, which is the baseline.

`use-sound-alerts.ts`:
- Add the parameter `markets?:{state:any;fresh:boolean}` and a `prevMarkets` ref.
- Add a second effect on `[markets?.state,markets?.fresh,prefs]`:
  - compute `next=marketsSnapshot(...)` and `events=detectMarketEvents(prevMarkets.current,next)`;
  - update `prevMarkets.current=next` only when fresh;
  - for each event, keep it when `prefs.enabled&&prefs.categories.markets&&claimOnce(ticker+':'+kind,Date.now(),localStorage)`, and play at most 3, spaced `SPACING_MS`.
- `page` gains `'markets'`. The BTC effect already returns when `s` is null.

Update every `useSoundAlerts` caller:
- `dashboard.tsx`: `const m=useLive('/markets-ws');` then `useSoundAlerts(s,fresh,'15m',{state:m.state,fresh:m.fresh})`
- `hourly.tsx`: the same, with `'hourly'`.

- [ ] **Step 4: Run all tests and the typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/use-live.ts src/components/sounds.ts src/components/alert-events.ts src/components/use-sound-alerts.ts src/components/dashboard.tsx src/components/hourly.tsx tests/alerts.test.ts
git commit -m "markets sounds: notice-driven alerts on every page, one tab plays each"
```

### Task 8: The Markets page

**Files:**
- Create: `src/app/markets/page.tsx`, `src/components/markets.tsx`, `src/components/position-card.tsx`
- Modify: `src/components/site-header.tsx` (Markets link, `current` union, `px-2 sm:px-3`), `src/components/panels.tsx` (export `Stat`, `Heading`; extract and export `Notice`, used by `Positions`)

**Interfaces:**
- Consumes: `MarketsState` and `PositionCard` JSON (Task 6), `useLive('/markets-ws')`, `useSoundAlerts` (Task 7).
- Produces:
  - `Notice({notice}:{notice:{tone:'yes'|'warn'|'no';title:string;text:string}})`
  - `PositionCardView({c,now}:{c:any;now:number})`
  - default export `Markets`

- [ ] **Step 1: Shared pieces in panels.tsx**

Export `Stat` and `Heading`. Add:
```tsx
const noticeStyle:Record<string,string>={yes:'border-yes/40 bg-yes-dim/30',warn:'border-warn/40 bg-warn-dim/30',no:'border-no/40 bg-no-dim/30'};
/** A heads-up box: what moved and what selling now would do. Shared by the Bitcoin positions box and Markets. */
export function Notice({notice}:{notice:{tone:'yes'|'warn'|'no';title:string;text:string}}){
  return <div role="status" className={cn('mt-3 rounded-xl border px-3 py-2 text-sm',noticeStyle[notice.tone])}><div className={cn('font-medium',toneText[notice.tone as Tone])}>{notice.title}</div><div className="text-fg/85">{notice.text}</div></div>;
}
```
In `Positions`, remove the local `noticeStyle` and replace the inline notice markup with `{e.notice?<Notice notice={e.notice}/>:null}`.

- [ ] **Step 2: Nav.** In `site-header.tsx`:
```tsx
const links=[{href:'/',label:'15-min'},{href:'/hourly',label:'Hourly'},{href:'/markets',label:'Markets'},{href:'/analytics',label:'Analytics'},{href:'/calibration',label:'Calibration'}];
export function SiteHeader({current,aside,children,bottom}:{current:'/'|'/hourly'|'/markets'|'/analytics'|'/calibration';…})
```
In the link class, change `px-3` to `px-2 sm:px-3`.

- [ ] **Step 3: Route.** `src/app/markets/page.tsx`:
```tsx
import Markets from '@/components/markets';
export const metadata={title:'Markets · Kalshi Advisor'};
export default function Page(){return <Markets/>;}
```

- [ ] **Step 4: Position card.** `src/components/position-card.tsx`:
```tsx
'use client';
import {Pill,Stat,Notice,type Tone} from './panels';
import {cn} from '@/lib/utils';
import {dollars,signedDollars,cents,pct,qty} from './format';
const groupLabel:Record<string,string>={sports:'Sports',combos:'Combo',politics:'Politics & econ',commodities:'Commodities & crypto'};
const toneText:Record<Tone,string>={yes:'text-yes',no:'text-no',warn:'text-warn',neutral:'text-fg'};
/** Cents with two decimals below 1¢, where combos trade. */
const price=(v:number|null|undefined)=>v!=null&&v<.01?cents(v,2):cents(v);
const sp=(x:number|null|undefined)=>x==null?'—':`${x>=0?'+':'−'}${Math.abs(x*100).toFixed(0)}%`;
function until(t:number|null,now:number){if(!t)return null;const s=Math.round((t-now)/1000);if(s<=0)return 'result due';const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return `result in ${d?`${d}d ${h}h`:h?`${h}h ${m}m`:`${m}m`}`;}
function Spark({points}:{points:{t:number;mid:number}[]}){
  if(points.length<2)return <div className="text-xs text-faint">Price line builds every 30 s.</div>;
  const t0=points[0].t,t1=points.at(-1)!.t,lo=Math.min(...points.map(p=>p.mid)),hi=Math.max(...points.map(p=>p.mid)),w=160,h=40;
  const d=points.map((p,k)=>`${k?'L':'M'}${((p.t-t0)/Math.max(1,t1-t0)*w).toFixed(1)},${(h-(p.mid-lo)/Math.max(1e-9,hi-lo)*h).toFixed(1)}`).join(' ');
  return <svg viewBox={`0 0 ${w} ${h}`} className="h-10 w-40" role="img" aria-label={`YES price from ${price(points[0].mid)} to ${price(points.at(-1)!.mid)}`}><path d={d} fill="none" stroke="var(--color-info)" strokeWidth="1.5" vectorEffect="non-scaling-stroke"/></svg>;
}
export function PositionCardView({c,now}:{c:any;now:number}){
  const pnlTone:Tone=c.unrealized>.005?'yes':c.unrealized<-.005?'no':'neutral';
  const verdictTone:Tone=c.verdict==='DEAD'?'no':c.verdict==='SELL BEATS HOLD'?'warn':c.verdict==='HOLD'?pnlTone:'neutral';
  const due=until(c.expectedExpiration??c.closeTime,now);
  return <div className="grid gap-4 border-t border-line pt-4 first:border-0 first:pt-0 lg:grid-cols-[1fr_auto]">
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2 text-sm"><Pill tone="neutral">{groupLabel[c.group]??c.group}</Pill><span className="font-medium">{c.title}</span><span className="truncate text-muted">{c.marketTitle}</span></div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1"><div className={cn('font-display text-5xl leading-none font-bold uppercase',toneText[verdictTone],c.stale&&'opacity-60')}>{c.verdict}</div>
        {c.unrealized!=null&&!['SETTLING','DEAD'].includes(c.verdict)?<div className={cn('num text-2xl font-semibold',toneText[pnlTone])}>{c.unrealized>=0?'UP':'DOWN'} {signedDollars(c.unrealized)} <span className="text-base">({sp(c.unrealizedPct)})</span></div>:null}</div>
      <div className="mt-2 text-sm"><span className="num">{qty(c.contracts)}</span> {c.side.toUpperCase()} · cost <span className="num">{price(c.avgCost)}</span> incl. fees{c.costSource==='estimate'?<span className="text-faint"> (estimated)</span>:null} · win chance <span className="num">{pct(c.winProb,c.winProb!=null&&c.winProb<.01?2:0)}</span>{due?<> · {due}</>:null}{c.stale?<span className="text-warn"> · prices stale</span>:null}</div>
      {c.peakPct!=null&&c.probSource==='market'?<div className="mt-1 text-xs text-muted">Best {sp(c.peakPct)} · worst {sp(c.troughPct)} so far</div>:null}
      {c.notice?<Notice notice={c.notice}/>:null}
      <p className="mt-2 text-sm text-fg/90">{c.reason}</p>
      {c.combo?<div className="mt-3 overflow-x-auto"><table className="w-full min-w-[480px] text-sm"><thead className="text-left text-xs text-muted"><tr>{['Leg','Side','Status','Bid / ask','Chance'].map(t=><th key={t} scope="col" className="pb-2 pr-3 font-medium">{t}</th>)}</tr></thead>
        <tbody>{c.combo.legs.map((l:any)=><tr key={l.ticker} className="border-t border-line"><th scope="row" className="py-1.5 pr-3 text-left font-medium">{l.label}</th><td className="pr-3 text-muted">{l.side.toUpperCase()}</td>
          <td className="pr-3">{l.status==='won'?<Pill tone="yes">won</Pill>:l.status==='lost'?<Pill tone="no">lost</Pill>:l.status==='unknown'?<Pill tone="warn">no price</Pill>:<span className="text-muted">to play</span>}</td>
          <td className="num pr-3">{l.status==='pending'?`${price(l.bid)} / ${price(l.ask)}`:'—'}</td><td className="num">{pct(l.p,0)}</td></tr>)}</tbody></table>
        <p className="mt-2 text-xs text-faint">{c.combo.won} won · {c.combo.pending} to play{c.combo.correlated?' · some legs are on the same game, so the value is rough':''}. Value = product of each leg&apos;s chance (independent legs).</p></div>:null}
    </div>
    <div className="flex flex-col items-end gap-3 self-start"><div className="grid grid-cols-3 gap-5 text-right">
      <Stat label="P&L if sold" tone={pnlTone} sub={c.unrealizedPct!=null?`${sp(c.unrealizedPct)} of cost`:undefined}>{signedDollars(c.unrealized)}</Stat>
      <Stat label="Sell now" sub={c.bid!=null?`bid ${price(c.bid)} − ${dollars(c.sellFee)} fee`:'no bid'}>{dollars(c.sellValue)}</Stat>
      <Stat label="Hold value" sub={c.probSource==='legs'?'legs × $1':c.probSource==='settled'?'payout':'market odds × $1'}>{dollars(c.holdValue)}</Stat></div>
      <Spark points={c.spark??[]}/></div>
  </div>;
}
```

- [ ] **Step 5: Page.** `src/components/markets.tsx`:
```tsx
'use client';
import {useEffect,useState} from 'react';
import {Wallet,Info} from 'lucide-react';
import {useLive} from './use-live';
import {useSoundAlerts} from './use-sound-alerts';
import {SoundToggle} from './sound-panel';
import {SiteHeader} from './site-header';
import {Card} from './ui/card';
import {Pill,Stat,Heading} from './panels';
import {PositionCardView} from './position-card';
import {cn} from '@/lib/utils';
import {dollars,signedDollars,ago} from './format';
const FILTERS:[string,string][]=[['all','All'],['sports','Sports'],['combos','Combos'],['politics','Politics & econ'],['commodities','Commodities & crypto']];
const KEY='markets:filter';
export default function Markets(){
  const m=useLive('/markets-ws'),st=m.fresh?m.state:null,sound=useSoundAlerts(null,false,'markets',{state:m.state,fresh:m.fresh});
  const [filter,setFilterState]=useState('all');
  useEffect(()=>{try{const v=localStorage.getItem(KEY);if(v&&FILTERS.some(([k])=>k===v))setFilterState(v);}catch{}},[]);
  const setFilter=(v:string)=>{setFilterState(v);try{localStorage.setItem(KEY,v);}catch{}};
  const all:any[]=st?.positions??[],shown=filter==='all'?all:all.filter(p=>p.group===filter),now=st?.time??Date.now(),s=st?.summary;
  const synced=st?.synced?.positions?`synced ${ago(Math.max(0,now-st.synced.positions))} ago`:'not synced yet';
  const urgent=shown.some(p=>p.notice);
  return <>
    <div aria-hidden className="ambient" data-tone={!m.fresh?'warn':'none'}/>
    <SiteHeader current="/markets">
      <SoundToggle prefs={sound.prefs} setPrefs={sound.setPrefs} ready={sound.ready}/>
      <Pill tone={m.fresh?'yes':'warn'}><span className={m.fresh?'pulse size-1.5 rounded-full bg-yes':'size-1.5 rounded-full bg-warn'}/>{m.fresh?'Live':m.connected?'Stale':'Reconnecting'}</Pill>
    </SiteHeader>
    <main className="mx-auto max-w-[1400px] space-y-4 px-4 pt-4 pb-16 sm:px-6">
      {!st?<Card className="space-y-1"><p className="text-sm">Markets engine unavailable.</p><p className="text-sm text-muted">{m.connected?'Waiting for its first update.':'It starts with the app; this page reconnects on its own.'} The Bitcoin pages are not affected.</p></Card>:<>
      {st.status==='no-credentials'?<Card><p className="text-sm">Kalshi credentials unavailable, so positions cannot be read. Add the API key in .env.local.</p></Card>:null}
      <Card className="rise grid grid-cols-2 gap-5 sm:grid-cols-4">
        <Stat label="At risk" sub={`${s.count} position${s.count===1?'':'s'} · cost incl. fees`}>{dollars(s.atRisk)}</Stat>
        <Stat label="If sold now" tone={s.sellAll>0?'yes':s.sellAll<0?'no':'neutral'} sub="P&L at the bids">{signedDollars(s.sellAll)}</Stat>
        <Stat label="If held" sub="value at market odds">{dollars(s.holdAll)}</Stat>
        <Stat label="Realized today" tone={s.realizedToday>0?'yes':s.realizedToday<0?'no':'neutral'} sub="outside Bitcoin">{signedDollars(s.realizedToday)}</Stat>
      </Card>
      <nav aria-label="Filter by category" className="flex flex-wrap gap-1">{FILTERS.map(([k,l])=>{const n=k==='all'?all.length:all.filter(p=>p.group===k).length;return <button key={k} type="button" aria-pressed={filter===k} onClick={()=>setFilter(k)}
        className={cn('inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-xl px-3 text-sm transition-colors',filter===k?'bg-surface-2 text-fg':'text-muted hover:text-fg')}>{l}<span className="num text-xs text-faint">{n}</span></button>;})}</nav>
      {shown.length?<Card className={cn('rise',urgent?'border-warn/50':'border-info/30')}><Heading icon={<Wallet aria-hidden className="size-4 text-info"/>} title="Your other positions" aside={synced}/>
        <div className="mt-4">{shown.map(c=><PositionCardView key={c.ticker} c={c} now={now}/>)}</div></Card>
      :<Card className="flex min-h-14 flex-wrap items-center gap-3 py-3"><Wallet aria-hidden className="size-4 text-faint"/><span className="label">Your other positions</span><span className="ml-auto text-sm text-muted">{filter==='all'?'No open positions outside Bitcoin':'None in this category'} <span className="text-xs text-faint">· {synced}</span></span></Card>}
      {st.bitcoin?<p className="text-sm text-muted">You also hold {st.bitcoin} Bitcoin position{st.bitcoin===1?'':'s'}; see the <a className="text-info hover:underline" href="/">15-min</a> and <a className="text-info hover:underline" href="/hourly">Hourly</a> pages.</p>:null}
      {st.error?<p className="text-xs text-warn">Kalshi: {st.error}</p>:null}
      <Card className="flex items-start gap-3 text-xs text-muted"><Info aria-hidden className="mt-0.5 size-4 shrink-0 text-info"/><span>Hold value is what the position pays at today&apos;s market odds (the YES mid; for a combo, its legs multiplied, which assumes they are independent). Selling pays the bid minus Kalshi&apos;s fee, so at market odds holding usually looks better; that changes only when another source disagrees with Kalshi (coming in a later stage). These are numbers, not recommendations. Prices refresh every 5 s and are saved every 30 s.</span></Card>
      </>}
    </main>
  </>;
}
```

- [ ] **Step 6: Typecheck, tests, build**

Run: `npx tsc --noEmit && npx vitest run && npx next build` with `NEXT_DIST_DIR` set to a scratch directory if the app is running. Restore `next-env.d.ts` afterwards (known gotcha).
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/app/markets src/components/markets.tsx src/components/position-card.tsx src/components/site-header.tsx src/components/panels.tsx
git commit -m "Markets page: positions with hold/sell math, combo legs, notices, filters and price line"
```

### Task 9: Live verification and docs

**Files:**
- Modify: `README.md` (Markets section), `DECISIONS.md` (new entries), `docs/VERIFICATION.md` (stage 1 record)

- [ ] **Step 1: Run the full app the way the user does.** Restart through the desktop launcher (`npm run trade` path), so the supervisor starts `markets`. Check `logs/launcher.log` for `process-start` with name `markets`.
- [ ] **Step 2: Browser check.**
  - In the built-in browser at `http://127.0.0.1:3000/markets` (local auth off): the combo card shows 8 legs, won/to-play statuses, a value ≈ the product of the mids, and a sell value at the 0.1¢ bid.
  - Filters switch.
  - Header nav fits at 375 px wide; check both desktop and mobile widths.
  - No console errors.
- [ ] **Step 3: Engine unaffected.** Read `loopMs` from `http://127.0.0.1:3001/state` with the markets process running and compare it with before. Expect the same order of magnitude.
- [ ] **Step 4: Docs.**
  - README: a "Markets page" bullet in *Reading the dashboard* plus the architecture line.
  - DECISIONS:
    - separate process;
    - the verdict margin formula;
    - combo fee type verified on the real fill;
    - leg status without game clock;
    - per-event fee changes not applied;
    - sounds claimed by one tab;
    - exit settings read from advisor.db.
  - VERIFICATION: what was checked, with numbers.
- [ ] **Step 5: Commit**

```bash
git add README.md DECISIONS.md docs/VERIFICATION.md
git commit -m "markets stage 1: docs and live verification"
```
