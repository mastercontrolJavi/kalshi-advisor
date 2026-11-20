import dotenv from 'dotenv';dotenv.config({path:'.env.local',quiet:true});
import next from 'next';
import {createServer,request} from 'node:http';
import {WebSocketServer,WebSocket} from 'ws';
import {authorized,requireDashboardCredentials} from '../src/engine/auth';
import {fullSpeed} from '../src/engine/power';
import {readBotRecord,readStatus,setSwitch,setFeature,sameOrigin} from '../src/bot/record';
requireDashboardCredentials();
// This server relays the 4 Hz engine stream to the page, so it must not be power-throttled on battery either (power.ts).
fullSpeed((event,data)=>console.log(JSON.stringify({time:new Date().toISOString(),event,data})));
const dev=process.argv.includes('--dev'),port=Number(process.env.PORT??3000),enginePort=Number(process.env.ENGINE_PORT??3001);
// The engine behind the authenticated server: HTTP by path prefix, live updates by WebSocket path.
const apis:[string,number,string][]=[['/api/engine/',enginePort,'Engine']],sockets:Record<string,number>={'/ws':enginePort};
const app=next({dev,hostname:'127.0.0.1',port});
await app.prepare();const handle=app.getRequestHandler(),wss=new WebSocketServer({noServer:true});
const server=createServer((req,res)=>{
  if(!authorized(req.headers.authorization,req)){res.writeHead(401,{'WWW-Authenticate':'Basic realm="Kalshi Advisor"','Cache-Control':'no-store'});res.end('Authentication required');return;}
  // The paper bot's record (bot/, DECISIONS 81): read here from its own ledger, so the engine does no work for it.
  if(req.url==='/api/bot'&&req.method==='GET'){try{const body=JSON.stringify(readBotRecord());res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(body);}catch(e){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:(e as Error).message}));}return;}
  // The real-money switch (bot/live.py): only this page's own button may flip it, so the request must come from this
  // origin as JSON. Switching on needs the bot running in live mode; switching off always works.
  if(req.url==='/api/bot/live'&&req.method==='POST'){
    const fail=(code:number,error:string)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error}));};
    if(!sameOrigin(req.headers.origin,req.headers.host)||!String(req.headers['content-type']??'').startsWith('application/json'))return fail(403,'Not allowed from here');
    let raw='';req.on('data',c=>{raw+=c;if(raw.length>1000)req.destroy();});
    req.on('end',()=>{try{const next=setSwitch(JSON.parse(raw||'{}').armed,readStatus());console.log(JSON.stringify({time:new Date().toISOString(),event:'real-trading-switch',data:next}));
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(next));}catch(e){fail(400,(e as Error).message);}});
    return;
  }
  // The feature switches on the Bot page (bot/features.py): the same rule as the switch above, this page's own buttons
  // only. They change what the bot buys and sells, never whether real trading is on.
  if(req.url==='/api/bot/features'&&req.method==='POST'){
    const fail=(code:number,error:string)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error}));};
    if(!sameOrigin(req.headers.origin,req.headers.host)||!String(req.headers['content-type']??'').startsWith('application/json'))return fail(403,'Not allowed from here');
    let raw='';req.on('data',c=>{raw+=c;if(raw.length>1000)req.destroy();});
    req.on('end',()=>{try{const body=JSON.parse(raw||'{}'),next=setFeature(body.name,body.on);console.log(JSON.stringify({time:new Date().toISOString(),event:'bot-feature-switch',data:{name:body.name,on:body.on}}));
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(next));}catch(e){fail(400,(e as Error).message);}});
    return;
  }
  const api=apis.find(([prefix])=>req.url?.startsWith(prefix));
  if(api){const [prefix,target,name]=api;
    const upstream=request({hostname:'127.0.0.1',port:target,path:req.url!.slice(prefix.length-1),method:req.method,headers:{...req.headers,'x-forwarded-host':req.headers.host}},r=>{res.writeHead(r.statusCode??502,r.headers);r.pipe(res);});
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(503);res.end(name+' unavailable');});req.pipe(upstream);return;
  }
  void handle(req,res);
});
server.on('upgrade',(req,socket,head)=>{
  if(!authorized(req.headers.authorization,req)){socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Kalshi Advisor"\r\n\r\n');socket.destroy();return;}
  if(req.url?.startsWith('/_next/')&&dev){app.getUpgradeHandler()(req,socket,head);return;}
  const target=sockets[req.url??''];
  if(!target||!sameOrigin(req.headers.origin,req.headers.host)){socket.destroy();return;}
  wss.handleUpgrade(req,socket,head,downstream=>{
    const upstream=new WebSocket(`ws://127.0.0.1:${target}/ws`,{headers:req.headers.authorization?{Authorization:req.headers.authorization}:{}});
    // A tab that can't keep up skips to newer updates instead of queueing an ever-older backlog (the engine has the same guard).
    upstream.on('message',m=>{if(downstream.readyState===WebSocket.OPEN&&downstream.bufferedAmount<1000000)downstream.send(m.toString());});
    // Every socket needs an error listener: an unhandled 'error' event (a malformed frame, a reset) would take the whole server down.
    downstream.on('error',()=>upstream.terminate());upstream.on('error',()=>downstream.close(1011,'Backend unavailable'));upstream.on('close',()=>downstream.close());downstream.on('close',()=>upstream.close());
  });
});
server.listen(port,'127.0.0.1',()=>console.log(`Authenticated dashboard: http://localhost:${port}`));
