import {fee,type FeeSchedule} from './model/fees';
/**
 * Paper trading (2026-10-22, user request: "trade on the advisor itself, not with real money"): market orders filled
 * against Kalshi's live order book the way Kalshi would fill them, with the real taker fee, and an account kept from
 * the fills and the journaled results. Pure functions; the journal side is paper.ts.
 *  - A YES buy takes the NO bids (YES price = 1 − NO bid), level by level; a NO buy takes the YES bids. A sale hits
 *    the bids of the side held. Whole contracts only. Visible depth is all there is: a bigger order fills partly.
 *  - One side per round: buying the other side first sells what you hold (Kalshi nets the two the same way).
 */
export type Side='yes'|'no';
export type Level=[number,number];
/** Bids per side, best first, as Orderbook.view() gives them. */
export interface BookSides {yes:Level[];no:Level[]}
export interface Quote {contracts:number;price:number;fee:number;/** buy: dollars paid incl. fee; sell: dollars received after fee */cash:number;levels:number;partial:boolean;/** the last (worst) level reached: the limit for a real order that fills the same way */limit:number}
const other=(s:Side):Side=>s==='yes'?'no':'yes';
/** What a market order gets now. `want.dollars` (buys) spends up to that much including the fee. */
export function quoteOrder(book:BookSides,side:Side,action:'buy'|'sell',want:{contracts?:number;dollars?:number},schedule:FeeSchedule):Quote{
  const levels:Level[]=action==='buy'?book[other(side)].map(([p,q]):Level=>[Math.round((1-p)*10000)/10000,q]):book[side];
  let target=want.contracts!==undefined?Math.floor(want.contracts):Infinity,budget=action==='buy'&&want.dollars!==undefined?want.dollars:Infinity;
  if(!(target>0)&&!(budget>0))return {contracts:0,price:0,fee:0,cash:0,levels:0,partial:false,limit:0};
  let n=0,gross=0,fees=0,used=0,limit=0;
  for(const [p,q] of levels){
    if(n>=target||!(p>0&&p<1))break;
    let take=Math.min(Math.floor(q),target-n);
    if(Number.isFinite(budget)){take=Math.min(take,Math.floor((budget-gross-fees)/p));while(take>0&&gross+fees+take*p+fee(p,take,'taker',schedule)>budget+1e-9)take--;}
    if(take<=0){if(Number.isFinite(budget))break;continue;}
    n+=take;gross+=take*p;fees+=fee(p,take,'taker',schedule);used++;limit=p;
  }
  const price=n?gross/n:0,partial=Number.isFinite(target)?n<target:false;
  return {contracts:n,price,fee:Math.round(fees*1e6)/1e6,cash:Math.round((action==='buy'?gross+fees:gross-fees)*1e6)/1e6,levels:used,partial,limit};
}
export interface SimFill {id?:number;time:number;ticker:string;side:Side;action:'buy'|'sell';contracts:number;price:number;fee:number;context?:any}
export interface SimPosition {ticker:string;side:Side;contracts:number;/** dollars still in the position, fees included */cost:number}
export interface SimRound {ticker:string;fills:SimFill[];side:Side;result:Side|null;/** dollars paid on buys incl. fees */staked:number;fees:number;
  /** settled: proceeds + payout − staked; open: null */pnl:number|null;soldEarly:boolean;flipped:boolean;
  /** what holding every contract bought to settlement would have made (needs the result) */holdPnl:number|null}
export interface Ledger {bankroll:number;cash:number;positions:SimPosition[];rounds:SimRound[];realized:number;fees:number}
/** The account from the bankroll, every fill (time order) and the settled results. */
export function ledger(bankroll:number,fills:SimFill[],results:Map<string,string>):Ledger{
  let cash=bankroll,realized=0,fees=0;const pos=new Map<string,SimPosition>(),byRound=new Map<string,SimFill[]>();
  for(const f of [...fills].sort((a,b)=>a.time-b.time||(a.id??0)-(b.id??0))){
    (byRound.get(f.ticker)??byRound.set(f.ticker,[]).get(f.ticker)!).push(f);fees+=f.fee;
    const p=pos.get(f.ticker);
    if(f.action==='buy'){cash-=f.contracts*f.price+f.fee;if(p&&p.side===f.side){p.contracts+=f.contracts;p.cost+=f.contracts*f.price+f.fee;}else pos.set(f.ticker,{ticker:f.ticker,side:f.side,contracts:f.contracts,cost:f.contracts*f.price+f.fee});}
    else if(p&&p.side===f.side){const n=Math.min(f.contracts,p.contracts),basis=p.cost*n/p.contracts;cash+=n*f.price-f.fee;realized+=n*f.price-f.fee-basis;p.contracts-=n;p.cost-=basis;if(p.contracts<=1e-9)pos.delete(f.ticker);}
  }
  for(const [ticker,p] of pos){const r=results.get(ticker);if(r!=='yes'&&r!=='no')continue;const payout=p.side===r?p.contracts:0;cash+=payout;realized+=payout-p.cost;pos.delete(ticker);}
  const rounds=[...byRound].map(([ticker,fs]):SimRound=>{
    const r=results.get(ticker),result=r==='yes'||r==='no'?r:null,buys=fs.filter(f=>f.action==='buy'),first=buys[0]??fs[0];
    const staked=buys.reduce((s,f)=>s+f.contracts*f.price+f.fee,0),sold=fs.filter(f=>f.action==='sell').reduce((s,f)=>s+f.contracts*f.price-f.fee,0);
    const held=new Map<Side,number>();for(const f of fs)held.set(f.side,(held.get(f.side)??0)+(f.action==='buy'?f.contracts:-f.contracts));
    const payout=result?Math.max(0,held.get(result)??0):0,open=!result&&[...held.values()].some(n=>n>1e-9);
    const holdPnl=result?buys.reduce((s,f)=>s+f.contracts*((f.side===result?1:0)-f.price)-f.fee,0):null;
    return {ticker,fills:fs,side:first.side,result,staked,fees:fs.reduce((s,f)=>s+f.fee,0),pnl:open?null:Math.round((sold+payout-staked)*1e6)/1e6,
      soldEarly:fs.some(f=>f.action==='sell'),flipped:new Set(buys.map(f=>f.side)).size>1,holdPnl:holdPnl===null?null:Math.round(holdPnl*1e6)/1e6};
  });
  return {bankroll,cash:Math.round(cash*1e6)/1e6,positions:[...pos.values()],rounds,realized:Math.round(realized*1e6)/1e6,fees:Math.round(fees*1e6)/1e6};
}
