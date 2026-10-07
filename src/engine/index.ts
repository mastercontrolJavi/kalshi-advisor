import dotenv from 'dotenv';
dotenv.config({path:'.env.local',quiet:true});
import {createServer} from 'node:http';
import {WebSocketServer,WebSocket} from 'ws';
import {Journal} from './journal';
import {ProxyFeed,healthy} from './feeds/proxy';
import {KalshiClient,KalshiFeed,type Market} from './feeds/kalshi';
import {Account} from './account';
import {dayKey,guardrails} from './guardrails';
import {filledSeconds,mean,probability,volatility,warmVolatility} from './model/math';
import {evaluate,size} from './signals';
import {validateConfig} from './config';
import {authorized,requireDashboardCredentials} from './auth';
import {createExecutor} from './executor';
import {buildCalibration} from './calibration';
import {openingCall,OPENING_WINDOW_SECONDS} from './model/opening';
import {exitAdvice} from './exits';
import {nextDirection,confidence,dueHorizon,dataQuality,type Direction} from './model/live';
import {fitStack,predict,explain,describe,type StackFit} from './quant/stack';
import {stackSamples} from './quant/samples';
import {autoBasis,nextWindow} from './quant/forecast';
import {scalp,dips} from './quant/tactics';
import {rollupMarkets,buildAnalytics} from './analytics';
requireDashboardCredentials();createExecutor(process.env.ENABLE_EXECUTOR==='true');
const journal=new Journal();let config=journal.config();
// Quant state: the stacked forecaster and the proxy→BRTI basis are refit from settled windows (see refitQuant).
const basisErrors=()=>(journal.db.prepare('SELECT basis_error FROM outcomes WHERE basis_error IS NOT NULL ORDER BY time').all() as {basis_error:number}[]).map(r=>r.basis_error);
let stack:StackFit=fitStack(stackSamples(journal.db)),basisState=autoBasis(basisErrors());
let calibration=buildCalibration(journal,stack,basisState);
const log=(event:string,data:unknown)=>{journal.log(event,data);console.log(JSON.stringify({time:new Date().toISOString(),event,data}));};
const proxy=new ProxyFeed(log);proxy.history=journal.restoreHistory();
const client=new KalshiClient(),account=new Account(client,journal);
const kalshi=new KalshiFeed(client,log,t=>journal.throughTrade(t),()=>void account.sync());
const known=new Map<string,Market>();let state:any={status:'Starting',config,engineTime:Date.now(),evaluation:{action:'NO TRADE',reason:'Warming feeds',makers:[]}};
const seriesHistory:{time:number;model:number|null;market:number|null;quant:number|null}[]=[];
let live:{ticker:string;direction:Direction|null;since:number;flips:number}={ticker:'',direction:null,since:0,flips:0};
const tacticsHistory:{time:number;yesAsk:number|null;noAsk:number|null;q:number}[]=[];
const exitLatch=new Map<string,string>();
let previousTicker='',lastLoop=Date.now(),lastSecond=0,lastPublish=0,lastFastRefresh=0,settling=false,refreshing=false;
const safe=(name:string,fn:()=>Promise<void>)=>void fn().catch(e=>log(name,{message:e.message}));
async function refresh(){if(refreshing)return;refreshing=true;try{await kalshi.refresh();for(const m of kalshi.markets){known.set(m.ticker,m);journal.set('market:'+m.ticker,m);}await kalshi.fallback();}finally{refreshing=false;}}
async function settlements(){
  if(settling)return;settling=true;
  try{const now=Date.now()+client.clockOffset;
    for(const pending of journal.pendingMarkets()){
      const cached=known.get(pending.ticker)??journal.get<Market|null>('market:'+pending.ticker,null);if(cached&&Date.parse(cached.close_time)>now)continue;
      const {market:m}=await client.get('/markets/'+encodeURIComponent(pending.ticker));known.set(m.ticker,m);
      const close=Date.parse(m.close_time),locked=filledSeconds(proxy.history,close-60000,close);
      if(locked)journal.set('closing-average:'+m.ticker,mean(locked.values));
      // Pending market results may arrive minutes after the close. Keep retrying without a cutoff.
      if(m.result==='yes'||m.result==='no'){
        const px=journal.get<number|null>('closing-average:'+m.ticker,null),actual=m.expiration_value!==''&&m.expiration_value!==undefined&&Number.isFinite(Number(m.expiration_value))?Number(m.expiration_value):null;
        journal.settle(m.ticker,m.result,now,actual,px,Number.isFinite(m.floor_strike)?m.floor_strike:null,m);
      }
    }
  }finally{settling=false;}
}
const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(!authorized(req.headers.authorization)){res.writeHead(401,{'WWW-Authenticate':'Basic realm="Kalshi Advisor"'});res.end('Authentication required');return;}
  const path=new URL(req.url??'/', 'http://127.0.0.1').pathname;
  try{
    if(req.method==='GET'&&path==='/analytics'){
      const fees=new Map((journal.db.prepare("SELECT json_extract(context,'$.ticker') AS ticker,SUM(json_extract(context,'$.fee_cost')) AS fees FROM account_raw WHERE type='fill' GROUP BY 1").all() as {ticker:string;fees:number}[]).map(r=>[r.ticker,r.fees]));
      const signals=journal.db.prepare('SELECT ticker,side,time FROM signals').all() as {ticker:string;side:string;time:number}[];
      const balances=journal.db.prepare('SELECT time,balance,portfolio_value AS portfolio FROM balances ORDER BY time').all() as {time:number;balance:number;portfolio:number|null}[];
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...buildAnalytics(rollupMarkets(journal.realEvents(),fees,signals),balances),account:{balance:account.balance,portfolio:account.portfolioValue,ready:account.ready}}));return;
    }
    if(req.method==='GET'&&path==='/state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(state));return;}
    if(req.method==='GET'&&path.startsWith('/export/')){const table=path.slice(8);const csv=journal.export(table);res.writeHead(200,{'Content-Type':'text/csv','Content-Disposition':`attachment; filename="${table}.csv"`});res.end(csv);return;}
    if(req.method==='POST'&&['/settings','/override'].includes(path)){
      const origin=req.headers.origin,host=req.headers['x-forwarded-host']??req.headers.host;
      if(!origin||new URL(origin).host!==host){res.writeHead(403);res.end('Origin rejected');return;}
      let body='';for await(const chunk of req){body+=chunk;if(body.length>16384)throw new Error('Request too large');}
      const data=JSON.parse(body);
      if(path==='/settings'){config=validateConfig({...config,...data});journal.set('config',config);log('settings-updated',config);}
      else {if(data.confirmation!=='I accept the risk')throw new Error('Type I accept the risk');journal.set('overrideDay',dayKey(Date.now()));log('daily-lock-override',{day:dayKey(Date.now())});}
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,config}));return;
    }
    res.writeHead(404);res.end('Not found');
  }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:(e as Error).message}));}
});
const wss=new WebSocketServer({noServer:true});
server.on('upgrade',(req,socket,head)=>{if(req.url!=='/ws'||!authorized(req.headers.authorization)){socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Kalshi Advisor"\r\n\r\n');socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>{wss.emit('connection',ws,req);ws.send(JSON.stringify(state));});});
server.listen(Number(process.env.ENGINE_PORT??3001),'127.0.0.1',()=>log('engine-listening',{port:Number(process.env.ENGINE_PORT??3001),authenticated:client.authenticated}));
proxy.start();safe('initial-refresh-error',async()=>{await refresh();await account.sync();});
const refreshTimer=setInterval(()=>safe('market-refresh-error',refresh),5000);
const fallbackTimer=setInterval(()=>safe('book-fallback-error',()=>kalshi.fallback()),2000);
const accountTimer=setInterval(()=>safe('account-sync-error',()=>account.sync()),30000);
const settlementTimer=setInterval(()=>safe('settlement-error',settlements),10000);
const pruneTimer=setInterval(()=>journal.prune(),3600000);journal.prune();
// Refit only when new settled windows arrive (leave-one-market-out CV is the costly part).
function refitQuant(){
  const samples=stackSamples(journal.db);basisState=autoBasis(basisErrors());if(samples.length===stack.n)return;
  stack=fitStack(samples);const entry={time:Date.now(),n:stack.n,markets:stack.markets,active:stack.active,cv:stack.cv,weights:describe(stack),basis:basisState.correction};
  log('quant-fit',entry);journal.set('quantHistory',[...journal.get<any[]>('quantHistory',[]),entry].slice(-200));
}
const calibrationTimer=setInterval(()=>{try{refitQuant();calibration=buildCalibration(journal,stack,basisState);}catch(e){log('calibration-error',{message:(e as Error).message});}},30000);
const loop=setInterval(()=>{
  const started=performance.now(),now=Date.now(),time=Math.floor((now+client.clockOffset)/1000)*1000;
  // Only a long gap means sleep/wake; a busy-machine stall of a few seconds leaves sockets intact, and restarting
  // every feed then caused the very outage it meant to repair.
  if(now-lastLoop>15000||now<lastLoop){log('wake-or-clock-jump',{gap:now-lastLoop});proxy.restart();kalshi.recover();client.clockSynced=false;safe('wake-refresh-error',async()=>{await refresh();await account.sync();});}
  else if(now-lastLoop>1500)log('loop-stall',{gap:now-lastLoop});
  // Evaluate and publish 4×/second on live quotes; journal ticks/signals once per second.
  lastLoop=now;if(now-lastPublish<250)return;lastPublish=now;const newSecond=time!==lastSecond;lastSecond=time;
  try{
    if(newSecond)journal.expire(time);
    const spot=proxy.sample(time,config.staleMs),market=kalshi.markets.find(m=>Date.parse(m.open_time)<=time&&Date.parse(m.close_time)>time);
    const events=journal.realEvents(),today=dayKey(now),baselineKey='startBalance:'+today;
    const baseline=journal.get<number|null>(baselineKey,null);
    if(baseline===null&&account.balance!==null){journal.set(baselineKey,account.balance);log('day-baseline',{day:today,balance:account.balance,source:'first observed cash balance; initial partial day'});}
    const override=journal.get<string|null>('overrideDay',null),guards=guardrails(events,journal.get(baselineKey,account.balance??0),config,now,override);
    if(guards.dailyLocked)journal.set('lockedDay',today);
    if(journal.get('lockedDay','')===today&&override!==today){guards.dailyLocked=true;guards.locked=true;guards.reason='Daily loss limit reached';}
    const venueStates=Object.values(proxy.venues).map(v=>({...v,healthy:healthy(v,now,config.staleMs),age:now-v.updated}));
    const rawVol=volatility(proxy.history,config.halfLifeSeconds,config.realizedBlend),vol=warmVolatility(rawVol,journal.get<{sigma:number;time:number}|null>('lastSigma',null),config.minVolSamples,now);
    if(newSecond&&rawVol.count>=config.minVolSamples&&rawVol.sigma>0&&time%60000===0)journal.set('lastSigma',{sigma:rawVol.sigma,time:now});
    const common={engineTime:now,status:market?'Live market':'Awaiting market',config,venues:venueStates,proxy:spot,vol,kalshi:{status:kalshi.status,lag:kalshi.lag,age:now-kalshi.lastMessage,clockOffset:client.clockOffset,clockSynced:client.clockSynced,fees:kalshi.fees,limits:client.limits},account:{balance:account.balance,ready:account.ready,error:account.error,updated:account.updated,positions:account.positions},guards,realWarnings:[...new Map(events.filter(e=>e.warnings?.length).map(e=>[e.orderId??e.id,e])).values()].slice(-5),next:kalshi.markets.find(m=>m.ticker!==market?.ticker),history:seriesHistory};
    if(!market){
      // Between windows: poll every second so the next market and its K are picked up immediately.
      if(now-lastFastRefresh>1000){lastFastRefresh=now;safe('market-refresh-error',refresh);}
      state={...common,market:null,evaluation:{action:'NO TRADE',reason:'No active market',idea:null,makers:[]}};
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
      const stackInputs=model?{modelP:model.p,mid,sigma:vol.sigma,momentum30s:features.momentum30s,momentum120s:features.momentum120s,imbalance:features.imbalance,tradeFlow30s:features.tradeFlow30s,tradeVolume30s:features.tradeVolume30s}:null;
      const q=stackInputs?predict(stack,stackInputs).p:null,pSignal=config.useQuantForSignals&&q!==null?q:model?.p??.5;
      const evaluation=evaluate(pSignal,tau,book,market,account.balance,config,schedule,{feedsHealthy:venueStates.every(v=>v.healthy),healthyFeeds:venueStates.filter(v=>v.healthy).length,totalFeeds:venueStates.length,kConfirmed:confirmed,lock:guards.reason,modelReady:!!model,accountReady:account.ready&&now-account.updated<config.accountStaleMs,now});
      const quality=dataQuality({healthyFeeds:venueStates.filter(v=>v.healthy).length,totalFeeds:venueStates.length,kalshiLive:kalshi.status==='connected',bookLive:bv.valid&&now-bv.updated<=config.bookStaleMs,kConfirmed:confirmed,modelReady:!!model,clockSynced:client.clockSynced});
      const callOf=(p:number,direction:'UP'|'DOWN')=>({direction,p,baseP:model.p,lean:p-model.p,confidence:confidence(p),reasons:explain(stack,stackInputs!),inputs:{...stackInputs,K,kSource:confirmed?'kalshi':'proxy estimate'}});
      // Opening call: frozen at the first evaluation of the window with a model (estimated K allowed, so it is instant).
      if(newSecond&&q!==null&&tau>=(close-open)/1000-OPENING_WINDOW_SECONDS&&!journal.openingCall(market.ticker)){
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
          const h=newSecond&&nextMarket?[60,10].find(h=>tau<=h&&tau>h-10&&!journal.nextHorizons(nextMarket.ticker).has(h)):undefined;
          if(h!==undefined)journal.saveNextCall(nextMarket!.ticker,h,market.ticker,time,tau,nextCall,{...nextCall,inputs:stackInputs});
        }catch(e){log('next-call-error',{message:(e as Error).message});}
      }
      // Tactics: scalp and dip ideas, priced after fees, only on live data and outside locks.
      if(newSecond&&q!==null)tacticsHistory.push({time,yesAsk:bv.yesAsk,noAsk:bv.noAsk,q});while(tacticsHistory.length>120)tacticsHistory.shift();
      const tcfg={scalpMinEdge:config.scalpMinEdge,scalpMinSeconds:config.scalpMinSeconds,scalpMaxSpread:config.scalpMaxSpread,dipMove:config.dipMove,minDepth:config.minDepth,minEdge:config.minEdge};
      const tacticsLive=q!==null&&quality.level!=='unreliable'&&!guards.locked&&market.status==='active'&&bv.valid&&now-bv.updated<=config.bookStaleMs;
      const scalpIdea=tacticsLive?scalp(q!,tau,bv,schedule,tcfg):null,dipState=q!==null?dips(tacticsHistory,time,q,bv,schedule,tcfg,tau):{watch:[],idea:null};
      const tacticIdeas=[scalpIdea,tacticsLive?dipState.idea:null].filter((t):t is NonNullable<typeof scalpIdea>=>!!t).map(t=>({...t,...size(t.side==='yes'?q!:1-q!,t.price,account.balance??0,config,schedule)}));
      const tick={time,ticker:market.ticker,proxy:spot,K,tau,sigma:vol.sigma,p:model?.p??null,q,mid,regime:vol.regime,model,kConfirmed:confirmed,book:{...bv,yes:bv.yes.slice(0,10),no:bv.no.slice(0,10)},features,close,evaluation};
      if(newSecond){journal.tick(tick);for(const idea of [...(evaluation.idea?[evaluation.idea]:[]),...evaluation.makers,...tacticIdeas.map(t=>({...t,queue:0}))])journal.signal(market.ticker,time,idea as any,tick,schedule);
      seriesHistory.push({time,model:model?.p??null,market:mid,quant:q});if(seriesHistory.length>901)seriesHistory.shift();}
      const exits=(account.positions as any[]).filter(pos=>String(pos.ticker).startsWith('KXBTC15M')).map(pos=>{const e=exitAdvice(pos,pos.ticker===market.ticker?q:null,kalshi.books.get(pos.ticker)?.view()??null,schedule,config,(exitLatch.get(pos.ticker)??null) as any);if(e){if(exitLatch.get(pos.ticker)!==e.action)log('exit-advice',{ticker:pos.ticker,action:e.action,side:e.side,contracts:e.contracts,bid:e.bid,winProb:e.winProb,unrealized:e.unrealized,unrealizedPct:e.unrealizedPct});exitLatch.set(pos.ticker,e.action);}else exitLatch.delete(pos.ticker);return e;}).filter(Boolean);
      state={...common,...tick,market,evaluation,exits,liveCall,nextCall,quality,openingCall:journal.openingCall(market.ticker),
        quant:{p:q,model:model?.p??null,mid,active:stack.active,markets:stack.markets,basis,autoBasis:basisState,signalSource:config.useQuantForSignals&&q!==null?'quant':'model'},
        tactics:{live:tacticsLive,ideas:tacticIdeas,dips:dipState.watch},lockedCount:locked?.length??0,lockedImputed:lockedFill?.imputed??0,distance:spot!==null&&K!==null?spot-K:null};
    }
    state.calibration=calibration;state.loopMs=performance.now()-started;const message=JSON.stringify(state);for(const ws of wss.clients)if(ws.readyState===WebSocket.OPEN&&ws.bufferedAmount<1000000)ws.send(message);
  }catch(e){log('loop-error',{message:(e as Error).message});state.evaluation={action:'NO TRADE',reason:'Engine evaluation error — see event journal',idea:null,makers:[]};}
},100);
const shutdown=()=>{for(const t of [loop,refreshTimer,fallbackTimer,accountTimer,settlementTimer,pruneTimer,calibrationTimer])clearInterval(t);proxy.stop();kalshi.stop();for(const c of wss.clients)c.terminate();wss.close();server.close();journal.db.close();process.exit(0);};
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
