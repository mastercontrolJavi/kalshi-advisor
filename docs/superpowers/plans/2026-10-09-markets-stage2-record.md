# Markets Stage 2: Backfill and Record Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two parts.
- A resumable backfill of settled non-Bitcoin Kalshi markets, refreshed daily in the background.
- A Record tab at `/markets/record` that shows (a) the user's own non-Bitcoin record by category and entry price, and (b) how accurate Kalshi's prices were, by category and price bucket, measured 1 h before, 24 h before, and as the volume-weighted average.

**Architecture:**
- **Pure functions** in `src/markets/backfill.ts` (candle math, series choice, batching) and `src/markets/record.ts` (aggregates with Wilson and event-clustered bootstrap ranges).
- **Fetch orchestrator:** `scripts/markets-backfill.ts`, public GETs only, writing into `data/markets.db`.
- **Refresh:** the markets process runs that script daily as a below-normal-priority child and serves `/record`.
- **UI:** a tab bar (Positions · Record) shared by both Markets pages.

**Tech Stack:** TypeScript, better-sqlite3, vitest, Next.js 15, recharts (existing `ReliabilityChart`).

**Spec:** `docs/superpowers/specs/2026-10-09-markets-advisor-design.md` (stage 2 in §8; §2.3 items 1–2 and 4; §3 backfill; §4 `backfill` table).

## Global Constraints

- Public, unauthenticated Kalshi GETs only. One client at 200 ms spacing (≤ 5 requests/s), with the existing 429 backoff. Never touches orders.
- KXBTC15M and KXBTCD are excluded everywhere. Combos are excluded from the Kalshi-accuracy backfill and appear only in "Your record" (see Rulings).
- Price buckets for accuracy are `[0,.05,.1,.2,.35,.5,.65,.8,.9,.95,1]`. Buckets for "Your record" entry price are `0–5¢, 5–20¢, 20–50¢, 50–80¢, 80–100¢` (spec §2.3).
- Horizons are measured before the **event time**: Kalshi's `occurrence_datetime` when it is earlier than settlement (game start), otherwise `settlement_ts`.
- A horizon price is the YES mid of the latest hourly candle ending at or before that time, no more than 2 h older than it. The bid must be > 0, the ask < 1, and the spread ≤ 20¢; otherwise the price is null.
- Ranges: Wilson 95% for win rates (`wilson` from `src/engine/model/opening.ts`). Event-clustered bootstrap 95% for return per $1 (`clusterCI` from `src/backtest/sim.ts`, 1,000 resamples).
- Return per $1 = (result − ask − taker fee(ask)) / (ask + fee) for buying one YES contract at the horizon ask. This is data, not a recommendation.
- The UI follows the stage 1 checklist. The Record page's reference is `src/components/analytics.tsx`: `Kpi` cards, `Breakdown`-style tables, the dashed `Empty` box, and a once-a-minute fetch with an error line.

## Rulings carried in from research (2026-10-09)

1. **Window = the live endpoint, from Kalshi's historical cutoff (2026-08-10) to now: about 60 days, growing daily.** The spec said 90 days. Before the cutoff, `/historical/markets` ignores filters and pages every market newest-first; more than 60,000 non-combo markets settle per day. Cost if wrong: about 30 fewer days at first.
2. **Series are chosen, not everything.** The backfill takes the top 20 series by lifetime volume in each of sports, politics & economics, and commodities & crypto, plus every series the user has traded. Within each series it takes markets with ≥ 100 contracts traded, at most 4,000 per series per run, highest volume first.
3. **No Kalshi-wide combo calibration.** A probe of one day found 2,000 settled combos, all with zero volume and no price history, so there is nothing to calibrate. Combos appear in "Your record".

## Review Focus

1. **A market with no candle near the horizon** (thin market, or one opened less than 24 h before): its price must be null and it must be excluded from that horizon's buckets, never counted at a stale price. The test is in Task 1.
2. **Both sides of one game** (two YES markets in one event): they must share one bootstrap cluster, so the range is not overstated. The test is in Task 4.
3. **The backfill is interrupted mid-run:** the next run resumes. Markets already stored are not refetched; candles are fetched only where they are missing. The test is in Task 3.
4. **The record endpoint before any backfill:** the page shows an empty state saying the backfill runs 10 minutes after start, not zeros. The test is in Task 4 (`buildRecord` with no rows), plus the UI empty state in Task 6.
5. **A bucket with very few markets:** its range is shown as unavailable rather than as a tight interval. Wilson with n = 1 is wide, and the bootstrap with fewer than 2 clusters gives NaN, shown as "—". The test is in Task 4.

---

### Task 1: Backfill math

**Files:** Create `src/markets/backfill.ts`; Test `tests/markets-backfill.test.ts`

**Interfaces:**
- Produces:
  - `interface Candle {end:number;bid:number|null;ask:number|null;mean:number|null;volume:number}`
  - `parseCandle(c:any):Candle`
  - `eventTime(m:any):number|null` (unix seconds)
  - `priceAt(candles:Candle[],ts:number):{mid:number;ask:number}|null`
  - `vwap(candles:Candle[],from:number,to:number):number|null`
  - `pickSeries(series:{ticker:string;category:string|null;volume:number}[],traded:Set<string>,perGroup=20):string[]`
  - `candleGroups<T extends {ticker:string;event:number}>(rows:T[],maxTickers=100,maxCandles=9900,lookbackH=25):T[][]`

- [ ] **Step 1: Failing tests**

```ts
import {it,expect} from 'vitest';
import {parseCandle,eventTime,priceAt,vwap,pickSeries,candleGroups} from '../src/markets/backfill';
const raw=(end:number,bid:string,ask:string,mean:string|null,vol:string)=>({end_period_ts:end,yes_bid:{close_dollars:bid},yes_ask:{close_dollars:ask},price:mean===null?{}:{mean_dollars:mean},volume_fp:vol});
it('parses Kalshi hourly candles; an empty book side is null',()=>{
  expect(parseCandle(raw(10,'0.5000','0.5200','0.5100','228.61'))).toEqual({end:10,bid:.5,ask:.52,mean:.51,volume:228.61});
  expect(parseCandle(raw(10,'0.0000','1.0000',null,'0'))).toEqual({end:10,bid:null,ask:null,mean:null,volume:0});});
it('event time is the game start when Kalshi gives one before settlement, else settlement',()=>{
  expect(eventTime({occurrence_datetime:'2026-10-09T00:00:00Z',settlement_ts:'2026-10-09T03:53:53Z'})).toBe(Date.parse('2026-10-09T00:00:00Z')/1000);
  expect(eventTime({occurrence_datetime:'2026-10-10T00:00:00Z',settlement_ts:'2026-10-09T03:53:53Z'})).toBe(Math.floor(Date.parse('2026-10-09T03:53:53Z')/1000));
  expect(eventTime({close_time:'2026-10-09T03:49:52Z'})).toBe(Date.parse('2026-10-09T03:49:52Z')/1000);expect(eventTime({})).toBeNull();});
it('price at a horizon: latest candle ending at or before it, at most 2 h stale, two-sided and ≤ 20¢ wide',()=>{
  const cs=[raw(3600,'0.40','0.42','0.41','5'),raw(7200,'0.45','0.47','0.46','5'),raw(10800,'0.10','0.50','0.3','5')].map(parseCandle);
  expect(priceAt(cs,7300)).toEqual({mid:.46,ask:.47});expect(priceAt(cs,10800)).toBeNull();
  expect(priceAt(cs,7200+2*3600+1)).toBeNull();expect(priceAt(cs,100)).toBeNull();});
it('volume-weighted mean price over a window ignores hours without trades',()=>{
  const cs=[raw(3600,'0.4','0.42','0.40','10'),raw(7200,'0.5','0.52','0.60','30'),raw(10800,'0.5','0.52',null,'0')].map(parseCandle);
  expect(vwap(cs,0,10800)).toBeCloseTo(.55);expect(vwap(cs,7201,10800)).toBeNull();});
it('picks the top series per group by volume plus traded ones, never Bitcoin or combos',()=>{
  const s=[{ticker:'KXBTC15M',category:'Crypto',volume:9e9},{ticker:'KXBTCD',category:'Crypto',volume:8e9},{ticker:'KXETH15M',category:'Crypto',volume:1e9},{ticker:'KXSOLD',category:'Crypto',volume:5e8},
    {ticker:'KXNBAGAME',category:'Sports',volume:9e9},{ticker:'KXMLBGAME',category:'Sports',volume:8e9},{ticker:'KXFED',category:'Economics',volume:3e8},{ticker:'KXMVECROSSCATEGORY',category:'Exotics',volume:9e9},{ticker:'KXTINY',category:'Sports',volume:1}];
  expect(pickSeries(s,new Set(['KXTINY','KXBTC15M']),1).sort()).toEqual(['KXETH15M','KXFED','KXNBAGAME','KXTINY']);});
it('groups markets for the batch candle endpoint by event time within the candle budget',()=>{
  const rows=Array.from({length:250},(_,k)=>({ticker:'T'+k,event:k<200?1000:1000+100*3600}));
  const g=candleGroups(rows);expect(g.flat()).toHaveLength(250);expect(g.every(x=>x.length<=100)).toBe(true);
  expect(g.every(x=>{const span=(Math.max(...x.map(r=>r.event))-Math.min(...x.map(r=>r.event)))/3600+25;return x.length*span<=9900;})).toBe(true);});
```

- [ ] **Step 2: Run them to make sure they fail.** `npx vitest run tests/markets-backfill.test.ts`. Expected: FAIL, because the module is missing.
- [ ] **Step 3: Implement** `src/markets/backfill.ts`:

```ts
import {isBitcoin} from './categories';
import {groupOf} from './categories';
/** Hourly Kalshi candle, prices in dollars; an empty side of the book (bid 0 / ask 1) is null. */
export interface Candle {end:number;bid:number|null;ask:number|null;mean:number|null;volume:number}
const num=(v:unknown)=>{const n=Number(v);return v===undefined||v===null||v===''||!Number.isFinite(n)?null:n;};
export function parseCandle(c:any):Candle{
  const bid=num(c?.yes_bid?.close_dollars),ask=num(c?.yes_ask?.close_dollars),mean=num(c?.price?.mean_dollars);
  return {end:Number(c.end_period_ts),bid:bid!==null&&bid>0?bid:null,ask:ask!==null&&ask<1&&ask>0?ask:null,mean,volume:num(c.volume_fp)??0};
}
const secs=(v:unknown)=>{const t=typeof v==='string'?Date.parse(v):NaN;return Number.isFinite(t)?Math.floor(t/1000):null;};
/** When the outcome is decided in practice: a game's start (occurrence) if before settlement, else settlement (or close). */
export function eventTime(m:any):number|null{
  const settle=secs(m.settlement_ts)??secs(m.close_time),occ=secs(m.occurrence_datetime);
  return occ!==null&&settle!==null&&occ<settle?occ:settle;
}
const STALE=2*3600,MAX_SPREAD=.2;
/** YES mid and ask at `ts`: the latest candle ending at or before it, at most 2 h old, with a tradable two-sided book. */
export function priceAt(candles:Candle[],ts:number):{mid:number;ask:number}|null{
  let best:Candle|null=null;for(const c of candles)if(c.end<=ts&&(!best||c.end>best.end))best=c;
  if(!best||ts-best.end>STALE||best.bid===null||best.ask===null||best.ask<best.bid||best.ask-best.bid>MAX_SPREAD)return null;
  return {mid:(best.bid+best.ask)/2,ask:best.ask};
}
/** Volume-weighted mean traded price over (from, to]; null when nothing traded. */
export function vwap(candles:Candle[],from:number,to:number):number|null{
  let s=0,v=0;for(const c of candles)if(c.end>from&&c.end<=to&&c.volume>0&&c.mean!==null){s+=c.mean*c.volume;v+=c.volume;}
  return v>0?s/v:null;
}
/** Top `perGroup` series by lifetime volume in each page group, plus every series the user traded; no Bitcoin, no combos. */
export function pickSeries(series:{ticker:string;category:string|null;volume:number}[],traded:Set<string>,perGroup=20):string[]{
  const ok=(t:string)=>!isBitcoin(t+'-')&&!t.startsWith('KXMVE');const out=new Set<string>();
  for(const g of ['sports','politics','commodities'] as const)
    series.filter(s=>ok(s.ticker)&&groupOf(s.category,false)===g).sort((a,b)=>b.volume-a.volume).slice(0,perGroup).forEach(s=>out.add(s.ticker));
  for(const t of traded)if(ok(t))out.add(t);
  return [...out];
}
/** Batches for /markets/candlesticks: ≤ maxTickers each, and tickers × hours (span + lookback) ≤ maxCandles. */
export function candleGroups<T extends {ticker:string;event:number}>(rows:T[],maxTickers=100,maxCandles=9900,lookbackH=25):T[][]{
  const sorted=[...rows].sort((a,b)=>a.event-b.event||a.ticker.localeCompare(b.ticker)),out:T[][]=[];let g:T[]=[];
  const cost=(x:T[])=>x.length*(Math.ceil((x.at(-1)!.event-x[0].event)/3600)+lookbackH);
  for(const r of sorted){const next=[...g,r];if(g.length&&(next.length>maxTickers||cost(next)>maxCandles)){out.push(g);g=[r];}else g=next;}
  if(g.length)out.push(g);return out;
}
```

- [ ] **Step 4: Run them to make sure they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit** with `git add src/markets/backfill.ts tests/markets-backfill.test.ts && git commit -m "markets backfill math: candles, horizons, series choice, batches"`

### Task 2: Backfill storage

**Files:** Modify `src/markets/journal.ts`; Test `tests/markets-journal.test.ts` (append)

**Interfaces:**
- Produces:
  - `interface BackfillRow {ticker:string;event:string;series:string;grp:'sports'|'politics'|'commodities';title:string;eventTs:number;settleTs:number;result:'yes'|'no';volume:number;p24:number|null;a24:number|null;p1:number|null;a1:number|null;vwap:number|null;priced:0|1}`
  - `putBackfill(rows:Omit<BackfillRow,'p24'|'a24'|'p1'|'a1'|'vwap'|'priced'>[])` (INSERT OR IGNORE)
  - `unpriced(limit=100000):{ticker:string;eventTs:number}[]`
  - `setPrices(ticker,p:{p24,a24,p1,a1,vwap})` (sets `priced=1`)
  - `backfillRows():BackfillRow[]` (priced only)
  - `backfillStats():{markets:number;priced:number;from:number|null;to:number|null}`

- [ ] **Step 1: Failing test (append)**

```ts
it('backfill rows insert once, wait for prices, and only priced rows are read back',()=>{
  const j=new MarketsJournal(':memory:');const r={ticker:'A',event:'E',series:'S',grp:'sports' as const,title:'t',eventTs:100,settleTs:200,result:'yes' as const,volume:500};
  j.putBackfill([r,r,{...r,ticker:'B',eventTs:50}]);expect(j.unpriced().map(x=>x.ticker).sort()).toEqual(['A','B']);
  j.setPrices('A',{p24:.4,a24:.41,p1:.5,a1:.51,vwap:.45});expect(j.unpriced().map(x=>x.ticker)).toEqual(['B']);
  expect(j.backfillRows()).toEqual([{...r,p24:.4,a24:.41,p1:.5,a1:.51,vwap:.45,priced:1}]);expect(j.backfillStats()).toEqual({markets:2,priced:1,from:50,to:100});j.db.close();});
```

- [ ] **Step 2: Run it to make sure it fails.** `npx vitest run tests/markets-journal.test.ts`. Expected: FAIL (`putBackfill` is not a function).
- [ ] **Step 3: Implement.** Add to the constructor's `exec`:

```sql
CREATE TABLE IF NOT EXISTS backfill(ticker TEXT PRIMARY KEY,event TEXT NOT NULL,series TEXT NOT NULL,grp TEXT NOT NULL,title TEXT NOT NULL,event_ts INTEGER NOT NULL,settle_ts INTEGER NOT NULL,result TEXT NOT NULL,volume REAL NOT NULL,p24 REAL,a24 REAL,p1 REAL,a1 REAL,vwap REAL,priced INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS backfill_priced ON backfill(priced,event_ts);
```

and the methods:

```ts
  putBackfill(rows:{ticker:string;event:string;series:string;grp:string;title:string;eventTs:number;settleTs:number;result:string;volume:number}[]){
    const put=this.db.prepare('INSERT OR IGNORE INTO backfill(ticker,event,series,grp,title,event_ts,settle_ts,result,volume) VALUES(?,?,?,?,?,?,?,?,?)');
    this.db.transaction(()=>{for(const r of rows)put.run(r.ticker,r.event,r.series,r.grp,r.title,r.eventTs,r.settleTs,r.result,r.volume);})();
  }
  unpriced(limit=100000){return this.db.prepare('SELECT ticker,event_ts AS eventTs FROM backfill WHERE priced=0 ORDER BY event_ts LIMIT ?').all(limit) as {ticker:string;eventTs:number}[];}
  setPrices(ticker:string,p:{p24:number|null;a24:number|null;p1:number|null;a1:number|null;vwap:number|null}){this.db.prepare('UPDATE backfill SET p24=?,a24=?,p1=?,a1=?,vwap=?,priced=1 WHERE ticker=?').run(p.p24,p.a24,p.p1,p.a1,p.vwap,ticker);}
  backfillRows():BackfillRow[]{return this.db.prepare('SELECT ticker,event,series,grp,title,event_ts AS eventTs,settle_ts AS settleTs,result,volume,p24,a24,p1,a1,vwap,priced FROM backfill WHERE priced=1 ORDER BY event_ts').all() as BackfillRow[];}
  backfillStats(){return this.db.prepare('SELECT COUNT(*) AS markets,COALESCE(SUM(priced),0) AS priced,MIN(event_ts) AS "from",MAX(event_ts) AS "to" FROM backfill').get() as {markets:number;priced:number;from:number|null;to:number|null};}
```

Export `BackfillRow` from `journal.ts` as in the Interfaces block.

- [ ] **Step 4: Run it to make sure it passes.** Same command. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -am "markets journal: backfill table"` (add the test file).

### Task 3: Backfill fetcher, script and daily refresh

**Files:**
- Create: `src/markets/fetch-backfill.ts` (orchestrator), `scripts/markets-backfill.ts` (CLI), `src/markets/refresh.ts` (daily child)
- Modify: `src/markets/index.ts` (start the refresher), `package.json` (`"markets-backfill": "tsx scripts/markets-backfill.ts"`)
- Test: `tests/markets-fetch-backfill.test.ts`

**Interfaces:**
- Consumes: Task 1 and Task 2; `KalshiClient.get`.
- Produces:
  - `runBackfill(client:Pick<KalshiClient,'get'>,journal:MarketsJournal,o:{now:number;traded:Set<string>;log:(m:string)=>void;perGroup?:number;perSeries?:number;minVolume?:number}):Promise<{listed:number;priced:number}>`
  - `class BackfillRefresher {constructor(log,journal,started?);tick(now?);running:boolean}`

- [ ] **Step 1: Failing tests**

```ts
import {it,expect} from 'vitest';
import {runBackfill} from '../src/markets/fetch-backfill';
import {MarketsJournal} from '../src/markets/journal';
const H=3600,NOW=Date.UTC(2026,9,9)/1000,CUTOFF=NOW-10*86400;
const market=(t:string,occ:number,result='yes',vol='500')=>({ticker:t,event_ticker:t.split('-').slice(0,2).join('-'),title:t,result,volume_fp:vol,occurrence_datetime:new Date(occ*1000).toISOString(),settlement_ts:new Date((occ+3*H)*1000).toISOString(),close_time:new Date((occ+3*H)*1000).toISOString(),status:'finalized'});
const candle=(end:number,bid:string,ask:string)=>({end_period_ts:end,yes_bid:{close_dollars:bid},yes_ask:{close_dollars:ask},price:{mean_dollars:bid},volume_fp:'10'});
function fake(fail=false){const calls:string[]=[];const occ=NOW-2*86400;return {calls,async get(p:string){calls.push(p);
  if(p==='/historical/cutoff')return {market_settled_ts:new Date(CUTOFF*1000).toISOString()};
  if(p.startsWith('/series?'))return {series:[{ticker:'KXNFLGAME',category:'Sports',volume_fp:'9e9'},{ticker:'KXFED',category:'Economics',volume_fp:'1e8'},{ticker:'KXBTC15M',category:'Crypto',volume_fp:'9e10'}]};
  if(p.startsWith('/markets?series_ticker=KXNFLGAME'))return {markets:[market('KXNFLGAME-26OCT07KCLV-KC',occ),market('KXNFLGAME-26OCT07KCLV-LV',occ,'no'),market('KXNFLGAME-26OCT07KCLV-X',occ,'no','5')]};
  if(p.startsWith('/markets?series_ticker='))return {markets:[]};
  if(p.startsWith('/markets/candlesticks')){if(fail)throw new Error('HTTP 503');const t=decodeURIComponent(p.split('market_tickers=')[1].split('&')[0]).split(',');
    return {markets:t.map(x=>({market_ticker:x,candlesticks:[candle(occ-24*H,'0.40','0.42'),candle(occ-H,'0.60','0.62')]}))};}
  throw new Error('unexpected '+p);}};}
it('lists settled markets of the chosen series since the cutoff, skips thin ones, prices them from candles',async()=>{
  const j=new MarketsJournal(':memory:'),c=fake();const r=await runBackfill(c,j,{now:NOW,traded:new Set(),log:()=>{}});
  expect(r).toEqual({listed:2,priced:2});expect(c.calls.some(p=>p.includes('KXBTC15M'))).toBe(false);
  expect(c.calls.find(p=>p.startsWith('/markets?series_ticker=KXNFLGAME'))).toContain(`min_close_ts=${CUTOFF}`);
  const kc=j.backfillRows().find(x=>x.ticker.endsWith('-KC'))!;expect(kc).toMatchObject({grp:'sports',result:'yes',p1:.61,a1:.62,p24:.41,a24:.42});expect(kc.vwap).toBeCloseTo(.5);});
it('resumes: stored markets are not refetched for candles, and a failed candle batch stays unpriced for next time',async()=>{
  const j=new MarketsJournal(':memory:');await runBackfill(fake(true),j,{now:NOW,traded:new Set(),log:()=>{}});expect(j.unpriced()).toHaveLength(2);
  const c=fake();const r=await runBackfill(c,j,{now:NOW,traded:new Set(),log:()=>{}});expect(r.priced).toBe(2);expect(j.unpriced()).toHaveLength(0);
  const again=fake();await runBackfill(again,j,{now:NOW,traded:new Set(),log:()=>{}});expect(again.calls.filter(p=>p.startsWith('/markets/candlesticks'))).toHaveLength(0);
  expect(again.calls.find(p=>p.startsWith('/markets?series_ticker=KXNFLGAME'))).toContain(`min_close_ts=${NOW-2*86400}`);});
```

- [ ] **Step 2: Run them to make sure they fail.** `npx vitest run tests/markets-fetch-backfill.test.ts`. Expected: FAIL, because the module is missing.
- [ ] **Step 3: Implement** `src/markets/fetch-backfill.ts`:

```ts
import type {KalshiClient} from '../engine/feeds/kalshi';
import type {MarketsJournal} from './journal';
import {parseCandle,eventTime,priceAt,vwap,pickSeries,candleGroups} from './backfill';
import {groupOf} from './categories';
const H=3600,DAY=86400;
type Client=Pick<KalshiClient,'get'>;
async function pages(client:Client,path:string){const out:any[]=[];let cursor='';const seen=new Set<string>();
  do{const r=await client.get(path+(path.includes('?')?'&':'?')+'limit=1000'+(cursor?'&cursor='+encodeURIComponent(cursor):''));out.push(...(r.markets??r.series??[]));cursor=r.cursor??'';if(cursor&&seen.has(cursor))break;seen.add(cursor);}while(cursor);return out;}
/**
 * Settled non-Bitcoin markets for the Record tab, from public data. It lists markets since the last run (2 days of overlap),
 * or since Kalshi's historical cutoff on the first run, for the chosen series. It keeps markets with ≥ minVolume contracts
 * (at most perSeries per series, by volume), then prices every stored market still missing prices from hourly candles:
 * YES mid and ask 24 h and 1 h before the event, and the volume-weighted price over those 24 h. Re-runnable and resumable.
 */
export async function runBackfill(client:Client,journal:MarketsJournal,o:{now:number;traded:Set<string>;log:(m:string)=>void;perGroup?:number;perSeries?:number;minVolume?:number}){
  const cutoff=Math.floor(Date.parse((await client.get('/historical/cutoff')).market_settled_ts)/1000);
  const last=journal.get<number|null>('backfillTo',null),from=Math.max(cutoff,last!==null?last-2*DAY:0);
  const series=(await pages(client,'/series?include_volume=true')).map((s:any)=>({ticker:String(s.ticker),category:s.category??null,volume:Number(s.volume_fp)||0}));
  const category=new Map(series.map(s=>[s.ticker,s.category])),chosen=pickSeries(series,o.traded,o.perGroup??20);
  o.log(`backfill: ${chosen.length} series, settled since ${new Date(from*1000).toISOString().slice(0,10)}`);
  let listed=0;
  for(const s of chosen){
    try{const ms=(await pages(client,`/markets?series_ticker=${encodeURIComponent(s)}&status=settled&min_close_ts=${from}&max_close_ts=${o.now}`))
        .filter(m=>(m.result==='yes'||m.result==='no')&&(Number(m.volume_fp)||0)>=(o.minVolume??100)&&eventTime(m)!==null)
        .sort((a,b)=>Number(b.volume_fp)-Number(a.volume_fp)).slice(0,o.perSeries??4000);
      journal.putBackfill(ms.map(m=>({ticker:String(m.ticker),event:String(m.event_ticker),series:s,grp:groupOf(category.get(s),false),title:String(m.yes_sub_title||m.title||m.ticker),
        eventTs:eventTime(m)!,settleTs:Math.floor(Date.parse(m.settlement_ts??m.close_time)/1000),result:m.result,volume:Number(m.volume_fp)||0})));listed+=ms.length;}
    catch(e){o.log(`  ${s}: ${(e as Error).message}`);}
  }
  journal.set('backfillTo',o.now);
  let priced=0;const groups=candleGroups(journal.unpriced().map(r=>({ticker:r.ticker,event:r.eventTs})));
  for(let i=0;i<groups.length;i++){const g=groups[i],start=g[0].event-25*H,end=g.at(-1)!.event;
    try{const r=await client.get(`/markets/candlesticks?market_tickers=${encodeURIComponent(g.map(x=>x.ticker).join(','))}&start_ts=${start}&end_ts=${end}&period_interval=60`);
      const got=new Map<string,any[]>((r.markets??[]).map((m:any)=>[m.market_ticker,m.candlesticks??[]]));
      for(const x of g){const cs=(got.get(x.ticker)??[]).map(parseCandle),p24=priceAt(cs,x.event-24*H),p1=priceAt(cs,x.event-H);
        journal.setPrices(x.ticker,{p24:p24?.mid??null,a24:p24?.ask??null,p1:p1?.mid??null,a1:p1?.ask??null,vwap:vwap(cs,x.event-24*H,x.event)});priced++;}}
    catch(e){o.log(`  candles batch ${i+1}/${groups.length}: ${(e as Error).message}`);}
    if(i%25===0)o.log(`  candles ${i+1}/${groups.length}`);
  }
  journal.set('backfillFinished',Date.now());o.log(`backfill done: ${listed} listed, ${priced} priced`);
  return {listed,priced};
}
```

Then:
- `scripts/markets-backfill.ts`: dotenv; `new KalshiClient('','',200)`; `new MarketsJournal()`; `traded` = series of the tickers in `journal.raw().fills` (non-Bitcoin, non-combo); `await runBackfill(...)` with a console logger; close the database.
- `src/markets/refresh.ts`: a `BackfillRefresher` that uses `refreshDue(journal.get('backfillFinished',null),now,{running,lastAttempt,started})` from `src/engine/refresh.ts`. It spawns `process.execPath --import tsx scripts/markets-backfill.ts` at `PRIORITY_BELOW_NORMAL`, logs to `logs/markets-backfill.log`, and logs `backfill-started` and `backfill-finished` through the journal. Same structure as `BacktestRefresher`.
- `index.ts`: `const refresher=new BackfillRefresher(log,journal);setInterval(()=>safe('backfill-refresh-error',()=>refresher.tick()),5*60000);`, and `refresher.stop()` in `stop`.

- [ ] **Step 4: Run tests and typecheck.** `npx vitest run tests/markets-fetch-backfill.test.ts && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "markets backfill: resumable fetch, CLI and daily low-priority refresh"`

### Task 4: Record aggregates

**Files:** Create `src/markets/record.ts`; Test `tests/markets-record.test.ts`

**Interfaces:**
- Consumes: `BackfillRow`; `rollupMarkets`, `RealEvent`; `wilson`; `clusterCI`; `takerFee`; `groupOf`, `seriesOf`.
- Produces:
  - `ACCURACY_EDGES`, `ENTRY_EDGES`
  - `type Horizon='p1'|'p24'|'vwap'`
  - `interface AccuracyBucket {lo:number;hi:number;n:number;events:number;price:number;win:number;low:number|null;high:number|null;ret:number|null;retLow:number|null;retHigh:number|null}`
  - `accuracy(rows:BackfillRow[],h:Horizon):AccuracyBucket[]`
  - `interface RecordLine {bucket:string;markets:number;wins:number;winRate:number|null;pnl:number;spent:number;ret:number|null}`
  - `yourRecord(events:RealEvent[],fills:any[],groupFor:(ticker:string)=>string):{byGroup:RecordLine[];byEntry:RecordLine[];total:RecordLine}`
  - `buildRecord(a:{rows:BackfillRow[];events:RealEvent[];fills:any[];groupFor:(t:string)=>string;stats:{markets:number;priced:number;from:number|null;to:number|null};finished:number|null}):RecordState`, where `RecordState={yours:ReturnType<typeof yourRecord>;accuracy:Record<'all'|'sports'|'politics'|'commodities',Record<Horizon,AccuracyBucket[]>>;backfill:{markets:number;priced:number;from:number|null;to:number|null;finished:number|null}}`

- [ ] **Step 1: Failing tests**

```ts
import {it,expect} from 'vitest';
import {accuracy,yourRecord,buildRecord} from '../src/markets/record';
import type {BackfillRow} from '../src/markets/journal';
const row=(ticker:string,event:string,p1:number|null,result:'yes'|'no',grp:any='sports'):BackfillRow=>({ticker,event,series:'S',grp,title:ticker,eventTs:1,settleTs:2,result,volume:500,p24:null,a24:null,p1,a1:p1===null?null:p1+.01,vwap:null,priced:1});
it('accuracy buckets: implied vs actual with a Wilson range; markets without a price at the horizon are left out',()=>{
  const rows=[row('A','E1',.03,'no'),row('B','E2',.04,'yes'),row('C','E3',.6,'yes'),row('D','E4',null,'yes')];
  const b=accuracy(rows,'p1');const low=b.find(x=>x.lo===0)!;expect(low.n).toBe(2);expect(low.price).toBeCloseTo(.035);expect(low.win).toBe(.5);expect(low.low!).toBeLessThan(.5);expect(low.high!).toBeGreaterThan(.5);
  expect(b.reduce((s,x)=>s+x.n,0)).toBe(3);expect(b.find(x=>x.lo===.5)!.n).toBe(1);});
it('return per $1 buys YES at the ask after the fee; both sides of one game are one bootstrap cluster',()=>{
  const rows=[row('A-1','G1',.5,'yes'),row('A-2','G1',.5,'no'),row('B-1','G2',.5,'yes'),row('B-2','G2',.5,'no')];
  const b=accuracy(rows,'p1').find(x=>x.lo===.5)!;expect(b.events).toBe(2);expect(b.ret!).toBeLessThan(0);
  // 2 clusters with identical means → a degenerate but defined range; 1 cluster → no range.
  expect(b.retLow).toBeCloseTo(b.retHigh!,9);expect(accuracy(rows.slice(0,2),'p1').find(x=>x.lo===.5)!.retLow).toBeNull();});
it('your record by group and entry price, from real fills and settlements',()=>{
  const fills=[{fill_id:'1',ticker:'KXNCAAFGAME-X-ARIZ',outcome_side:'yes',action:'buy',count_fp:'10',yes_price_dollars:'0.83',fee_cost:'0.10',created_time:'2026-10-04T00:00:00Z'},
    {fill_id:'2',ticker:'KXMVECROSSCATEGORY-S-A',outcome_side:'yes',action:'buy',count_fp:'1000',yes_price_dollars:'0.003',fee_cost:'0.21',created_time:'2026-10-04T00:00:00Z'}];
  const settlements=[{ticker:'KXNCAAFGAME-X-ARIZ',revenue:1000,yes_total_cost_dollars:'8.3',no_total_cost_dollars:'0',fee_cost:'0.10',settled_time:'2026-10-05T00:00:00Z',yes_count_fp:'10',no_count_fp:'0'},
    {ticker:'KXMVECROSSCATEGORY-S-A',revenue:0,yes_total_cost_dollars:'3',no_total_cost_dollars:'0',fee_cost:'0.21',settled_time:'2026-10-05T00:00:00Z',yes_count_fp:'1000',no_count_fp:'0'}];
  const {normalizeAccount}=require('../src/engine/account');const events=normalizeAccount(fills,settlements,(t:string)=>!t.startsWith('KXBTC'));
  const r=yourRecord(events,fills,t=>t.startsWith('KXMVE')?'combos':'sports');
  expect(r.byGroup.find(x=>x.bucket==='combos')).toMatchObject({markets:1,wins:0});expect(r.byGroup.find(x=>x.bucket==='combos')!.pnl).toBeCloseTo(-3.21);
  expect(r.byGroup.find(x=>x.bucket==='sports')!.pnl).toBeCloseTo(1.6);expect(r.byEntry.find(x=>x.bucket==='0–5¢')!.markets).toBe(1);expect(r.byEntry.find(x=>x.bucket==='80–100¢')!.wins).toBe(1);
  expect(r.total.ret!).toBeCloseTo((1.6-3.21)/(8.4+3.21),3);});
it('an empty backfill gives empty accuracy and the stats, not zeros',()=>{
  const s=buildRecord({rows:[],events:[],fills:[],groupFor:()=>'sports',stats:{markets:0,priced:0,from:null,to:null},finished:null});
  expect(s.accuracy.all.p1.every(b=>b.n===0&&b.win===null)).toBe(true);expect(s.backfill.markets).toBe(0);expect(s.yours.total.markets).toBe(0);});
```

- [ ] **Step 2: Run them to make sure they fail.** `npx vitest run tests/markets-record.test.ts`. Expected: FAIL, because the module is missing.
- [ ] **Step 3: Implement** `src/markets/record.ts`:

```ts
import type {RealEvent} from '../engine/guardrails';
import {rollupMarkets} from '../engine/analytics';
import {wilson} from '../engine/model/opening';
import {takerFee} from '../engine/model/fees';
import {clusterCI} from '../backtest/sim';
import type {BackfillRow} from './journal';
export const ACCURACY_EDGES=[0,.05,.1,.2,.35,.5,.65,.8,.9,.95,1],ENTRY_EDGES=[0,.05,.2,.5,.8,1];
export type Horizon='p1'|'p24'|'vwap';
export interface AccuracyBucket {lo:number;hi:number;n:number;events:number;price:number|null;win:number|null;low:number|null;high:number|null;ret:number|null;retLow:number|null;retHigh:number|null}
const askOf=(r:BackfillRow,h:Horizon)=>h==='p1'?r.a1:h==='p24'?r.a24:null;
/**
 * How often contracts priced in each band actually won (Wilson 95%), and what buying YES at the ask returned per $1 after
 * the taker fee (bootstrap 95% over events: both sides of a game, or one strike ladder, move together).
 */
export function accuracy(rows:BackfillRow[],h:Horizon):AccuracyBucket[]{
  return ACCURACY_EDGES.slice(0,-1).map((lo,i)=>{const hi=ACCURACY_EDGES[i+1],last=i===ACCURACY_EDGES.length-2;
    const xs=rows.filter(r=>{const p=r[h];return p!==null&&p>=lo&&(p<hi||last&&p<=hi);});
    const wins=xs.filter(r=>r.result==='yes').length,w=wilson(wins,xs.length);
    const clusters=new Map<string,{sum:number;n:number}>();let total=0,count=0;
    for(const r of xs){const a=askOf(r,h)??r[h]!;if(!(a>0&&a<1))continue;const cost=a+takerFee(a),ret=((r.result==='yes'?1:0)-cost)/cost;
      const c=clusters.get(r.event)??{sum:0,n:0};c.sum+=ret;c.n++;clusters.set(r.event,c);total+=ret;count++;}
    const [l,u]=clusterCI([...clusters.values()]);
    return {lo,hi,n:xs.length,events:new Set(xs.map(r=>r.event)).size,price:xs.length?xs.reduce((s,r)=>s+r[h]!,0)/xs.length:null,win:xs.length?wins/xs.length:null,low:w.low,high:w.high,
      ret:count?total/count:null,retLow:Number.isFinite(l)?l:null,retHigh:Number.isFinite(u)?u:null};});
}
export interface RecordLine {bucket:string;markets:number;wins:number;winRate:number|null;pnl:number;spent:number;ret:number|null}
const line=(bucket:string,ms:{pnl:number;spent:number}[]):RecordLine=>{const pnl=ms.reduce((s,m)=>s+m.pnl,0),spent=ms.reduce((s,m)=>s+m.spent,0),wins=ms.filter(m=>m.pnl>0).length;
  return {bucket,markets:ms.length,wins,winRate:ms.length?wins/ms.length:null,pnl,spent,ret:spent>0?pnl/spent:null};};
const cents=(x:number)=>`${Math.round(x*100)}¢`;
/** Your settled non-Bitcoin markets: P&L, win rate and return on money spent (entry cost + fees), by group and entry price. */
export function yourRecord(events:RealEvent[],fills:any[],groupFor:(ticker:string)=>string){
  const fees=new Map<string,number>();for(const f of fills){const t=f.ticker??f.market_ticker;fees.set(t,(fees.get(t)??0)+(Number(f.fee_cost)||0));}
  const ms=rollupMarkets(events,fees,[]).filter(m=>m.status==='settled').map(m=>({...m,group:groupFor(m.ticker),spent:m.contracts*(m.avgEntry??0)+m.fees}));
  const groups=[...new Set(ms.map(m=>m.group))].sort();
  const byEntry=ENTRY_EDGES.slice(0,-1).map((lo,i)=>{const hi=ENTRY_EDGES[i+1];return line(`${cents(lo)}–${cents(hi)}`,ms.filter(m=>m.avgEntry!==null&&m.avgEntry>=lo&&(m.avgEntry<hi||hi===1)));});
  return {byGroup:groups.map(g=>line(g,ms.filter(m=>m.group===g))),byEntry,total:line('All',ms)};
}
export interface RecordState {yours:ReturnType<typeof yourRecord>;accuracy:Record<'all'|'sports'|'politics'|'commodities',Record<Horizon,AccuracyBucket[]>>;backfill:{markets:number;priced:number;from:number|null;to:number|null;finished:number|null}}
export function buildRecord(a:{rows:BackfillRow[];events:RealEvent[];fills:any[];groupFor:(t:string)=>string;stats:{markets:number;priced:number;from:number|null;to:number|null};finished:number|null}):RecordState{
  const by=(rows:BackfillRow[])=>({p1:accuracy(rows,'p1'),p24:accuracy(rows,'p24'),vwap:accuracy(rows,'vwap')});
  return {yours:yourRecord(a.events,a.fills,a.groupFor),accuracy:{all:by(a.rows),sports:by(a.rows.filter(r=>r.grp==='sports')),politics:by(a.rows.filter(r=>r.grp==='politics')),commodities:by(a.rows.filter(r=>r.grp==='commodities'))},
    backfill:{...a.stats,finished:a.finished}};
}
```

In the tests, `fills` entries without `fee_cost` count 0. `rollupMarkets` takes `pnl` from `outcomePnl`. The `require` in the third test should become a top-level `import {normalizeAccount} from '../src/engine/account'` when the file is written.

- [ ] **Step 4: Run them to make sure they pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "markets record: Kalshi accuracy buckets and your record by group and entry price"`

### Task 5: `/record` endpoint

**Files:** Modify `src/markets/index.ts`, `src/markets/kalshi-data.ts` (expose `groupFor`)

- [ ] **Step 1:**
  - In `MarketsData` add `groupFor(ticker)`: `groupOf(this.series.get(seriesOf(ticker))?.category, ticker.startsWith('KXMVE'))`, falling back to the series category in `journal.db` markets/backfill.
  - For tickers whose series is unknown (old trades), `syncAccount` fetches `/series/{s}` once per unknown series of settled fills (`seriesInfo` already caches).
- [ ] **Step 2:** In `index.ts`, add `GET /record`. It is cached 60 s and returns `buildRecord({rows:journal.backfillRows(),events:data.events,fills:journal.raw().fills.filter(f=>!isBitcoin(f.ticker??f.market_ticker)),groupFor:t=>data.groupFor(t),stats:journal.backfillStats(),finished:journal.get('backfillFinished',null)})`, plus `refresher:{running}`.
- [ ] **Step 3:** Smoke-check: `curl /record` on a side instance returns JSON with `yours.byGroup` covering sports/combos/commodities from the real account.
- [ ] **Step 4: Commit.**

### Task 6: Record tab UI

**Files:**
- Create: `src/app/markets/record/page.tsx`, `src/components/markets-record.tsx`, `src/components/markets-nav.tsx` (tab bar plus category chips)
- Modify: `src/components/markets.tsx` (use `MarketsNav`), `src/components/site-header.tsx` (`current` also matches `/markets/record`, marking Markets)

UI checklist additions. The reference is Analytics, with the stage 1 checklist for everything else:

| Role | Project answer |
|---|---|
| Tab bar | Links written like the nav and filter chips (`inline-flex min-h-10 items-center rounded-xl px-3 text-sm`, active `bg-surface-2 text-fg`, `aria-current="page"`), in a `nav aria-label="Markets sections"` above the category chips |
| Category chips | Moved unchanged into `MarketsNav`; same `markets:filter` key; on Record they filter the accuracy tables (`combos` shows your record only plus a one-line note) |
| KPI row | Analytics `Kpi`: a `Card p-4` per KPI, `.label`, `num text-2xl font-medium`. Four: settled markets, win rate, P&L, return on spent |
| Tables | Analytics `Breakdown` markup: `Card` + `h2 font-semibold mb-3`, table `w-full text-sm`, `thead text-xs text-muted`, rows `border-t border-line`, `th scope="row"` first cell, P&L tone `text-yes`/`text-no` |
| Horizon switch | Chips like the filters: "1 h before" · "24 h before" · "Average traded" (`aria-pressed`) |
| Chart | Existing `ReliabilityChart` (dynamic import, `ssr:false`), data `{bucket,predicted,actual}` |
| Empty | Analytics `Empty`: dashed box, centred `text-sm text-muted` |
| Loading / error | Analytics pattern: fetch `/api/markets/record` every 60 s; an error line `text-xs text-warn` |
| Footnote | Info card as on the Markets page: window, sources, how each figure is computed, not advice |

New copy: "Your record outside Bitcoin", "How accurate Kalshi's prices were", "1 h before", "24 h before", "Average traded", "Return per $1 (buy YES at the ask, after fees)", "History is still loading: the first download starts about 10 minutes after the app starts and takes a few minutes."

- [ ] **Step 1:** `markets-nav.tsx`. It exports `MarketsNav({current,filter,setFilter,counts})` and `useMarketsFilter()` (the localStorage logic moved from `markets.tsx`). `markets.tsx` uses both, so stage 1 behaviour is unchanged.
- [ ] **Step 2:** `markets-record.tsx`. Same holder as Markets (ambient, `SiteHeader current="/markets"` with `SoundToggle` and the Live pill from `useLive('/markets-ws')`, and `useSoundAlerts(null,false,'markets',…)` so alerts keep playing). Then `MarketsNav`; the KPI row; "Your record" tables by category and by entry price; then accuracy with the horizon chips, `ReliabilityChart`, and a bucket table: Priced at, Markets (events), Priced avg, Won (range), Gap, Return per $1 (range). Finally the backfill status line and the footnote.
- [ ] **Step 3:** Typecheck, tests, and a verification build. Browser check on a side instance at desktop and 375 px. Run `ui-consistency:verifying` against this checklist; it is a self-check, which must be stated.
- [ ] **Step 4: Commit.**

### Task 7: Live backfill, docs

- [ ] Run `npm run markets-backfill` once for real, against `data/markets.db`. Record how long it took and the counts.
- [ ] Check the Record page with real numbers.
- [ ] README: a Markets → Record bullet. DECISIONS 47: the rulings above plus any taken during execution. VERIFICATION: the numbers.
- [ ] Commit.
