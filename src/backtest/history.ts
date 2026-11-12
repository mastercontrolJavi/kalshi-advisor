import Database from 'better-sqlite3';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {KalshiClient} from '../engine/feeds/kalshi';
/**
 * Historical backfill for the backtest (data/history.db, separate from the live journal). Public read-only data only:
 * Kalshi settled KXBTC15M markets with 1-minute YES bid/ask candles,
 * and Coinbase BTC-USD 1-minute candles as the spot proxy. Every step is resumable; nothing is signed or written to
 * Kalshi.
 */
export const SERIES15='KXBTC15M';
export interface MarketRow {ticker:string;series:string;event:string|null;open_ts:number;close_ts:number;strike:number|null;result:string|null;settle:number|null;volume:number|null;source:string;candles:number}
export interface CandleRow {ticker:string;ts:number;bid:number|null;ask:number|null;bid_lo:number|null;bid_hi:number|null;ask_lo:number|null;ask_hi:number|null;price:number|null;volume:number|null}
export interface SpotRow {ts:number;open:number;high:number;low:number;close:number;volume:number}
export class HistoryStore {
  db:Database.Database;
  constructor(path=process.env.HISTORY_DB??'./data/history.db'){
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});this.db=new Database(path);this.db.pragma('journal_mode = WAL');this.db.pragma('synchronous = NORMAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS markets(ticker TEXT PRIMARY KEY,series TEXT NOT NULL,event TEXT,open_ts INTEGER NOT NULL,close_ts INTEGER NOT NULL,strike REAL,result TEXT,settle REAL,volume REAL,source TEXT NOT NULL,candles INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS markets_close ON markets(series,close_ts);
      CREATE TABLE IF NOT EXISTS candles(ticker TEXT NOT NULL,ts INTEGER NOT NULL,bid REAL,ask REAL,bid_lo REAL,bid_hi REAL,ask_lo REAL,ask_hi REAL,price REAL,volume REAL,PRIMARY KEY(ticker,ts)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS spot(ts INTEGER PRIMARY KEY,open REAL NOT NULL,high REAL NOT NULL,low REAL NOT NULL,close REAL NOT NULL,volume REAL NOT NULL);`);
  }
  putMarkets(rows:MarketRow[]){const s=this.db.prepare('INSERT INTO markets VALUES(@ticker,@series,@event,@open_ts,@close_ts,@strike,@result,@settle,@volume,@source,@candles) ON CONFLICT(ticker) DO UPDATE SET result=excluded.result,settle=excluded.settle,volume=excluded.volume,strike=excluded.strike');this.db.transaction(()=>{for(const r of rows)s.run(r);})();}
  putCandles(ticker:string,rows:CandleRow[]){const s=this.db.prepare('INSERT OR REPLACE INTO candles VALUES(@ticker,@ts,@bid,@ask,@bid_lo,@bid_hi,@ask_lo,@ask_hi,@price,@volume)');
    this.db.transaction(()=>{for(const r of rows)s.run(r);this.db.prepare('UPDATE markets SET candles=? WHERE ticker=?').run(rows.length||-1,ticker);})();}
  putSpot(rows:SpotRow[]){const s=this.db.prepare('INSERT OR REPLACE INTO spot VALUES(@ts,@open,@high,@low,@close,@volume)');this.db.transaction(()=>{for(const r of rows)s.run(r);})();}
  markets(series:string,from=0,to=Infinity):MarketRow[]{return this.db.prepare('SELECT * FROM markets WHERE series=? AND close_ts>=? AND close_ts<=? ORDER BY close_ts,ticker').all(series,from,Number.isFinite(to)?to:4e9) as MarketRow[];}
  candles(ticker:string):CandleRow[]{return this.db.prepare('SELECT * FROM candles WHERE ticker=? ORDER BY ts').all(ticker) as CandleRow[];}
  allCandles(series:string):Map<string,CandleRow[]>{const out=new Map<string,CandleRow[]>();
    for(const r of this.db.prepare('SELECT c.* FROM candles c JOIN markets m ON m.ticker=c.ticker WHERE m.series=? ORDER BY c.ticker,c.ts').all(series) as CandleRow[]){const l=out.get(r.ticker);if(l)l.push(r);else out.set(r.ticker,[r]);}return out;}
  spot(from:number,to:number):SpotRow[]{return this.db.prepare('SELECT * FROM spot WHERE ts>=? AND ts<=? ORDER BY ts').all(from,to) as SpotRow[];}
  spotCount(from:number,to:number){return (this.db.prepare('SELECT count(*) n FROM spot WHERE ts>=? AND ts<?').get(from,to) as {n:number}).n;}
}
const num=(v:unknown)=>{if(v===undefined||v===null||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;};
const iso=(s:string|undefined)=>s?Math.floor(Date.parse(s)/1000):NaN;
/** Kalshi market JSON → row. Live and historical payloads share these fields. */
export function marketRow(m:any,source:string):MarketRow|null{
  const open=iso(m.open_time),close=iso(m.close_time);if(!Number.isFinite(open)||!Number.isFinite(close))return null;
  return {ticker:m.ticker,series:String(m.ticker).split('-')[0],event:m.event_ticker??null,open_ts:open,close_ts:close,strike:num(m.floor_strike),result:m.result||null,settle:num(m.expiration_value),volume:num(m.volume_fp??m.volume),source,candles:0};
}
/** Live candles use *_dollars / *_fp; the historical endpoint uses bare names. Accept both. */
export function candleRow(ticker:string,c:any):CandleRow{
  const d=(o:any,k:string)=>num(o?.[k+'_dollars']??o?.[k]);
  return {ticker,ts:c.end_period_ts,bid:d(c.yes_bid,'close'),ask:d(c.yes_ask,'close'),bid_lo:d(c.yes_bid,'low'),bid_hi:d(c.yes_bid,'high'),ask_lo:d(c.yes_ask,'low'),ask_hi:d(c.yes_ask,'high'),price:d(c.price,'close'),volume:num(c.volume_fp??c.volume)};
}
type Log=(msg:string)=>void;
async function paged(client:KalshiClient,path:string,stop:(m:any)=>boolean,log:Log){
  const out:any[]=[];let cursor='';const seen=new Set<string>();
  for(;;){const page=await client.get(path+(path.includes('?')?'&':'?')+'limit=1000'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
    const list=page.markets??[];out.push(...list);if(list.some(stop))break;cursor=page.cursor??'';if(!cursor||seen.has(cursor)||!list.length)break;seen.add(cursor);log(`  ${out.length} markets listed`);}
  return out;
}
/** Settled 15-minute markets closing in [from, to]: live endpoint after the historical cutoff, historical before it. */
export async function fetchMarkets15(store:HistoryStore,client:KalshiClient,from:number,to:number,log:Log){
  const cutoff=iso((await client.get('/historical/cutoff')).market_settled_ts);
  const live=await paged(client,`/markets?series_ticker=${SERIES15}&status=settled&min_close_ts=${Math.max(from,cutoff)}&max_close_ts=${to}`,()=>false,log);
  const rows=live.map(m=>marketRow(m,'live')).filter((r):r is MarketRow=>!!r&&r.close_ts>=from&&r.close_ts<=to);
  if(from<cutoff){
    // The historical list is newest-first and ignores close-time filters: page until we pass the start.
    const old=await paged(client,`/historical/markets?series_ticker=${SERIES15}`,m=>iso(m.close_time)<from,log);
    rows.push(...old.map(m=>marketRow(m,'historical')).filter((r):r is MarketRow=>!!r&&r.close_ts>=from&&r.close_ts<Math.min(to+1,cutoff+1)&&r.series===SERIES15));
  }
  store.putMarkets(rows.filter(r=>r.result==='yes'||r.result==='no'));log(`15-min markets stored: ${rows.length} (historical cutoff ${new Date(cutoff*1000).toISOString().slice(0,10)})`);return cutoff;
}
/**
 * Group markets for the batch candlestick endpoint. Kalshi caps a request at 10,000 candles counted as
 * tickers × minutes in the requested window (not candles actually returned), and at 100 tickers.
 */
export function candleBatches(markets:MarketRow[],maxCandles=9900,maxTickers=100):MarketRow[][]{
  const sorted=[...markets].sort((a,b)=>a.open_ts-b.open_ts||a.ticker.localeCompare(b.ticker)),out:MarketRow[][]=[];let group:MarketRow[]=[];
  const cost=(g:MarketRow[])=>g.length*(Math.floor((Math.max(...g.map(m=>m.close_ts))-Math.min(...g.map(m=>m.open_ts)))/60)+1);
  for(const m of sorted){const next=[...group,m];if(group.length&&(next.length>maxTickers||cost(next)>maxCandles)){out.push(group);group=[m];}else group=next;}
  if(group.length)out.push(group);return out;
}
async function batchCandles(store:HistoryStore,client:KalshiClient,markets:MarketRow[],log:Log,label:string){
  const groups=candleBatches(markets);
  for(let i=0;i<groups.length;i++){const group=groups[i];
    try{const r=await client.get(`/markets/candlesticks?market_tickers=${group.map(m=>m.ticker).join(',')}&start_ts=${Math.min(...group.map(m=>m.open_ts))}&end_ts=${Math.max(...group.map(m=>m.close_ts))}&period_interval=1`);
      const got=new Map<string,any[]>((r.markets??[]).map((m:any)=>[m.market_ticker,m.candlesticks??[]]));
      for(const m of group)store.putCandles(m.ticker,(got.get(m.ticker)??[]).map(c=>candleRow(m.ticker,c)));
    }catch(e){log(`  batch at ${group[0].ticker} failed: ${(e as Error).message}`);}
    if(i%25===0)log(`  ${label} candles: batch ${i+1}/${groups.length}`);}
}
/** 1-minute candles: live markets through the batch endpoint (only active minutes are returned); historical one by one. */
export async function fetchCandles(store:HistoryStore,client:KalshiClient,series:string,log:Log){
  const todo=store.markets(series).filter(m=>m.candles===0);log(`${series}: ${todo.length} markets need candles`);
  const live=todo.filter(m=>m.source!=='historical'),old=todo.filter(m=>m.source==='historical');
  await batchCandles(store,client,live,log,'live');
  for(let i=0;i<old.length;i++){const m=old[i];
    try{const r=await client.get(`/historical/markets/${encodeURIComponent(m.ticker)}/candlesticks?start_ts=${m.open_ts}&end_ts=${m.close_ts}&period_interval=1`);store.putCandles(m.ticker,(r.candlesticks??[]).map((c:any)=>candleRow(m.ticker,c)));}
    catch(e){store.putCandles(m.ticker,[]);log(`  ${m.ticker} failed: ${(e as Error).message}`);}
    if(i%250===0)log(`  historical candles ${i+1}/${old.length}`);}
}
/** Coinbase Exchange public 1-minute candles, 300 per request. Rows are keyed by minute start (seconds). */
export async function fetchSpot(store:HistoryStore,from:number,to:number,log:Log){
  const chunk=300*60;let n=0;
  for(let t=Math.floor(from/60)*60;t<to;t+=chunk){
    if(store.spotCount(t,t+chunk)>=chunk/60-5)continue;
    for(let attempt=0;;attempt++){
      const r=await fetch(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${new Date(t*1000).toISOString()}&end=${new Date((t+chunk-60)*1000).toISOString()}`,{headers:{'User-Agent':'kalshi-advisor-backtest'},redirect:'error',signal:AbortSignal.timeout(15000)});
      if(r.status===429&&attempt<6){await new Promise(res=>setTimeout(res,500*2**attempt));continue;}
      if(!r.ok)throw new Error(`Coinbase candles HTTP ${r.status}`);
      const rows=(await r.json() as number[][]).map(([ts,low,high,open,close,volume])=>({ts,open,high,low,close,volume}));store.putSpot(rows);break;
    }
    await new Promise(res=>setTimeout(res,150));if(++n%50===0)log(`  spot ${new Date(t*1000).toISOString().slice(0,10)}`);
  }
}
