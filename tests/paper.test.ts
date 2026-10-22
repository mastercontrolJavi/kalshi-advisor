import {it,expect} from 'vitest';
import {quoteOrder,ledger,type SimFill} from '../src/engine/sim';
import {coach,reviewRound} from '../src/engine/coach';
import {PaperDesk,type MarketNow} from '../src/engine/paper';
import {Journal} from '../src/engine/journal';
import {baseFees,fee} from '../src/engine/model/fees';
import type {SetupStats} from '../src/backtest/setups';
// YES bids 69¢ ×100, 68¢ ×200; NO bids 30¢ ×50, 29¢ ×100 → YES ask 70¢ ×50, then 71¢ ×100.
const book={yes:[[.69,100],[.68,200]] as [number,number][],no:[[.30,50],[.29,100]] as [number,number][]};
it('fills a market order level by level at Kalshi prices with the taker fee',()=>{
  const q=quoteOrder(book,'yes','buy',{contracts:80},baseFees);
  expect(q.contracts).toBe(80);expect(q.levels).toBe(2);expect(q.price).toBeCloseTo((50*.7+30*.71)/80,6);
  expect(q.fee).toBeCloseTo(fee(.7,50)+fee(.71,30),6);expect(q.cash).toBeCloseTo(50*.7+30*.71+q.fee,6);
  // A dollar budget includes the fee.
  const d=quoteOrder(book,'yes','buy',{dollars:20},baseFees);expect(d.cash).toBeLessThanOrEqual(20);expect(d.contracts).toBe(27);
  // The book runs out at 150 contracts: a partial fill.
  expect(quoteOrder(book,'yes','buy',{contracts:500},baseFees)).toMatchObject({contracts:150,partial:true});
  const sell=quoteOrder(book,'no','sell',{contracts:60},baseFees);expect(sell.price).toBeCloseTo((50*.3+10*.29)/60,6);expect(sell.cash).toBeCloseTo(50*.3+10*.29-sell.fee,6);
});
const f=(time:number,ticker:string,side:'yes'|'no',action:'buy'|'sell',contracts:number,price:number,context:any={}):SimFill=>({time,ticker,side,action,contracts,price,fee:fee(price,contracts),context});
it('keeps the paper account: buys, sales, flips and settlement',()=>{
  const fills=[f(1,'A','yes','buy',10,.7),f(2,'B','no','buy',10,.4),f(3,'B','no','sell',10,.6),f(4,'C','yes','buy',5,.5),f(5,'C','yes','sell',5,.45,{flip:true}),f(6,'C','no','buy',5,.55,{flip:true})];
  const l=ledger(100,fills,new Map([['A','yes'],['B','yes'],['C','yes']]));
  const cost=(x:SimFill)=>x.contracts*x.price+x.fee,proceeds=(x:SimFill)=>x.contracts*x.price-x.fee;
  expect(l.positions).toEqual([]);
  expect(l.cash).toBeCloseTo(100-cost(fills[0])+10-cost(fills[1])+proceeds(fills[2])-cost(fills[3])+proceeds(fills[4])-cost(fills[5]),6);
  const r=Object.fromEntries(l.rounds.map(x=>[x.ticker,x]));
  expect(r.A.pnl).toBeCloseTo(10-cost(fills[0]),6);expect(r.B.soldEarly).toBe(true);expect(r.B.holdPnl).toBeCloseTo(-cost(fills[1]),6);
  expect(r.C.flipped).toBe(true);expect(r.C.pnl).toBeCloseTo(proceeds(fills[4])-cost(fills[3])-cost(fills[5]),6);
  // Unsettled rounds stay open and keep their position.
  const open=ledger(100,[fills[0]],new Map());expect(open.positions[0]).toMatchObject({ticker:'A',side:'yes',contracts:10});expect(open.rounds[0].pnl).toBeNull();
});
const stats:SetupStats[]=[{window:'10–5',kind:'coinflip',with:{n:8000,mean:-.02,ci:[-.03,-.01],early:-.02,late:-.02,win:.5,paid:.52},against:{n:8000,mean:-.025,ci:[-.035,-.015],early:-.02,late:-.03,win:.48,paid:.5}},
  {window:'10–5',kind:'strong',with:{n:5000,mean:.006,ci:[-.001,.014],early:.005,late:.007,win:.9,paid:.89},against:null}];
const ctx=(kind:string,side:'yes'|'no',q:number,equity=1000)=>({tau:420,q,equity,setup:{kind,side,window:'10–5'}});
it('judges each round on the decision, not the result',()=>{
  const round=(fills:SimFill[],result:'yes'|'no')=>ledger(1000,fills,new Map([[fills[0].ticker,result]])).rounds[0];
  // Strong trend, bought at 88¢ against a 92% forecast, 2% of the bankroll.
  const good=reviewRound(round([f(1,'G','yes','buy',20,.88,ctx('strong','yes',.92))],'yes'),stats);
  expect(good.verdict).toBe('good');expect(good.flags).toEqual([]);expect(good.entry.edge).toBeGreaterThan(0);
  expect(reviewRound(round([f(1,'U','yes','buy',20,.88,ctx('strong','yes',.92))],'no'),stats).verdict).toBe('unlucky');
  // A coin flip bought above the forecast with 42% of the bankroll: a mistake even when it wins.
  const lucky=reviewRound(round([f(1,'L','yes','buy',800,.52,ctx('coinflip','yes',.5))],'yes'),stats);
  expect(lucky.verdict).toBe('lucky');expect(lucky.flags).toEqual(expect.arrayContaining(['selection','price','sizing']));
  expect(lucky.notes.join(' ')).toMatch(/lost −2\.0¢ per contract over 8,000 past rounds/);
});
it('adds up what each habit cost and names the biggest leak',()=>{
  const fills=[f(1,'A','yes','buy',20,.52,ctx('coinflip','yes',.5)),f(2,'B','yes','buy',60,.55,ctx('coinflip','yes',.52)),f(3,'C','yes','buy',20,.88,ctx('strong','yes',.92)),
    f(4,'D','yes','buy',20,.6,ctx('strong','yes',.7)),f(5,'D','yes','sell',20,.4)];
  const l=ledger(1000,fills,new Map([['A','no'],['B','no'],['C','yes'],['D','yes']])),r=coach(l.rounds,stats,1000);
  expect(r.settled).toBe(4);expect(r.causes[0].cause).toBe('selection');expect(r.causes.map(c=>c.cause)).toContain('earlyExit');
  // B staked 3× A's stake right after A lost: a tilt round.
  expect(r.causes.find(c=>c.cause==='tilt')?.rounds).toBe(1);
  expect(r.headline).toMatch(/Biggest leak: trading setups that lose/);expect(r.notWorking.map(g=>g.label)).toContain('Coin flip');expect(r.working.map(g=>g.label)).not.toContain('10–5 min left');
});
it('the paper desk fills on the live book, refuses stale or delayed prices, and settles with the real result',()=>{
  const j=new Journal(':memory:'),desk=new PaperDesk(j),now=Date.now();
  const m=(over:Partial<MarketNow>={}):MarketNow=>({ticker:'KXBTC15M-T',tau:400,active:true,book:{...book,valid:true,updated:now},delayed:false,delayMs:0,schedule:baseFees,bookStaleMs:5000,now,context:{q:.74,setup:{kind:'trend',side:'yes',window:'10–5'}},...over});
  expect(()=>desk.order({side:'yes',action:'buy',contracts:10},m())).toThrow(/Start a paper account/);
  desk.reset(500,now);
  expect(()=>desk.order({side:'yes',action:'buy',contracts:10},m({delayed:true,delayMs:9000}))).toThrow(/9 s behind/);
  expect(()=>desk.order({side:'yes',action:'buy',contracts:10},m({book:{...book,valid:true,updated:now-9000}}))).toThrow(/stale/);
  const v=desk.version,res=desk.order({side:'yes',action:'buy',dollars:50},m());
  // $50 buys 50 at 70¢ and 19 at 71¢: the fee is inside the budget.
  expect(res.fills[0]).toMatchObject({side:'yes',action:'buy',contracts:69});expect(res.message).toMatch(/^Bought 69 YES at 70\.3¢/);expect(desk.version).toBeGreaterThan(v);
  // Buying NO now sells the YES first (a flip), then buys NO with the cash.
  const flip=desk.order({side:'no',action:'buy',contracts:10},m());expect(flip.fills.map(x=>`${x.action} ${x.side}`)).toEqual(['sell yes','buy no']);
  const live=desk.summary(()=>({bid:.29,fair:.26}));expect(live.positions![0]).toMatchObject({side:'no',contracts:10});
  j.settle('KXBTC15M-T','no',now+1e6,null,null,null,{});desk.invalidate();
  const after=desk.summary(()=>({bid:null,fair:null}));expect(after.positions).toEqual([]);expect(after.rounds).toBe(1);
  const rep=desk.report(null);expect(rep.coach!.settled).toBe(1);expect(rep.coach!.reviews[0].flags).toContain('flips');expect(rep.equity.length).toBe(2);
  // A reset keeps the old account and starts clean.
  desk.reset(1000,now+2e6);expect(desk.summary(()=>({bid:null,fair:null}))).toMatchObject({cash:1000,rounds:0});expect(desk.report(null).accounts).toBe(2);
});
