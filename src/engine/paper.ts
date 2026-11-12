import type {Journal} from './journal';
import {ledger,quoteOrder,type BookSides,type Ledger,type Side,type SimFill} from './sim';
import {coach,type CoachReport} from './coach';
import type {FeeSchedule} from './model/fees';
import type {SetupStats} from '../backtest/setups';
/**
 * The paper account in the journal (sim_accounts, sim_fills): every reset starts a new account with the bankroll you
 * choose, so the old record stays for the coach and for later studies. Bitcoin rounds settle from the outcomes table the
 * live advisor writes; any other Kalshi market (an earlier round still holding a paper position) from sim_results, which the engine fills
 * from Kalshi's own result while a paper position is open.
 */
export const PAPER_SCHEMA=`CREATE TABLE IF NOT EXISTS sim_accounts(id INTEGER PRIMARY KEY,time INTEGER NOT NULL,bankroll REAL NOT NULL);
  CREATE TABLE IF NOT EXISTS sim_fills(id INTEGER PRIMARY KEY,account INTEGER NOT NULL,time INTEGER NOT NULL,ticker TEXT NOT NULL,side TEXT NOT NULL,action TEXT NOT NULL,contracts REAL NOT NULL,price REAL NOT NULL,fee REAL NOT NULL,context TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS sim_fills_account ON sim_fills(account,time);
  CREATE TABLE IF NOT EXISTS sim_results(ticker TEXT PRIMARY KEY,time INTEGER NOT NULL,result TEXT NOT NULL);`;
export interface OrderRequest {side:Side;action:'buy'|'sell';contracts?:number;dollars?:number}
/** The live market at the moment of the order, as the engine sees it. */
export interface MarketNow {ticker:string;tau:number;active:boolean;book:BookSides&{valid:boolean;updated:number};delayed:boolean;delayMs:number;schedule:FeeSchedule;bookStaleMs:number;now:number;context:Record<string,unknown>}
export interface Mark {bid:number|null;fair:number|null}
export class PaperDesk {
  version=0;private cache:Ledger|null=null;
  constructor(private journal:Journal){journal.db.exec(PAPER_SCHEMA);}
  account(){return (this.journal.db.prepare('SELECT id,time,bankroll FROM sim_accounts ORDER BY id DESC LIMIT 1').get() as {id:number;time:number;bankroll:number}|undefined)??null;}
  reset(bankroll:number,now=Date.now()){
    if(!Number.isFinite(bankroll)||bankroll<1||bankroll>10_000_000)throw new Error('Choose a paper bankroll between $1 and $10,000,000');
    this.journal.db.prepare('INSERT INTO sim_accounts(time,bankroll) VALUES(?,?)').run(now,Math.round(bankroll*100)/100);this.invalidate();return this.account()!;
  }
  /** Call when fills or results change; the page refetches the review when `version` moves. */
  invalidate(){this.cache=null;this.version++;}
  fills(account:number):SimFill[]{
    return (this.journal.db.prepare('SELECT id,time,ticker,side,action,contracts,price,fee,context FROM sim_fills WHERE account=? ORDER BY time,id').all(account) as any[]).map(r=>({...r,context:JSON.parse(r.context)}));
  }
  ledger():Ledger|null{
    const a=this.account();if(!a)return null;if(this.cache)return this.cache;
    const fills=this.fills(a.id),tickers=[...new Set(fills.map(f=>f.ticker))],results=new Map<string,string>();
    const q=this.journal.db.prepare('SELECT result FROM outcomes WHERE ticker=?'),q2=this.journal.db.prepare('SELECT result FROM sim_results WHERE ticker=?');
    for(const t of tickers){const r=(q.get(t)??q2.get(t)) as {result:string}|undefined;if(r)results.set(t,r.result);}
    return this.cache=ledger(a.bankroll,fills,results);
  }
  /** Tickers with an open paper position and no result yet: the engine marks them and looks their result up. */
  openTickers(){return this.ledger()?.positions.map(p=>p.ticker)??[];}
  setResult(ticker:string,result:string,time=Date.now()){if(result!=='yes'&&result!=='no')return;this.journal.db.prepare('INSERT OR REPLACE INTO sim_results VALUES(?,?,?)').run(ticker,time,result);this.invalidate();}
  /** A market order on the current round. Refuses on a stale or delayed book: a paper fill must be a fill you could have got. */
  order(req:OrderRequest,m:MarketNow):{fills:SimFill[];message:string}{
    const a=this.account();if(!a)throw new Error('Start a paper account first');
    if(req.side!=='yes'&&req.side!=='no'||req.action!=='buy'&&req.action!=='sell')throw new Error('Choose YES or NO, buy or sell');
    if(!m.active||m.tau<=1)throw new Error('This round is closed for trading');
    if(!m.book.valid||m.now-m.book.updated>m.bookStaleMs)throw new Error('Kalshi book is stale; try again in a moment');
    if(m.delayed)throw new Error(`Kalshi prices are ${Math.round(m.delayMs/1000)} s behind; paper fills wait until they catch up`);
    const want:{contracts?:number;dollars?:number}|null=req.contracts!==undefined?{contracts:req.contracts}:req.dollars!==undefined?{dollars:req.dollars}:null;
    if(!want||!((want.contracts??want.dollars??0)>0))throw new Error('Enter an amount');
    const l=this.ledger()!,held=l.positions.find(p=>p.ticker===m.ticker)??null,fills:SimFill[]=[];
    const equity=l.cash+l.positions.reduce((s,p)=>s+p.cost,0),base={...m.context,tau:m.tau,equity,delay:m.delayMs};
    const record=(side:Side,action:'buy'|'sell',q:{contracts:number;price:number;fee:number},extra:Record<string,unknown>={})=>{
      const f:SimFill={time:m.now,ticker:m.ticker,side,action,contracts:q.contracts,price:Math.round(q.price*1e6)/1e6,fee:q.fee,context:{...base,...extra}};
      const r=this.journal.db.prepare('INSERT INTO sim_fills(account,time,ticker,side,action,contracts,price,fee,context) VALUES(?,?,?,?,?,?,?,?,?)').run(a.id,f.time,f.ticker,f.side,f.action,f.contracts,f.price,f.fee,JSON.stringify(f.context));
      fills.push({...f,id:Number(r.lastInsertRowid)});};
    let cash=l.cash;
    this.journal.db.transaction(()=>{
      if(req.action==='sell'){
        if(!held||held.side!==req.side)throw new Error(`No paper ${req.side.toUpperCase()} position in this round to sell`);
        const q=quoteOrder(m.book,req.side,'sell',{contracts:Math.min(req.contracts??held.contracts,held.contracts)},m.schedule);
        if(!q.contracts)throw new Error('No bids to sell into right now');record(req.side,'sell',q);return;
      }
      // Buying the other side first sells what you hold, as Kalshi nets YES against NO.
      if(held&&held.side!==req.side){const q=quoteOrder(m.book,held.side,'sell',{contracts:held.contracts},m.schedule);if(!q.contracts)throw new Error('No bids to close your current side first');record(held.side,'sell',q,{flip:true});cash+=q.cash;}
      const q=quoteOrder(m.book,req.side,'buy',{contracts:want.contracts,dollars:Math.min(want.dollars??Infinity,cash)},m.schedule);
      if(!q.contracts)throw new Error(cash<1?'Not enough paper cash':'No offers on the book at a price your cash covers');
      record(req.side,'buy',q,held&&held.side!==req.side?{flip:true}:{});
    })();
    this.invalidate();
    const f=fills[fills.length-1],verb=f.action==='buy'?'Bought':'Sold';
    return {fills,message:`${verb} ${f.contracts} ${f.side.toUpperCase()} at ${(f.price*100).toFixed(1)}¢ (fee $${f.fee.toFixed(2)})${req.contracts&&f.action==='buy'&&f.contracts<req.contracts?` · only ${f.contracts} of ${req.contracts} were on offer`:''}`};
  }
  /** Small enough for the 4 Hz dashboard stream: the account marked at the live bids. */
  summary(mark:(ticker:string,side:Side)=>Mark){
    const a=this.account();if(!a)return {version:this.version,account:null};
    const l=this.ledger()!,meta=new Map<string,any>();for(const f of this.fills(a.id))if(f.context?.title)meta.set(f.ticker,f.context);
    const positions=l.positions.map(p=>{const m=mark(p.ticker,p.side),value=m.bid!==null?p.contracts*m.bid:null,c=meta.get(p.ticker);
      return {...p,avgCost:p.cost/p.contracts,bid:m.bid,fair:m.fair,value,unrealized:value!==null?value-p.cost:null,holdValue:m.fair!==null?p.contracts*m.fair:null,
        title:c?.title??null,url:c?.url??null,close:c?.close??null};});
    const equity=l.cash+positions.reduce((s,p)=>s+(p.value??p.cost),0),settled=l.rounds.filter(r=>r.pnl!==null);
    return {version:this.version,account:a,cash:l.cash,equity,realized:l.realized,fees:l.fees,positions,rounds:settled.length,wins:settled.filter(r=>r.pnl!>0).length};
  }
  /** The coach's review of the current account, and its equity after every settled round. */
  report(stats?:SetupStats[]|null):{account:{id:number;time:number;bankroll:number}|null;coach:CoachReport|null;equity:{time:number;equity:number}[];accounts:number;fills:{time:number;ticker:string;side:Side;action:'buy'|'sell';price:number;contracts:number}[]}{
    const a=this.account(),accounts=(this.journal.db.prepare('SELECT COUNT(*) n FROM sim_accounts').get() as {n:number}).n;
    if(!a)return {account:null,coach:null,equity:[],accounts,fills:[]};
    const l=this.ledger()!,report=coach(l.rounds,stats,a.bankroll);let eq=a.bankroll;
    const equity=[{time:a.time,equity:a.bankroll},...[...report.reviews].reverse().filter(r=>r.pnl!==null).map(r=>({time:r.time,equity:eq+=r.pnl!}))];
    // Fills for the chart markers on the Paper page.
    const fills=this.fills(a.id).map(f=>({time:f.time,ticker:f.ticker,side:f.side,action:f.action,price:f.price,contracts:f.contracts}));
    return {account:a,coach:report,equity,accounts,fills};
  }
}
