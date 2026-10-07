import type {KalshiClient} from './feeds/kalshi';
import type {Journal} from './journal';
import {fillWarnings,type RealEvent} from './guardrails';
/** Settlement endpoint cost basis is authoritative; sell P&L uses FIFO fills when history is complete. */
export function normalizeAccount(fills:any[],settlements:any[]):RealEvent[]{
  const lots=new Map<string,{count:number;cost:number}[]>(),events:RealEvent[]=[];
  for(const f of [...fills].sort((a,b)=>Date.parse(a.created_time)-Date.parse(b.created_time))){
    const ticker=f.ticker??f.market_ticker;if(!ticker?.startsWith('KXBTC15M'))continue;
    const side=f.outcome_side??f.side,action=f.action??(f.book_side===(side==='yes'?'bid':'ask')?'buy':'sell'),count=Number(f.count_fp),price=Number(side==='yes'?f.yes_price_dollars:f.no_price_dollars),fees=Number(f.fee_cost??0),time=f.created_time?Date.parse(f.created_time):f.ts*1000;
    if(![count,price,fees,time].every(Number.isFinite)||!['yes','no'].includes(side)||count<=0)throw new Error('Unsupported fill schema');
    const key=ticker+':'+side,list=lots.get(key)??[];let pnl=0;
    if(action==='buy')list.push({count,cost:price+fees/count});
    else {let remaining=count,cost=0;while(remaining>1e-8&&list.length){const n=Math.min(remaining,list[0].count);cost+=n*list[0].cost;list[0].count-=n;remaining-=n;if(list[0].count<1e-8)list.shift();}if(remaining>1e-8)throw new Error('Sell cost basis unavailable; historical fills needed');pnl=count*price-fees-cost;}
    lots.set(key,list);events.push({id:'fill:'+(f.fill_id??f.trade_id),ticker,type:'fill',time,pnl,contracts:count,side,price,action,orderId:f.order_id});
  }
  for(const s of settlements){if(!s.ticker?.startsWith('KXBTC15M'))continue;
    const revenue=Number(s.revenue)/100,cost=Number(s.yes_total_cost_dollars)+Number(s.no_total_cost_dollars),fees=Number(s.fee_cost??0),time=Date.parse(s.settled_time);
    if(![revenue,cost,fees,time].every(Number.isFinite))throw new Error('Unsupported settlement schema');
    const marketFills=events.filter(e=>e.ticker===s.ticker&&e.type==='fill');
    const matchingFills=fills.filter(f=>(f.ticker??f.market_ticker)===s.ticker);
    const cashFlow=matchingFills.reduce((sum,f)=>{const side=f.outcome_side??f.side,action=f.action??(f.book_side===(side==='yes'?'bid':'ask')?'buy':'sell'),price=Number(side==='yes'?f.yes_price_dollars:f.no_price_dollars);return sum+(action==='buy'?-1:1)*Number(f.count_fp)*price-Number(f.fee_cost??0);},0);
    const outcomePnl=matchingFills.length?revenue+cashFlow:revenue-cost-fees;
    const alreadyRealized=marketFills.reduce((sum,f)=>sum+f.pnl,0);
    events.push({id:'settlement:'+s.ticker,ticker:s.ticker,type:'settlement',time,pnl:outcomePnl-alreadyRealized,outcomePnl,contracts:Number(s.yes_count_fp)+Number(s.no_count_fp)});
  }return events.sort((a,b)=>a.time-b.time);
}
export class Account {
  balance:number|null=null;ready=false;updated=0;error='Credentials unavailable';positions:unknown[]=[];private busy=false;
  constructor(private client:KalshiClient,private journal:Journal){}
  async sync(){
    if(this.busy||!this.client.authenticated)return;this.busy=true;
    try{
      const b=await this.client.get('/portfolio/balance',true);this.balance=Number(b.balance)/100;
      this.client.limits=(await this.client.get('/account/limits',true));
      this.positions=await this.client.pages('/portfolio/positions','market_positions');
      // Persist every raw record. Refresh live pages; archived fills backfill only on first run.
      const fills=await this.client.pages('/portfolio/fills','fills');
      if(!this.journal.get('historicalBackfill',false)){const old=await this.client.pages('/historical/fills','fills');fills.push(...old);}
      const settlements=await this.client.pages('/portfolio/settlements','settlements');
      const put=this.journal.db.prepare('INSERT OR REPLACE INTO account_raw VALUES(?,?,?,?)');
      this.journal.db.transaction(()=>{for(const f of fills)put.run('fill:'+(f.fill_id??f.trade_id),'fill',Date.parse(f.created_time),JSON.stringify(f));for(const s of settlements)put.run('settlement:'+s.ticker,'settlement',Date.parse(s.settled_time),JSON.stringify(s));})();
      const raw=this.journal.db.prepare('SELECT type,context FROM account_raw ORDER BY time').all() as {type:string;context:string}[];
      const events=normalizeAccount(raw.filter(r=>r.type==='fill').map(r=>JSON.parse(r.context)),raw.filter(r=>r.type==='settlement').map(r=>JSON.parse(r.context)));
      for(const e of events.filter(e=>e.type==='fill')){
        const signal=this.journal.db.prepare('SELECT context FROM signals WHERE ticker=? AND side=? AND time<=? ORDER BY time DESC LIMIT 1').get(e.ticker,e.side,e.time) as {context:string}|undefined;
        const prior=this.journal.db.prepare('SELECT time,context FROM ticks WHERE ticker=? AND time BETWEEN ? AND ? ORDER BY time').all(e.ticker,e.time-60000,e.time) as {time:number;context:string}[];
        const orderCount=events.filter(f=>f.type==='fill'&&f.orderId===e.orderId&&f.time<=e.time).reduce((sum,f)=>sum+f.contracts,0);
        e.warnings=fillWarnings({...e,contracts:orderCount},signal?JSON.parse(signal.context).idea.contracts:null,prior.map(r=>({time:r.time,price:JSON.parse(r.context).book?.[e.side==='yes'?'yesAsk':'noAsk']})).filter(p=>Number.isFinite(p.price)),this.journal.config());
      }
      this.journal.real(events);this.journal.set('historicalBackfill',true);this.ready=true;this.updated=Date.now();this.error='';
    }catch(e){this.ready=false;this.error=(e as Error).message;this.journal.log('account-error',{message:this.error});}finally{this.busy=false;}
  }
}
