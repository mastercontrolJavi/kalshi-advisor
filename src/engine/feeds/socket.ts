import WebSocket from 'ws';
export class ReconnectingSocket {
  socket?:WebSocket; private timer?:NodeJS.Timeout; private heartbeat?:NodeJS.Timeout; private stopped=false; private attempts=0; private lastMessage=0;
  constructor(private url:string,private subscribe:()=>unknown[],private onMessage:(data:any)=>void,private status:(s:string)=>void,private headers?:()=>Record<string,string>){}
  start(){this.stopped=false;this.connect();}
  private connect(){
    if(this.stopped)return;
    this.status('connecting');
    try {
      const ws=this.socket=new WebSocket(this.url,{headers:this.headers?.(),handshakeTimeout:10000,followRedirects:false});
      ws.on('open',()=>{this.lastMessage=Date.now();this.status('connected');for(const msg of this.subscribe())ws.send(JSON.stringify(msg));});
      ws.on('message',raw=>{this.lastMessage=Date.now();this.attempts=0;try{this.onMessage(JSON.parse(raw.toString()));}catch(e){this.status(`message rejected: ${(e as Error).message}`);}});
      ws.on('pong',()=>{this.lastMessage=Date.now();});
      ws.on('error',()=>{this.status('connection error');ws.terminate();});
      ws.on('close',()=>{clearInterval(this.heartbeat);this.status('disconnected');if(!this.stopped)this.timer=setTimeout(()=>this.connect(),Math.min(30000,500*2**Math.min(this.attempts++,6))+Math.random()*300);});
      this.heartbeat=setInterval(()=>{if(Date.now()-this.lastMessage>15000)ws.terminate();else if(ws.readyState===WebSocket.OPEN)ws.ping();},5000);
    }catch {this.status('connection failed');this.timer=setTimeout(()=>this.connect(),5000);}
  }
  stop(){this.stopped=true;clearTimeout(this.timer);clearInterval(this.heartbeat);this.socket?.terminate();}
  restart(){this.stop();this.start();}
}
