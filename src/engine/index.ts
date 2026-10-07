import dotenv from 'dotenv';
dotenv.config({path:'.env.local',quiet:true});
import {createServer} from 'node:http';
import {WebSocketServer,WebSocket} from 'ws';
import {Journal} from './journal';
import {ProxyFeed,healthy} from './feeds/proxy';
import {KalshiClient,KalshiFeed,type Market} from './feeds/kalshi';
import {Account} from './account';
import {dayKey,guardrails} from './guardrails';
import {coveredSeconds,mean,probability,volatility} from './model/math';
import {evaluate} from './signals';
import {validateConfig} from './config';
import {authorized,requireDashboardCredentials} from './auth';
import {createExecutor} from './executor';
import {buildCalibration} from './calibration';
requireDashboardCredentials();createExecutor(process.env.ENABLE_EXECUTOR==='true');
const journal=new Journal();let config=journal.config();
let calibration=buildCalibration(journal);
const log=(event:string,data:unknown)=>{journal.log(event,data);console.log(JSON.stringify({time:new Date().toISOString(),event,data}));};
const proxy=new ProxyFeed(log);proxy.history=journal.restoreHistory();
const client=new KalshiClient(),account=new Account(client,journal);
const kalshi=new KalshiFeed(client,log,t=>journal.throughTrade(t),()=>void account.sync());
const known=new Map<string,Market>();let state:any={status:'Starting',config,engineTime:Date.now(),evaluation:{action:'NO TRADE',reason:'Warming feeds',makers:[]}};
const seriesHistory:{time:number;model:number|null;market:number|null}[]=[];
let previousTicker='',lastLoop=Date.now(),lastSecond=0,settling=false,refreshing=false;
const safe=(name:string,fn:()=>Promise<void>)=>void fn().catch(e=>log(name,{message:e.message}));
async function refresh(){if(refreshing)return;refreshing=true;try{await kalshi.refresh();for(const m of kalshi.markets){known.set(m.ticker,m);journal.set('market:'+m.ticker,m);}await kalshi.fallback();}finally{refreshing=false;}}
async function settlements(){
  if(settling)return;settling=true;
  try{const now=Date.now()+client.clockOffset;
    for(const pending of journal.pendingMarkets()){
      const cached=known.get(pending.ticker)??journal.get<Market|null>('market:'+pending.ticker,null);if(cached&&Date.parse(cached.close_time)>now)continue;
      const {market:m}=await client.get('/markets/'+encodeURIComponent(pending.ticker));known.set(m.ticker,m);
      const close=Date.parse(m.close_time),locked=coveredSeconds(proxy.history,close-60000,close);
      if(locked)journal.set('closing-average:'+m.ticker,mean(locked));
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
const calibrationTimer=setInterval(()=>{try{calibration=buildCalibration(journal);}catch(e){log('calibration-error',{message:(e as Error).message});}},30000);
const loop=setInterval(()=>{
  const started=performance.now(),now=Date.now(),time=Math.floor((now+client.clockOffset)/1000)*1000;
  if(now-lastLoop>5000||now<lastLoop){log('wake-or-clock-jump',{gap:now-lastLoop});proxy.restart();kalshi.recover();client.clockSynced=false;safe('wake-refresh-error',async()=>{await refresh();await account.sync();});}
  lastLoop=now;if(time===lastSecond)return;lastSecond=time;
  try{
    journal.expire(time);
    const spot=proxy.sample(time,config.staleMs),market=kalshi.markets.find(m=>Date.parse(m.open_time)<=time&&Date.parse(m.close_time)>time);
    const events=journal.realEvents(),today=dayKey(now),baselineKey='startBalance:'+today;
    const baseline=journal.get<number|null>(baselineKey,null);
    if(baseline===null&&account.balance!==null){journal.set(baselineKey,account.balance);log('day-baseline',{day:today,balance:account.balance,source:'first observed cash balance; initial partial day'});}
    const override=journal.get<string|null>('overrideDay',null),guards=guardrails(events,journal.get(baselineKey,account.balance??0),config,now,override);
    if(guards.dailyLocked)journal.set('lockedDay',today);
    if(journal.get('lockedDay','')===today&&override!==today){guards.dailyLocked=true;guards.locked=true;guards.reason='Daily loss limit reached';}
    const venueStates=Object.values(proxy.venues).map(v=>({...v,healthy:healthy(v,now,config.staleMs),age:now-v.updated}));
    const vol=volatility(proxy.history,config.halfLifeSeconds,config.realizedBlend);
    const common={engineTime:now,status:market?'Live market':'Awaiting market',config,venues:venueStates,proxy:spot,vol,kalshi:{status:kalshi.status,lag:kalshi.lag,age:now-kalshi.lastMessage,clockOffset:client.clockOffset,clockSynced:client.clockSynced,fees:kalshi.fees,limits:client.limits},account:{balance:account.balance,ready:account.ready,error:account.error,updated:account.updated,positions:account.positions},guards,realWarnings:events.filter(e=>e.warnings?.length).slice(-5),next:kalshi.markets.find(m=>m.ticker!==market?.ticker),history:seriesHistory};
    if(!market){state={...common,market:null,evaluation:{action:'NO TRADE',reason:'No active market',idea:null,makers:[]}};}
    else {
      const close=Date.parse(market.close_time),open=Date.parse(market.open_time),tau=(close-time)/1000,book=kalshi.books.get(market.ticker)!;
      if(previousTicker!==market.ticker){seriesHistory.length=0;previousTicker=market.ticker;log('market-open-observed',{ticker:market.ticker,open:market.open_time,close:market.close_time});}
      const confirmed=Number.isFinite(market.floor_strike)&&market.floor_strike!>0,opening=confirmed?null:coveredSeconds(proxy.history,open-60000,open),K=confirmed?market.floor_strike!:opening?mean(opening):null;
      const locked=tau<=60?coveredSeconds(proxy.history,close-60000,time):[];
      let model:any=null;
      if(spot!==null&&K!==null&&locked!==null&&vol.count>=config.minVolSamples&&vol.sigma>0)model=probability(spot,K,vol.sigma,tau,locked,config.basisCorrection);
      const schedule={...kalshi.fees,precision:config.feePrecision};
      const evaluation=evaluate(model?.p??.5,tau,book,market,account.balance,config,schedule,{feedsHealthy:venueStates.every(v=>v.healthy),kConfirmed:confirmed,lock:guards.reason,modelReady:!!model,accountReady:account.ready&&now-account.updated<config.accountStaleMs,now});
      const bv=book.view(),mid=bv.yesBid!==null&&bv.yesAsk!==null?(bv.yesBid+bv.yesAsk)/2:null;
      const momentum=(seconds:number)=>{const prior=proxy.history.find(s=>s.time===time-seconds*1000);return prior&&spot?Math.log(spot/prior.price):null;};
      const y=bv.yes.slice(0,3).reduce((s,[,q])=>s+q,0),n=bv.no.slice(0,3).reduce((s,[,q])=>s+q,0);
      const features={imbalance:y+n?(y-n)/(y+n):null,tradeFlow30s:kalshi.status==='connected'?kalshi.trades.filter(t=>t.ticker===market.ticker&&t.time>time-30000).reduce((s,t)=>s+(t.takerSide==='yes'?t.count:-t.count),0):null,momentum30s:momentum(30),momentum120s:momentum(120),midModelGap:model&&mid!==null?mid-model.p:null};
      const tick={time,ticker:market.ticker,proxy:spot,K,tau,sigma:vol.sigma,p:model?.p??null,mid,regime:vol.regime,model,kConfirmed:confirmed,book:{...bv,yes:bv.yes.slice(0,10),no:bv.no.slice(0,10)},features,close,evaluation};
      journal.tick(tick);for(const idea of [...(evaluation.idea?[evaluation.idea]:[]),...evaluation.makers])journal.signal(market.ticker,time,idea,tick,schedule);
      seriesHistory.push({time,model:model?.p??null,market:mid});if(seriesHistory.length>901)seriesHistory.shift();
      state={...common,...tick,market,evaluation,lockedCount:locked?.length??0,distance:spot!==null&&K!==null?spot-K:null};
    }
    state.calibration=calibration;state.loopMs=performance.now()-started;const message=JSON.stringify(state);for(const ws of wss.clients)if(ws.readyState===WebSocket.OPEN&&ws.bufferedAmount<1000000)ws.send(message);
  }catch(e){log('loop-error',{message:(e as Error).message});state.evaluation={action:'NO TRADE',reason:'Engine evaluation error — see event journal',idea:null,makers:[]};}
},100);
const shutdown=()=>{for(const t of [loop,refreshTimer,fallbackTimer,accountTimer,settlementTimer,pruneTimer,calibrationTimer])clearInterval(t);proxy.stop();kalshi.stop();for(const c of wss.clients)c.terminate();wss.close();server.close();journal.db.close();process.exit(0);};
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
