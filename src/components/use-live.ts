'use client';
import {useEffect,useState} from 'react';
export function useLive(){
  const [state,setState]=useState<any>(null),[connected,setConnected]=useState(false),[received,setReceived]=useState(0),[clock,setClock]=useState(Date.now());
  useEffect(()=>{let socket:WebSocket|undefined,timer:ReturnType<typeof setTimeout>,stopped=false,attempt=0;
    const connect=()=>{socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`);socket.onopen=()=>{attempt=0;setConnected(true);};socket.onmessage=event=>{try{setState(JSON.parse(event.data));setReceived(Date.now());}catch{}};socket.onerror=()=>socket?.close();socket.onclose=()=>{setConnected(false);if(!stopped)timer=setTimeout(connect,Math.min(10000,500*2**attempt++));};};connect();
    const heartbeat=setInterval(()=>setClock(Date.now()),1000);return()=>{stopped=true;clearTimeout(timer);clearInterval(heartbeat);socket?.close();};
  },[]);
  return {state,connected,fresh:connected&&clock-received<4000,age:clock-received};
}
