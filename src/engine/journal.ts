import Database from 'better-sqlite3';
import {mkdirSync} from 'node:fs';
import {defaults,validateConfig,type Config} from './config';
import type {Idea} from './signals';
import {fee,type FeeSchedule} from './model/fees';
import type {RealEvent} from './guardrails';
import type {OpeningCall} from './model/opening';
export const tables=['ticks','signals','paper_trades','outcomes','real_trades','opening_calls','live_calls'] as const;
export class Journal {
  db:Database.Database;
  constructor(path='./data/advisor.db'){
    if(path!==':memory:')mkdirSync('data',{recursive:true});this.db=new Database(path);this.db.pragma('journal_mode = WAL');this.db.pragma('synchronous = NORMAL');this.db.pragma('busy_timeout = 5000');
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
      CREATE TABLE IF NOT EXISTS account_raw(id TEXT PRIMARY KEY,type TEXT NOT NULL,time INTEGER NOT NULL,context TEXT NOT NULL);`);
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
      this.db.prepare('INSERT INTO paper_trades(signal_id,time,ticker,kind,side,price,fee,status,filled_time,context) VALUES(?,?,?,?,?,?,?,?,?,?)').run(r.lastInsertRowid,time,ticker,idea.kind,idea.side,idea.price,fee(idea.price,1,idea.kind,schedule),idea.kind==='taker'?'filled':'resting',idea.kind==='taker'?time:null,JSON.stringify({idea,schedule,close:context.close}));
    })();
  }
  throughTrade(trade:{ticker:string;time:number;yesPrice:number;count:number;takerSide:string}){
    const orders=this.db.prepare("SELECT * FROM paper_trades WHERE ticker=? AND status='resting' AND time<? ORDER BY time,id").all(trade.ticker,trade.time) as any[];
    let volume=trade.count;
    for(const row of orders){const ctx=JSON.parse(row.context);if(trade.time>=ctx.close||volume<1)continue;const price=row.side==='yes'?trade.yesPrice:1-trade.yesPrice;
      if(trade.takerSide!==row.side&&price<row.price-1e-8){this.db.prepare("UPDATE paper_trades SET status='filled',filled_time=? WHERE id=?").run(trade.time,row.id);volume-=1;}}
  }
  settle(ticker:string,result:string,time:number,actual:number|null,proxy:number|null,K:number|null,context:unknown){
    if(!['yes','no'].includes(result))return;
    this.db.transaction(()=>{
      const paired=this.db.prepare('SELECT p,mid,tau FROM ticks WHERE ticker=? AND p IS NOT NULL AND mid IS NOT NULL AND tau BETWEEN 150 AND 210 ORDER BY ABS(tau-180),time LIMIT 1').get(ticker)??null;
      this.db.prepare('INSERT OR REPLACE INTO outcomes VALUES(?,?,?,?,?,?,?,?)').run(ticker,time,result,actual,proxy,proxy!==null&&K!==null?(Math.round(proxy*100)/100>=K?'yes':'no'):null,actual!==null&&proxy!==null?proxy-actual:null,JSON.stringify({market:context,pairedPrediction:paired}));
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
  real(events:RealEvent[]){this.realCache=null;const stmt=this.db.prepare('INSERT OR REPLACE INTO real_trades VALUES(?,?,?,?,?,?,?)');this.db.transaction(()=>{for(const e of events)stmt.run(e.id,e.time,e.ticker,e.type,e.pnl,e.contracts,JSON.stringify(e));})();}
  realEvents():RealEvent[]{return this.realCache??=(this.db.prepare('SELECT context FROM real_trades ORDER BY time').all() as {context:string}[]).map(r=>JSON.parse(r.context));}
  restoreHistory(){return this.db.prepare('SELECT time,proxy AS price FROM ticks WHERE proxy IS NOT NULL AND time>? GROUP BY time ORDER BY time').all(Date.now()-7200000) as {time:number;price:number}[];}
  pendingMarkets(){return this.db.prepare('SELECT ticker,MAX(time) AS time FROM ticks WHERE ticker NOT IN (SELECT ticker FROM outcomes) GROUP BY ticker').all() as {ticker:string;time:number}[];}
  prune(now=Date.now()){this.db.prepare('DELETE FROM ticks WHERE time<?').run(now-30*86400000);}
  expire(now:number){this.db.prepare("UPDATE paper_trades SET status='expired',settled_time=? WHERE status='resting' AND json_extract(context,'$.close')<=?").run(now,now);}
  export(table:string){if(!tables.includes(table as any))throw new Error('Unknown journal table');const rows=this.db.prepare(`SELECT * FROM ${table}`).all() as Record<string,unknown>[];
    const columns=(this.db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(r=>r.name);
    const cell=(v:unknown)=>'"'+String(v??'').replace(/"/g,'""')+'"';return [columns.join(','),...rows.map(r=>columns.map(k=>cell(r[k])).join(','))].join('\r\n');}
}
