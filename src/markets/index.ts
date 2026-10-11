import dotenv from 'dotenv';dotenv.config({path:'.env.local',quiet:true});
import {createServer} from 'node:http';
import Database from 'better-sqlite3';
import {WebSocketServer,WebSocket} from 'ws';
import {KalshiClient} from '../engine/feeds/kalshi';
import {authorized,requireDashboardCredentials} from '../engine/auth';
import {defaults,validateConfig,type Config} from '../engine/config';
import {dayKey} from '../engine/guardrails';
import {MarketsJournal} from './journal';
import {MarketsData} from './kalshi-data';
import {buildPositions,summarize,snapshotRows,sparkKey,sparkCache,type MarketsState} from './state';
import {isBitcoin} from './categories';
import type {MarketMemory} from './holdsell';
import {BackfillRefresher} from './refresh';
import {Scanner,type ScanRow} from './scanner';
import {flagStats,type FlagStats} from './scoring';
import {References,type HeldRef} from './references';
import {GAMMA} from './sources/polymarket';
import {ODDS_HOST} from './sources/odds';
import {buildRecord,compareSources,type RecordState,type SourceComparison} from './record';
import {SharpFeed} from './sharp-feed';
import {falconClient} from './sources/falcon';
import {PM_DATA} from './sources/pmdata';
import {CryptoPricer} from './crypto';
import {eiaPrices,eiaFor,EIA_HOST,type EiaPrice} from './sources/eia';
/**
 * Markets process (127.0.0.1:3002): every open Kalshi position outside the two Bitcoin series, read-only. Runs apart from
 * the Bitcoin engine so its polling can never stall that engine's 4 Hz loop.
 */
requireDashboardCredentials();
const journal=new MarketsJournal(),log=(event:string,data:unknown)=>{journal.log(event,data);console.log(JSON.stringify({time:new Date().toISOString(),event,...(data as object)}));};
// 200 ms between requests: at most 5 a second, leaving most of the account's read allowance to the Bitcoin engine.
const client=new KalshiClient(undefined,undefined,200),data=new MarketsData(client,journal,log);
// Outside references. Each fetcher only ever calls its own fixed host; the Odds API key goes to the Odds API only.
const fetchJson=async(url:string)=>{if(!url.startsWith(GAMMA+'/'))throw new Error('Blocked host');const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(10000),headers:{accept:'application/json'}});if(!r.ok)throw new Error(`Polymarket HTTP ${r.status}`);return r.json();};
const fetchRes=async(url:string)=>{if(!url.startsWith(ODDS_HOST+'/'))throw new Error('Blocked host');const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(10000)});return {status:r.status,body:await r.json().catch(()=>null),headers:r.headers};};
const references=new References(journal,{fetchJson,fetchRes,oddsKey:process.env.ODDS_API_KEY||undefined,log});
// Sharp money: Falcon (key to its host only) ranks traders; Polymarket's public data API gives their positions and trades.
const pmData=async(url:string)=>{if(!url.startsWith(PM_DATA+'/'))throw new Error('Blocked host');const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(10000),headers:{accept:'application/json'}});if(!r.ok)throw new Error(`Polymarket data HTTP ${r.status}`);return r.json();};
// Stage 5: other 15-minute crypto rounds priced by the Bitcoin model (feeds start when you hold one), and EIA context.
const pricer=new CryptoPricer(log);setInterval(()=>safe('crypto-tick-error',()=>pricer.tick(Date.now())),250);
let eia:{at:number;prices:EiaPrice[];error:string|null}={at:0,prices:journal.get<EiaPrice[]>('eia',[]),error:null};
const eiaFetch=async(url:string)=>{if(!url.startsWith(EIA_HOST+'/'))throw new Error('Blocked host');const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000)});return {status:r.status,body:await r.json().catch(()=>null)};};
async function refreshEia(now:number){if(!process.env.EIA_API_KEY||now-eia.at<6*3600000)return;eia.at=now;try{eia={at:now,prices:await eiaPrices(eiaFetch,process.env.EIA_API_KEY),error:null};journal.set('eia',eia.prices);}catch(e){eia.error=(e as Error).message;log('eia-error',{message:eia.error});}}
const sharps=new SharpFeed(journal,{falcon:process.env.FALCON_API_KEY?falconClient(process.env.FALCON_API_KEY):undefined,pmData,gamma:fetchJson,client:new KalshiClient(undefined,undefined,400),log});
/** Held markets and every leg of a held combo, each with its sports-match description (null for non-sports). */
async function refreshReferences(){
  const tickers=new Set<string>();for(const p of data.held()){const t=String(p.ticker);tickers.add(t);for(const l of data.quotes.get(t)?.legs??[])tickers.add(l.marketTicker);}
  const held:HeldRef[]=[];for(const t of tickers){const q=data.quotes.get(t);if(!q||q.legs)continue;held.push({ticker:t,title:q.title,kalshiGame:await data.kalshiGame(q)});}
  await references.refresh(held,Date.now());
}
let memory=new Map<string,MarketMemory>(Object.entries(journal.get<Record<string,MarketMemory>>('memory',{})));
/** Exit settings come from the dashboard's Settings (advisor.db), read-only; defaults if it is unavailable. */
let cfg:Config=defaults;
function loadConfig(){
  try{const db=new Database(process.env.ADVISOR_DB??'./data/advisor.db',{readonly:true,fileMustExist:true});
    try{const row=db.prepare("SELECT value FROM settings WHERE key='config'").get() as {value:string}|undefined;cfg=row?validateConfig(JSON.parse(row.value)):defaults;}finally{db.close();}}
  catch(e){log('config-unavailable',{message:(e as Error).message});}
}
let state:MarketsState={time:Date.now(),status:client.authenticated?'starting':'no-credentials',error:null,positions:[],bitcoin:0,summary:{count:0,atRisk:0,sellAll:null,holdAll:null,realizedToday:null},synced:{positions:null,quotes:null},sources:[]};
// The price line starts at your first fill in that market (or a day back if fills have not synced yet).
const readSpark=sparkCache(t=>journal.spark(sparkKey(data.quotes.get(t),t),data.events.find(e=>e.ticker===t&&e.type==='fill')?.time??Date.now()-86400000));
function build(){
  const now=Date.now(),spark=(t:string)=>readSpark(t,now);
  const {cards,memory:next}=buildPositions({positions:data.positions,quotes:data.quotes,series:data.series,open:data.open,cfg,memory,now,spark,reference:t=>references.reference(t,now),sharps:t=>sharps.forTicker(t),
    crypto:q=>{pricer.want(q.seriesTicker);return pricer.price(q,now);},eia:s=>{const n=eiaFor(s);return n?eia.prices.find(p=>p.name===n)??null:null;}});
  for(const c of cards){const before=memory.get(c.ticker)?.notice??null;if(c.notice&&c.notice.kind!==before)journal.notice(now,c.ticker,c.notice.kind,{notice:c.notice,bid:c.bid,winProb:c.winProb,unrealized:c.unrealized});}
  memory=next;
  state={time:now,status:!client.authenticated?'no-credentials':data.positionsUpdated?'live':'starting',error:data.error.account??data.error.quotes,positions:cards,
    bitcoin:data.positions.filter(p=>isBitcoin(String(p.ticker))&&Math.abs(Number(p.position_fp))>1e-9).length,
    summary:summarize(cards,data.events,dayKey(now),t=>dayKey(t)),synced:{positions:data.positionsUpdated||null,quotes:data.quotesUpdated||null},sources:[...references.health(now),...sharps.health(now),{name:'EIA',ok:!!process.env.EIA_API_KEY&&!eia.error,updated:eia.prices.length?eia.at||null:null,error:eia.error,detail:!process.env.EIA_API_KEY?'no key':eia.prices.length?`${eia.prices.map(p=>`${p.name} ${p.value}`).join(' · ')}`:'waiting for first use'}]};
}
// The Record tab is historical: built on request, at most once a minute.
let record:{at:number;body:RecordState&{refreshing:boolean;sources:SourceComparison[];flags:FlagStats[]}}|null=null;
// Scanner: liquid open markets every 5 min (first sweep 2 min after start), flags paper-scored as they settle.
// Its own request queue (2.5/s), so a sweep never delays the 5-s price updates of your positions; ~5 requests/s in all.
const scanner=new Scanner(new KalshiClient(undefined,undefined,400),journal,references,data,log);
let scan:{at:number;body:{rows:ScanRow[];updated:number|null;error:string|null;count:number;stats:FlagStats[]}}|null=null;
function scanState(now=Date.now()){
  if(!scan||now-scan.at>=60000||scan.body.updated!==(scanner.updated||null)){const stats=flagStats(journal.flagRows());scan={at:now,body:{rows:scanner.rows(now,stats),updated:scanner.updated||null,error:scanner.error,count:scanner.count,stats}};}
  return scan.body;
}
function recordState(now=Date.now()){
  if(!record||now-record.at>=60000)record={at:now,body:{...buildRecord({accuracy:journal.get('accuracy',null),events:data.events,fills:journal.raw().fills.filter((f:any)=>!isBitcoin(String(f.ticker??f.market_ticker))),
    groupFor:t=>data.groupFor(t),stats:journal.backfillStats(),finished:journal.get<number|null>('backfillFinished',null)}),refreshing:refresher.active(now),sources:compareSources(journal.sourcePairs()),flags:flagStats(journal.flagRows())}};
  return record.body;
}
const safe=(name:string,f:()=>unknown)=>{try{const r=f();if(r instanceof Promise)r.catch(e=>log(name,{message:(e as Error).message}));}catch(e){log(name,{message:(e as Error).message});}};
const server=createServer((req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(!authorized(req.headers.authorization,req)){res.writeHead(401,{'WWW-Authenticate':'Basic realm="Kalshi Advisor"'});res.end('Authentication required');return;}
  const path=new URL(req.url??'/','http://127.0.0.1').pathname;
  if(req.method==='GET'&&path==='/state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(state));return;}
  if(req.method==='GET'&&path==='/scan'){try{const body=JSON.stringify(scanState());res.setHeader('Content-Type','application/json');res.end(body);}catch(e){log('scan-error',{message:(e as Error).message});res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:(e as Error).message}));}return;}
  if(req.method==='GET'&&path==='/sharps/btc'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(sharps.state().btc));return;}
  if(req.method==='GET'&&path==='/sharps'){try{const stats=flagStats(journal.flagRows()).filter(s=>s.type.startsWith('sharp'));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...sharps.state(),stats}));}catch(e){log('sharps-error',{message:(e as Error).message});res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:(e as Error).message}));}return;}
  if(req.method==='GET'&&path==='/record'){try{const body=JSON.stringify(recordState());res.setHeader('Content-Type','application/json');res.end(body);}catch(e){log('record-error',{message:(e as Error).message});res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:(e as Error).message}));}return;}
  // You confirm or reject a suggested Kalshi market for a Polymarket one on the Sharps tab. Same-origin only.
  if(req.method==='POST'&&path==='/sharp-link'){
    const origin=req.headers.origin,host=String(req.headers['x-forwarded-host']??req.headers.host??'');
    if(!origin||new URL(origin).host!==host){res.writeHead(403);res.end('Origin rejected');return;}
    let body='';req.on('data',c=>{body+=c;if(body.length>4096)req.destroy();});
    req.on('end',()=>{try{const d=JSON.parse(body);
      if(typeof d.cond!=='string'||typeof d.ticker!=='string'||!['confirmed','rejected'].includes(d.status))throw new Error('Invalid link decision');
      const ok=journal.decideLink(d.cond,d.ticker,d.status,Date.now());if(ok)sharps.decided(d.cond,d.ticker,d.status);log('sharp-link-decided',{...d,ok});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok}));}
      catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:(e as Error).message}));}});
    return;
  }
  // You confirm or reject a suggested outside match from a position card. Same-origin only, like the engine's settings.
  if(req.method==='POST'&&path==='/match'){
    const origin=req.headers.origin,host=String(req.headers['x-forwarded-host']??req.headers.host??'');
    if(!origin||new URL(origin).host!==host){res.writeHead(403);res.end('Origin rejected');return;}
    let body='';req.on('data',c=>{body+=c;if(body.length>4096)req.destroy();});
    req.on('end',()=>{try{const d=JSON.parse(body);
      if(typeof d.ticker!=='string'||typeof d.refId!=='string'||d.source!=='polymarket'||!['confirmed','rejected'].includes(d.status))throw new Error('Invalid match decision');
      const ok=journal.decideMatch(d.ticker,d.source,d.refId,d.status,Date.now());log('match-decided',{...d,ok});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok}));}
      catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:(e as Error).message}));}});
    return;
  }
  res.writeHead(404);res.end('Not found');
});
const wss=new WebSocketServer({noServer:true});
server.on('upgrade',(req,socket,head)=>{if(req.url!=='/ws'||!authorized(req.headers.authorization,req)){socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Kalshi Advisor"\r\n\r\n');socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>ws.send(JSON.stringify(state)));});
const port=Number(process.env.MARKETS_PORT??3002);
server.listen(port,'127.0.0.1',()=>log('markets-listening',{port,authenticated:client.authenticated}));
async function boot(){
  loadConfig();
  // Any public response carries the server Date, which signed requests need first.
  try{await client.get('/exchange/status');}catch(e){log('clock-sync-error',{message:(e as Error).message});}
  await data.syncAccount();await data.pollQuotes(Date.now());await refreshReferences().catch(e=>log('references-error',{message:(e as Error).message}));build();
}
void boot();
setInterval(()=>safe('account-sync-error',()=>data.syncAccount()),30000);
setInterval(()=>safe('quotes-error',()=>data.pollQuotes(Date.now())),5000);
setInterval(()=>safe('references-error',refreshReferences),60000);
// Matched markets keep being checked after they leave your positions, so their results can be scored against the outside price.
setInterval(()=>safe('settle-check-error',()=>data.settleCheck(Date.now())),15*60000);
setTimeout(()=>{safe('scanner-error',()=>scanner.sweep(Date.now()));setInterval(()=>safe('scanner-error',()=>scanner.sweep(Date.now())),5*60000);},2*60000);
// Sharp money: ranked wallets (6 h, checked every 10 min), their positions (10 min), the Bitcoin round (20 s), lean scoring (5 min).
setTimeout(()=>{safe('sharp-wallets-error',async()=>{await sharps.refreshWallets(Date.now());await sharps.refreshPositions(Date.now());});},30000);
setInterval(()=>safe('sharp-wallets-error',()=>sharps.refreshWallets(Date.now())),10*60000);
setInterval(()=>safe('sharp-positions-error',()=>sharps.refreshPositions(Date.now())),60000);
setInterval(()=>safe('btc-lean-error',()=>sharps.refreshBtc(Date.now())),20000);
setTimeout(()=>safe('eia-error',()=>refreshEia(Date.now())),20000);setInterval(()=>safe('eia-error',()=>refreshEia(Date.now())),3600000);
setInterval(()=>safe('btc-lean-score-error',()=>sharps.scoreBtc(Date.now())),5*60000);
setInterval(()=>safe('snapshot-error',()=>journal.snapshot(snapshotRows(data.quotes,state.positions,Date.now()))),30000);
setInterval(()=>safe('memory-save-error',()=>journal.set('memory',Object.fromEntries(memory))),30000);
setInterval(()=>safe('config-error',loadConfig),60000);
setInterval(()=>safe('prune-error',()=>journal.prune()),3600000);
// History for the Record tab: refreshed daily in a low-priority child process (first run 10 min after start).
const refresher=new BackfillRefresher(log,journal);setInterval(()=>safe('backfill-refresh-error',()=>refresher.tick()),5*60000);
setInterval(()=>{safe('build-error',build);const message=JSON.stringify(state);for(const ws of wss.clients)if(ws.readyState===WebSocket.OPEN&&ws.bufferedAmount<1000000)ws.send(message);},1000);
const stop=()=>{refresher.stop();try{journal.set('memory',Object.fromEntries(memory));journal.db.close();}catch{}process.exit(0);};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
