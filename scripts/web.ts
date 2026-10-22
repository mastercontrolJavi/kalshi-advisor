import dotenv from 'dotenv';dotenv.config({path:'.env.local',quiet:true});
import next from 'next';
import {createServer,request} from 'node:http';
import {WebSocketServer,WebSocket} from 'ws';
import {authorized,requireDashboardCredentials} from '../src/engine/auth';
requireDashboardCredentials();
const dev=process.argv.includes('--dev'),port=Number(process.env.PORT??3000),enginePort=Number(process.env.ENGINE_PORT??3001),marketsPort=Number(process.env.MARKETS_PORT??3002);
// Each backend process behind the authenticated server: HTTP by path prefix, live updates by WebSocket path.
const apis:[string,number,string][]=[['/api/engine/',enginePort,'Engine'],['/api/markets/',marketsPort,'Markets engine']],sockets:Record<string,number>={'/ws':enginePort,'/markets-ws':marketsPort};
const app=next({dev,hostname:'127.0.0.1',port});
await app.prepare();const handle=app.getRequestHandler(),wss=new WebSocketServer({noServer:true});
const server=createServer((req,res)=>{
  if(!authorized(req.headers.authorization,req)){res.writeHead(401,{'WWW-Authenticate':'Basic realm="Kalshi Advisor"','Cache-Control':'no-store'});res.end('Authentication required');return;}
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
  if(!target||!req.headers.origin||new URL(req.headers.origin).host!==req.headers.host){socket.destroy();return;}
  wss.handleUpgrade(req,socket,head,downstream=>{
    const upstream=new WebSocket(`ws://127.0.0.1:${target}/ws`,{headers:req.headers.authorization?{Authorization:req.headers.authorization}:{}});
    // A tab that can't keep up skips to newer updates instead of queueing an ever-older backlog (the engine has the same guard).
    upstream.on('message',m=>{if(downstream.readyState===WebSocket.OPEN&&downstream.bufferedAmount<1000000)downstream.send(m.toString());});
    upstream.on('error',()=>downstream.close(1011,'Backend unavailable'));upstream.on('close',()=>downstream.close());downstream.on('close',()=>upstream.close());
  });
});
server.listen(port,'127.0.0.1',()=>console.log(`Authenticated dashboard: http://localhost:${port}`));
