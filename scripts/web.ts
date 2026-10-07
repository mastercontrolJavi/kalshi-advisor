import dotenv from 'dotenv';dotenv.config({path:'.env.local',quiet:true});
import next from 'next';
import {createServer,request} from 'node:http';
import {WebSocketServer,WebSocket} from 'ws';
import {authorized,requireDashboardCredentials} from '../src/engine/auth';
requireDashboardCredentials();
const dev=process.argv.includes('--dev'),port=Number(process.env.PORT??3000),enginePort=Number(process.env.ENGINE_PORT??3001);
const app=next({dev,hostname:'127.0.0.1',port});
await app.prepare();const handle=app.getRequestHandler(),wss=new WebSocketServer({noServer:true});
const server=createServer((req,res)=>{
  if(!authorized(req.headers.authorization)){res.writeHead(401,{'WWW-Authenticate':'Basic realm="Kalshi Advisor"','Cache-Control':'no-store'});res.end('Authentication required');return;}
  if(req.url?.startsWith('/api/engine/')){
    const upstream=request({hostname:'127.0.0.1',port:enginePort,path:req.url.slice('/api/engine'.length),method:req.method,headers:{...req.headers,'x-forwarded-host':req.headers.host}},r=>{res.writeHead(r.statusCode??502,r.headers);r.pipe(res);});
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(503);res.end('Engine unavailable');});req.pipe(upstream);return;
  }
  void handle(req,res);
});
server.on('upgrade',(req,socket,head)=>{
  if(!authorized(req.headers.authorization)){socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Kalshi Advisor"\r\n\r\n');socket.destroy();return;}
  if(req.url?.startsWith('/_next/')&&dev){app.getUpgradeHandler()(req,socket,head);return;}
  if(req.url!=='/ws'||!req.headers.origin||new URL(req.headers.origin).host!==req.headers.host){socket.destroy();return;}
  wss.handleUpgrade(req,socket,head,downstream=>{
    const upstream=new WebSocket(`ws://127.0.0.1:${enginePort}/ws`,{headers:{Authorization:req.headers.authorization!}});
    upstream.on('message',m=>{if(downstream.readyState===WebSocket.OPEN)downstream.send(m.toString());});
    upstream.on('error',()=>downstream.close(1011,'Engine unavailable'));upstream.on('close',()=>downstream.close());downstream.on('close',()=>upstream.close());
  });
});
server.listen(port,'127.0.0.1',()=>console.log(`Authenticated dashboard: http://localhost:${port}`));
