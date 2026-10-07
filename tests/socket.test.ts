import {it,expect} from 'vitest';
import {WebSocketServer} from 'ws';
import {ReconnectingSocket} from '../src/engine/feeds/socket';
// Regression: Kraken's ~1.5 s handshake was terminated by a 1 s watchdog still measuring the previous connection's silence.
it('a slow handshake survives fast pings after a long disconnect',async()=>{
  const wss=new WebSocketServer({port:0,verifyClient:(_info,done)=>setTimeout(()=>done(true),1200)});
  await new Promise(r=>wss.once('listening',r));const port=(wss.address() as any).port,statuses:string[]=[];
  const socket=new ReconnectingSocket(`ws://127.0.0.1:${port}`,()=>[],()=>{},s=>statuses.push(s),undefined,{pingMs:200});
  (socket as any).lastMessage=Date.now()-60000;socket.start();
  await new Promise(r=>setTimeout(r,2500));socket.stop();wss.close();
  expect(statuses).toContain('connected');expect(statuses).not.toContain('connection error');
},10000);
