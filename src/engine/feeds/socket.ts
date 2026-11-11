import WebSocket from 'ws';
export class ReconnectingSocket {
  socket?:WebSocket; private timer?:NodeJS.Timeout; private heartbeat?:NodeJS.Timeout; private stopped=false; private attempts=0; private lastMessage=0;
  // pingMs: protocol ping cadence; onAlive fires on any frame or pong so callers can tell a quiet-but-live feed from a dead one.
  constructor(private url:string,private subscribe:()=>unknown[],private onMessage:(data:any)=>void,private status:(s:string)=>void,private headers?:()=>Record<string,string>,private options:{pingMs?:number;onAlive?:()=>void}={}){}
  start(){this.stopped=false;this.connect();}
  private connect(){
    if(this.stopped)return;
    // Reset the watchdog clock per attempt; otherwise a slow handshake is killed using the previous connection's silence.
    this.status('connecting');this.lastMessage=Date.now();
    try {
      // Keep per-message compression. It costs CPU (the same feeds 80 vs 29 ms/s), but in Kalshi's 2,000–3,000 message/s
      // bursts bytes are the limit: on 2026-10-23 an uncompressed connection fell 7 s behind while a compressed one on the
      // same PC stayed under 0.5 s. Turned off for an hour that day and reverted (DECISIONS 65).
      const ws=this.socket=new WebSocket(this.url,{headers:this.headers?.(),handshakeTimeout:10000,followRedirects:false});
      // After restart() the old socket's events still fire; only the current socket may touch shared state.
      ws.on('open',()=>{if(this.socket!==ws)return;this.lastMessage=Date.now();this.status('connected');for(const msg of this.subscribe())ws.send(JSON.stringify(msg));});
      ws.on('message',raw=>{if(this.socket!==ws)return;this.lastMessage=Date.now();this.options.onAlive?.();this.attempts=0;try{this.onMessage(JSON.parse(raw.toString()));}catch(e){this.status(`message rejected: ${(e as Error).message}`);}});
      ws.on('pong',()=>{if(this.socket!==ws)return;this.lastMessage=Date.now();this.options.onAlive?.();});
      ws.on('error',()=>{if(this.socket===ws)this.status('connection error');ws.terminate();});
      ws.on('close',()=>{if(this.socket!==ws)return;clearInterval(this.heartbeat);this.status('disconnected');if(!this.stopped)this.timer=setTimeout(()=>this.connect(),Math.min(30000,500*2**Math.min(this.attempts++,6))+Math.random()*300);});
      this.heartbeat=setInterval(()=>{if(this.socket!==ws){clearInterval(hb);return;}if(Date.now()-this.lastMessage>15000)ws.terminate();else if(ws.readyState===WebSocket.OPEN)ws.ping();},this.options.pingMs??5000);
      const hb=this.heartbeat;
    }catch {this.status('connection failed');this.timer=setTimeout(()=>this.connect(),5000);}
  }
  stop(){this.stopped=true;clearTimeout(this.timer);clearInterval(this.heartbeat);this.socket?.terminate();}
  restart(){this.stop();this.start();}
}
