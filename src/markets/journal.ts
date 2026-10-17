import Database from 'better-sqlite3';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import type {Group,Quote} from './types';
const DAY=86400000;
/** A settled market from the public backfill, with its YES mid and ask 24 h and 1 h before the event and the 24-h traded average. */
/** A stored scanner flag; result and pnl stay null until its market settles yes or no. */
export interface LeanRow {round:number;horizon:number;time:number;ticker:string;upPrice:number|null;sharpNet:number;allNet:number;sharpWallets:number;yesBid:number|null;yesAsk:number|null;result:string|null;trend:number|null;slope:number|null}
export interface FlagRow {id:number;time:number;ticker:string;event:string;group:string;type:string;side:'yes'|'no';price:number;fee:number;edge:number;result:string|null;pnl:number|null}
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
      CREATE TABLE IF NOT EXISTS refs(ticker TEXT NOT NULL,source TEXT NOT NULL,time INTEGER NOT NULL,prob REAL NOT NULL,PRIMARY KEY(ticker,source,time));
      CREATE TABLE IF NOT EXISTS flags(id INTEGER PRIMARY KEY,time INTEGER NOT NULL,ticker TEXT NOT NULL,event TEXT NOT NULL,grp TEXT NOT NULL,type TEXT NOT NULL,side TEXT NOT NULL,price REAL NOT NULL,fee REAL NOT NULL,edge REAL NOT NULL,context TEXT NOT NULL,result TEXT,pnl REAL,settled_at INTEGER);
      CREATE INDEX IF NOT EXISTS flags_open ON flags(result,ticker);CREATE INDEX IF NOT EXISTS flags_last ON flags(ticker,type,time);`);
    // Cumulative traded contracts per snapshot (the scanner's 1-hour volume); added after stage 1, so older databases gain it here.
    if(!(this.db.prepare('PRAGMA table_info(snapshots)').all() as {name:string}[]).some(c=>c.name==='volume'))this.db.exec('ALTER TABLE snapshots ADD COLUMN volume REAL');
    // Sharp money (2026-10-10): which Polymarket market (condition id) a match is, and which of its outcomes is Kalshi's YES.
    const mcols=(this.db.prepare('PRAGMA table_info(matches)').all() as {name:string}[]).map(c=>c.name);
    if(!mcols.includes('cond'))this.db.exec('ALTER TABLE matches ADD COLUMN cond TEXT');if(!mcols.includes('yes_outcome'))this.db.exec('ALTER TABLE matches ADD COLUMN yes_outcome TEXT');
    this.db.exec(`CREATE INDEX IF NOT EXISTS matches_cond ON matches(cond);
      CREATE TABLE IF NOT EXISTS wallets(address TEXT PRIMARY KEY,source TEXT NOT NULL,rank INTEGER,tier TEXT,context TEXT NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sharp_snaps(time INTEGER NOT NULL,cond TEXT NOT NULL,outcome TEXT NOT NULL,title TEXT,wallets INTEGER NOT NULL,value REAL NOT NULL,avg_entry REAL,cur_price REAL,against INTEGER NOT NULL,ticker TEXT,side TEXT,PRIMARY KEY(time,cond,outcome));
      CREATE TABLE IF NOT EXISTS sharp_links(cond TEXT NOT NULL,ticker TEXT NOT NULL,yes_outcome TEXT NOT NULL,status TEXT NOT NULL,score REAL,title TEXT,decided_at INTEGER,PRIMARY KEY(cond,ticker));
      CREATE TABLE IF NOT EXISTS btc_lean(round INTEGER NOT NULL,horizon INTEGER NOT NULL,time INTEGER NOT NULL,ticker TEXT NOT NULL,up_price REAL,sharp_net REAL NOT NULL,all_net REAL NOT NULL,sharp_wallets INTEGER NOT NULL,yes_bid REAL,yes_ask REAL,result TEXT,PRIMARY KEY(round,horizon));`);
    // Trend at the lean (2026-10-16): Kalshi YES mid − 50¢ (where BTC is vs the target) and the mid's move over the last ~3 min.
    const lcols=(this.db.prepare('PRAGMA table_info(btc_lean)').all() as {name:string}[]).map(c=>c.name);
    if(!lcols.includes('trend'))this.db.exec('ALTER TABLE btc_lean ADD COLUMN trend REAL');if(!lcols.includes('slope'))this.db.exec('ALTER TABLE btc_lean ADD COLUMN slope REAL');
  }
  log(event:string,context:unknown){this.db.prepare('INSERT INTO events(time,event,context) VALUES(?,?,?)').run(Date.now(),event,JSON.stringify(context));}
  get<T>(key:string,fallback:T):T{const row=this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as {value:string}|undefined;return row?JSON.parse(row.value):fallback;}
  set(key:string,value:unknown){this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key,JSON.stringify(value));}
  upsertMarket(q:Quote,category:string|null,group:Group){
    this.db.prepare(`INSERT INTO markets(ticker,event_ticker,series_ticker,category,grp,title,yes_label,close_time,expected_expiration,is_combo,legs,result,first_seen,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(ticker) DO UPDATE SET category=excluded.category,grp=excluded.grp,title=excluded.title,yes_label=excluded.yes_label,close_time=excluded.close_time,expected_expiration=excluded.expected_expiration,legs=excluded.legs,result=excluded.result,updated=excluded.updated`)
      .run(q.ticker,q.eventTicker,q.seriesTicker,category,group,q.title,q.yesLabel,q.closeTime,q.expectedExpiration,q.legs?1:0,q.legs?JSON.stringify(q.legs):null,q.result,q.updated,q.updated);
  }
  snapshot(rows:{ticker:string;time:number;yesBid:number|null;yesAsk:number|null;last:number|null;volume24h:number|null;held:boolean;volume?:number|null}[]){
    const put=this.db.prepare('INSERT OR IGNORE INTO snapshots(ticker,time,yes_bid,yes_ask,last,volume_24h,held,volume) VALUES(?,?,?,?,?,?,?,?)');
    this.db.transaction(()=>{for(const r of rows)put.run(r.ticker,r.time,r.yesBid,r.yesAsk,r.last,r.volume24h,r.held?1:0,r.volume??null);})();
  }
  /** YES mid (or last trade) and cumulative volume per snapshot since `since`, for the scanner's 1-hour move. */
  recentMids(ticker:string,since:number):{t:number;mid:number;volume:number|null}[]{
    return (this.db.prepare('SELECT time AS t,CASE WHEN yes_bid IS NOT NULL AND yes_ask IS NOT NULL THEN (yes_bid+yes_ask)/2 ELSE last END AS mid,volume FROM snapshots WHERE ticker=? AND time>=? ORDER BY time').all(ticker,since) as {t:number;mid:number|null;volume:number|null}[])
      .filter((r):r is {t:number;mid:number;volume:number|null}=>r.mid!==null);
  }
  /** Scanner flags, each a one-contract paper trade scored when its market settles. */
  putFlags(flags:{time:number;ticker:string;event:string;group:string;type:string;side:string;price:number;fee:number;edge:number;context:unknown}[]){
    const put=this.db.prepare('INSERT INTO flags(time,ticker,event,grp,type,side,price,fee,edge,context) VALUES(?,?,?,?,?,?,?,?,?,?)');
    this.db.transaction(()=>{for(const f of flags)put.run(f.time,f.ticker,f.event,f.group,f.type,f.side,f.price,f.fee,f.edge,JSON.stringify(f.context));})();
  }
  lastFlag(ticker:string,type:string):{time:number;edge:number}|null{return (this.db.prepare('SELECT time,edge FROM flags WHERE ticker=? AND type=? ORDER BY time DESC LIMIT 1').get(ticker,type) as {time:number;edge:number}|undefined)??null;}
  openFlagTickers():string[]{return (this.db.prepare('SELECT DISTINCT ticker FROM flags WHERE result IS NULL ORDER BY ticker').all() as {ticker:string}[]).map(r=>r.ticker);}
  /** Score a settled market's open flags: P&L per contract = (1 if the flagged side won) − ask − fee. Only yes/no results count. */
  settleFlags(ticker:string,result:'yes'|'no',now:number){this.db.prepare('UPDATE flags SET result=?,pnl=(CASE WHEN side=? THEN 1 ELSE 0 END)-price-fee,settled_at=? WHERE ticker=? AND result IS NULL').run(result,result,now,ticker);}
  flagsSince(since:number){return this.db.prepare('SELECT id,time,ticker,event,grp AS "group",type,side,price,fee,edge,result,pnl FROM flags WHERE time>=? ORDER BY time DESC').all(since) as FlagRow[];}
  flagRows(){return this.db.prepare('SELECT id,time,ticker,event,grp AS "group",type,side,price,fee,edge,result,pnl FROM flags ORDER BY time').all() as FlagRow[];}
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
  setMatch(m:{ticker:string;source:string;refId:string;method:'auto'|'suggested';status:'auto'|'suggested';score:number|null;title:string;url:string;cond?:string|null;yesOutcome?:string|null}){
    this.db.prepare(`INSERT INTO matches(ticker,source,ref_id,method,status,score,title,url,cond,yes_outcome) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(ticker,source,ref_id) DO UPDATE SET title=excluded.title,url=excluded.url,score=excluded.score,cond=COALESCE(excluded.cond,cond),yes_outcome=COALESCE(excluded.yes_outcome,yes_outcome) WHERE status NOT IN ('confirmed','rejected')`).run(m.ticker,m.source,m.refId,m.method,m.status,m.score,m.title,m.url,m.cond??null,m.yesOutcome??null);
  }
  /** Kalshi markets tied to a Polymarket market: automatic sports matches, and title links (suggested or confirmed) from the Sharps tab. */
  linksForCond(cond:string):{ticker:string;yesOutcome:string;status:string}[]{
    return this.db.prepare(`SELECT ticker,yes_outcome AS yesOutcome,status FROM matches WHERE cond=? AND yes_outcome IS NOT NULL AND status IN ('auto','confirmed')
      UNION SELECT ticker,yes_outcome AS yesOutcome,status FROM sharp_links WHERE cond=? AND status IN ('confirmed','suggested')`).all(cond,cond) as {ticker:string;yesOutcome:string;status:string}[];
  }
  suggestLink(l:{cond:string;ticker:string;yesOutcome:string;score:number;title:string}){
    this.db.prepare(`INSERT INTO sharp_links(cond,ticker,yes_outcome,status,score,title) VALUES(?,?,?,'suggested',?,?) ON CONFLICT(cond,ticker) DO NOTHING`).run(l.cond,l.ticker,l.yesOutcome,l.score,l.title);
  }
  hasLink(cond:string){return !!this.db.prepare('SELECT 1 FROM sharp_links WHERE cond=?').get(cond);}
  decideLink(cond:string,ticker:string,status:'confirmed'|'rejected',now:number){return this.db.prepare('UPDATE sharp_links SET status=?,decided_at=? WHERE cond=? AND ticker=?').run(status,now,cond,ticker).changes>0;}
  putWallets(rows:{address:string;source:string;rank:number;tier:string;context:unknown}[],now:number){
    const put=this.db.prepare('INSERT OR REPLACE INTO wallets(address,source,rank,tier,context,updated) VALUES(?,?,?,?,?,?)');
    this.db.transaction(()=>{this.db.prepare('DELETE FROM wallets').run();for(const r of rows)put.run(r.address,r.source,r.rank,r.tier,JSON.stringify(r.context),now);})();
  }
  walletRows(){return (this.db.prepare('SELECT context FROM wallets ORDER BY source,rank').all() as {context:string}[]).map(r=>JSON.parse(r.context));}
  walletsUpdated(){return (this.db.prepare('SELECT MAX(updated) AS t FROM wallets').get() as {t:number|null}).t;}
  putSharpSnaps(time:number,rows:{cond:string;outcome:string;title:string;wallets:number;value:number;avgEntry:number|null;curPrice:number|null;against:number;ticker:string|null;side:string|null}[]){
    const put=this.db.prepare('INSERT OR IGNORE INTO sharp_snaps VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    this.db.transaction(()=>{for(const r of rows)put.run(time,r.cond,r.outcome,r.title,r.wallets,r.value,r.avgEntry,r.curPrice,r.against,r.ticker,r.side);})();
  }
  putLean(r:{round:number;horizon:number;time:number;ticker:string;upPrice:number|null;sharpNet:number;allNet:number;sharpWallets:number;yesBid:number|null;yesAsk:number|null;trend:number|null;slope:number|null}){
    this.db.prepare('INSERT OR IGNORE INTO btc_lean(round,horizon,time,ticker,up_price,sharp_net,all_net,sharp_wallets,yes_bid,yes_ask,trend,slope) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(r.round,r.horizon,r.time,r.ticker,r.upPrice,r.sharpNet,r.allNet,r.sharpWallets,r.yesBid,r.yesAsk,r.trend,r.slope);
  }
  leanHorizons(round:number){return new Set((this.db.prepare('SELECT horizon FROM btc_lean WHERE round=?').all(round) as {horizon:number}[]).map(r=>r.horizon));}
  /** Rounds whose Kalshi result is not stored yet, 5+ minutes after they closed. */
  unscoredLean(now:number){return (this.db.prepare('SELECT DISTINCT ticker FROM btc_lean WHERE result IS NULL AND (round+900)*1000<? ORDER BY ticker LIMIT 20').all(now-300000) as {ticker:string}[]).map(r=>r.ticker);}
  scoreLean(ticker:string,result:'yes'|'no'){this.db.prepare('UPDATE btc_lean SET result=? WHERE ticker=?').run(result,ticker);}
  categoryOf(series:string){return (this.db.prepare('SELECT category FROM markets WHERE series_ticker=? AND category IS NOT NULL LIMIT 1').get(series) as {category:string}|undefined)?.category??null;}
  leanRows(){return this.db.prepare('SELECT round,horizon,time,ticker,up_price AS upPrice,sharp_net AS sharpNet,all_net AS allNet,sharp_wallets AS sharpWallets,yes_bid AS yesBid,yes_ask AS yesAsk,result,trend,slope FROM btc_lean ORDER BY round').all() as LeanRow[];}
  setLeanTrend(round:number,horizon:number,trend:number|null,slope:number|null){this.db.prepare('UPDATE btc_lean SET trend=?,slope=? WHERE round=? AND horizon=?').run(trend,slope,round,horizon);}
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
  awaitingResult(now:number):string[]{return (this.db.prepare(`SELECT ticker FROM markets WHERE result IS NULL AND COALESCE(expected_expiration,close_time)<? AND ticker IN (SELECT ticker FROM refs UNION SELECT ticker FROM flags WHERE result IS NULL) ORDER BY ticker`).all(now) as {ticker:string}[]).map(r=>r.ticker);}
  /** Start the public history over (after a change to how markets are chosen). */
  resetBackfill(){this.db.transaction(()=>{this.db.prepare('DELETE FROM backfill').run();this.db.prepare("DELETE FROM meta WHERE key IN ('backfillTo','backfillFinished','accuracy')").run();})();}
  unpriced(limit=1000000){return this.db.prepare('SELECT ticker,event_ts AS eventTs FROM backfill WHERE priced=0 ORDER BY event_ts LIMIT ?').all(limit) as {ticker:string;eventTs:number}[];}
  setPrices(ticker:string,p:{p24:number|null;a24:number|null;p1:number|null;a1:number|null;vwap:number|null}){this.db.prepare('UPDATE backfill SET p24=?,a24=?,p1=?,a1=?,vwap=?,priced=1 WHERE ticker=?').run(p.p24,p.a24,p.p1,p.a1,p.vwap,ticker);}
  backfillRows():BackfillRow[]{return this.db.prepare('SELECT ticker,event,series,grp,title,event_ts AS eventTs,settle_ts AS settleTs,result,volume,p24,a24,p1,a1,vwap,priced FROM backfill WHERE priced=1 ORDER BY event_ts').all() as BackfillRow[];}
  backfillStats(){return this.db.prepare('SELECT COUNT(*) AS markets,COALESCE(SUM(priced),0) AS priced,MIN(event_ts) AS "from",MAX(event_ts) AS "to" FROM backfill').get() as {markets:number;priced:number;from:number|null;to:number|null};}
  /** Snapshots of markets you hold are kept for good; others (the scanner, from stage 4) for 14 days. */
  prune(now=Date.now()){this.db.prepare('DELETE FROM snapshots WHERE held=0 AND time<?').run(now-14*DAY);}
}
