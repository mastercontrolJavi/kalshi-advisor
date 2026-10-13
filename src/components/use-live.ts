'use client';
import {useEffect,useState} from 'react';
import {mergeLiveState,liveFresh,clockSkew} from './live-state';
/** Live state over a WebSocket on this host: the Bitcoin engine at /ws, the markets process at /markets-ws. */
export function useLive(path='/ws'){
  const [state,setState]=useState<any>(null),[connected,setConnected]=useState(false),[received,setReceived]=useState(0),[clock,setClock]=useState(Date.now()),[skew,setSkew]=useState(0);
  useEffect(()=>{let socket:WebSocket|undefined,timer:ReturnType<typeof setTimeout>,stopped=false,attempt=0;
    setState(null);setConnected(false);setReceived(0);setSkew(0);
    // Receive delays of the last ~30 s of packets (engine 4 Hz, markets 1 Hz); cleared on reconnect.
    let delays:number[]=[];
    const connect=()=>{const ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}${path}`);socket=ws;ws.onopen=()=>{if(stopped)return;attempt=0;delays=[];setConnected(true);};ws.onmessage=event=>{if(stopped)return;try{const next=JSON.parse(event.data);if(!mergeLiveState(null,next))return;const now=Date.now();delays.push(now-(next.engineTime??next.time));if(delays.length>120)delays.shift();setSkew(clockSkew(delays));setState((prev:any)=>mergeLiveState(prev,next));setReceived(now);}catch{}};ws.onerror=()=>ws.close();ws.onclose=()=>{if(stopped)return;setConnected(false);timer=setTimeout(connect,Math.min(10000,500*2**attempt++));};};connect();
    const heartbeat=setInterval(()=>setClock(Date.now()),1000);return()=>{stopped=true;clearTimeout(timer);clearInterval(heartbeat);socket?.close();};
  },[path]);
  return {state,connected,fresh:liveFresh(connected,state?.engineTime??state?.time,received,clock,skew),age:received?Math.max(0,clock-received):Infinity};
}
