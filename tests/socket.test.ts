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
// Regression: restart() = stop() + start(); the retired socket's late 'close' must not clear the new heartbeat or schedule a second connection.
it('restart leaves exactly one live connection and schedules no extra reconnect',async()=>{
  const wss=new WebSocketServer({port:0});await new Promise(r=>wss.once('listening',r));
  const port=(wss.address() as any).port,statuses:string[]=[];let connections=0;wss.on('connection',()=>{connections++;});
  const socket=new ReconnectingSocket(`ws://127.0.0.1:${port}`,()=>[],()=>{},s=>statuses.push(s),undefined,{pingMs:200});
  socket.start();await new Promise(r=>setTimeout(r,300));
  const old=socket.socket!;socket.restart();const fresh=socket.socket!;
  await new Promise(r=>setTimeout(r,2000));
  expect(old.readyState).toBe(3);expect(fresh.readyState).toBe(1);expect(socket.socket).toBe(fresh);
  expect(connections).toBe(2);expect((socket as any).timer).toBeUndefined();
  expect([...wss.clients].filter(c=>c.readyState===1).length).toBe(1);
  socket.stop();wss.close();
},10000);
// Regression (2026-11-17 audit): one message whose handler threw (bad JSON, or a journal write failing with SQLite's
// "disk I/O error", seen 2026-11-13) set the status to 'message rejected' for good while the socket stayed open and kept
// delivering. BenchmarkFeed.current() then returned nothing and the stale-book breaker stayed tripped until a reconnect;
// a price venue stayed unhealthy. The next message handled cleanly now reports 'connected' again.
it('a rejected message does not leave the feed marked down while it keeps delivering',async()=>{
  const wss=new WebSocketServer({port:0});await new Promise(r=>wss.once('listening',r));const port=(wss.address() as any).port,statuses:string[]=[],got:any[]=[];
  wss.on('connection',ws=>{ws.send('not json');setTimeout(()=>ws.send(JSON.stringify({n:1})),50);});
  const socket=new ReconnectingSocket(`ws://127.0.0.1:${port}`,()=>[],m=>got.push(m),s=>statuses.push(s),undefined,{pingMs:200});
  socket.start();await new Promise(r=>setTimeout(r,500));socket.stop();wss.close();
  expect(statuses.some(s=>s.startsWith('message rejected'))).toBe(true);
  expect(got).toEqual([{n:1}]);expect(statuses.at(-1)).toBe('connected');
},10000);
