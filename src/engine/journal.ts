import Database from 'better-sqlite3';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {defaults,validateConfig,type Config} from './config';
import type {Idea} from './signals';
import {fee,type FeeSchedule} from './model/fees';
import type {RealEvent} from './guardrails';
import type {OpeningCall} from './model/opening';
import {PRICE_FORECAST_SCHEMA} from './quant/price-journal';
import {BENCHMARK_SCHEMA} from './quant/benchmark-journal';
import {RESEARCH_SCHEMA} from './quant/research-journal';
export const tables=['ticks','signals','paper_trades','outcomes','real_trades','opening_calls','live_calls','next_calls','balances','price_forecasts','benchmark_ticks','benchmark_forecasts','research_forecasts','research_gaps','sim_accounts','sim_fills'] as const;
export class Journal {
  db:Database.Database;
  private restingOrders:Database.Statement;private fillRestingOrder:Database.Statement;
  // ADVISOR_DB lets a verification instance run against a copy of the journal without touching the live one.
  constructor(path=process.env.ADVISOR_DB??'./data/advisor.db'){
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});this.db=new Database(path);this.db.pragma('journal_mode = WAL');this.db.pragma('synchronous = NORMAL');this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ticks(id INTEGER PRIMARY KEY, time INTEGER NOT NULL,ticker TEXT NOT NULL,proxy REAL,k REAL,tau REAL,sigma REAL,p REAL,mid REAL,regime TEXT,context TEXT NOT NULL,UNIQUE(time,ticker));
      CREATE INDEX IF NOT EXISTS ticks_time ON ticks(time);CREATE INDEX IF NOT EXISTS ticks_market ON ticks(ticker);CREATE INDEX IF NOT EXISTS ticks_market_tau ON ticks(ticker,tau);
      CREATE TABLE IF NOT EXISTS signals(id INTEGER PRIMARY KEY,time INTEGER NOT NULL,ticker TEXT NOT NULL,kind TEXT NOT NULL,side TEXT NOT NULL,price REAL NOT NULL,edge REAL NOT NULL,p REAL NOT NULL,tau REAL,regime TEXT,context TEXT NOT NULL,UNIQUE(ticker,kind,side,price));
      CREATE TABLE IF NOT EXISTS paper_trades(id INTEGER PRIMARY KEY,signal_id INTEGER UNIQUE,time INTEGER NOT NULL,ticker TEXT NOT NULL,kind TEXT NOT NULL,side TEXT NOT NULL,price REAL NOT NULL,fee REAL NOT NULL,status TEXT NOT NULL,filled_time INTEGER,settled_time INTEGER,pnl REAL,context TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outcomes(ticker TEXT PRIMARY KEY,time INTEGER NOT NULL,result TEXT NOT NULL,actual_average REAL,proxy_average REAL,proxy_result TEXT,basis_error REAL,context TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS real_trades(id TEXT PRIMARY KEY,time INTEGER NOT NULL,ticker TEXT NOT NULL,type TEXT NOT NULL,pnl REAL NOT NULL,contracts REAL NOT NULL,context TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,time INTEGER NOT NULL,event TEXT NOT NULL,context TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS opening_calls(ticker TEXT PRIMARY KEY,time INTEGER NOT NULL,tau REAL NOT NULL,direction TEXT NOT NULL,p REAL NOT NULL,base_p REAL NOT NULL,lean REAL NOT NULL,mid REAL,context TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS live_calls(ticker TEXT NOT NULL,horizon INTEGER NOT NULL,time INTEGER NOT NULL,tau REAL NOT NULL,direction TEXT NOT NULL,p REAL NOT NULL,base_p REAL NOT NULL,mid REAL,context TEXT NOT NULL,PRIMARY KEY(ticker,horizon));
      CREATE TABLE IF NOT EXISTS next_calls(ticker TEXT NOT NULL,horizon INTEGER NOT NULL,from_ticker TEXT NOT NULL,time INTEGER NOT NULL,tau REAL NOT NULL,direction TEXT NOT NULL,p REAL NOT NULL,base_p REAL NOT NULL,head_start REAL,expected_k REAL,context TEXT NOT NULL,PRIMARY KEY(ticker,horizon));
      CREATE TABLE IF NOT EXISTS balances(time INTEGER PRIMARY KEY,balance REAL NOT NULL,portfolio_value REAL);
      CREATE TABLE IF NOT EXISTS account_raw(id TEXT PRIMARY KEY,type TEXT NOT NULL,time INTEGER NOT NULL,context TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS paper_status ON paper_trades(status,ticker);CREATE INDEX IF NOT EXISTS signals_cover ON signals(id,tau,regime,edge);`);
    this.db.exec(PRICE_FORECAST_SCHEMA);
    this.db.exec(BENCHMARK_SCHEMA);
    this.db.exec(RESEARCH_SCHEMA);
    // Public trades can arrive thousands per second. Reuse the query plan, but read current rows on every trade
    // so newly resting, filled and expired paper orders retain exactly the same causal fill rules.
    this.restingOrders=this.db.prepare("SELECT * FROM paper_trades WHERE ticker=? AND status='resting' AND time<? ORDER BY time,id");
    this.fillRestingOrder=this.db.prepare("UPDATE paper_trades SET status='filled',filled_time=? WHERE id=?");
  }
  log(event:string,context:unknown){this.db.prepare('INSERT INTO events(time,event,context) VALUES(?,?,?)').run(Date.now(),event,JSON.stringify(context));}
  get<T>(key:string,fallback:T):T{const row=this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as {value:string}|undefined;return row?JSON.parse(row.value):fallback;}
  set(key:string,value:unknown){this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key,JSON.stringify(value));}
  config():Config{return validateConfig(this.get('config',defaults));}
  tick(t:any){this.db.prepare('INSERT OR IGNORE INTO ticks(time,ticker,proxy,k,tau,sigma,p,mid,regime,context) VALUES(?,?,?,?,?,?,?,?,?,?)').run(t.time,t.ticker,t.proxy,t.K,t.tau,t.sigma,t.p,t.mid,t.regime,JSON.stringify(t));}
  signal(ticker:string,time:number,idea:Idea,context:any,schedule:FeeSchedule){
    this.db.transaction(()=>{
      const r=this.db.prepare('INSERT OR IGNORE INTO signals(time,ticker,kind,side,price,edge,p,tau,regime,context) VALUES(?,?,?,?,?,?,?,?,?,?)').run(time,ticker,idea.kind,idea.side,idea.price,idea.edge,context.p,context.tau,context.regime,JSON.stringify({...context,idea}));
      if(!r.changes)return;
      // Taker, scalp and dip enter at the ask immediately; only maker ideas rest.
      const resting=idea.kind==='maker';
      this.db.prepare('INSERT INTO paper_trades(signal_id,time,ticker,kind,side,price,fee,status,filled_time,context) VALUES(?,?,?,?,?,?,?,?,?,?)').run(r.lastInsertRowid,time,ticker,idea.kind,idea.side,idea.price,fee(idea.price,1,resting?'maker':'taker',schedule),resting?'resting':'filled',resting?null:time,JSON.stringify({idea,schedule,close:context.close}));
    })();
  }
  throughTrade(trade:{ticker:string;time:number;yesPrice:number;count:number;takerSide:string}){
    const orders=this.restingOrders.all(trade.ticker,trade.time) as any[];
    let volume=trade.count;
    for(const row of orders){const ctx=JSON.parse(row.context);if(trade.time>=ctx.close||volume<1)continue;const price=row.side==='yes'?trade.yesPrice:1-trade.yesPrice;
      if(trade.takerSide!==row.side&&price<row.price-1e-8){this.fillRestingOrder.run(trade.time,row.id);volume-=1;}}
  }
  settle(ticker:string,result:string,time:number,actual:number|null,proxy:number|null,K:number|null,context:unknown){
    if(!['yes','no'].includes(result))return;
    this.db.transaction(()=>{
      const paired=this.db.prepare('SELECT p,mid,tau FROM ticks WHERE ticker=? AND p IS NOT NULL AND mid IS NOT NULL AND tau BETWEEN 150 AND 210 ORDER BY ABS(tau-180),time LIMIT 1').get(ticker)??null;
      this.db.prepare('INSERT OR REPLACE INTO outcomes VALUES(?,?,?,?,?,?,?,?)').run(ticker,time,result,actual,proxy,proxy!==null&&K!==null?(Math.round(proxy*100)/100>=K?'yes':'no'):null,actual!==null&&proxy!==null?proxy-actual:null,JSON.stringify({market:context,pairedPrediction:paired}));
      // Scalps/dips exit at their resting target if the side's bid reached it before close (maker fee on the exit);
      // otherwise they are held to settlement like a taker entry.
      for(const t of this.db.prepare("SELECT id,time,side,price,fee,context FROM paper_trades WHERE ticker=? AND status='filled' AND kind IN ('scalp','dip')").all(ticker) as any[]){
        const ctx=JSON.parse(t.context),target=ctx.idea?.target;if(!Number.isFinite(target))continue;
        const hit=this.db.prepare(`SELECT time FROM ticks WHERE ticker=? AND time>? AND json_extract(context,'$.book.${t.side==='yes'?'yesBid':'noBid'}')>=? ORDER BY time LIMIT 1`).get(ticker,t.time,target-1e-9) as {time:number}|undefined;
        if(hit)this.db.prepare("UPDATE paper_trades SET status='settled',settled_time=?,pnl=?,context=? WHERE id=?").run(time,target-t.price-t.fee-fee(target,1,'maker',ctx.schedule),JSON.stringify({...ctx,exit:{at:hit.time,price:target,reason:'target'}}),t.id);
      }
      this.db.prepare("UPDATE paper_trades SET status='settled',settled_time=?,pnl=CASE WHEN side=? THEN 1 ELSE 0 END-price-fee WHERE ticker=? AND status='filled'").run(time,result,ticker);
      this.db.prepare("UPDATE paper_trades SET status='expired',settled_time=? WHERE ticker=? AND status='resting'").run(time,ticker);
      this.log('settlement-logged',{ticker,result,actual,proxy});
    })();
  }
  /** First call per market wins; later attempts in the same window are ignored. */
  saveOpeningCall(ticker:string,time:number,tau:number,call:OpeningCall,mid:number|null){this.db.prepare('INSERT OR IGNORE INTO opening_calls VALUES(?,?,?,?,?,?,?,?,?)').run(ticker,time,tau,call.direction,call.p,call.baseP,call.lean,mid,JSON.stringify(call));}
  openingCall(ticker:string){const row=this.db.prepare('SELECT time,tau,mid,context FROM opening_calls WHERE ticker=?').get(ticker) as {time:number;tau:number;mid:number|null;context:string}|undefined;return row?{...JSON.parse(row.context) as OpeningCall,time:row.time,tau:row.tau,mid:row.mid}:null;}
  private realCache:RealEvent[]|null=null;
  saveLiveCall(ticker:string,horizon:number,time:number,tau:number,call:OpeningCall,mid:number|null){this.db.prepare('INSERT OR IGNORE INTO live_calls VALUES(?,?,?,?,?,?,?,?,?)').run(ticker,horizon,time,tau,call.direction,call.p,call.baseP,mid,JSON.stringify(call));}
  liveHorizons(ticker:string){return new Set((this.db.prepare('SELECT horizon FROM live_calls WHERE ticker=?').all(ticker) as {horizon:number}[]).map(r=>r.horizon));}
  saveNextCall(ticker:string,horizon:number,fromTicker:string,time:number,tau:number,call:{direction:string;p:number;baseP:number;headStart:number;expectedK:number},context:unknown){
    this.db.prepare('INSERT OR IGNORE INTO next_calls VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(ticker,horizon,fromTicker,time,tau,call.direction,call.p,call.baseP,call.headStart,call.expectedK,JSON.stringify(context));}
  nextHorizons(ticker:string){return new Set((this.db.prepare('SELECT horizon FROM next_calls WHERE ticker=?').all(ticker) as {horizon:number}[]).map(r=>r.horizon));}
  /** Balance history for the equity curve: on change, or every 5 minutes. */
  balance(time:number,balance:number,portfolio:number|null){const last=this.db.prepare('SELECT time,balance,portfolio_value FROM balances ORDER BY time DESC LIMIT 1').get() as any;
    if(!last||last.balance!==balance||last.portfolio_value!==portfolio||time-last.time>=300000)this.db.prepare('INSERT OR REPLACE INTO balances VALUES(?,?,?)').run(time,balance,portfolio);}
  real(events:RealEvent[]){this.realCache=null;const stmt=this.db.prepare('INSERT OR REPLACE INTO real_trades VALUES(?,?,?,?,?,?,?)');this.db.transaction(()=>{for(const e of events)stmt.run(e.id,e.time,e.ticker,e.type,e.pnl,e.contracts,JSON.stringify(e));})();}
  realEvents():RealEvent[]{return this.realCache??=(this.db.prepare('SELECT context FROM real_trades ORDER BY time').all() as {context:string}[]).map(r=>JSON.parse(r.context));}
  restoreHistory(){return this.db.prepare('SELECT time,proxy AS price FROM ticks WHERE proxy IS NOT NULL AND time>? GROUP BY time ORDER BY time').all(Date.now()-7200000) as {time:number;price:number}[];}
  /** Markets with ticks since `since` and no recorded outcome. Reads only the UNIQUE(time,ticker) index (~3 ms); scanning all
   *  30 days of ticks every 10 s grew with the journal. */
  pendingMarkets(since=0){return this.db.prepare('SELECT ticker,MAX(time) AS time FROM ticks INDEXED BY sqlite_autoindex_ticks_1 WHERE time>=? AND ticker NOT IN (SELECT ticker FROM outcomes) GROUP BY ticker').all(since) as {ticker:string;time:number}[];}
  /** Ticks older than 30 days are deleted, except the final minute (tau < 60): that is the one window the 1-minute
   *  history cannot test, so it is kept for good (~25 MB/day) for the final-minute study and the late-round forecast. */
  // Ticks with ≤ 90 s left are kept forever: the final-minute entry study and the final-90-second sell study (DECISIONS 50).
  prune(now=Date.now()){this.db.prepare('DELETE FROM ticks WHERE time<? AND (tau IS NULL OR tau>=90)').run(now-30*86400000);this.db.prepare("DELETE FROM benchmark_ticks WHERE channel=? AND source_time<?").run('cfbenchmarks_value_5hz',now-7*86400000);this.db.prepare("DELETE FROM benchmark_ticks WHERE channel=? AND source_time<?").run('cfbenchmarks_value',now-30*86400000);
    this.db.prepare('DELETE FROM microstructure_events WHERE received_time<?').run(now-3*86400000);this.db.prepare('DELETE FROM microstructure_features WHERE time<?').run(now-30*86400000);this.db.prepare('DELETE FROM research_books WHERE time<?').run(now-14*86400000);}
  expire(now:number){this.db.prepare("UPDATE paper_trades SET status='expired',settled_time=? WHERE status='resting' AND json_extract(context,'$.close')<=?").run(now,now);}
  export(table:string){if(!tables.includes(table as any))throw new Error('Unknown journal table');const rows=this.db.prepare(`SELECT * FROM ${table}`).all() as Record<string,unknown>[];
    const columns=(this.db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(r=>r.name);
    const cell=(v:unknown)=>'"'+String(v??'').replace(/"/g,'""')+'"';return [columns.join(','),...rows.map(r=>columns.map(k=>cell(r[k])).join(','))].join('\r\n');}
}
