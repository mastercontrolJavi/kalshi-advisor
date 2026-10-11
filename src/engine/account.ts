import type {KalshiClient} from './feeds/kalshi';
import type {Journal} from './journal';
import {fillWarnings,type RealEvent} from './guardrails';
/** FIFO realized accounting, including canonical directional fills and complementary-side netting. */
/** Open position cost per contract, including the actual fees paid on the fills still open (FIFO). */
export interface OpenCost {ticker:string;side:'yes'|'no';contracts:number;avgCost:number}
export function normalizeAccount(fills:any[],settlements:any[],series:string[]|((ticker:string)=>boolean)=['KXBTC15M'],open?:Map<string,OpenCost>):RealEvent[]{
  const lots=new Map<string,{count:number;cost:number}[]>(),events:RealEvent[]=[],cashFlows=new Map<string,number>();
  const wanted=(ticker:unknown)=>typeof ticker==='string'&&(typeof series==='function'?series(ticker):series.some(s=>ticker.startsWith(s+'-')));
  for(const f of [...fills].sort((a,b)=>Date.parse(a.created_time)-Date.parse(b.created_time))){
    const ticker=f.ticker??f.market_ticker;if(!wanted(ticker))continue;
    // Direction comes from outcome_side/book_side: yes = buy YES or sell NO. Live fills mirror it into the
    // deprecated side field, so action/side are only interpreted the legacy way when canonical fields are absent.
    // Every fill is then a purchase in its direction, netted FIFO against the complementary side.
    const opposite=(s:string)=>s==='yes'?'no':'yes',action=f.action??'buy';
    const side=f.outcome_side??(f.book_side==='bid'?'yes':f.book_side==='ask'?'no':action==='sell'?opposite(f.side):f.side);
    const yes=Number(f.yes_price_dollars??1-Number(f.no_price_dollars)),count=Number(f.count_fp),price=side==='yes'?yes:Number(f.no_price_dollars??1-yes),fees=Number(f.fee_cost),time=f.created_time?Date.parse(f.created_time):f.ts*1000;
    if(![count,price,fees,time].every(Number.isFinite)||!['yes','no'].includes(side)||!['buy','sell'].includes(action)||count<=0||price<0||price>1||fees<0)throw new Error('Unsupported fill schema or missing actual fee');
    const prefix=ticker+':'+(f.subaccount_number??f.subaccount??0)+':',key=prefix+side,list=lots.get(key)??[],oppositeKey=prefix+opposite(side),against=lots.get(oppositeKey)??[];
    let pnl=0,closedContracts=0,remaining=count;
    while(remaining>1e-8&&against.length){const n=Math.min(remaining,against[0].count);pnl+=n*(1-price-fees/count-against[0].cost);closedContracts+=n;against[0].count-=n;remaining-=n;if(against[0].count<1e-8)against.shift();}
    lots.set(oppositeKey,against);if(remaining>1e-8)list.push({count:remaining,cost:price+fees/count});
    const cashFlow=closedContracts-count*price-fees;
    cashFlows.set(ticker,(cashFlows.get(ticker)??0)+cashFlow);
    lots.set(key,list);events.push({id:'fill:'+(f.fill_id??f.trade_id),ticker,type:'fill',time,pnl,closedContracts,contracts:count,side,price,action,orderId:f.order_id});
  }
  if(open)for(const [key,list] of lots){const count=list.reduce((n,l)=>n+l.count,0);if(count<1e-8)continue;const [ticker,,side]=key.split(':');
    const prior=open.get(ticker);if(!prior||prior.contracts<count)open.set(ticker,{ticker,side:side as 'yes'|'no',contracts:count,avgCost:list.reduce((n,l)=>n+l.count*l.cost,0)/count});}
  for(const s of settlements){if(!wanted(s.ticker))continue;
    const revenue=Number(s.revenue)/100,cost=Number(s.yes_total_cost_dollars)+Number(s.no_total_cost_dollars),fees=Number(s.fee_cost),time=Date.parse(s.settled_time);
    if(![revenue,cost,fees,time].every(Number.isFinite))throw new Error('Unsupported settlement schema');
    const marketFills=events.filter(e=>e.ticker===s.ticker&&e.type==='fill');
    const matchingFills=fills.filter(f=>(f.ticker??f.market_ticker)===s.ticker);
    const cashFlow=cashFlows.get(s.ticker)??0;
    const outcomePnl=matchingFills.length?revenue+cashFlow:revenue-cost-fees;
    const alreadyRealized=marketFills.reduce((sum,f)=>sum+f.pnl,0);
    events.push({id:'settlement:'+s.ticker,ticker:s.ticker,type:'settlement',time,pnl:outcomePnl-alreadyRealized,outcomePnl,contracts:Number(s.yes_count_fp)+Number(s.no_count_fp)});
  }return events.sort((a,b)=>a.time-b.time);
}
export class Account {
  balance:number|null=null;portfolioValue:number|null=null;ready=false;updated=0;error='Credentials unavailable';positions:unknown[]=[];openCosts=new Map<string,OpenCost>();positionsUpdated=0;private busy=false;private again=false;
  // Fill warnings never change once computed; recomputing ~400 of them every sync stalled the engine loop ~300 ms.
  private warnings=new Map<string,string[]>();
  constructor(private client:KalshiClient,private journal:Journal){}
  /** A fill: refresh positions at once (one request), then the full sync. */
  async onFill(){
    if(this.client.authenticated){try{this.positions=await this.client.pages('/portfolio/positions','market_positions');this.positionsUpdated=Date.now();}catch(e){this.journal.log('account-error',{message:(e as Error).message});}}
    await this.sync();
  }
  async sync(){
    if(!this.client.authenticated)return;
    // A sync requested while one runs (e.g. a fill mid-sync) is queued, not dropped: dropping it left the positions
    // box up to 30 s stale (p90 17 s, max 317 s over 53 orders on 2026-10-07).
    if(this.busy){this.again=true;return;}this.busy=true;
    try{
      const b=await this.client.get('/portfolio/balance',true);this.balance=Number(b.balance)/100;this.portfolioValue=Number.isFinite(Number(b.portfolio_value))?Number(b.portfolio_value)/100:null;
      if(!Number.isFinite(this.balance)||this.balance<0)throw new Error('Unsupported account balance');
      this.journal.balance(Date.now(),this.balance,this.portfolioValue);
      this.client.limits=(await this.client.get('/account/limits',true));
      this.positions=await this.client.pages('/portfolio/positions','market_positions');this.positionsUpdated=Date.now();
      // Persist every raw record. Refresh live pages; archived fills backfill only on first run.
      const fills=await this.client.pages('/portfolio/fills','fills');
      if(!this.journal.get('historicalBackfill',false)){const old=await this.client.pages('/historical/fills','fills');fills.push(...old);}
      const settlements=await this.client.pages('/portfolio/settlements','settlements');
      const put=this.journal.db.prepare('INSERT OR REPLACE INTO account_raw VALUES(?,?,?,?)');
      this.journal.db.transaction(()=>{for(const f of fills)put.run('fill:'+(f.fill_id??f.trade_id),'fill',Date.parse(f.created_time),JSON.stringify(f));for(const s of settlements)put.run('settlement:'+s.ticker,'settlement',Date.parse(s.settled_time),JSON.stringify(s));})();
      const raw=this.journal.db.prepare('SELECT type,context FROM account_raw ORDER BY time').all() as {type:string;context:string}[];
      const rawFills=raw.filter(r=>r.type==='fill').map(r=>JSON.parse(r.context)),rawSettlements=raw.filter(r=>r.type==='settlement').map(r=>JSON.parse(r.context));
      const events=normalizeAccount(rawFills,rawSettlements);
      // Open-position costs (with actual fees) for every Bitcoin market, hourly included; P&L and guardrails stay 15-minute only.
      const openCosts=new Map<string,OpenCost>();normalizeAccount(rawFills,rawSettlements,['KXBTC15M','KXBTCD'],openCosts);this.openCosts=openCosts;
      const config=this.journal.config();
      // Warnings are stored with each real trade; reuse them after a restart instead of recomputing every past fill
      // (763 fills cost 2–12 s of blocked engine loop on the first sync, 2026-10-11).
      if(!this.warnings.size)for(const e of this.journal.realEvents())if(e.type==='fill'&&e.warnings)this.warnings.set(e.id,e.warnings);
      for(const e of events.filter(e=>e.type==='fill')){
        const cached=this.warnings.get(e.id);if(cached){e.warnings=cached;continue;}
        const signal=this.journal.db.prepare("SELECT json_extract(context,'$.idea.contracts') AS contracts FROM signals WHERE ticker=? AND side=? AND time<=? ORDER BY time DESC LIMIT 1").get(e.ticker,e.side,e.time) as {contracts:number}|undefined;
        const prior=this.journal.db.prepare(`SELECT time,json_extract(context,'$.book.${e.side==='yes'?'yesAsk':'noAsk'}') AS price FROM ticks INDEXED BY sqlite_autoindex_ticks_1 WHERE time BETWEEN ? AND ? AND ticker=? ORDER BY time`).all(e.time-60000,e.time,e.ticker) as {time:number;price:number|null}[];
        const orderCount=events.filter(f=>f.type==='fill'&&f.orderId===e.orderId&&f.time<=e.time).reduce((sum,f)=>sum+f.contracts,0);
        e.warnings=fillWarnings({...e,contracts:orderCount},signal?.contracts??null,prior.filter((p):p is {time:number;price:number}=>Number.isFinite(p.price)),config,events.filter(f=>f.ticker===e.ticker));
        this.warnings.set(e.id,e.warnings);
      }
      this.journal.real(events);this.journal.set('historicalBackfill',true);this.ready=true;this.updated=Date.now();this.error='';
    }catch(e){this.ready=false;this.error=(e as Error).message;this.journal.log('account-error',{message:this.error});}finally{this.busy=false;if(this.again){this.again=false;void this.sync();}}
  }
}
