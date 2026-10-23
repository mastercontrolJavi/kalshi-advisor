import dotenv from 'dotenv';
dotenv.config({path:'.env.local',quiet:true});
import {createServer} from 'node:http';
import {Worker} from 'node:worker_threads';
import {readFileSync,statSync} from 'node:fs';
import {WebSocketServer,WebSocket} from 'ws';
import {Journal} from './journal';
import {ProxyFeed,healthy} from './feeds/proxy';
import {KalshiClient,KalshiFeed,type Market} from './feeds/kalshi';
import {delaySide,type DelaySide} from './feeds/orderbook';
import {LoopLag} from './loop-lag';
import {Account} from './account';
import {dayKey,guardrails} from './guardrails';
import {filledSeconds,mean,probability,volatility,warmVolatility} from './model/math';
import {evaluate,size,latchSignal,emptyLatch,type Latch} from './signals';
import {validateConfig} from './config';
import {authorized,requireDashboardCredentials} from './auth';
import {createExecutor} from './executor';
import {buildCalibration} from './calibration';
import {openingCall,OPENING_K_DEADLINE_SECONDS} from './model/opening';
import {exitAdvice,entryCost,type ExitMemory} from './exits';
import {nextDirection,confidence,dueHorizon,dataQuality,type Direction} from './model/live';
import {fitStack,predict,explain,describe,type StackFit,type StackSample} from './quant/stack';
import {stackSamples,lateSamples} from './quant/samples';
import {autoBasis,nextWindow,NEXT_HORIZONS} from './quant/forecast';
import {usableMid} from './quant/quote';
import {PRICE_HORIZONS,PRICE_VERSION,emptyPriceFit,priceInputs,forecastPrice,type PriceFit} from './quant/price-forecast';
import {PriceForecastJournal} from './quant/price-journal';
import {scalp,dips} from './quant/tactics';
import {rollupMarkets,buildAnalytics} from './analytics';
import {HourlyBoard,HOURLY_SERIES,HOURLY_HORIZONS,ladder,impliedAbove,hourlyIdeas} from './hourly';
import {buildHourlyHistory} from './rounds';
import {priorFit} from './quant/stack';
import {VERDICT_PATH,type Verdict} from '../backtest/verdict';
import {gateEvaluation,gateHourly,gateTactics} from './evidence';
import {BacktestRefresher} from './refresh';
import {classifySetup,type MySetups} from '../backtest/setups';
import {mySetups} from './my-setups';
import {SLOW_FIELDS} from './stream';
import {PaperDesk,type MarketNow} from './paper';
import {RealCopy,orderBody,describeFill,newClientOrderId} from './real-copy';
import {Orderbook} from './feeds/orderbook';
import {effectiveFees} from './feeds/kalshi';
import {baseFees} from './model/fees';
requireDashboardCredentials();createExecutor(process.env.ENABLE_EXECUTOR==='true');
const journal=new Journal();let config=journal.config();
const priceJournal=new PriceForecastJournal(journal.db);
// Paper trading on the live round (paper.ts): its own account in the journal, settled by the same results.
const desk=new PaperDesk(journal);
// Real copy orders (real-copy.ts): confirmed quotes only, capped, off until switched on in Settings.
const realCopy=new RealCopy();
{const stored=journal.get<any>('config',null);
  if(stored&&!journal.get('migration:2026-10-07b',false)){
    // Move settings still at their old defaults to the evidence-backed ones (DECISIONS 31); values the user changed are kept.
    const changes:Record<string,unknown>={};if(stored.sweetMaxSeconds===300)changes.sweetMaxSeconds=900;
    config=validateConfig({...config,...changes});journal.set('config',config);journal.set('migration:2026-10-07b',true);
    journal.log('settings-migrated',{changes});
  }
  // Exits: the 2026-10-07 backtest found holding beat both exit plans on the same entries (DECISIONS 38). Only the
  // old default ('risk') moves to 'hold'; a deliberately chosen EV mode is kept.
  if(stored&&!journal.get('migration:2026-10-07c',false)){
    const changes:Record<string,unknown>={};if((journal.get<any>('config',{}).exitMode??'risk')==='risk')changes.exitMode='hold';
    config=validateConfig({...config,...changes});journal.set('config',config);journal.set('migration:2026-10-07c',true);
    journal.log('settings-migrated',{changes});
  }
  // Exits: the user asked (2026-10-10) for clear hold / let it ride / sell / sell now / let it settle calls instead of a
  // steady HOLD. Advise mode gives them on evidence (DECISIONS 50); hold-mode users move to it, risk and EV stay.
  if(stored&&!journal.get('migration:2026-10-10a',false)){
    const changes:Record<string,unknown>={};if((journal.get<any>('config',{}).exitMode??'hold')==='hold')changes.exitMode='advise';
    config=validateConfig({...config,...changes});journal.set('config',config);journal.set('migration:2026-10-10a',true);
    journal.log('settings-migrated',{changes});
  }}
// Quant state: the stacked forecaster and the proxy→BRTI basis are refit from settled windows (calibration-worker.ts).
const basisErrors=()=>(journal.db.prepare('SELECT basis_error FROM outcomes WHERE basis_error IS NOT NULL ORDER BY time').all() as {basis_error:number}[]).map(r=>r.basis_error);
let stack:StackFit=fitStack(stackSamples(journal.db)),basisState=autoBasis(basisErrors());
let calibration=buildCalibration(journal,stack,basisState);
const log=(event:string,data:unknown)=>{journal.log(event,data);console.log(JSON.stringify({time:new Date().toISOString(),event,data}));};
const proxy=new ProxyFeed(log);proxy.history=journal.restoreHistory();const loopLag=new LoopLag();loopLag.start();let lastDelaySide:DelaySide|null=null;
const client=new KalshiClient(),account=new Account(client,journal);
const kalshi=new KalshiFeed(client,log,t=>journal.throughTrade(t),()=>void account.onFill());
const known=new Map<string,Market>();let state:any={status:'Starting',config,engineTime:Date.now(),evaluation:{action:'NO TRADE',reason:'Warming feeds',makers:[]}};
const seriesHistory:{time:number;model:number|null;market:number|null;quant:number|null}[]=[];
let live:{ticker:string;direction:Direction|null;since:number;flips:number}={ticker:'',direction:null,since:0,flips:0};
const tacticsHistory:{time:number;yesAsk:number|null;noAsk:number|null;q:number}[]=[];
const exitMemory=new Map<string,ExitMemory>();
let candleRounds:{at:number;rows:{ticker:string;k:number}[]}|null=null;
// Firm BUY signals (signals.ts latchSignal): per round, reset when the round changes.
let latch:Latch=emptyLatch(),latchTicker='',journaledLatch=0;
// Backtest verdict (written by npm run backtest), reloaded whenever the file changes; shown beside every BUY.
let verdict:Verdict|null=null,verdictMtime=-1;
function loadVerdict(){try{const m=statSync(VERDICT_PATH).mtimeMs;if(m!==verdictMtime){verdict=JSON.parse(readFileSync(VERDICT_PATH,'utf8'));verdictMtime=m;journal.log('backtest-verdict-loaded',{generated:verdict?.generated});}}catch{verdict=null;verdictMtime=-1;}}
loadVerdict();
// Your own record per chart setup (my-setups.ts), shown under the setup's history; rebuilt at most once a minute.
let mine:{at:number;value:MySetups|null}={at:0,value:null};
function mySetupsCached(now:number){if(now-mine.at>=60000){mine.at=now;try{mine.value=mySetups(journal,now);}catch(e){log('my-setups-error',{message:(e as Error).message});}}return mine.value;}
// Daily automatic backtest refresh in a separate low-priority process (see refresh.ts).
const refresher=new BacktestRefresher(log);const refresherTimer=setInterval(()=>refresher.tick(),5*60000);
let settledOnce=false,sentCalibration:number|null=null,shownPositions='';
let previousTicker='',lastLoop=Date.now(),lastSecond=0,lastPublish=0,lastFastRefresh=0,settling=false,refreshing=false;
const safe=(name:string,fn:()=>Promise<void>)=>void fn().catch(e=>log(name,{message:e.message}));
async function refresh(){if(refreshing)return;refreshing=true;try{await kalshi.refresh();for(const m of kalshi.markets){known.set(m.ticker,m);journal.set('market:'+m.ticker,m);}await kalshi.fallback();}finally{refreshing=false;}}
async function settlements(){
  if(settling)return;settling=true;
  try{const now=Date.now()+client.clockOffset;
    // Results normally land minutes after the close; after a restart look back 3 days once, then 3 hours.
    for(const pending of journal.pendingMarkets(Date.now()-(settledOnce?3*3600000:3*86400000))){
      const cached=known.get(pending.ticker)??journal.get<Market|null>('market:'+pending.ticker,null);if(cached&&Date.parse(cached.close_time)>now)continue;
      const {market:m}=await client.get('/markets/'+encodeURIComponent(pending.ticker));known.set(m.ticker,m);
      const close=Date.parse(m.close_time),locked=filledSeconds(proxy.history,close-60000,close);
      if(locked)journal.set('closing-average:'+m.ticker,mean(locked.values));
      // Pending market results may arrive minutes after the close. Keep retrying without a cutoff.
      if(m.result==='yes'||m.result==='no'){
        const px=journal.get<number|null>('closing-average:'+m.ticker,null),actual=m.expiration_value!==''&&m.expiration_value!==undefined&&Number.isFinite(Number(m.expiration_value))?Number(m.expiration_value):null;
        journal.settle(m.ticker,m.result,now,actual,px,Number.isFinite(m.floor_strike)?m.floor_strike:null,m);desk.invalidate();
      }
    }
    settledOnce=true;
  }finally{settling=false;}
}
/** What a copied sharp bet carried into the paper fill (sanitised: it comes from the page). */
function copyContext(c:any):Record<string,unknown>{
  if(!c||typeof c!=='object')return {};const str=(x:unknown,n:number)=>typeof x==='string'?x.slice(0,n):null,num=(x:unknown)=>Number.isFinite(Number(x))?Number(x):null;
  return {copy:{cond:str(c.cond,100),outcome:str(c.outcome,200),title:str(c.title,300),group:str(c.group,30),wallets:num(c.wallets),value:num(c.value),avgEntry:num(c.avgEntry)}};
}
/**
 * The market for a paper order. The current Bitcoin round uses the live book and its delay check; any other Kalshi
 * market (a copied sports, politics or crypto bet) is read now: its order book and its series' fee schedule.
 */
async function paperMarket(ticker?:string,extra:Record<string,unknown>={}):Promise<MarketNow>{
  const m=state.market;
  if(ticker&&ticker!==m?.ticker){
    if(!/^[A-Z0-9][A-Z0-9._-]{2,99}$/.test(ticker))throw new Error('Unknown Kalshi market');
    const now=Date.now(),[{market:mk},ob]=await Promise.all([client.get('/markets/'+encodeURIComponent(ticker)),client.get('/markets/'+encodeURIComponent(ticker)+'/orderbook')]);
    const book=new Orderbook();book.snapshot(ob.orderbook_fp?.yes_dollars??[],ob.orderbook_fp?.no_dollars??[],'rest');const v=book.view();
    let schedule={...baseFees,precision:config.feePrecision};
    try{const {series}=await client.get('/series/'+encodeURIComponent(String(mk.event_ticker).split('-')[0]));schedule={...effectiveFees(series,[],mk.event_ticker,now+client.clockOffset),precision:config.feePrecision};}catch{}
    return {ticker,tau:(Date.parse(mk.close_time)-(now+client.clockOffset))/1000,active:mk.status==='active',book:v,delayed:false,delayMs:0,schedule,bookStaleMs:config.bookStaleMs,now,
      context:{title:[mk.title,mk.yes_sub_title].filter(Boolean).join(' · '),close:Date.parse(mk.close_time),url:`https://kalshi.com/markets/${String(mk.event_ticker).split('-')[0].toLowerCase()}`,
        mid:v.yesBid!==null&&v.yesAsk!==null?(v.yesBid+v.yesAsk)/2:null,spread:v.yesBid!==null&&v.yesAsk!==null?v.yesAsk-v.yesBid:null,feeVerified:schedule.verified,...extra}};
  }
  if(!m)throw new Error('No round is open right now');
  const book=kalshi.books.get(m.ticker)?.view(),now=Date.now();if(!book)throw new Error('No Kalshi book yet');
  const mid=book.yesBid!==null&&book.yesAsk!==null?(book.yesBid+book.yesAsk)/2:null;
  return {ticker:m.ticker,tau:(Date.parse(m.close_time)-(now+client.clockOffset))/1000,active:m.status==='active',book,delayed:kalshi.delay.delayed,delayMs:kalshi.delay.ms,
    schedule:{...kalshi.fees,precision:config.feePrecision},bookStaleMs:config.bookStaleMs,now,
    context:{setup:state.setup??null,q:state.quant?.p??null,model:state.quant?.model??null,mid,spread:book.yesBid!==null&&book.yesAsk!==null?book.yesAsk-book.yesBid:null,dist:state.distance??null,K:state.K??null,proxy:state.proxy??null,...extra}};
}
/**
 * Paper positions outside the current Bitcoin round (copied bets, or a round that closed while the engine was off):
 * marked at Kalshi's live bids and settled on Kalshi's own result, checked every 30 s.
 */
const paperMarks=new Map<string,{yesBid:number|null;noBid:number|null}>();
async function paperSweep(){
  const cur=state.market?.ticker,price=(x:unknown)=>{const n=Number(x);return Number.isFinite(n)&&n>0?n:null;};
  for(const t of desk.openTickers()){if(t===cur)continue;const {market:mk}=await client.get('/markets/'+encodeURIComponent(t));
    if(mk.result==='yes'||mk.result==='no'){desk.setResult(t,mk.result);paperMarks.delete(t);log('paper-settled',{ticker:t,result:mk.result});continue;}
    paperMarks.set(t,{yesBid:price(mk.yes_bid_dollars),noBid:price(mk.no_bid_dollars)});}
}
const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(!authorized(req.headers.authorization,req)){res.writeHead(401,{'WWW-Authenticate':'Basic realm="Kalshi Advisor"'});res.end('Authentication required');return;}
  const path=new URL(req.url??'/', 'http://127.0.0.1').pathname;
  try{
    if(req.method==='GET'&&path==='/analytics'){
      const fees=new Map((journal.db.prepare("SELECT json_extract(context,'$.ticker') AS ticker,SUM(json_extract(context,'$.fee_cost')) AS fees FROM account_raw WHERE type='fill' GROUP BY 1").all() as {ticker:string;fees:number}[]).map(r=>[r.ticker,r.fees]));
      const signals=journal.db.prepare("SELECT ticker,side,time FROM signals WHERE kind IN ('taker','scalp','dip')").all() as {ticker:string;side:string;time:number}[];
      const balances=journal.db.prepare('SELECT time,balance,portfolio_value AS portfolio FROM balances ORDER BY time').all() as {time:number;balance:number;portfolio:number|null}[];
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...buildAnalytics(rollupMarkets(journal.realEvents(),fees,signals),balances),account:{balance:account.balance,portfolio:account.portfolioValue,ready:account.ready}}));return;
    }
    // Price chart: the last 2 h of the 1-s proxy (the model's own spot) and each round's opening price K, for candles.
    // INDEXED BY ticks_time: left to itself SQLite walked ticks_market (every tick ever, 1–12 s) and froze the loop every
    // time a dashboard loaded the chart. On the time index it is ~60 ms; the round list is also cached for 30 s.
    if(req.method==='GET'&&path==='/candles'){
      const since=Date.now()-7200000;if(!candleRounds||Date.now()-candleRounds.at>30000)candleRounds={at:Date.now(),rows:journal.db.prepare('SELECT ticker,MAX(k) AS k FROM ticks INDEXED BY ticks_time WHERE time>=? AND k IS NOT NULL GROUP BY ticker').all(since) as {ticker:string;k:number}[]};
      const rows=candleRounds.rows;
      const rounds=rows.map(r=>{const m=known.get(r.ticker)??journal.get<Market|null>('market:'+r.ticker,null),k=Number(m?.floor_strike);return m?{ticker:r.ticker,open:Date.parse(m.open_time),close:Date.parse(m.close_time),k:Number.isFinite(k)&&k>0?k:r.k}:null;}).filter(Boolean);
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({samples:proxy.history.filter(x=>x.time>=since).map(x=>[x.time,Math.round(x.price*100)/100]),rounds}));return;}
    if(req.method==='GET'&&path==='/state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(state));return;}
    if(req.method==='GET'&&path.startsWith('/export/')){const table=path.slice(8);const csv=journal.export(table);res.writeHead(200,{'Content-Type':'text/csv','Content-Disposition':`attachment; filename="${table}.csv"`});res.end(csv);return;}
    if(req.method==='GET'&&path==='/sim/report'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(desk.report(verdict?.setups)));return;}
    if(req.method==='POST'&&['/settings','/override','/sim/order','/sim/reset','/real/quote','/real/order'].includes(path)){
      const origin=req.headers.origin,host=req.headers['x-forwarded-host']??req.headers.host;
      if(!origin||new URL(origin).host!==host){res.writeHead(403);res.end('Origin rejected');return;}
      let body='';for await(const chunk of req){body+=chunk;if(body.length>16384)throw new Error('Request too large');}
      const data=JSON.parse(body);
      if(path==='/real/quote'){const lock=state.guards?.locked?String(state.guards.reason??'guardrail lock'):null;
        const q=realCopy.quote(await paperMarket(typeof data.ticker==='string'?data.ticker:undefined,copyContext(data.copy)),data.side,data.dollars===undefined?undefined:Number(data.dollars),
          {enabled:config.realCopyEnabled,cap:config.realCopyMaxDollars,balance:account.balance,lock,now:Date.now()});
        const {context:_c,...quote}=q;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,quote,balance:account.balance}));return;}
      if(path==='/real/order'){const q=realCopy.take(data.token,Date.now());
        // Checked again at the moment of sending: the switch or a lock may have changed during the 30 s.
        if(!config.realCopyEnabled)throw new Error('Real copy orders were switched off');if(state.guards?.locked)throw new Error(`Real orders are paused: ${state.guards.reason??'guardrail lock'}`);
        const body=orderBody(q,newClientOrderId());log('real-order-sent',{...body,cost:q.cost,cap:q.cap,copy:q.context.copy??null});
        let r:any;try{r=await client.post('/portfolio/events/orders',body);}catch(e){log('real-order-error',{client_order_id:body.client_order_id,message:(e as Error).message});throw e;}
        const result=describeFill(q,r);log('real-order-result',{client_order_id:body.client_order_id,order_id:r.order_id,fill_count:r.fill_count,remaining_count:r.remaining_count,average_fill_price:r.average_fill_price,average_fee_paid:r.average_fee_paid});
        void account.onFill();res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,order_id:r.order_id,...result}));return;}
      if(path==='/sim/reset'){const account=desk.reset(Number(data.bankroll));log('paper-account',account);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,account}));return;}
      if(path==='/sim/order'){const result=desk.order({side:data.side,action:data.action,contracts:data.contracts===undefined?undefined:Number(data.contracts),dollars:data.dollars===undefined?undefined:Number(data.dollars)},await paperMarket(typeof data.ticker==='string'?data.ticker:undefined,copyContext(data.copy)));
        log('paper-order',{message:result.message,fills:result.fills.map(f=>({ticker:f.ticker,side:f.side,action:f.action,contracts:f.contracts,price:f.price}))});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,...result}));return;}
      if(path==='/settings'){config=validateConfig({...config,...data});journal.set('config',config);log('settings-updated',config);}
      else {if(data.confirmation!=='I accept the risk')throw new Error('Type I accept the risk');journal.set('overrideDay',dayKey(Date.now()));log('daily-lock-override',{day:dayKey(Date.now())});}
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,config}));return;
    }
    res.writeHead(404);res.end('Not found');
  }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:(e as Error).message}));}
});
const wss=new WebSocketServer({noServer:true});
server.on('upgrade',(req,socket,head)=>{if(req.url!=='/ws'||!authorized(req.headers.authorization,req)){socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Kalshi Advisor"\r\n\r\n');socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>{wss.emit('connection',ws,req);ws.send(JSON.stringify(state));});});
server.listen(Number(process.env.ENGINE_PORT??3001),'127.0.0.1',()=>log('engine-listening',{port:Number(process.env.ENGINE_PORT??3001),authenticated:client.authenticated}));
proxy.start();safe('initial-refresh-error',async()=>{await refresh();await account.sync();});
const refreshTimer=setInterval(()=>safe('market-refresh-error',refresh),5000);
const fallbackTimer=setInterval(()=>safe('book-fallback-error',()=>kalshi.fallback()),2000);
const accountTimer=setInterval(()=>safe('account-sync-error',()=>account.sync()),30000);
const settlementTimer=setInterval(()=>safe('settlement-error',settlements),10000);
const hourlyTimer=setInterval(()=>safe('hourly-refresh-error',()=>hourlyBoard.refresh(Date.now()+client.clockOffset)),3000);
const hourlySettleTimer=setInterval(()=>safe('hourly-settle-error',settleHours),30000);
const pruneTimer=setInterval(()=>journal.prune(),3600000);journal.prune();
const paperTimer=setInterval(()=>safe('paper-sweep-error',paperSweep),30000);
// Hourly Bitcoin (KXBTCD): one REST read of every strike every 3 s, priced with the same settlement-average model.
const hourlyBoard=new HourlyBoard(client),hourlyMemory=new Map<string,ExitMemory>();
let hourlyState:any=null,hourlyHistory=buildHourlyHistory(journal.db);
function computeHourly(time:number,now:number,spot:number|null,vol:any,venueStates:any[],guards:any){
  const {current,next}=hourlyBoard.events(time);
  const base={updated:hourlyBoard.updated,error:hourlyBoard.error,series:HOURLY_SERIES,next:next?{event:next.event,open:next.open,close:next.close}:hourlyBoard.upcoming,history:hourlyHistory,calibration:{hourly:calibration?.hourly??null}};
  if(!current)return {...base,event:null};
  const tau=(current.close-time)/1000,basis=config.basisCorrection+(config.autoBasis?basisState.correction:0),schedule={...kalshi.fees,precision:config.feePrecision};
  // "Up this hour" reference: the proxy average of the 60 s before the hour opened (plus the learned basis).
  const kFill=filledSeconds(proxy.history,current.open-60000,current.open),kHour=kFill?mean(kFill.values)+basis:null;
  const lockedFill=tau<=60?filledSeconds(proxy.history,current.close-60000,time):{values:[],imputed:0},locked=lockedFill?.values??null;
  const modelReady=spot!==null&&vol.count>=config.minVolSamples&&vol.sigma>0&&locked!==null;
  const inputs={spot,sigma:vol.sigma,tau,locked,basis,kHour,modelReady};
  const rungs=ladder(current.markets,inputs,schedule);
  const upModel=modelReady&&kHour!==null?probability(spot!,kHour,vol.sigma,tau,locked!,basis).p:null,kalshiUp=kHour!==null?impliedAbove(rungs,kHour):null;
  const upQuant=upModel!==null?predict(priorFit(),{modelP:upModel,mid:kalshiUp,sigma:vol.sigma,momentum30s:null,momentum120s:null,imbalance:null,tradeFlow30s:null}).p:null;
  const feedsOk=venueStates.every((v:any)=>v.healthy),accountOk=account.ready&&now-account.updated<config.accountStaleMs;
  const blocked=guards.reason??(!modelReady?'Model warming':!feedsOk?'One or more price feeds stale':!accountOk?'Authenticated balance/history unavailable':now-hourlyBoard.updated>15000?'Hourly prices stale':null);
  const {ideas:allIdeas,reason}=hourlyIdeas(rungs,tau,account.balance,config,schedule,blocked);
  // Paper-trade every best idea, but show (and sound) only a proven rule (evidence.ts).
  const {ideas,hidden}=gateHourly(allIdeas,verdict,config.provenSignalsOnly);
  if(upQuant!==null&&kHour!==null&&rungs.length){
    const h=HOURLY_HORIZONS.find(h=>tau<=h&&tau>h-30&&!journal.hourlyHorizons(current.event).has(h));
    if(h!==undefined){const atm=rungs.reduce((b,r)=>Math.abs(r.strike-kHour)<Math.abs(b.strike-kHour)?r:b,rungs[0]);
      journal.saveHourlyCall(current.event,h,time,tau,kHour,{direction:upQuant>=.5?'UP':'DOWN',p:upQuant,baseP:upModel!,kalshi:kalshiUp},{ticker:atm.ticker,close:current.close,spot,sigma:vol.sigma});}
  }
  // Paper-trade the best hourly idea (the signals table dedupes by ticker/side/price).
  const best=ideas[0],paperBest=allIdeas[0];
  if(paperBest)journal.signal(paperBest.ticker,time,{side:paperBest.side,kind:'hourly',price:paperBest.price,fee:paperBest.fee,edge:paperBest.edge,contracts:paperBest.contracts,cost:paperBest.cost,maxLoss:paperBest.maxLoss,queue:0,reason:paperBest.reason} as any,{p:paperBest.fair,tau,regime:vol.regime,close:current.close},schedule);
  // Exit plans for hourly positions in this event, priced per strike.
  const held=(account.positions as any[]).filter(p=>String(p.ticker).startsWith(current.event+'-'));
  const heldRungs=new Map(ladder(current.markets.filter(m=>held.some(p=>p.ticker===m.ticker)),inputs,schedule,Infinity).map(r=>[r.ticker,r]));
  const exits=held.map(pos=>{const r=heldRungs.get(pos.ticker),key=`${pos.ticker}:${pos.position_fp}:${pos.market_exposure_dollars}`,mem=hourlyMemory.get(key)??{action:null,peak:null};
    const e=exitAdvice(pos,r?.quant??null,r?{yesBid:r.yesBid,noBid:r.noBid}:null,schedule,config,mem,null,entryCost(pos,account.openCosts.get(pos.ticker),schedule),tau);if(e){if(mem.action!==e.action)log('exit-advice',{ticker:pos.ticker,action:e.action,hourly:true,bid:e.bid,winProb:e.winProb,unrealized:e.unrealized});if(e.notice&&e.notice.kind!==mem.notice)log('exit-notice',{ticker:pos.ticker,kind:e.notice.kind,hourly:true,unrealized:e.unrealized});hourlyMemory.set(key,{action:e.action,peak:e.peakPct,trough:e.troughPct??null,entryProb:e.entryWinProb??mem.entryProb??null,notice:e.notice?.kind??null});}
    return e?{...e,strike:r?.strike??null}:null;}).filter(Boolean);
  return {...base,event:current.event,open:current.open,close:current.close,tau,spot,kHour,kSource:kFill?'proxy average of the 60 s before the hour opened':null,lockedCount:locked?.length??0,
    up:upQuant===null?null:{model:upModel,kalshi:kalshiUp,quant:upQuant,direction:upQuant>=.5?'UP':'DOWN',confidence:confidence(upQuant)},
    rungs,ideas,hidden,reason:best?best.reason:hidden&&paperBest?'No proven edge — the hourly BUY idea is hidden.':reason,action:best?`BUY ${best.side==='yes'?'ABOVE':'NOT ABOVE'} $${Math.round(best.strike).toLocaleString()}`:'NO TRADE',exits};
}
async function settleHours(){
  const now=Date.now()+client.clockOffset;
  for(const p of journal.pendingHours(now-5000)){const {market:m}=await client.get('/markets/'+encodeURIComponent(p.ticker));const v=Number(m.expiration_value);
    if((m.result==='yes'||m.result==='no')&&m.expiration_value!==''&&Number.isFinite(v)){journal.settleHourly(p.event,now,v,p.k_hour,{ticker:p.ticker,result:m.result});log('hourly-settled',{event:p.event,settle:v,kHour:p.k_hour,up:p.k_hour==null?null:v>=p.k_hour});}}
  for(const t of journal.unsettledPaper('hourly',now-5000)){const {market:m}=await client.get('/markets/'+encodeURIComponent(t));if(m.result==='yes'||m.result==='no')journal.settlePaper(t,m.result,now);}
  hourlyHistory=buildHourlyHistory(journal.db);
}

// Late-round forecast (final minute): fitted on the kept final-minute seconds and used only once its learned weights beat
// the default blend on rounds held out of the fit; until then the main forecast applies there too. Fitted once at startup
// (before the loop runs); after that refits and the calibration report run on a worker thread (calibration-worker.ts):
// on this thread they froze the 4 Hz loop for 2–7 s several times a round and the dashboard went stale (2026-10-11).
let lateStack:StackFit=fitStack(lateSamples(journal.db,new Map<string,StackSample[]>()));
const calWorker=new Worker(new URL('./calibration-worker.ts',import.meta.url),{workerData:{path:process.env.ADVISOR_DB??'./data/advisor.db'}});
let calBusy=false;
calWorker.on('message',(m:any)=>{calBusy=false;for(const [e,d] of m.logs??[])log(e,d);if(m.error){log('calibration-error',{message:m.error});return;}
  if(m.stack)stack=m.stack;if(m.lateStack)lateStack=m.lateStack;if(m.basis)basisState=m.basis;if(m.calibration)calibration=m.calibration;});
calWorker.on('error',e=>{calBusy=false;log('calibration-worker-error',{message:e.message});});
const calibrationTimer=setInterval(()=>{loadVerdict();if(!calBusy){calBusy=true;calWorker.postMessage('tick');}},30000);
let priceFits:PriceFit[]=PRICE_HORIZONS.map(h=>emptyPriceFit(h)),priceScores:ReturnType<PriceForecastJournal['scores']>={},priceState:any=null;
const savedPriceFits=journal.get<PriceFit[]>('shortTermFit:v1',[]);
for(const saved of savedPriceFits)if(saved.version===PRICE_VERSION&&PRICE_HORIZONS.includes(saved.horizon as 30|60|180)&&saved.weights?.length===8&&saved.weights.every(Number.isFinite)&&Number.isFinite(saved.noise))priceFits=priceFits.map(f=>f.horizon===saved.horizon?saved:f);
let priceWorker:Worker|null=null,priceBusy=false,priceRequested=0;
function refreshPriceFit(){
  if(priceBusy&&Date.now()-priceRequested<60000)return;
  if(priceBusy){void priceWorker?.terminate();priceWorker=null;priceBusy=false;}
  if(!priceWorker){const worker=new Worker(new URL('./quant/price-worker.ts',import.meta.url),{workerData:{path:process.env.ADVISOR_DB??'./data/advisor.db'}});priceWorker=worker;
    worker.on('message',(m:any)=>{if(priceWorker!==worker)return;priceBusy=false;if(m.error){log('price-forecast-error',{message:m.error});return;}if(m.fits){priceFits=m.fits;journal.set('shortTermFit:v1',priceFits);log('price-forecast-fit',{horizons:priceFits.map(f=>({horizon:f.horizon,active:f.active,n:f.n,validation:f.validation.n,brier:f.validation.brier}))});}if(m.scores)priceScores=m.scores;});
    worker.on('error',e=>{if(priceWorker===worker){priceBusy=false;priceWorker=null;}log('price-worker-error',{message:e.message});});
    worker.on('exit',()=>{if(priceWorker===worker){priceWorker=null;priceBusy=false;}});
  }
  priceBusy=true;priceRequested=Date.now();priceWorker.postMessage('tick');
}
refreshPriceFit();const priceTimer=setInterval(refreshPriceFit,30000);
const loop=setInterval(()=>{
  const started=performance.now(),now=Date.now(),time=Math.floor((now+client.clockOffset)/1000)*1000;
  // Only a long gap means sleep/wake; a busy-machine stall of a few seconds leaves sockets intact, and restarting
  // every feed then caused the very outage it meant to repair.
  if(now-lastLoop>15000||now<lastLoop){log('wake-or-clock-jump',{gap:now-lastLoop});proxy.restart();kalshi.recover();client.clockSynced=false;safe('wake-refresh-error',async()=>{await refresh();await account.sync();});}
  else if(now-lastLoop>1500)log('loop-stall',{gap:now-lastLoop});
  // Evaluate and publish 4×/second on live quotes; journal ticks/signals once per second.
  lastLoop=now;if(now-lastPublish<250)return;lastPublish=now;const newSecond=time!==lastSecond;lastSecond=time;
  try{
    if(newSecond){journal.expire(time);loopLag.sample(now);}
    // Which side a Kalshi delay comes from: this computer (loop stalls), the connection (exchange feeds late too) or Kalshi.
    const exchanges=proxy.delay(now),side=delaySide(kalshi.delay.ms,exchanges.median,loopLag.ms);
    const feedCheck={side,exchangeDelay:exchanges.median===null?null:Math.round(exchanges.median),coinbaseDelay:exchanges.coinbase===null?null:Math.round(exchanges.coinbase),loopLag:Math.round(loopLag.ms)};
    if(newSecond&&side!==lastDelaySide){log('feed-delay',{...feedCheck,kalshiDelay:Math.round(kalshi.delay.ms),venues:exchanges.each.map(v=>({name:v.name,ms:Math.round(v.ms)}))});lastDelaySide=side;}
    const spot=proxy.sample(time,config.staleMs),market=kalshi.markets.find(m=>Date.parse(m.open_time)<=time&&Date.parse(m.close_time)>time);
    const events=journal.realEvents(),today=dayKey(now),baselineKey='startBalance:'+today;
    const baseline=journal.get<number|null>(baselineKey,null);
    // Baseline = account value (cash + open positions). Cash alone made the 2026-10-07 baseline $5.18 while money sat
    // in positions, so the 10% daily limit was $0.52 and locked on the first small loss.
    const accountValue=account.balance!==null?account.balance+(account.portfolioValue??0):null;
    if(baseline===null&&accountValue!==null){journal.set(baselineKey,accountValue);log('day-baseline',{day:today,balance:accountValue,cash:account.balance,source:'first observed account value (cash + positions)'});}
    const override=journal.get<string|null>('overrideDay',null),guards=guardrails(events,journal.get(baselineKey,accountValue??0),config,now,override);
    if(guards.dailyLocked)journal.set('lockedDay',today);
    if(journal.get('lockedDay','')===today&&override!==today){guards.dailyLocked=true;guards.locked=true;guards.reason='Daily loss limit reached';}
    const venueStates=Object.values(proxy.venues).map(v=>({...v,healthy:healthy(v,now,config.staleMs),age:now-v.updated}));
    if(newSecond){const healthyPrice=venueStates.filter(v=>v.healthy).length>=3;priceJournal.settle(proxy.history,time,healthyPrice);
      const inputs=healthyPrice?priceInputs(proxy.history.slice(-301),time):null;if(inputs)priceJournal.capture(time,inputs,priceFits);
      priceState={time,ready:!!inputs,reason:!healthyPrice?'Needs at least 3 healthy price feeds':!inputs?'Needs 5 uninterrupted minutes of prices':null,horizons:inputs?priceFits.map(f=>forecastPrice(inputs,f,time)):[],scores:priceScores,fitting:priceBusy};}
    const rawVol=volatility(proxy.history,config.halfLifeSeconds,config.realizedBlend),vol=warmVolatility(rawVol,journal.get<{sigma:number;time:number}|null>('lastSigma',null),config.minVolSamples,now);
    if(newSecond&&rawVol.count>=config.minVolSamples&&rawVol.sigma>0&&time%60000===0)journal.set('lastSigma',{sigma:rawVol.sigma,time:now});
    const common={engineTime:now,status:market?'Live market':'Awaiting market',config,venues:venueStates,proxy:spot,vol,kalshi:{status:kalshi.status,lag:kalshi.lag,delay:Math.round(kalshi.delay.ms),delayed:kalshi.delay.delayed,...feedCheck,age:now-kalshi.lastMessage,clockOffset:client.clockOffset,clockSynced:client.clockSynced,fees:kalshi.fees,limits:client.limits},account:{balance:account.balance,ready:account.ready,error:account.error,updated:account.updated,positionsUpdated:account.positionsUpdated,positions:account.positions},guards,realWarnings:[...new Map(events.filter(e=>e.warnings?.length).map(e=>[e.orderId??e.id,e])).values()].slice(-5),backtest:verdict,backtestRefresh:{running:refresher.running,lastFinished:refresher.lastFinished,lastExit:refresher.lastExit},next:kalshi.markets.find(m=>m.ticker!==market?.ticker),history:seriesHistory,mySetups:mySetupsCached(now)};
    if(!market){
      // Between windows: poll every second so the next market and its K are picked up immediately.
      if(now-lastFastRefresh>1000){lastFastRefresh=now;safe('market-refresh-error',refresh);}
      const upcoming=kalshi.markets.find(m=>Date.parse(m.open_time)>time);
      state={...common,market:null,nextOpen:upcoming?Date.parse(upcoming.open_time):null,evaluation:{action:'NO TRADE',reason:upcoming?'No round is open right now':'No active market',idea:null,makers:[]}};
    }
    else {
      const close=Date.parse(market.close_time),open=Date.parse(market.open_time),tau=(close-time)/1000,book=kalshi.books.get(market.ticker)!;
      if(previousTicker!==market.ticker){seriesHistory.length=0;tacticsHistory.length=0;previousTicker=market.ticker;log('market-open-observed',{ticker:market.ticker,open:market.open_time,close:market.close_time});}
      const confirmed=Number.isFinite(market.floor_strike)&&market.floor_strike!>0;
      // Kalshi publishes floor_strike shortly after the open; poll every second until it lands.
      if(!confirmed&&now-lastFastRefresh>1000){lastFastRefresh=now;safe('market-refresh-error',refresh);}
      const basis=config.basisCorrection+(config.autoBasis?basisState.correction:0);
      // Until Kalshi's K arrives, estimate it from the same 60 s of prices Kalshi averages (plus the learned basis).
      const openingFill=confirmed?null:filledSeconds(proxy.history,open-60000,open),K=confirmed?market.floor_strike!:openingFill?mean(openingFill.values)+basis:null;
      const lockedFill=tau<=60?filledSeconds(proxy.history,close-60000,time):{values:[],imputed:0},locked=lockedFill?.values??null;
      let model:any=null;
      if(spot!==null&&K!==null&&locked!==null&&vol.count>=config.minVolSamples&&vol.sigma>0)model=probability(spot,K,vol.sigma,tau,locked,basis);
      const schedule={...kalshi.fees,precision:config.feePrecision};
      const bv=book.view(),mid=bv.yesBid!==null&&bv.yesAsk!==null?(bv.yesBid+bv.yesAsk)/2:null;
      const momentum=(seconds:number)=>{const prior=proxy.history.find(s=>s.time===time-seconds*1000);return prior&&spot?Math.log(spot/prior.price):null;};
      const y=bv.yes.slice(0,3).reduce((s,[,q])=>s+q,0),n=bv.no.slice(0,3).reduce((s,[,q])=>s+q,0);
      const recentTrades=kalshi.trades.filter(t=>t.ticker===market.ticker&&t.time>time-30000);
      const features={imbalance:y+n?(y-n)/(y+n):null,tradeVolume30s:kalshi.status==='connected'?recentTrades.reduce((s,t)=>s+t.count,0):null,tradeFlow30s:kalshi.status==='connected'?recentTrades.reduce((s,t)=>s+(t.takerSide==='yes'?t.count:-t.count),0):null,momentum30s:momentum(30),momentum120s:momentum(120),midModelGap:model&&mid!==null?mid-model.p:null};
      // Quant forecast: stacked blend of the diffusion model, Kalshi and features (see quant/stack.ts).
      // Kalshi's midpoint only counts as a forecast when the book is tight; a wide spread makes it meaningless.
      // A delayed book (FeedDelay: still updating but seconds behind Kalshi) is not a forecast: the 2026-10-21 loss round
      // showed YES at 11¢ while Kalshi traded at 90¢, and the 90% Kalshi weight pinned the quant to it.
      const delayMs=kalshi.delay.ms,delayed=kalshi.delay.delayed,kalshiP=delayed?null:usableMid(bv,now,config.bookStaleMs);
      const stackInputs=model?{modelP:model.p,mid:kalshiP,sigma:vol.sigma,momentum30s:features.momentum30s,momentum120s:features.momentum120s,imbalance:features.imbalance,tradeFlow30s:features.tradeFlow30s,tradeVolume30s:features.tradeVolume30s}:null;
      const forecast=tau<60&&lateStack.active==='fitted'?lateStack:stack;
      const q=stackInputs?predict(forecast,stackInputs).p:null,pSignal=config.useQuantForSignals&&q!==null?q:model?.p??.5;
      const rawEvaluation=evaluate(pSignal,tau,book,market,account.balance,config,schedule,{feedsHealthy:venueStates.every(v=>v.healthy),healthyFeeds:venueStates.filter(v=>v.healthy).length,totalFeeds:venueStates.length,kConfirmed:confirmed,lock:guards.reason,modelReady:!!model,bookDelayMs:delayMs,accountReady:account.ready&&now-account.updated<config.accountStaleMs,now});
      // Hard gates end a shown BUY at once; spread and depth blips do not (they are what made signals flash).
      if(latchTicker!==market.ticker){latch=emptyLatch(latch.id);latchTicker=market.ticker;}
      const hardGate=rawEvaluation.gates?.find(g=>!g.ok&&['market','feeds','book','k','model','account','guards'].includes(g.key)),closedForEntries=tau<(config.finalMinuteSignals?5:60);
      const firm=latchSignal(latch,rawEvaluation,pSignal,bv,config,schedule,account.balance,now,hardGate?`${hardGate.label}: ${hardGate.detail}`:closedForEntries?'Closed for entries (final minute)':null);
      latch=firm.latch;const evaluation=firm.evaluation;
      const quality=dataQuality({healthyFeeds:venueStates.filter(v=>v.healthy).length,totalFeeds:venueStates.length,kalshiLive:kalshi.status==='connected',bookLive:bv.valid&&now-bv.updated<=config.bookStaleMs,kConfirmed:confirmed,modelReady:!!model,clockSynced:client.clockSynced});
      const callOf=(p:number,direction:'UP'|'DOWN')=>({direction,p,baseP:model.p,lean:p-model.p,confidence:confidence(p),reasons:explain(forecast,stackInputs!),inputs:{...stackInputs,K,kSource:confirmed?'kalshi':'proxy estimate'}});
      // Opening call: frozen at the first evaluation after Kalshi publishes K (floor_strike), usually 5–40 s into the
      // window. User request: the call is made against the official opening price, never an estimate.
      if(newSecond&&q!==null&&confirmed&&tau>=(close-open)/1000-OPENING_K_DEADLINE_SECONDS&&!journal.openingCall(market.ticker)){
        try{const call=callOf(q,q>=.5?'UP':'DOWN');journal.saveOpeningCall(market.ticker,time,tau,call as any,mid);log('opening-call',{ticker:market.ticker,direction:call.direction,p:call.p,tau,kSource:call.inputs.kSource});}
        catch(e){log('opening-call-error',{message:(e as Error).message});}
      }
      // Live call: the quant forecast with direction hysteresis; snapshots scored at fixed horizons.
      if(live.ticker!==market.ticker)live={ticker:market.ticker,direction:null,since:now,flips:0};
      let liveCall:any=null;
      if(q!==null&&quality.level!=='unreliable'){
        const direction=nextDirection(live.direction,q);if(live.direction&&direction!==live.direction){live.flips++;live.since=now;}live.direction=direction;
        liveCall={...callOf(q,direction),since:live.since,flips:live.flips};
        const due=newSecond?dueHorizon(tau,journal.liveHorizons(market.ticker)):null;if(due!==null)journal.saveLiveCall(market.ticker,due,time,tau,liveCall,mid);
      }
      // Next-window preview: the next K is this window's settlement average, so the final minute reveals a head start.
      const nextMarket=kalshi.markets.find(m=>Date.parse(m.open_time)===close);let nextCall:any=null;
      if(stackInputs&&spot!==null&&locked&&quality.level!=='unreliable'){
        try{const nw=nextWindow(spot,vol.sigma,tau,locked,basis),nq=predict(stack,{...stackInputs,modelP:nw.pUp,mid:null}).p;
          nextCall={ticker:nextMarket?.ticker??null,direction:nq>=.5?'UP':'DOWN',p:nq,baseP:nw.pUp,confidence:confidence(nq),headStart:nw.headStart,headStartSd:nw.headStartSd,expectedK:nw.expectedK};
          const h=newSecond&&nextMarket?NEXT_HORIZONS.find(h=>tau<=h&&tau>h-10&&!journal.nextHorizons(nextMarket.ticker).has(h)):undefined;
          if(h!==undefined)journal.saveNextCall(nextMarket!.ticker,h,market.ticker,time,tau,nextCall,{...nextCall,inputs:stackInputs});
        }catch(e){log('next-call-error',{message:(e as Error).message});}
      }
      // Tactics: scalp and dip ideas, priced after fees, only on live data and outside locks.
      if(newSecond&&q!==null)tacticsHistory.push({time,yesAsk:bv.yesAsk,noAsk:bv.noAsk,q});while(tacticsHistory.length>120)tacticsHistory.shift();
      const tcfg={scalpMinEdge:config.scalpMinEdge,scalpMinSeconds:config.scalpMinSeconds,scalpMaxSpread:config.scalpMaxSpread,dipMove:config.dipMove,minDepth:config.minDepth,minEdge:config.minEdge};
      const tacticsLive=q!==null&&quality.level!=='unreliable'&&!guards.locked&&market.status==='active'&&bv.valid&&now-bv.updated<=config.bookStaleMs&&!delayed;
      const scalpIdea=tacticsLive?scalp(q!,tau,bv,schedule,tcfg):null,dipState=q!==null?dips(tacticsHistory,time,q,bv,schedule,tcfg,tau):{watch:[],idea:null};
      const tacticIdeas=[scalpIdea,tacticsLive?dipState.idea:null].filter((t):t is NonNullable<typeof scalpIdea>=>!!t).map(t=>({...t,...size(t.side==='yes'?q!:1-q!,t.price,account.balance??0,config,schedule)}));
      // Chart setup (backtest/setups.ts): coin flip / trend / strong trend / dip, on the basis-corrected price, so the
      // dashboard can show how the same setup paid on past rounds (verdict.setups).
      let prior60:number|null=null;for(let i=proxy.history.length-1;i>=0&&proxy.history[i].time>=time-60000;i--)if(proxy.history[i].time===time-60000){prior60=proxy.history[i].price;break;}
      const setup=spot!==null&&K!==null&&vol.sigma>0?classifySetup({tau,spot:spot+basis,k:K,sigma:vol.sigma,spot60:prior60!==null?prior60+basis:null}):null;
      const tick={time,ticker:market.ticker,proxy:spot,K,tau,sigma:vol.sigma,p:model?.p??null,q,mid,regime:vol.regime,model,kConfirmed:confirmed,setup,kalshiDelay:Math.round(delayMs),coinbaseDelay:feedCheck.coinbaseDelay,exchangeDelay:feedCheck.exchangeDelay,loopLag:feedCheck.loopLag,delaySide:side,book:{...bv,yes:bv.yes.slice(0,10),no:bv.no.slice(0,10)},features,close,evaluation,rawAction:rawEvaluation.action};
      // The taker signal is journaled (and paper-traded) once, at the price shown when it confirmed, not every second it stands.
      const newFirm=evaluation.idea&&evaluation.firm&&evaluation.firm.id!==journaledLatch?[evaluation.idea]:[];
      if(newSecond){journal.tick(tick);if(newFirm.length)journaledLatch=evaluation.firm!.id;for(const idea of [...newFirm,...evaluation.makers,...tacticIdeas.map(t=>({...t,queue:0}))])journal.signal(market.ticker,time,idea as any,tick,schedule);
      seriesHistory.push({time,model:model?.p??null,market:mid,quant:q});if(seriesHistory.length>901)seriesHistory.shift();}
      const exits=(account.positions as any[]).filter(pos=>String(pos.ticker).startsWith('KXBTC15M')).map(pos=>{
        // Memory is keyed by the position itself, so adding to or flipping a position restarts its trailing stop.
        const key=`${pos.ticker}:${pos.position_fp}:${pos.market_exposure_dollars}`,mem=exitMemory.get(key)??{action:null,peak:null};
        // A position in a round that has already closed is settling, not unpriced.
        const posMarket=known.get(pos.ticker)??journal.get<Market|null>('market:'+pos.ticker,null),posClose=posMarket?Date.parse(posMarket.close_time):null;
        let closed:{result:'yes'|'no'|null;estimate:'yes'|'no'|null}|null=null;
        if(posClose!==null&&posClose<=time){const official=journal.db.prepare('SELECT result FROM outcomes WHERE ticker=?').get(pos.ticker) as {result:'yes'|'no'}|undefined;
          const avg=filledSeconds(proxy.history,posClose-60000,posClose),k=Number(posMarket!.floor_strike);
          closed={result:official?.result??null,estimate:avg&&Number.isFinite(k)&&k>0?(mean(avg.values)+basis>=k?'yes':'no'):null};}
        const e=exitAdvice(pos,pos.ticker===market.ticker?q:null,delayed?null:kalshi.books.get(pos.ticker)?.view()??null,schedule,config,mem,closed,entryCost(pos,account.openCosts.get(pos.ticker),schedule),pos.ticker===market.ticker?tau:null);
        if(e){if(mem.action!==e.action)log('exit-advice',{ticker:pos.ticker,action:e.action,side:e.side,contracts:e.contracts,bid:e.bid,winProb:e.winProb,unrealized:e.unrealized,unrealizedPct:e.unrealizedPct,peakPct:e.peakPct});if(e.notice&&e.notice.kind!==mem.notice)log('exit-notice',{ticker:pos.ticker,kind:e.notice.kind,title:e.notice.title,unrealized:e.unrealized,unrealizedPct:e.unrealizedPct,winProb:e.winProb});exitMemory.set(key,{action:e.action,peak:e.peakPct,trough:e.troughPct??null,entryProb:e.entryWinProb??mem.entryProb??null,notice:e.notice?.kind??null});}
        return e;}).filter(Boolean);
      // What Your positions shows, journaled when it changes (with the dashboards connected), so a card that stays empty
      // while the engine holds a position can be traced (user report, 2026-10-21).
      const shownNow=(exits as any[]).map(e=>`${e.ticker}:${Math.round(e.contracts*100)/100}`).join(',');
      if(shownNow!==shownPositions){shownPositions=shownNow;log('positions-shown',{positions:(exits as any[]).map(e=>({ticker:e.ticker,side:e.side,contracts:e.contracts,action:e.action})),dashboards:wss.clients.size,maxBuffered:Math.max(0,...[...wss.clients].map(c=>c.bufferedAmount))});}
      // Evidence gate (evidence.ts, DECISIONS 56): the journal and paper trades above saw every signal; the dashboard
      // and its sounds see only rules that have proven an edge.
      const shown=gateEvaluation(evaluation,verdict,config.useQuantForSignals&&q!==null?'quant':'model',config.provenSignalsOnly);
      const tactics=gateTactics(tacticIdeas,dipState.watch,calibration,config.provenSignalsOnly);
      state={...common,...tick,market,evaluation:shown,exits,liveCall,nextCall,quality,openingCall:journal.openingCall(market.ticker),
        quant:{p:q,model:model?.p??null,mid,active:stack.active,markets:stack.markets,late:{active:lateStack.active,markets:lateStack.markets,inUse:forecast===lateStack,cv:lateStack.cv},basis,autoBasis:basisState,signalSource:config.useQuantForSignals&&q!==null?'quant':'model'},
        tactics:{live:tacticsLive,ideas:tactics.ideas,dips:tactics.watch,hidden:tactics.hidden},lockedCount:locked?.length??0,lockedImputed:lockedFill?.imputed??0,distance:spot!==null&&K!==null?spot-K:null};
    }
    // Hourly board: recomputed once per second, reused between the faster publishes.
    if(newSecond){try{hourlyState=computeHourly(time,now,spot,vol,venueStates,guards);}catch(e){log('hourly-error',{message:(e as Error).message});}}
    state.hourly=hourlyState;
    state.shortTerm=priceState;
    // The paper account marked at the live bids (the hold value uses the quant forecast on the current round).
    state.sim=desk.summary((ticker,side)=>{const live=kalshi.books.get(ticker);
      if(!live){const f=paperMarks.get(ticker);return {bid:f?(side==='yes'?f.yesBid:f.noBid):null,fair:null};}
      const v=kalshi.delay.delayed?null:live.view(),cur=state.market?.ticker===ticker?state.quant?.p:null;
      return {bid:v?(side==='yes'?v.yesBid:v.noBid):null,fair:cur==null?null:side==='yes'?cur:1-cur};});
    // Calibration (~90 KB) goes out only when it changes and the window history (~80 KB) once a second; the page keeps
    // the last copy. New connections get the full state on connect. This cut the 4 Hz push from ~200 KB to ~30 KB.
    state.calibration=calibration;state.loopMs=performance.now()-started;
    const sendCalibration=calibration?.updated!==sentCalibration;sentCalibration=calibration?.updated??null;
    // Slow fields (stream.ts: verdict, setup records, hourly board, settings…) also go once a second only (~240 → ~130 KB/s).
    const slow=newSecond?{}:Object.fromEntries(SLOW_FIELDS.map(k=>[k,undefined]));
    const message=JSON.stringify({...state,...slow,calibration:sendCalibration?calibration:undefined,history:newSecond?state.history:undefined});for(const ws of wss.clients)if(ws.readyState===WebSocket.OPEN&&ws.bufferedAmount<1000000)ws.send(message);
  }catch(e){log('loop-error',{message:(e as Error).message});state.evaluation={action:'NO TRADE',reason:'Engine evaluation error — see event journal',idea:null,makers:[]};}
},100);
const shutdown=()=>{refresher.stop();loopLag.stop();void calWorker.terminate();void priceWorker?.terminate();for(const t of [refresherTimer,loop,refreshTimer,fallbackTimer,accountTimer,settlementTimer,pruneTimer,paperTimer,calibrationTimer,hourlyTimer,hourlySettleTimer,priceTimer])clearInterval(t);proxy.stop();kalshi.stop();for(const c of wss.clients)c.terminate();wss.close();server.close();journal.db.close();process.exit(0);};
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
