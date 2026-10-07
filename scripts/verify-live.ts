import dotenv from 'dotenv';dotenv.config({path:'.env.local',quiet:true});
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import WebSocket from 'ws';
const base=`http://127.0.0.1:${process.env.PORT??3000}`,authorization='Basic '+Buffer.from(process.env.DASHBOARD_USER+':'+process.env.DASHBOARD_PASSWORD).toString('base64');
const report:{time:string;checks:string[];state?:unknown}={time:new Date().toISOString(),checks:[]};
const ok=(s:string)=>{report.checks.push(s);console.log('PASS '+s);};
for(const path of ['/','/calibration','/icon.svg','/api/engine/state','/api/engine/export/ticks']){assert.equal((await fetch(base+path)).status,401);}
ok('All tested unauthenticated pages, assets and API routes return 401');
for(const path of ['/','/calibration','/icon.svg'])assert.equal((await fetch(base+path,{headers:{authorization}})).status,200);
ok('Authenticated dashboard, calibration and icon return 200');
const response=await fetch(base+'/api/engine/state',{headers:{authorization}});assert.equal(response.status,200);const state=await response.json();assert.ok(state.market?.ticker.startsWith('KXBTC15M'));assert.ok(state.proxy>0);assert.ok(state.loopMs>=0);
ok('Live market, positive proxy price and measured engine loop available');
const denied=await fetch(base+'/api/engine/settings',{method:'POST',headers:{authorization,'Content-Type':'application/json'},body:'{}'});assert.equal(denied.status,403);
const saved=await fetch(base+'/api/engine/settings',{method:'POST',headers:{authorization,Origin:base,'Content-Type':'application/json'},body:JSON.stringify(state.config)});assert.equal(saved.status,200);
ok('Settings require same-origin request and persist validated configuration');
for(const table of ['ticks','signals','paper_trades','outcomes','real_trades','opening_calls','live_calls']){const r=await fetch(base+'/api/engine/export/'+table,{headers:{authorization}});assert.equal(r.status,200);assert.ok((await r.text()).includes('ticker'));}
ok('Every required journal table exports CSV');
const wsURL=base.replace('http','ws')+'/ws';
await new Promise<void>((resolve,reject)=>{const ws=new WebSocket(wsURL);const timer=setTimeout(()=>reject(new Error('Unauthenticated WS timeout')),5000);ws.on('unexpected-response',(_req,res)=>{clearTimeout(timer);try{assert.equal(res.statusCode,401);res.destroy();ws.terminate();resolve();}catch(e){reject(e);}});ws.on('open',()=>{ws.terminate();reject(new Error('Unauthenticated WS accepted'));});ws.on('error',()=>{});});
ok('Unauthenticated WebSocket handshake rejected');
await new Promise<void>((resolve,reject)=>{const ws=new WebSocket(wsURL,{headers:{authorization,Origin:base}});let messages=0;const timer=setTimeout(()=>{ws.terminate();reject(new Error('Authenticated WS updates timeout'));},10000);ws.on('message',raw=>{const s=JSON.parse(raw.toString());assert.ok(s.engineTime);if(++messages>=3){clearTimeout(timer);ws.close();resolve();}});ws.on('error',reject);});
ok('Authenticated same-origin WebSocket delivers consecutive realtime updates');
report.state={ticker:state.ticker,proxy:state.proxy,p:state.p,loopMs:state.loopMs,reason:state.evaluation.reason,accountReady:state.account.ready,kalshiStatus:state.kalshi.status,calibrationMarkets:state.calibration.count};
writeFileSync('data/live-verification.json',JSON.stringify(report,null,2));
