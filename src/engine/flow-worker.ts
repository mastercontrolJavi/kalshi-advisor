import {parentPort,workerData} from 'node:worker_threads';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import Database from 'better-sqlite3';
import {ReconnectingSocket} from './feeds/socket';
import {FlowState,parseBinance,parseBybit,parseCoinbase,barValues,FLOW_INSERT,FLOW_SCHEMA,FLOW_VERSION,FLOW_BUCKET_MS,type FlowVenueId} from './flow';
/**
 * The order-flow & futures pulse on its own thread (flow.ts, DECISIONS 71). Its sockets, JSON parsing, rolling windows
 * and database writes never run on the engine's event loop; the engine gets one pulse message every 250 ms and sends
 * back its Kalshi clock offset. Bars go to their own SQLite file, so they never contend with the journal's writes.
 */
const {path}=workerData as {path:string};
const send=(m:unknown)=>parentPort!.postMessage(m),log=(event:string,data:unknown)=>send({kind:'log',event,data});
let offset=0,dbError:string|null=null,written=0;
const at=()=>Date.now()+offset,state=new FlowState();
if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
const db=new Database(path);db.pragma('journal_mode = WAL');db.pragma('synchronous = NORMAL');db.exec(FLOW_SCHEMA);
db.prepare('INSERT OR REPLACE INTO flow_meta VALUES(?,?)').run('version',FLOW_VERSION);
const insert=db.prepare(FLOW_INSERT),writeBars=db.transaction((rows:ReturnType<FlowState['drain']>)=>{for(const r of rows)insert.run(...barValues(r));});
const sockets:ReconnectingSocket[]=[];
function venue(id:FlowVenueId,url:string,subscribe:()=>unknown[],handle:(m:any,t:number)=>void){
  const s=new ReconnectingSocket(url,subscribe,m=>handle(m,at()),status=>{state.status(id,status,at());if(status==='connected'||status==='disconnected')log('flow-feed-status',{venue:id,status});},undefined,{pingMs:1000,onAlive:()=>state.alive(id,at())});
  sockets.push(s);return s;
}
venue('coinbase','wss://ws-feed.exchange.coinbase.com',()=>[{type:'subscribe',product_ids:['BTC-USD'],channels:['matches','heartbeat']}],(m,t)=>{const trade=parseCoinbase(m,t);if(trade)state.trade(trade);});
// Binance moved USDⓈ-M trade and mark streams to /market and book streams to /public (the old /ws path accepts the
// subscription and sends nothing for aggTrade, checked 2026-11-02). Reachable from this PC; both compressed.
const binance=(m:any,t:number)=>{const r=parseBinance(m,t);if(r?.trade)state.trade(r.trade);if(r?.quote)state.book(r.quote);if(r?.mark)state.mark(r.mark);};
venue('binance','wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade/btcusdt@markPrice@1s',()=>[],binance);
const book=new ReconnectingSocket('wss://fstream.binance.com/public/stream?streams=btcusdt@depth5@100ms',()=>[],m=>binance(m,at()),status=>{if(status!=='connected')state.quote=null;},undefined,{pingMs:1000});sockets.push(book);
const bybit=venue('bybit','wss://stream.bybit.com/v5/public/linear',()=>[{op:'subscribe',args:['publicTrade.BTCUSDT']}],(m,t)=>{for(const trade of parseBybit(m,t))state.trade(trade);});
// Bybit closes a public connection without an application-level ping every ~20 s.
const bybitPing=setInterval(()=>{const ws=bybit.socket;if(ws?.readyState===1)ws.send('{"op":"ping"}');},20000);
for(const s of sockets)s.start();
const pulseTimer=setInterval(()=>{try{send({kind:'pulse',pulse:state.pulse(at()),db:{written,error:dbError}});}catch(e){log('flow-pulse-error',{message:(e as Error).message});}},FLOW_BUCKET_MS);
const barTimer=setInterval(()=>{try{const rows=state.drain(at()-FLOW_BUCKET_MS);if(rows.length){writeBars(rows);written+=rows.length;}dbError=null;}catch(e){const message=(e as Error).message;if(message!==dbError)log('flow-db-error',{message});dbError=message;}},1000);
parentPort!.on('message',(m:any)=>{
  if(m?.kind==='clock'&&Number.isFinite(m.offset)&&m.offset!==offset){offset=m.offset;state.rebase();}
  if(m?.kind==='stop'){clearInterval(pulseTimer);clearInterval(barTimer);clearInterval(bybitPing);for(const s of sockets)s.stop();try{writeBars(state.drain(at()+FLOW_BUCKET_MS));}catch{}db.close();process.exit(0);}
});
