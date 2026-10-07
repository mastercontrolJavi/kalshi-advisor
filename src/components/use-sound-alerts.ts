'use client';
import {useEffect,useRef,useState} from 'react';
import {SoundEngine,soundCatalog,loadPrefs,savePrefs,defaultPrefs,type SoundName,type SoundPrefs} from './sounds';
import {snapshot,detectEvents,type AlertSnapshot} from './alert-events';
const categoryOf=Object.fromEntries(soundCatalog.map(s=>[s.name,s.category])) as Record<SoundName,keyof SoundPrefs['categories']>;
const SELL_REPEAT_MS=15000,WARNING_GAP_MS=30000,SPACING_MS=650,MAX_PER_UPDATE=3;
/** Plays alert sounds (and optional browser notifications) on state transitions. Prefs are per-browser. */
export function useSoundAlerts(s:any,fresh:boolean){
  const engine=useRef<SoundEngine|null>(null),prev=useRef<AlertSnapshot|null>(null),lastSell=useRef(Date.now()),lastWarning=useRef(0);
  const [prefs,setPrefsState]=useState<SoundPrefs>(defaultPrefs),[ready,setReady]=useState(false);
  useEffect(()=>{setPrefsState(loadPrefs());engine.current=new SoundEngine();
    // Browsers block audio until a user gesture; any click or key press on the page arms it.
    const unlock=()=>{engine.current?.unlock();setTimeout(()=>setReady(!!engine.current?.ready),80);};
    window.addEventListener('pointerdown',unlock);window.addEventListener('keydown',unlock);
    return()=>{window.removeEventListener('pointerdown',unlock);window.removeEventListener('keydown',unlock);engine.current?.close();};
  },[]);
  useEffect(()=>{
    if(!s)return;
    const next=snapshot(s,fresh),events=detectEvents(prev.current,next),now=Date.now();prev.current=next;
    if(prefs.repeatSell&&Object.values(next.exits).includes('SELL NOW')&&!events.includes('sell')&&now-lastSell.current>=SELL_REPEAT_MS)events.unshift('sell');
    const playable=events.filter(n=>n!=='warning'||now-lastWarning.current>=WARNING_GAP_MS).filter(n=>prefs.enabled&&prefs.categories[categoryOf[n]]).slice(0,MAX_PER_UPDATE);
    if(playable.includes('sell'))lastSell.current=now;if(playable.includes('warning'))lastWarning.current=now;
    playable.forEach((n,i)=>setTimeout(()=>engine.current?.play(n,prefs.volume),i*SPACING_MS));
    if(s.config?.notifications&&typeof Notification!=='undefined'&&Notification.permission==='granted'){
      const sell=(s.exits??[]).find((e:any)=>e.action==='SELL NOW');
      if(events.includes('sell')&&sell)new Notification('SELL NOW',{body:sell.reason,tag:'sell'});
      if(events.includes('buyYes')||events.includes('buyNo'))new Notification(s.evaluation.action,{body:s.evaluation.reason,tag:'signal'});
      if(events.includes('win'))new Notification('Profit',{body:`P&L today ${s.guards.pnl>=0?'+':'−'}$${Math.abs(s.guards.pnl).toFixed(2)}`,tag:'result'});
    }
  },[s,fresh,prefs]);
  const setPrefs=(p:SoundPrefs)=>{setPrefsState(p);savePrefs(p);};
  const test=(name:SoundName)=>{engine.current?.unlock();setTimeout(()=>{setReady(!!engine.current?.ready);engine.current?.play(name,prefs.volume);},80);};
  return {prefs,setPrefs,ready,test};
}
