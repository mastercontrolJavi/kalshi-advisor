import Database from 'better-sqlite3';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import type {Group,Quote} from './types';
const DAY=86400000;
/** A settled market from the public backfill, with its YES mid and ask 24 h and 1 h before the event and the 24-h traded average. */
export interface BackfillRow {ticker:string;event:string;series:string;grp:'sports'|'politics'|'commodities';title:string;eventTs:number;settleTs:number;result:'yes'|'no';volume:number;p24:number|null;a24:number|null;p1:number|null;a1:number|null;vwap:number|null;priced:0|1}
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
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,time INTEGER NOT NULL,event TEXT NOT NULL,context TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS backfill(ticker TEXT PRIMARY KEY,event TEXT NOT NULL,series TEXT NOT NULL,grp TEXT NOT NULL,title TEXT NOT NULL,event_ts INTEGER NOT NULL,settle_ts INTEGER NOT NULL,result TEXT NOT NULL,volume REAL NOT NULL,p24 REAL,a24 REAL,p1 REAL,a1 REAL,vwap REAL,priced INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS backfill_priced ON backfill(priced,event_ts);
      CREATE TABLE IF NOT EXISTS matches(ticker TEXT NOT NULL,source TEXT NOT NULL,ref_id TEXT NOT NULL,method TEXT NOT NULL,status TEXT NOT NULL,score REAL,title TEXT,url TEXT,decided_at INTEGER,PRIMARY KEY(ticker,source,ref_id));
      CREATE TABLE IF NOT EXISTS refs(ticker TEXT NOT NULL,source TEXT NOT NULL,time INTEGER NOT NULL,prob REAL NOT NULL,PRIMARY KEY(ticker,source,time));`);
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
  putBackfill(rows:{ticker:string;event:string;series:string;grp:string;title:string;eventTs:number;settleTs:number;result:string;volume:number}[]){
    const put=this.db.prepare('INSERT OR IGNORE INTO backfill(ticker,event,series,grp,title,event_ts,settle_ts,result,volume) VALUES(?,?,?,?,?,?,?,?,?)');
    this.db.transaction(()=>{for(const r of rows)put.run(r.ticker,r.event,r.series,r.grp,r.title,r.eventTs,r.settleTs,r.result,r.volume);})();
  }
  /** Outside-market matches: auto (sports pairing) or suggested (title); the user confirms or rejects. A decision is never overwritten. */
  setMatch(m:{ticker:string;source:string;refId:string;method:'auto'|'suggested';status:'auto'|'suggested';score:number|null;title:string;url:string}){
    this.db.prepare(`INSERT INTO matches(ticker,source,ref_id,method,status,score,title,url) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(ticker,source,ref_id) DO UPDATE SET title=excluded.title,url=excluded.url,score=excluded.score WHERE status NOT IN ('confirmed','rejected')`).run(m.ticker,m.source,m.refId,m.method,m.status,m.score,m.title,m.url);
  }
  matchesFor(ticker:string){return this.db.prepare('SELECT ticker,source,ref_id AS refId,method,status,score,title,url,decided_at AS decidedAt FROM matches WHERE ticker=?').all(ticker) as {ticker:string;source:string;refId:string;method:string;status:string;score:number|null;title:string;url:string;decidedAt:number|null}[];}
  decideMatch(ticker:string,source:string,refId:string,status:'confirmed'|'rejected',now:number){return this.db.prepare('UPDATE matches SET status=?,decided_at=? WHERE ticker=? AND source=? AND ref_id=?').run(status,now,ticker,source,refId).changes>0;}
  isRejected(ticker:string,source:string,refId:string){return !!this.db.prepare(`SELECT 1 FROM matches WHERE ticker=? AND source=? AND ref_id=? AND status='rejected'`).get(ticker,source,refId);}
  putRef(ticker:string,source:string,time:number,prob:number){this.db.prepare('INSERT OR IGNORE INTO refs VALUES(?,?,?,?)').run(ticker,source,time,prob);}
  refSeries(ticker:string,source:string,since:number){return this.db.prepare('SELECT time,prob FROM refs WHERE ticker=? AND source=? AND time>=? ORDER BY time').all(ticker,source,since) as {time:number;prob:number}[];}
  /**
   * Settled markets you held that had an outside match: the last Kalshi mid and the last outside price at least 1 h before
   * the expected result (or close), with the outcome. For the Record tab's accuracy comparison.
   */
  sourcePairs():{ticker:string;source:string;y:0|1;kalshi:number;ref:number}[]{
    return this.db.prepare(`WITH m AS (SELECT ticker,result,COALESCE(expected_expiration,close_time)-3600000 AS cut FROM markets WHERE result IN ('yes','no') AND COALESCE(expected_expiration,close_time) IS NOT NULL),
      k AS (SELECT m.ticker,(SELECT (s.yes_bid+s.yes_ask)/2 FROM snapshots s WHERE s.ticker=m.ticker AND s.time<=m.cut AND s.yes_bid IS NOT NULL AND s.yes_ask IS NOT NULL ORDER BY s.time DESC LIMIT 1) AS kalshi FROM m),
      r AS (SELECT DISTINCT m.ticker,refs.source FROM m JOIN refs ON refs.ticker=m.ticker AND refs.time<=m.cut)
      SELECT r.ticker,r.source,CASE m.result WHEN 'yes' THEN 1 ELSE 0 END AS y,k.kalshi,(SELECT prob FROM refs WHERE refs.ticker=r.ticker AND refs.source=r.source AND refs.time<=m.cut ORDER BY time DESC LIMIT 1) AS ref
      FROM r JOIN m ON m.ticker=r.ticker JOIN k ON k.ticker=r.ticker WHERE k.kalshi IS NOT NULL ORDER BY r.ticker,r.source`).all() as {ticker:string;source:string;y:0|1;kalshi:number;ref:number}[];
  }
  /** Matched markets whose result is due but not stored yet (they may have left your positions when they settled). */
  awaitingResult(now:number):string[]{return (this.db.prepare(`SELECT ticker FROM markets WHERE result IS NULL AND COALESCE(expected_expiration,close_time)<? AND ticker IN (SELECT DISTINCT ticker FROM refs) ORDER BY ticker`).all(now) as {ticker:string}[]).map(r=>r.ticker);}
  /** Start the public history over (after a change to how markets are chosen). */
  resetBackfill(){this.db.transaction(()=>{this.db.prepare('DELETE FROM backfill').run();this.db.prepare("DELETE FROM meta WHERE key IN ('backfillTo','backfillFinished','accuracy')").run();})();}
  unpriced(limit=1000000){return this.db.prepare('SELECT ticker,event_ts AS eventTs FROM backfill WHERE priced=0 ORDER BY event_ts LIMIT ?').all(limit) as {ticker:string;eventTs:number}[];}
  setPrices(ticker:string,p:{p24:number|null;a24:number|null;p1:number|null;a1:number|null;vwap:number|null}){this.db.prepare('UPDATE backfill SET p24=?,a24=?,p1=?,a1=?,vwap=?,priced=1 WHERE ticker=?').run(p.p24,p.a24,p.p1,p.a1,p.vwap,ticker);}
  backfillRows():BackfillRow[]{return this.db.prepare('SELECT ticker,event,series,grp,title,event_ts AS eventTs,settle_ts AS settleTs,result,volume,p24,a24,p1,a1,vwap,priced FROM backfill WHERE priced=1 ORDER BY event_ts').all() as BackfillRow[];}
  backfillStats(){return this.db.prepare('SELECT COUNT(*) AS markets,COALESCE(SUM(priced),0) AS priced,MIN(event_ts) AS "from",MAX(event_ts) AS "to" FROM backfill').get() as {markets:number;priced:number;from:number|null;to:number|null};}
  /** Snapshots of markets you hold are kept for good; others (the scanner, from stage 4) for 14 days. */
  prune(now=Date.now()){this.db.prepare('DELETE FROM snapshots WHERE held=0 AND time<?').run(now-14*DAY);}
}
